import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadQueue } from '../recording/upload-queue';
import type { MediaApi } from '../recording/types';
import { TEST_KEY_B64 } from '../test/helpers';
import { EventQueue, type SendResult, type SignedBatch } from './event-queue';
import { importSessionKey } from './hmac';
import { IdbStore } from './idb';
import { ProctorSession } from './session';

let n = 0;
const newStore = () => new IdbStore(indexedDB, `sf-${++n}`);
const ev = () => ({
  type: 'TAB_SWITCH' as const,
  occurredAt: new Date().toISOString(),
  payload: {},
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function queue(store: IdbStore, outcome: SendResult | (() => SendResult), over = {}) {
  const attempts: SignedBatch[] = [];
  const reasons: string[] = [];
  const q = new EventQueue({
    sessionId: 's',
    key: await importSessionKey(TEST_KEY_B64),
    store,
    jitter: 0,
    backoffBaseMs: 1000,
    transport: {
      sendBatch: (b) => {
        attempts.push(b);
        return Promise.resolve(typeof outcome === 'function' ? outcome() : outcome);
      },
    },
    onStorageDegraded: (r) => reasons.push(r),
    ...over,
  });
  return { q, attempts, reasons };
}

describe('EventQueue IndexedDB failures (S3, NFR-08, TC-063)', () => {
  it('NFR-08: a failing put does not kill the queue; batches are still sent from memory and the failure is flagged once', async () => {
    const store = newStore();
    vi.spyOn(store, 'put').mockRejectedValue(new Error('QuotaExceededError'));
    const { q, attempts, reasons } = await queue(store, 'OK');
    await q.start();
    q.enqueue(ev());
    await q.flush();
    q.enqueue(ev());
    await q.flush(); // the chain is not rejected, a second flush still works
    expect(attempts.map((b) => b.seq)).toEqual([0, 1]);
    expect(reasons).toEqual(['WRITE_FAILED']);
    expect(q.stats().storageDegraded).toBe(true);
  });

  it('NFR-08: if IndexedDB cannot be opened start() does not throw and events are still delivered', async () => {
    const store = newStore();
    vi.spyOn(store, 'entries').mockRejectedValue(new Error('open failed'));
    const { q, attempts, reasons } = await queue(store, 'OK');
    await q.start();
    q.enqueue(ev());
    await q.flush();
    expect(reasons).toEqual(['OPEN_FAILED']);
    expect(attempts).toHaveLength(1);
  });

  it('FR-609: ProctorSession.start succeeds without IndexedDB and raises an event-storage capability flag', async () => {
    const store = newStore();
    vi.spyOn(store, 'entries').mockRejectedValue(new Error('open failed'));
    const s = new ProctorSession();
    const caps: string[] = [];
    s.on('capability', (c) => caps.push(`${c.id}:${c.status}`));
    await s.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [],
      store,
    });
    expect(caps).toContain('event-storage:UNVERIFIABLE');
    await s.stop();
  });
});

describe('EventQueue.finish() drain (S2, NFR-08)', () => {
  it('NFR-08: during a 5xx outage finish() sends a handful of requests, not hundreds, and does not retry after it returned', async () => {
    const { q, attempts } = await queue(newStore(), 'RETRY');
    await q.start();
    q.enqueue(ev());
    const r = await q.finish(2500);
    expect(r.lostBatches).toBe(1);
    expect(attempts.length).toBeLessThanOrEqual(7); // about one per second, not one per 50 ms
    const after = attempts.length;
    await new Promise((res) => setTimeout(res, 1200));
    expect(attempts).toHaveLength(after); // no late retry re-armed after finish
  });

  it('NFR-08: a batch still being sent at the deadline that then acknowledges is not counted as lost', async () => {
    const store = newStore();
    let release!: (r: SendResult) => void;
    const q = new EventQueue({
      sessionId: 's',
      key: await importSessionKey(TEST_KEY_B64),
      store,
      transport: {
        sendBatch: () =>
          new Promise<SendResult>((r) => {
            release = r;
          }),
      },
    });
    await q.start();
    q.enqueue(ev());
    const finishing = q.finish(100);
    await new Promise((res) => setTimeout(res, 300)); // deadline passed, send in flight
    release('OK');
    const r = await finishing;
    expect(r.lostBatches).toBe(0);
  });

  it('FR-609: session.finish() warns the UI to stay online before discarding, then reports what was lost', async () => {
    const s = new ProctorSession();
    const caps: string[] = [];
    s.on('capability', (c) => caps.push(`${c.id}`));
    await s.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: {
        sendBatch: () => Promise.resolve('RETRY'),
        heartbeat: () => Promise.resolve(true),
      },
      detectors: [{ id: 'x', start: (ctx) => ctx.emit('RIGHT_CLICK', {}), stop: () => undefined }],
      store: newStore(),
      flushIntervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60)); // the batch is cut and cannot be sent
    const r = await s.finish(200);
    expect(r.lostBatches).toBe(1);
    expect(caps).toEqual(['finish-pending', 'finish-lost']);
  });
});

