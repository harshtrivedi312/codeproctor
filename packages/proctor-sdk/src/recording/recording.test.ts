import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdbStore } from '../core/idb';
import { ConsentRequiredError } from '../core/types';
import { RecordingPipeline } from './pipeline';
import { ChunkRecorder, PROFILES, type MediaRecorderLike } from './recorder';
import { chunkKey, parseChunkKey, UploadQueue } from './upload-queue';
import { MediaApiError, type ChunkRef, type MediaApi } from './types';
import { chunkRef, okPresign } from '../test/media-helpers';

let n = 0;
const newStore = () => new IdbStore(indexedDB, `rec-${++n}`);
/** Advance fake time while letting fake-indexeddb (which uses real setImmediate) make progress. */
async function run(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step);
    for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
  }
}
const bytes = (size: number) => new Uint8Array(size).buffer;
const ref = chunkRef;

function fakeApi() {
  const calls = { presign: 0, confirm: [] as number[] };
  const api: MediaApi = {
    presign: () => {
      calls.presign++;
      return Promise.resolve(okPresign());
    },
    confirm: (c) => {
      calls.confirm.push(c.seq);
      return Promise.resolve();
    },
  };
  return { api, calls };
}

describe('chunk keys (FR-701)', () => {
  it('FR-701: round-trips and sorts by stream, segment, seq', () => {
    const c = ref(12, 345, 'WEBCAM', 3);
    expect(parseChunkKey(chunkKey('sess', c))).toEqual(c);
    expect(parseChunkKey(chunkKey('sess', ref(1, 5, 'AUDIO', 2, { first: true })))).toMatchObject({
      contentType: 'audio/webm',
      first: true,
    });
    expect(chunkKey('s', ref(2)) < chunkKey('s', ref(10))).toBe(true);
  });
});

describe('UploadQueue (FR-701, FR-702, TC-063, NFR-08)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('FR-701: presign, PUT, confirm, then the chunk leaves IndexedDB', async () => {
    const store = newStore();
    const { api, calls } = fakeApi();
    const put = vi.fn(() => Promise.resolve(200));
    const q = new UploadQueue({ sessionId: 's', api, store, put, jitter: 0 });
    await q.start();
    await q.add(ref(0), bytes(100));
    await run(100);
    expect(put).toHaveBeenCalledTimes(1);
    expect(calls.confirm).toEqual([0]);
    expect(q.health()).toMatchObject({ bytesPending: 0, chunksPending: 0, degraded: false });
    expect(q.health().lastSuccessfulUploadAt).not.toBeNull();
    expect(await store.keys('chunks', 's:')).toHaveLength(0);
  });

  it('FR-701: never runs more than 2 uploads at once', async () => {
    const store = newStore();
    const { api } = fakeApi();
    let active = 0;
    let peak = 0;
    const put = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 50));
      active--;
      return 200;
    });
    const q = new UploadQueue({ sessionId: 's', api, store, put, jitter: 0 });
    await q.start();
    for (let i = 0; i < 6; i++) await q.add(ref(i), bytes(10));
    await run(1000);
    expect(put).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it('TC-063: a 60 s outage loses no chunks; every one is uploaded afterwards with a fresh presign', async () => {
    const store = newStore();
    const { api, calls } = fakeApi();
    let online = false;
    const uploaded: number[] = [];
    let seqOf = 0;
    const put = vi.fn(() => {
      if (!online) return Promise.reject(new Error('offline'));
      uploaded.push(seqOf++);
      return Promise.resolve(200);
    });
    const q = new UploadQueue({ sessionId: 's', api, store, put, jitter: 0, backoffBaseMs: 1000 });
    await q.start();
    for (let i = 0; i < 6; i++) await q.add(ref(i, 1000), bytes(1000));
    await run(60_000);
    expect(uploaded).toHaveLength(0);
    expect(q.health()).toMatchObject({ chunksPending: 6, degraded: true, bytesPending: 6000 });
    expect(await store.keys('chunks', 's:')).toHaveLength(6);
    const presignsBefore = calls.presign;
    online = true;
    await run(31_000);
    expect(uploaded).toHaveLength(6);
    expect(calls.confirm.sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(calls.presign).toBeGreaterThan(presignsBefore);
    expect(q.health().chunksPending).toBe(0);
  });

  it('FR-702: chunks buffered in IndexedDB are uploaded after a reload', async () => {
    const store = newStore();
    const { api, calls } = fakeApi();
    const failing = new UploadQueue({
      sessionId: 's',
      api,
      store,
      put: () => Promise.reject(new Error('offline')),
    });
    await failing.start();
    await failing.add(ref(0, 50), bytes(50));
    await failing.add(ref(1, 50), bytes(50));
    await run(100);
    failing.stop();
    // reload
    const fresh = new UploadQueue({ sessionId: 's', api, store, put: () => Promise.resolve(200) });
    await fresh.start();
    expect(fresh.health().chunksPending).toBe(2);
    await run(100);
    expect(calls.confirm.sort()).toEqual([0, 1]);
    expect(fresh.maxSegment('SCREEN')).toBe(-1);
  });

  it('FR-702: the buffer is capped; the oldest waiting chunks are dropped and counted', async () => {
    const store = newStore();
    const { api } = fakeApi();
    const q = new UploadQueue({
      sessionId: 's',
      api,
      store,
      maxBufferBytes: 1000,
      put: () => Promise.reject(new Error('offline')),
      concurrency: 0,
    });
    await q.start();
    for (let i = 0; i < 5; i++) await q.add(ref(i, 400), bytes(400));
    const h = q.health();
    expect(h.bytesPending).toBeLessThanOrEqual(1000);
    expect(h.chunksPending).toBe(2);
    expect(h.droppedChunks).toBe(3);
    expect(h.droppedBytes).toBe(1200);
    const keys = (await store.keys('chunks', 's:')).map((k) => parseChunkKey(k)?.seq);
    expect(keys).toEqual([3, 4]);
  });

  it('FR-702: a fatal server answer drops the chunk instead of retrying forever', async () => {
    const store = newStore();
    const api: MediaApi = {
      presign: () => Promise.reject(new MediaApiError('FATAL', 'session ended')),
      confirm: () => Promise.resolve(),
    };
    const q = new UploadQueue({ sessionId: 's', api, store, put: () => Promise.resolve(200) });
    await q.start();
    await q.add(ref(0), bytes(10));
    await run(100);
    expect(q.health()).toMatchObject({ chunksPending: 0, droppedChunks: 1 });
  });

  it('FR-702: a PUT that returns 403 (expired URL) is retried with a new presign', async () => {
    const store = newStore();
    const { api, calls } = fakeApi();
    const statuses = [403, 200];
    const q = new UploadQueue({
      sessionId: 's',
      api,
      store,
      jitter: 0,
      backoffBaseMs: 1000,
      put: () => Promise.resolve(statuses.shift() ?? 200),
    });
    await q.start();
    await q.add(ref(0), bytes(10));
    await run(1500);
    expect(calls.presign).toBe(2);
    expect(calls.confirm).toEqual([0]);
  });
});

