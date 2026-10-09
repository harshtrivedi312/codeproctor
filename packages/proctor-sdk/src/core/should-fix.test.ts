import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadQueue } from '../recording/upload-queue';
import { MediaApiError, type MediaApi } from '../recording/types';
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
  localStorage.clear();
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

describe('EventQueue sequence safety after storage failures (B1, TC-065, NFR-08)', () => {
  it('TC-065 NFR-08: batches sent while IndexedDB writes failed are never reused as seq after a reload with IndexedDB working', async () => {
    const store = newStore();
    const realPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation((name, key, value) =>
      name === 'chunks' || name === 'meta' || name === 'eventBatches'
        ? Promise.reject(new Error('quota'))
        : realPut(name, key, value),
    );
    const first = await queue(store, 'OK');
    await first.q.start();
    for (let i = 0; i < 3; i++) {
      first.q.enqueue(ev());
      await first.q.flush();
    }
    expect(first.attempts.map((b) => b.seq)).toEqual([0, 1, 2]); // all acknowledged
    vi.restoreAllMocks(); // IndexedDB works again after the reload
    const second = await queue(store, 'OK');
    await second.q.start();
    second.q.enqueue(ev());
    await second.q.flush();
    expect(second.attempts.map((b) => b.seq)).toEqual([3]); // continues, no SEQ_CONFLICT
  });

  it('TC-065 NFR-08: an unreadable counter with no backup seeds the sequence high and raises a flag, never restarts at 0', async () => {
    const store = newStore();
    vi.spyOn(store, 'entries').mockRejectedValue(new Error('open failed'));
    vi.spyOn(store, 'get').mockRejectedValue(new Error('open failed'));
    const flags: string[] = [];
    const { q, attempts } = await queue(store, 'OK', { onSeqUntrusted: () => flags.push('seq') });
    await q.start();
    q.enqueue(ev());
    await q.flush();
    expect(flags).toEqual(['seq']);
    expect(attempts[0]?.seq).toBeGreaterThan(1_000_000);
    expect(attempts[0]?.seq).toBeLessThan(2_147_483_647);
  });

  it('TC-065 NFR-08: entries() works but the counter read throws: nextSeq is not left at 0 below saved batches', async () => {
    const store = newStore();
    await store.put('eventBatches', 's:0000000004', { seq: 4, body: '{}', signature: 'x' });
    vi.spyOn(store, 'get').mockRejectedValue(new Error('meta unreadable'));
    const { q } = await queue(store, 'RETRY');
    await q.start();
    q.enqueue(ev());
    await q.flush();
    expect(q.stats().nextSeq).toBeGreaterThan(5); // above the saved seq 4 (seeded: counter unknown)
  });

  it('NFR-08: the counter backup survives a reload where IndexedDB is unreadable', async () => {
    const store = newStore();
    const a = await queue(store, 'OK');
    await a.q.start();
    for (let i = 0; i < 2; i++) {
      a.q.enqueue(ev());
      await a.q.flush();
    }
    vi.spyOn(store, 'entries').mockRejectedValue(new Error('open failed'));
    vi.spyOn(store, 'get').mockRejectedValue(new Error('open failed'));
    const b = await queue(store, 'OK');
    await b.q.start();
    b.q.enqueue(ev());
    await b.q.flush();
    expect(b.attempts.map((x) => x.seq)).toEqual([2]); // from the backup, not 0 and not a jump
  });

  it('NFR-08: after a transient write failure the queue probes IndexedDB again and recovers', async () => {
    const store = newStore();
    const realPut = store.put.bind(store);
    let failed = false;
    vi.spyOn(store, 'put').mockImplementation((name, key, value) => {
      if (name === 'eventBatches' && !failed) {
        failed = true;
        return Promise.reject(new Error('quota'));
      }
      return realPut(name, key, value);
    });
    const events: string[] = [];
    const { q } = await queue(store, 'RETRY', {
      storageProbeMs: 0,
      onStorageDegraded: () => events.push('degraded'),
      onStorageRecovered: () => events.push('recovered'),
    });
    await q.start();
    q.enqueue(ev());
    await q.flush();
    q.enqueue(ev());
    await q.flush();
    expect(events).toEqual(['degraded', 'recovered']);
    expect(await store.keys('eventBatches', 's:')).toHaveLength(1); // the second batch persisted
  });
});

