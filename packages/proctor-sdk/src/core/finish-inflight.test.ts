import 'fake-indexeddb/auto';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_KEY_B64 } from '../test/helpers';
import { EventQueue, type SendResult, type SignedBatch } from './event-queue';
import { importSessionKey } from './hmac';
import { IdbStore } from './idb';

/**
 * Same proof as stop-inflight for finish() (PR #47): finish() never drop a batch whose signing is still in flight (FR-601,
 * TC-065). crypto.subtle.sign is held on a deferred promise so the batch is genuinely mid-signing
 * when stop() or finish() is called.
 */
const KEY = Buffer.from(TEST_KEY_B64, 'base64');
const validSig = (b: SignedBatch): boolean =>
  createHmac('sha256', KEY).update(b.body).digest('hex') === b.signature;
const ev = (n: number) => ({
  type: 'TAB_SWITCH' as const,
  occurredAt: new Date(1_700_000_000_000 + n).toISOString(),
  durationMs: n,
  payload: {},
});
const eventsOf = (b: SignedBatch): number[] =>
  (JSON.parse(b.body) as { events: { durationMs: number }[] }).events.map((e) => e.durationMs);

let n = 0;
afterEach(() => vi.restoreAllMocks());

async function rig(outcome: SendResult) {
  const store = new IdbStore(indexedDB, `inflight-${++n}`);
  const sent: SignedBatch[] = [];
  const attempted: SignedBatch[] = [];
  const q = new EventQueue({
    sessionId: 's',
    key: await importSessionKey(TEST_KEY_B64),
    store,
    flushIntervalMs: 10,
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
  vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return realSign(...args);
  });
  return { q, store, sent, attempted, release, inSign };
}

describe.each([['finish', (q: EventQueue) => q.finish(500)]] as const)(
  'EventQueue.%s() with a batch mid-signing (FR-601, TC-065)',
  (name, end) => {
    it(`TC-065: ${name}() waits for the in-flight signature, then sends the batch with its original seq and a valid signature, and also cuts events not yet cut`, async () => {
      const r = await rig('OK');
      r.q.enqueue(ev(1));
      await r.inSign; // the flush timer cut a batch and signing is now blocked
      r.q.enqueue(ev(2)); // enqueued before stop(), not yet cut
      const ended = end(r.q);
      let settled = false;
      void ended.then(() => (settled = true));
      await new Promise((res) => setTimeout(res, 50));
      expect(settled).toBe(false); // stop/finish is waiting for the signature, not skipping it
      r.release();
      await ended;
      expect(r.sent.map((b) => b.seq)).toEqual([0, 1]);
      expect(r.sent.every(validSig)).toBe(true);
      expect(eventsOf(r.sent[0] as SignedBatch)).toEqual([1]);
      expect(eventsOf(r.sent[1] as SignedBatch)).toEqual([2]);
      expect(r.q.stats().pendingEvents).toBe(0);
    });
  },
);
