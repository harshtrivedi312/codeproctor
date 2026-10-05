import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_KEY_B64 } from '../test/helpers';
import { EventQueue, type SignedBatch } from './event-queue';
import { importSessionKey } from './hmac';
import { IdbStore } from './idb';
import { ProctorSession } from './session';
import { sweepStaleSessions } from './sweep';

let n = 0;
const newStore = () => new IdbStore(indexedDB, `rf-${++n}`);
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => vi.useRealTimers());

describe('stale session sweep (FR-702)', () => {
  it('FR-702: deletes chunks, batches and meta of other sessions last seen over 24 h ago', async () => {
    const store = newStore();
    await store.put('chunks', 'old:WEBCAM:0000000000:0000000000:5:x', { data: new ArrayBuffer(5) });
    await store.put('eventBatches', 'old:0000000000', { seq: 0 });
    await store.put('meta', 'old:segment:WEBCAM', 3);
    await store.put('meta', 'lastseen:old', 1000);
    const r = await sweepStaleSessions(store, 'now', 1000 + DAY + 1, DAY);
    expect(r.sessionsRemoved).toBe(1);
    expect(await store.keys('chunks', 'old:')).toEqual([]);
    expect(await store.keys('eventBatches', 'old:')).toEqual([]);
    expect(await store.keys('meta', 'old:')).toEqual([]);
    expect(await store.get('meta', 'lastseen:old')).toBeUndefined();
  });

  it('FR-702: keeps recent sessions, never touches the current one, and gives unmarked data a grace period', async () => {
    const store = newStore();
    await store.put('chunks', 'recent:WEBCAM:0:0:5:x', { data: new ArrayBuffer(5) });
    await store.put('meta', 'lastseen:recent', 5000);
    await store.put('chunks', 'cur:WEBCAM:0:0:5:x', { data: new ArrayBuffer(5) });
    await store.put('chunks', 'legacy:WEBCAM:0:0:5:x', { data: new ArrayBuffer(5) });
    const r = await sweepStaleSessions(store, 'cur', 5000 + DAY - 1, DAY);
    expect(r.sessionsRemoved).toBe(0);
    expect(await store.keys('chunks', 'recent:')).toHaveLength(1);
    expect(await store.keys('chunks', 'cur:')).toHaveLength(1);
    expect(await store.keys('chunks', 'legacy:')).toHaveLength(1);
    expect(await store.get('meta', 'lastseen:legacy')).toBe(5000 + DAY - 1);
  });

  it('FR-702: a failing store never throws out of the sweep', async () => {
    const store = newStore();
    vi.spyOn(store, 'keys').mockRejectedValue(new Error('idb down'));
    await expect(sweepStaleSessions(store, 'x')).resolves.toEqual({ sessionsRemoved: 0 });
  });
});

describe('EventQueue.finish and ProctorSession.finish (FR-702, TC-063)', () => {
  it('FR-702: finish() drains, then leaves no batches or counter in IndexedDB', async () => {
    const store = newStore();
    const key = await importSessionKey(TEST_KEY_B64);
    const sent: SignedBatch[] = [];
    const q = new EventQueue({
      sessionId: 's',
      key,
      store,
      transport: {
        sendBatch: (b) => {
          sent.push(b);
          return Promise.resolve('OK');
        },
      },
    });
    await q.start();
    q.enqueue({ type: 'TAB_SWITCH', occurredAt: new Date().toISOString(), payload: {} });
    const r = await q.finish(1000);
    expect(r.lostBatches).toBe(0);
    expect(sent).toHaveLength(1);
    expect(await store.keys('eventBatches', 's:')).toEqual([]);
    expect(await store.keys('meta', 's:')).toEqual([]);
  });

  it('FR-702/TC-063: batches that could not be sent are counted as lost and still purged', async () => {
    const store = newStore();
    const key = await importSessionKey(TEST_KEY_B64);
    const q = new EventQueue({
      sessionId: 's',
      key,
      store,
      jitter: 0,
      transport: { sendBatch: () => Promise.resolve('RETRY') },
    });
    await q.start();
    q.enqueue({ type: 'TAB_SWITCH', occurredAt: new Date().toISOString(), payload: {} });
    const r = await q.finish(200);
    expect(r.lostBatches).toBe(1);
    expect(await store.keys('eventBatches', 's:')).toEqual([]);
  });

  it('FR-609: a detector whose start() hangs is abandoned after the timeout and reported', async () => {
    const store = newStore();
    const root = document.createElement('div');
    const session = new ProctorSession();
    const seen: string[] = [];
    session.on('event', (e) => seen.push(`${e.type}`));
    await session.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root,
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [
        {
          id: 'hang',
          accommodationId: 'DEVTOOLS',
          start: () => new Promise<void>(() => undefined),
          stop: () => undefined,
        },
      ],
      store,
      detectorStartTimeoutMs: 50,
    });
    expect(seen).toEqual(['DETECTOR_UNAVAILABLE']);
    await session.stop();
  });

  it('FR-702: session.finish() flushes and purges the session store', async () => {
    const store = newStore();
    const root = document.createElement('div');
    const session = new ProctorSession();
    await session.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root,
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [
        {
          id: 'x',
          start: (ctx) => ctx.emit('RIGHT_CLICK', {}),
          stop: () => undefined,
        },
      ],
      store,
    });
    const r = await session.finish(500);
    expect(r.lostBatches).toBe(0);
    expect(await store.keys('eventBatches', 's:')).toEqual([]);
  });
});