describe('ProctorSession start timeout (SF5)', () => {
  it('FR-609: a detector whose stop() hangs after a start timeout does not block the session start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = new ProctorSession();
    const started = s.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [
        {
          id: 'hang',
          start: () => new Promise<void>(() => undefined),
          stop: () => new Promise<void>(() => undefined),
        },
      ],
      store: newStore(),
      detectorStartTimeoutMs: 100,
    });
    // start timeout, then the 5 s stop bound; fake-indexeddb needs real ticks between steps
    for (let t = 0; t < 5400; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
    }
    await started;
    vi.useRealTimers();
    await s.stop();
  });
});

describe('UploadQueue storage recovery and memory counter (S6, FR-702)', () => {
  const api: MediaApi = {
    presign: () => Promise.resolve({ url: 'https://store.invalid/x' }),
    confirm: () => Promise.resolve(),
  };
  const chunk = (seq: number) => ({
    stream: 'WEBCAM' as const,
    segment: 0,
    seq,
    bytes: 10,
    contentType: 'video/webm',
  });

  it('FR-702: after a transient write failure the queue probes IndexedDB again and leaves memory-only mode', async () => {
    const store = newStore();
    const realPut = store.put.bind(store);
    let failed = false;
    const put = vi.spyOn(store, 'put').mockImplementation((name, key, value) => {
      if (name === 'chunks' && !failed) {
        failed = true;
        return Promise.reject(new Error('quota')); // one transient chunk write failure
      }
      return realPut(name, key, value);
    });
    const events: string[] = [];
    const q = new UploadQueue({
      sessionId: 's',
      api,
      store,
      concurrency: 0,
      storageProbeMs: 0,
      put: () => Promise.reject(new Error('offline')),
      onStorageDegraded: () => events.push('degraded'),
      onStorageRecovered: () => events.push('recovered'),
    });
    await q.start();
    await q.add(chunk(0), new ArrayBuffer(10)); // fails: memory only
    expect(q.health()).toMatchObject({ storageDegraded: true, memoryBytes: 10 });
    await q.add(chunk(1), new ArrayBuffer(10)); // probe succeeds
    expect(events).toEqual(['degraded', 'recovered']);
    expect(q.health().storageDegraded).toBe(false);
    expect(put).toHaveBeenCalled();
    expect(await store.keys('chunks', 's:')).toHaveLength(1); // only the second chunk is persisted
  });

  it('FR-702: the memory byte counter follows adds, uploads and purge without rescanning', async () => {
    const store = newStore();
    vi.spyOn(store, 'put').mockRejectedValue(new Error('down'));
    const q = new UploadQueue({
      sessionId: 's',
      api,
      store,
      concurrency: 0,
      put: () => Promise.reject(new Error('offline')),
    });
    await q.start();
    await q.add(chunk(0), new ArrayBuffer(10));
    await q.add(chunk(1), new ArrayBuffer(10));
    expect(q.health().memoryBytes).toBe(20);
    await q.purge();
    expect(q.health().memoryBytes).toBe(0);
  });
});