describe('sequence seed and backup hygiene (S-C, S-E, N1, TC-065)', () => {
  it('TC-065: with the device clock before 2026 the seed is still far above any earlier seq and below the schema limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-03-01T00:00:00Z'));
    const store = newStore();
    vi.spyOn(store, 'entries').mockRejectedValue(new Error('x'));
    vi.spyOn(store, 'get').mockRejectedValue(new Error('x'));
    const { q, attempts } = await queue(store, 'OK');
    await q.start();
    q.enqueue(ev());
    await q.flush();
    expect(attempts[0]?.seq).toBeGreaterThanOrEqual(10_000_000);
    expect(attempts[0]?.seq).toBeLessThan(2_147_483_647);
  });

  it('NFR-08: a corrupt, negative or oversized counter in IndexedDB or the backup is ignored, not trusted', async () => {
    const store = newStore();
    await store.put('meta', 's:nextEventSeq', 2 ** 40);
    localStorage.setItem('codeproctor:eventseq:s', JSON.stringify({ seq: -5, seenAt: Date.now() }));
    const flags: string[] = [];
    const { q } = await queue(store, 'OK', { onSeqUntrusted: () => flags.push('seq') });
    await q.start();
    expect(flags).toEqual(['seq']);
    expect(q.stats().nextSeq).toBeGreaterThanOrEqual(10_000_000);
  });

  it('NFR-08: the backup stores {seq, seenAt} and start() removes other sessions older than staleAfterMs but keeps fresh ones', async () => {
    const now = Date.now();
    localStorage.setItem(
      'codeproctor:eventseq:old',
      JSON.stringify({ seq: 3, seenAt: now - 3 * 86_400_000 }),
    );
    localStorage.setItem(
      'codeproctor:eventseq:fresh',
      JSON.stringify({ seq: 3, seenAt: now - 1000 }),
    );
    localStorage.setItem('codeproctor:eventseq:plain', '7');
    localStorage.setItem('unrelated', 'keep');
    const { q } = await queue(newStore(), 'OK');
    await q.start();
    q.enqueue(ev());
    await q.flush();
    expect(localStorage.getItem('codeproctor:eventseq:old')).toBeNull();
    expect(localStorage.getItem('codeproctor:eventseq:plain')).toBeNull(); // no age: not kept
    expect(localStorage.getItem('codeproctor:eventseq:fresh')).not.toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
    const mine = JSON.parse(localStorage.getItem('codeproctor:eventseq:s') ?? '{}') as {
      seq: number;
      seenAt: number;
    };
    expect(mine.seq).toBe(1);
    expect(mine.seenAt).toBeGreaterThanOrEqual(now);
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
    s.on('capability', (c) => c.id !== 'keystrokes' && caps.push(`${c.id}`));
    const sendBatch = vi.fn(() => Promise.resolve('RETRY' as const));
    await s.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: {
        sendBatch,
        heartbeat: () => Promise.resolve(true),
      },
      detectors: [{ id: 'x', start: (ctx) => ctx.emit('RIGHT_CLICK', {}), stop: () => undefined }],
      store: newStore(),
      flushIntervalMs: 10,
    });
    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalled()); // cut, signed, tried, refused
    const r = await s.finish(200);
    expect(r.lostBatches).toBe(1);
    expect(caps).toEqual(['finish-pending', 'finish-lost']);
  });
});

describe('ProctorSession start timeout (SF5, FR-609)', () => {
  it('FR-609: a detector that hangs in start() is abandoned after the timeout, stop() is called (bounded), the flag is emitted and it is not stopped again', async () => {
    const store = newStore();
    const s = new ProctorSession();
    const caps: string[] = [];
    s.on('capability', (c) => caps.push(`${c.id}:${c.status}`));
    let entered!: () => void;
    const inStart = new Promise<void>((r) => (entered = r));
    const stop = vi.fn(() => new Promise<void>(() => undefined)); // stop() hangs too
    const startPromise = s.start({
      sessionId: 's',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [
        {
          id: 'hang',
          start: () => {
            entered();
            return new Promise<void>(() => undefined);
          },
          stop,
        },
      ],
      store,
      detectorStartTimeoutMs: 50,
      detectorStopTimeoutMs: 50,
    });
    await inStart; // real WebCrypto and IndexedDB have finished: start() is now awaited
    await startPromise; // resolves after the 50 ms start timeout and the 50 ms stop bound
    expect(stop).toHaveBeenCalledTimes(1);
    expect(caps).toContain('hang:UNVERIFIABLE');
    await s.stop(); // the abandoned detector is no longer in the started list
    expect(stop).toHaveBeenCalledTimes(1);
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

  it('FR-702: the memory byte counter follows adds and purge (no upload runs here, concurrency 0)', async () => {
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

  it('FR-702: confirm and a FATAL answer both decrement the memory counter', async () => {
    const store = newStore();
    vi.spyOn(store, 'put').mockRejectedValue(new Error('down'));
    let fatal = false;
    const mixedApi: MediaApi = {
      presign: () =>
        fatal
          ? Promise.reject(new MediaApiError('FATAL', 'session ended'))
          : Promise.resolve({ url: 'https://store.invalid/x' }),
      confirm: () => Promise.resolve(),
    };
    const q = new UploadQueue({
      sessionId: 's',
      api: mixedApi,
      store,
      put: () => Promise.resolve(200),
    });
    await q.start();
    await q.add(chunk(0), new ArrayBuffer(10));
    await vi.waitFor(() => expect(q.health().chunksPending).toBe(0)); // uploaded and confirmed
    expect(q.health().memoryBytes).toBe(0);
    fatal = true;
    await q.add(chunk(1), new ArrayBuffer(10));
    await vi.waitFor(() => expect(q.health().droppedChunks).toBe(1)); // FATAL: dropped
    expect(q.health().memoryBytes).toBe(0);
    q.stop();
  });
});