class FakeRecorder implements MediaRecorderLike {
  state = 'inactive';
  ondataavailable: MediaRecorderLike['ondataavailable'] = null;
  onstop: MediaRecorderLike['onstop'] = null;
  onerror: MediaRecorderLike['onerror'] = null;
  timeslice: number | undefined;
  start(t?: number) {
    this.state = 'recording';
    this.timeslice = t;
  }
  stop() {
    this.state = 'inactive';
    this.emit(3);
    this.onstop?.();
  }
  emit(size: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) });
  }
}

describe('ChunkRecorder (FR-701)', () => {
  it('FR-701: asks for 10 s chunks, numbers them and flushes the last one on stop', async () => {
    const rec = new FakeRecorder();
    const factory = vi.fn(() => rec);
    const got: ChunkRef[] = [];
    const r = new ChunkRecorder(
      'WEBCAM',
      2,
      (c) => {
        got.push(c);
        return Promise.resolve();
      },
      factory,
    );
    r.start({} as MediaStream);
    expect(rec.timeslice).toBe(10_000);
    expect(factory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 250_000 }),
    );
    rec.emit(10);
    rec.emit(20);
    await r.stop();
    expect(got.map((c) => [c.stream, c.segment, c.seq, c.bytes])).toEqual([
      ['WEBCAM', 2, 0, 10],
      ['WEBCAM', 2, 1, 20],
      ['WEBCAM', 2, 2, 3],
    ]);
  });

  it('FR-701: audio uses Opus at a low bitrate', () => {
    expect(PROFILES.AUDIO).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 32_000,
    });
    expect(PROFILES.SCREEN.videoBitsPerSecond).toBeLessThanOrEqual(500_000);
  });
});

