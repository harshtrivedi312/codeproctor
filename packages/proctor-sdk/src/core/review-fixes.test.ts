import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTouch } from './sweep';
import { chunkRef, okPresign } from '../test/media-helpers';
import { TEST_KEY_B64 } from '../test/helpers';
import { EventQueue, type SignedBatch } from './event-queue';
import { importSessionKey } from './hmac';
import { IdbStore } from './idb';
import { UploadQueue } from '../recording/upload-queue';
import { ProctorSession } from './session';
import { sweepStaleSessions } from './sweep';

let n = 0;
const newStore = () => new IdbStore(indexedDB, `rf-${++n}`);
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
  it('FR-702: finish() drains, then leaves no batches in IndexedDB (the seq counter is kept)', async () => {
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
    // The counter stays so a reloaded queue continues the sequence (see the next test).
    expect(await store.get('meta', 's:nextEventSeq')).toBe(1);
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

describe('review blockers (FR-702, FR-601, TC-065)', () => {
  it('TC-065: after finish() a new queue for the same session continues at the next seq, not 0', async () => {
    const store = newStore();
    const key = await importSessionKey(TEST_KEY_B64);
    const mk = (sent: SignedBatch[]) =>
      new EventQueue({
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
    const ev = { type: 'TAB_SWITCH' as const, occurredAt: new Date().toISOString(), payload: {} };
    const first: SignedBatch[] = [];
    const q1 = mk(first);
    await q1.start();
    q1.enqueue(ev);
    await q1.flush();
    q1.enqueue(ev);
    await q1.finish(500);
    expect(first.map((b) => b.seq)).toEqual([0, 1]);
    expect(await store.keys('eventBatches', 's:')).toEqual([]);
    const second: SignedBatch[] = [];
    const q2 = mk(second);
    await q2.start();
    q2.enqueue(ev);
    await q2.flush();
    expect(second.map((b) => b.seq)).toEqual([2]);
  });

  it('FR-702: a live session that is quiet for 23 h and then writes is not swept by another tab at T+25h', async () => {
    const store = newStore();
    const T = 1_000_000;
    await sweepStaleSessions(store, 'live', T, DAY); // marks 'live' at T
    await store.put('chunks', 'live:WEBCAM:0000000000:0000000000:5:x', {
      data: new ArrayBuffer(5),
    });
    await store.put('meta', 'live:nextEventSeq', 7);
    const touch = new SessionTouch(store, 'live');
    await touch.touch(T + 23 * 60 * 60 * 1000); // a chunk or batch was written
    const r = await sweepStaleSessions(store, 'tab2', T + 25 * 60 * 60 * 1000, DAY);
    expect(r.sessionsRemoved).toBe(0);
    expect(await store.keys('chunks', 'live:')).toHaveLength(1);
    expect(await store.get('meta', 'live:nextEventSeq')).toBe(7);
  });

  it('FR-702: without any write after T the same session is swept at T+25h (control)', async () => {
    const store = newStore();
    const T = 1_000_000;
    await sweepStaleSessions(store, 'dead', T, DAY);
    await store.put('chunks', 'dead:WEBCAM:0000000000:0000000000:5:x', {
      data: new ArrayBuffer(5),
    });
    const r = await sweepStaleSessions(store, 'tab2', T + 25 * 60 * 60 * 1000, DAY);
    expect(r.sessionsRemoved).toBe(1);
  });

  it('FR-702: SessionTouch is throttled to once a minute and swallows IndexedDB failures', async () => {
    const store = newStore();
    const put = vi.spyOn(store, 'put');
    const t = new SessionTouch(store, 's', 60_000);
    await t.touch(1000);
    await t.touch(30_000);
    await t.touch(61_001);
    expect(put).toHaveBeenCalledTimes(2);
    put.mockRejectedValue(new Error('idb down'));
    await expect(t.touch(200_000)).resolves.toBeUndefined();
  });

  it('FR-702: EventQueue cuts and UploadQueue add/confirm refresh the last-seen mark to the time of the write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T = 1_800_000_000_000;
    const MIN = 60_000;
    vi.setSystemTime(T);
    const store = newStore();
    const key = await importSessionKey(TEST_KEY_B64);
    const q = new EventQueue({
      sessionId: 'qq',
      key,
      store,
      transport: { sendBatch: () => Promise.resolve('OK') },
    });
    await q.start();
    expect(await store.get('meta', 'lastseen:qq')).toBe(T); // marked by the start-time sweep
    // The fake clock keeps ticking a little while IndexedDB works: allow a few seconds of drift.
    const near = (v: unknown, at: number) => typeof v === 'number' && v >= at && v < at + 5000;
    vi.setSystemTime(T + 2 * MIN);
    q.enqueue({ type: 'TAB_SWITCH', occurredAt: new Date().toISOString(), payload: {} });
    await q.flush();
    await vi.waitFor(async () =>
      expect(near(await store.get('meta', 'lastseen:qq'), T + 2 * MIN)).toBe(true),
    );

    const uq = new UploadQueue({
      sessionId: 'uu',
      store,
      put: () => Promise.resolve(200),
      api: {
        presign: () => Promise.resolve(okPresign('https://store.invalid/x')),
        confirm: () => Promise.resolve(),
      },
    });
    await uq.start();
    expect(near(await store.get('meta', 'lastseen:uu'), T + 2 * MIN)).toBe(true);
    vi.setSystemTime(T + 4 * MIN);
    await uq.add(chunkRef(0, 5, 'WEBCAM'), new ArrayBuffer(5));
    await vi.waitFor(async () =>
      expect(near(await store.get('meta', 'lastseen:uu'), T + 4 * MIN)).toBe(true),
    );
    vi.setSystemTime(T + 6 * MIN);
    await vi.waitFor(() => expect(uq.health().chunksPending).toBe(0)); // upload and confirm done
    vi.setSystemTime(T + 6 * MIN);
    uq.stop();
  });

  it('FR-609: a detector that finishes starting after the timeout stays silent and was stopped', async () => {
    const store = newStore();
    const root = document.createElement('div');
    const session = new ProctorSession();
    const seen: string[] = [];
    session.on('event', (e) => seen.push(e.type));
    session.on('capability', (c) => c.id !== 'keystrokes' && seen.push(`cap:${c.id}:${c.status}`));
    let finishLate!: () => void;
    const stop = vi.fn();
    await session.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root,
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [
        {
          id: 'slow',
          accommodationId: 'DEVTOOLS',
          start: (ctx) =>
            new Promise<void>((resolve) => {
              finishLate = () => {
                ctx.setCapability({ id: 'slow', status: 'SUPPORTED' });
                ctx.emit('DEVTOOLS_OPEN', { heuristic: 'WINDOW_SIZE' });
                resolve();
              };
            }),
          stop,
        },
      ],
      store,
      detectorStartTimeoutMs: 30,
    });
    const afterTimeout = ['cap:slow:UNVERIFIABLE', 'DETECTOR_UNAVAILABLE'];
    expect(seen).toEqual(afterTimeout);
    expect(stop).toHaveBeenCalledTimes(1);
    finishLate();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(afterTimeout); // nothing after the timeout was reported
    await session.stop();
    expect(stop).toHaveBeenCalledTimes(1); // removed from the started list, not stopped twice
  });

  it('FR-609: a timed-out detector without an accommodation id leaves an UNVERIFIABLE capability flag', async () => {
    const store = newStore();
    const session = new ProctorSession();
    const caps: string[] = [];
    session.on('capability', (c) => c.id !== 'keystrokes' && caps.push(`${c.id}:${c.status}`));
    await session.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [
        { id: 'plug', start: () => new Promise<void>(() => undefined), stop: () => undefined },
      ],
      store,
      detectorStartTimeoutMs: 20,
    });
    expect(caps).toEqual(['plug:UNVERIFIABLE']);
    await session.stop();
  });
});
