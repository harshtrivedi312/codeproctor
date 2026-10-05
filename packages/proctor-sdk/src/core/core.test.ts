import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './canonical';
import { EventQueue, type SendResult, type SignedBatch } from './event-queue';
import { importSessionKey, signHex } from './hmac';
import { IdbStore } from './idb';
import { TEST_KEY_B64 } from '../test/helpers';

const ev = (n = 0) => ({
  type: 'TAB_SWITCH' as const,
  occurredAt: new Date(1_700_000_000_000 + n).toISOString(),
  durationMs: n,
  payload: {},
});

describe('canonicalJson (FR-601 pipeline, ARC-03 assumption)', () => {
  it('FR-801: sorts keys, drops undefined and is stable', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('FR-801: refuses non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe('HMAC signing', () => {
  it('TC-065: a modified payload no longer matches its signature', async () => {
    const key = await importSessionKey(TEST_KEY_B64);
    const body = canonicalJson({ seq: 1, events: [ev(1)] });
    const sig = await signHex(key, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const tampered = canonicalJson({ seq: 1, events: [ev(2)] });
    expect(await signHex(key, tampered)).not.toBe(sig);
    expect(await signHex(key, body)).toBe(sig);
  });
});

describe('EventQueue (FR-609, TC-063, TC-065, NFR-08)', () => {
  let store: IdbStore;
  let sent: SignedBatch[];
  let outcome: SendResult;
  let n = 0;

  const makeQueue = async (over: { flushIntervalMs?: number } = {}) => {
    const key = await importSessionKey(TEST_KEY_B64);
    const q = new EventQueue({
      sessionId: 's1',
      key,
      store,
      jitter: 0,
      backoffBaseMs: 1000,
      ...over,
      transport: {
        sendBatch: (b) => {
          if (outcome === 'OK') sent.push(b);
          return Promise.resolve(outcome);
        },
      },
    });
    await q.start();
    return q;
  };

  beforeEach(() => {
    n++;
    store = new IdbStore(indexedDB, `test-${n}`);
    sent = [];
    outcome = 'OK';
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('FR-801: cuts a batch at 100 events with a valid signature', async () => {
    const q = await makeQueue();
    for (let i = 0; i < 100; i++) q.enqueue(ev(i));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [b] = sent;
    const parsed = JSON.parse(b!.body) as { seq: number; events: unknown[] };
    expect(parsed.events).toHaveLength(100);
    const key = await importSessionKey(TEST_KEY_B64);
    expect(await signHex(key, b!.body)).toBe(b!.signature);
  });

  it('FR-801: flushes after 5 s with fewer than 100 events', async () => {
    const q = await makeQueue();
    q.enqueue(ev());
    await vi.advanceTimersByTimeAsync(4900);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('FR-801: sequence is monotonic across batches', async () => {
    const q = await makeQueue();
    for (let i = 0; i < 250; i++) q.enqueue(ev(i));
    await q.flush();
    expect(sent.map((b) => b.seq)).toEqual([0, 1, 2]);
  });

  it('TC-065: server-only event types and bad payloads never reach a batch', async () => {
    const q = await makeQueue();
    expect(q.enqueue({ ...ev(), type: 'PASTE_BURST', payload: {} })).toBe(false);
    expect(q.enqueue({ ...ev(), type: 'SHORTCUT_BLOCKED', payload: { shortcut: 'a b' } })).toBe(
      false,
    );
    expect(q.stats().droppedInvalidEvents).toBe(2);
    await q.flush();
    expect(sent).toHaveLength(0);
  });

  it('TC-063: a 60 s outage loses no batches and sends them in order afterwards', async () => {
    outcome = 'RETRY';
    const q = await makeQueue();
    for (let i = 0; i < 3; i++) {
      q.enqueue(ev(i));
      await q.flush();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(0);
    expect(q.stats().unsentBatches).toBe(3);
    outcome = 'OK';
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(sent.map((b) => b.seq)).toEqual([0, 1, 2]));
    expect(q.stats().unsentBatches).toBe(0);
    expect(await store.entries('eventBatches', 's1:')).toHaveLength(0);
  });

  it('FR-702/NFR-08: backoff doubles up to the cap', async () => {
    outcome = 'RETRY';
    const calls: number[] = [];
    const key = await importSessionKey(TEST_KEY_B64);
    const q = new EventQueue({
      sessionId: 's1',
      key,
      store,
      jitter: 0,
      backoffBaseMs: 1000,
      backoffMaxMs: 4000,
      transport: {
        sendBatch: () => {
          calls.push(Date.now());
          return Promise.resolve('RETRY');
        },
      },
    });
    await q.start();
    q.enqueue(ev());
    await q.flush();
    await vi.advanceTimersByTimeAsync(20_000);
    const gaps = calls.slice(1).map((t, i) => t - (calls[i] as number));
    expect(gaps.slice(0, 4)).toEqual([1000, 2000, 4000, 4000]);
  });

  it('TC-063: unsent batches survive a page reload and the sequence continues', async () => {
    outcome = 'RETRY';
    const q1 = await makeQueue();
    q1.enqueue(ev(1));
    await q1.flush();
    expect(q1.stats().unsentBatches).toBe(1);
    // "reload": new queue, same IndexedDB
    outcome = 'OK';
    const q2 = await makeQueue();
    await vi.waitFor(() => expect(sent.map((b) => b.seq)).toEqual([0]));
    q2.enqueue(ev(2));
    await q2.flush();
    expect(sent.map((b) => b.seq)).toEqual([0, 1]);
  });

  it('FR-609: a rejected batch is dropped so it cannot block later batches', async () => {
    outcome = 'REJECTED';
    const q = await makeQueue();
    q.enqueue(ev());
    await q.flush();
    expect(q.stats()).toMatchObject({ rejectedBatches: 1, unsentBatches: 0 });
  });
});