describe('RecordingPipeline', () => {
  const make = (over: Partial<ConstructorParameters<typeof RecordingPipeline>[0]> = {}) => {
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream),
    );
    const { api } = fakeApi();
    const recs: FakeRecorder[] = [];
    const caps: string[] = [];
    const p = new RecordingPipeline({
      sessionId: 's',
      api,
      assertConsent: () => undefined,
      store: newStore(),
      mediaDevices: { getUserMedia },
      recorderFactory: () => {
        const r = new FakeRecorder();
        recs.push(r);
        return r;
      },
      isTypeSupported: () => true,
      put: () => Promise.resolve(200),
      onCapability: (f) => caps.push(`${f.id}:${f.status}`),
      ...over,
    });
    return { p, getUserMedia, recs, caps };
  };

  it('D-17: no camera or microphone request before consent', async () => {
    const { p, getUserMedia } = make({
      assertConsent: () => {
        throw new ConsentRequiredError();
      },
    });
    await expect(p.recordWebcam()).rejects.toBeInstanceOf(ConsentRequiredError);
    await expect(p.recordAudio()).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('FR-701: records webcam at 640x360 and audio as separate streams', async () => {
    const { p, getUserMedia, recs } = make();
    await p.recordWebcam();
    await p.recordAudio();
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: expect.objectContaining({ width: { ideal: 640 }, height: { ideal: 360 } }) as unknown,
      audio: false,
    });
    expect(recs).toHaveLength(2);
    await p.stop();
  });

  it('FR-701: an unsupported codec gives a capability flag, not a silent skip', async () => {
    const { p, caps, getUserMedia } = make({ isTypeSupported: () => false });
    expect(await p.recordWebcam()).toBeNull();
    expect(caps).toEqual(['record-webcam:UNSUPPORTED']);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('FR-701: a denied camera is reported as DENIED', async () => {
    const { p, caps } = make({
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('no')) },
    });
    expect(await p.recordWebcam()).toBeNull();
    expect(caps).toEqual(['record-webcam:DENIED']);
  });

  it('FR-701/ADR 0004: a restart of a stream opens a new segment', async () => {
    const { p } = make();
    const stream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    const segs: number[] = [];
    const spy = vi.spyOn(UploadQueue.prototype, 'add').mockImplementation((c) => {
      segs.push(c.segment);
      return Promise.resolve();
    });
    await p.recordScreen(stream);
    await p.stopStream('SCREEN');
    await p.recordScreen(stream);
    await p.stop();
    expect(segs).toEqual([0, 1]);
    spy.mockRestore();
  });

  it('FR-702/TC-063: finish() leaves IndexedDB empty and reports undelivered chunks as dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = newStore();
    const { p } = make({
      store,
      put: () => Promise.reject(new Error('offline')),
      backoffBaseMs: 1000,
    });
    const stream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    await p.recordScreen(stream);
    const q = (p as unknown as { queue: UploadQueue }).queue;
    await q.add(ref(0, 500), bytes(500));
    await q.add(ref(1, 500), bytes(500));
    const done = p.finish({ drainTimeoutMs: 2000 });
    await run(3000);
    const h = await done;
    expect(h.droppedChunks).toBeGreaterThanOrEqual(2);
    expect(h.droppedBytes).toBeGreaterThanOrEqual(1000);
    expect(h.chunksPending).toBe(0);
    expect(await store.keys('chunks', 's:')).toHaveLength(0);
    // only the small per-stream counters stay, so a new load continues the seq and segment numbers
    expect(await store.keys('meta', 's:')).toEqual(['s:media:SCREEN']);
    vi.useRealTimers();
  });

  it('FR-702: finish() with a working network uploads everything and drops nothing', async () => {
    const store = newStore();
    const { p } = make({ store });
    const stream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    await p.recordScreen(stream);
    const q = (p as unknown as { queue: UploadQueue }).queue;
    await q.add(ref(0, 100), bytes(100));
    const h = await p.finish({ drainTimeoutMs: 5000 });
    expect(h.droppedChunks).toBe(0);
    expect(await store.keys('chunks', 's:')).toHaveLength(0);
  });

  it('FR-702: when IndexedDB writes fail, chunks still upload from memory and the failure is flagged', async () => {
    const store = newStore();
    vi.spyOn(store, 'put').mockRejectedValue(new Error('QuotaExceededError'));
    const caps: string[] = [];
    const { api, calls } = fakeApi();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const q = new UploadQueue({
      sessionId: 's',
      api,
      store,
      put: () => Promise.resolve(200),
      onStorageDegraded: (r) => caps.push(r),
    });
    await q.start();
    await q.add(ref(0, 100), bytes(100));
    expect(q.health()).toMatchObject({ storageDegraded: true, memoryBytes: 100, degraded: true });
    await run(300);
    expect(calls.confirm).toEqual([0]);
    expect(q.health()).toMatchObject({ chunksPending: 0, memoryBytes: 0, droppedChunks: 0 });
    expect(caps).toEqual(['WRITE_FAILED']);
    vi.useRealTimers();
  });

  it('FR-702: past the memory cap with IndexedDB down, chunks are counted as dropped, never silent', async () => {
    const store = newStore();
    vi.spyOn(store, 'put').mockRejectedValue(new Error('down'));
    const { api } = fakeApi();
    const q = new UploadQueue({
      sessionId: 's',
      api,
      store,
      maxMemoryBytes: 250,
      concurrency: 0,
      put: () => Promise.reject(new Error('offline')),
    });
    await q.start();
    for (let i = 0; i < 4; i++) await q.add(ref(i, 100), bytes(100));
    expect(q.health()).toMatchObject({ chunksPending: 2, droppedChunks: 2, droppedBytes: 200 });
  });

  it('FR-702: if IndexedDB cannot be opened the queue starts in memory-only mode and says so', async () => {
    const store = newStore();
    vi.spyOn(store, 'keys').mockRejectedValue(new Error('open failed'));
    const reasons: string[] = [];
    const { api } = fakeApi();
    const q = new UploadQueue({
      sessionId: 's',
      api,
      store,
      put: () => Promise.resolve(200),
      onStorageDegraded: (r) => reasons.push(r),
    });
    await q.start();
    expect(reasons).toEqual(['OPEN_FAILED']);
    expect(q.health().storageDegraded).toBe(true);
  });

  it('FR-702: start() sweeps other sessions older than the retention window', async () => {
    const store = newStore();
    await store.put('chunks', 'other:WEBCAM:0000000000:0000000000:5:x', { data: bytes(5) });
    await store.put('meta', 'lastseen:other', Date.now() - 3 * 24 * 60 * 60 * 1000);
    const { api } = fakeApi();
    const q = new UploadQueue({ sessionId: 's', api, store, put: () => Promise.resolve(200) });
    await q.start();
    expect(await store.keys('chunks', 'other:')).toEqual([]);
  });

  it('FR-701: a webcam track that ends is flushed, reported as device lost, and restart opens a new segment', async () => {
    const ended: Array<() => void> = [];
    const track = {
      addEventListener: (_n: string, f: () => void) => ended.push(f),
      stop: vi.fn(),
    };
    const media = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const lost: unknown[] = [];
    const caps: string[] = [];
    const segs: number[] = [];
    const spy = vi.spyOn(UploadQueue.prototype, 'add').mockImplementation((c) => {
      segs.push(c.segment);
      return Promise.resolve();
    });
    const { p } = make({
      mediaDevices: { getUserMedia: () => Promise.resolve(media) },
      onDeviceLost: (l) => lost.push(l),
      onCapability: (f) => caps.push(`${f.id}:${f.status}`),
    });
    await p.recordWebcam();
    ended[0]?.();
    await vi.waitFor(() => expect(lost).toEqual([{ stream: 'WEBCAM', reason: 'TRACK_ENDED' }]));
    expect(caps).toContain('record-webcam:UNVERIFIABLE');
    await p.recordWebcam();
    await p.stop();
    expect(segs).toEqual([0, 1]);
    spy.mockRestore();
  });

  it('FR-701: a MediaRecorder error is surfaced as device lost, not swallowed', async () => {
    const lost: unknown[] = [];
    const recs: FakeRecorder[] = [];
    const { p } = make({
      onDeviceLost: (l) => lost.push(l),
      recorderFactory: () => {
        const r = new FakeRecorder();
        recs.push(r);
        return r;
      },
    });
    await p.recordWebcam();
    recs[0]?.onerror?.();
    await vi.waitFor(() => expect(lost).toEqual([{ stream: 'WEBCAM', reason: 'RECORDER_ERROR' }]));
  });
});

