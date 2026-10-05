import 'fake-indexeddb/auto';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_KEY_B64 } from '../test/helpers';
import { EventQueue, type SendResult, type SignedBatch } from './event-queue';
import { importSessionKey } from './hmac';
import { IdbStore } from './idb';

/**
 * Proof that EventQueue.stop() never drops a batch whose signing is still in flight, and that it
 * makes its own final cut of events not yet cut (TC-065 NFR-04, TC-063 NFR-08, FR-609).
 * crypto.subtle.sign is held on a deferred promise so a batch is genuinely mid-signing when
 * stop() is called. These tests cover stop() only; finish() is covered in
 * finish-inflight.test.ts on PR #43.
 */
const KEY = Buffer.from(TEST_KEY_B64, 'base64');
const validSig = (b: SignedBatch): boolean =>
  createHmac('sha256', KEY).update(b.body).digest('hex') === b.signature;
const ev = (k: number) => ({
  type: 'TAB_SWITCH' as const,
  occurredAt: new Date(1_700_000_000_000 + k).toISOString(),
  durationMs: k,
  payload: {},
});
const eventsOf = (b: SignedBatch): number[] =>
  (JSON.parse(b.body) as { events: { durationMs: number }[] }).events.map((e) => e.durationMs);

let dbCounter = 0;
afterEach(() => vi.restoreAllMocks());

async function rig(
  outcome: SendResult,
  opts: { flushIntervalMs?: number; holdSign?: boolean } = {},
) {
  const store = new IdbStore(indexedDB, `inflight-${++dbCounter}`);
  const sent: SignedBatch[] = [];
  const attempted: SignedBatch[] = [];
  const q = new EventQueue({
    sessionId: 's',
    key: await importSessionKey(TEST_KEY_B64),
    store,
    flushIntervalMs: opts.flushIntervalMs ?? 10,
    jitter: 0,
    backoffBaseMs: 60_000,
    transport: {
      sendBatch: (b) => {
        attempted.push(b);
        if (outcome === 'OK') sent.push(b);
        return Promise.resolve(outcome);
      },
    },
  });
  await q.start();
  // Hold the first sign() on a deferred promise; later calls pass straight through.
  const realSign = crypto.subtle.sign.bind(crypto.subtle);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inSign = new Promise<void>((r) => (entered = r));
  let first = true;
  if (opts.holdSign !== false) {
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return realSign(...args);
    });
  }
  return { q, store, sent, attempted, release, inSign };
}

/** enqueue(1), wait until its batch is being signed, enqueue(2) while it is held, call stop(). */
async function stopMidSign(r: Awaited<ReturnType<typeof rig>>) {
  r.q.enqueue(ev(1));
  await r.inSign; // the flush timer cut a batch and signing is now blocked
  r.q.enqueue(ev(2)); // enqueued while the first batch is mid-signing
  const stopped = r.q.stop();
  let settled = false;
  void stopped.then(() => (settled = true));
  await new Promise((res) => setTimeout(res, 50));
  return { stopped, isSettled: () => settled };
}

describe('EventQueue.stop() with a batch mid-signing (TC-065 NFR-04, FR-609)', () => {
  it('TC-065 NFR-04: stop() waits for the in-flight signature, then sends the batch with its original seq and a valid signature; events enqueued while signing are not lost', async () => {
    const r = await rig('OK');
    const { stopped, isSettled } = await stopMidSign(r);
    expect(isSettled()).toBe(false); // stop() is waiting for the signature, not skipping it
    r.release();
    await stopped;
    const [b0, b1] = r.sent;
    expect(r.sent.map((b) => b.seq)).toEqual([0, 1]);
    expect(r.sent.every(validSig)).toBe(true);
    expect(eventsOf(b0 as SignedBatch)).toEqual([1]);
    expect(eventsOf(b1 as SignedBatch)).toEqual([2]);
    expect(r.q.stats().pendingEvents).toBe(0);
  });

  it('TC-065 NFR-04: stop() makes its own final cut of events that were never cut (timer window not yet elapsed)', async () => {
    const r = await rig('OK', { flushIntervalMs: 60_000, holdSign: false });
    r.q.enqueue(ev(1));
    expect(r.q.stats().pendingEvents).toBe(1);
    await r.q.stop();
    expect(r.sent.map((b) => b.seq)).toEqual([0]);
    expect(eventsOf(r.sent[0] as SignedBatch)).toEqual([1]);
    expect(validSig(r.sent[0] as SignedBatch)).toBe(true);
    expect(r.q.stats().pendingEvents).toBe(0);
  });
});

describe('EventQueue.stop() offline with a batch mid-signing (TC-063 NFR-08, TC-065 NFR-04)', () => {
  it('TC-063 NFR-08: the transport was tried, nothing was acknowledged, and both signed batches stay in the IDB outbox with continuous seq', async () => {
    const r = await rig('RETRY');
    const { stopped } = await stopMidSign(r);
    r.release();
    await stopped;
    expect(r.attempted.map((b) => b.seq)).toContain(0);
    expect(r.sent).toHaveLength(0);
    const saved = await r.store.entries<SignedBatch>('eventBatches', 's:');
    expect(saved.map((e) => e.value.seq)).toEqual([0, 1]);
    expect(saved.every((e) => validSig(e.value))).toBe(true);
    expect(await r.store.get('meta', 's:nextEventSeq')).toBe(2);
  });

  it('TC-063 NFR-08: a reloaded queue resends the same batches with the same signatures and continues at seq 2 with a valid signature', async () => {
    const r = await rig('RETRY');
    const { stopped } = await stopMidSign(r);
    r.release();
    await stopped;
    const before = (await r.store.entries<SignedBatch>('eventBatches', 's:')).map(
      (e) => `${e.value.seq}:${e.value.signature}`,
    );
    const resent: SignedBatch[] = [];
    const q2 = new EventQueue({
      sessionId: 's',
      key: await importSessionKey(TEST_KEY_B64),
      store: r.store,
      transport: {
        sendBatch: (b) => {
          resent.push(b);
          return Promise.resolve('OK');
        },
      },
    });
    await q2.start();
    await vi.waitFor(() => expect(resent).toHaveLength(2));
    expect(resent.map((b) => `${b.seq}:${b.signature}`)).toEqual(before);
    q2.enqueue(ev(3));
    await q2.flush();
    expect(resent.map((b) => b.seq)).toEqual([0, 1, 2]);
    expect(resent.every(validSig)).toBe(true);
    await q2.stop();
  });
});