describe('pipeline with a broken IndexedDB (FR-701, FR-702)', () => {
  it('FR-702: when every store call rejects, recording still starts, segments come from memory and chunks upload from memory', async () => {
    const store = newStore();
    for (const m of ['get', 'put', 'keys', 'delete', 'deletePrefix', 'entries'] as const) {
      vi.spyOn(store, m).mockRejectedValue(new Error('idb broken'));
    }
    const confirmed: string[] = [];
    const api: MediaApi = {
      presign: () => Promise.resolve(okPresign()),
      confirm: (c) => {
        confirmed.push(`${c.stream}:${c.segment}:${c.seq}`);
        return Promise.resolve();
      },
    };
    const caps: string[] = [];
    const p = new RecordingPipeline({
      sessionId: 's',
      api,
      assertConsent: () => undefined,
      store,
      mediaDevices: {
        getUserMedia: () =>
          Promise.resolve({
            getTracks: () => [],
            getVideoTracks: () => [],
          } as unknown as MediaStream),
      },
      recorderFactory: () => new FakeRecorder(),
      isTypeSupported: () => true,
      put: () => Promise.resolve(200),
      onCapability: (f) => caps.push(`${f.id}:${f.status}`),
    });
    await p.recordWebcam();
    await p.recordWebcam(); // restart: the previous recorder flushes its chunk, new segment
    const h = await p.finish({ drainTimeoutMs: 3000 });
    expect(confirmed.sort()).toEqual(['WEBCAM:0:0', 'WEBCAM:1:1']); // seq continues across segments
    expect(caps).toContain('recording-storage:UNSUPPORTED');
    expect(h.droppedChunks).toBe(0);
  });
});
