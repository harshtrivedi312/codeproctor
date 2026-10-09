import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdbStore } from '../core/idb';
import { chunkRef, okPresign } from '../test/media-helpers';
import { createFetchMediaApi } from './media-api';
import { RecordingPipeline } from './pipeline';
import type { MediaRecorderLike } from './recorder';
import { UploadQueue, type UploadQueueOptions } from './upload-queue';
import {
  MediaApiError,
  type ChunkRef,
  type MediaApi,
  type MediaApiErrorKind,
  type PresignResult,
} from './types';

/**
 * Media alignment with ADR 0013 5.5 as built (FR-701, FR-702, TC-063, TC-070): bare content types,
 * startedAt/durationMs, seq unique per stream across segments, lazy and reused presigns, code based
 * error handling, the first chunk of a segment is never dropped.
 */
let n = 0;
const newStore = () => new IdbStore(indexedDB, `ma-${++n}`);
const buf = (size: number) => new Uint8Array(size).buffer;

/** Advance fake time while letting fake-indexeddb (real setImmediate) make progress. */
async function run(ms: number, step = 50): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step);
    for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------- the HTTP media API ----------

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('createFetchMediaApi (FR-701, ADR 0013 5.5)', () => {
  const api = (fetchFn: (u: string, i: RequestInit) => Promise<Response>) =>
    createFetchMediaApi({
      baseUrl: 'https://api.example/v1',
      getToken: () => 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 1000,
    });

  it('FR-701: presign sends the bare content type, startedAt and durationMs, and nothing else', async () => {
    const bodies: Record<string, unknown>[] = [];
    const a = api((_u, i) => {
      bodies.push(JSON.parse(i.body as string) as Record<string, unknown>);
      return Promise.resolve(
        jsonRes(200, {
          url: 'https://store.invalid/x',
          method: 'PUT',
          headers: { 'Content-Type': 'video/webm', 'If-None-Match': '*' },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
    });
    const r = await a.presign(
      chunkRef(3, 777, 'WEBCAM', 1, { startedAtMs: 1_800_000_000_000, durationMs: 9876 }),
    );
    await a.presign(chunkRef(0, 5, 'AUDIO', 0));
    expect(bodies[0]).toEqual({
      stream: 'WEBCAM',
      segment: 1,
      seq: 3,
      bytes: 777,
      contentType: 'video/webm',
      startedAt: new Date(1_800_000_000_000).toISOString(),
      durationMs: 9876,
    });
    expect(bodies[1]?.contentType).toBe('audio/webm');
    expect(r).toMatchObject({ headers: { 'If-None-Match': '*' } });
    expect((r as { expiresAtMs: number }).expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('FR-701: a recorder mime type with codecs never reaches the server', async () => {
    let sent = '';
    const a = api((_u, i) => {
      sent = i.body as string;
      return Promise.resolve(jsonRes(200, { alreadyUploaded: true }));
    });
    const bad = {
      ...chunkRef(0, 5, 'SCREEN'),
      contentType: 'video/webm;codecs=vp8',
    };
    expect(await a.presign(bad)).toEqual({ alreadyUploaded: true, url: '' });
    expect(sent).toContain('"contentType":"video/webm"');
    expect(sent).not.toContain('codecs');
  });

  it.each<[number, string | undefined, MediaApiErrorKind]>([
    [409, 'SESSION_NOT_ACTIVE', 'ENDED'],
    [429, 'PRESIGN_QUOTA_EXCEEDED', 'QUOTA'],
    [404, 'CHUNK_NOT_PRESIGNED', 'REPRESIGN'],
    [422, 'UPLOAD_MISMATCH', 'REPRESIGN'],
    [409, 'UPLOAD_NOT_FOUND', 'REUPLOAD'],
    [409, 'SEQ_CONFLICT', 'FATAL'],
    [429, 'RATE_LIMITED', 'RETRY'],
    [503, 'STORAGE_UNAVAILABLE', 'RETRY'],
    [500, undefined, 'RETRY'],
    [401, undefined, 'RETRY'],
    [400, 'VALIDATION_FAILED', 'FATAL'],
    [403, undefined, 'FATAL'],
  ])(
    'FR-702: %i %s is %s (decided by the problem code first, then the status)',
    async (status, code, kind) => {
      const a = api(() =>
        Promise.resolve(jsonRes(status, code ? { code } : {}, { 'Retry-After': '7' })),
      );
      const err = await a.confirm(chunkRef(0)).then(
        () => null,
        (e: unknown) => e as MediaApiError,
      );
      expect(err?.kind).toBe(kind);
      expect(err?.retryAfterMs).toBe(7000);
    },
  );

  it('FR-702: a request that never answers is aborted by the per-request timeout and reported as NETWORK', async () => {
    let aborted = false;
    const a = api(
      (_u, i) =>
        new Promise((_res, rej) => {
          i.signal?.addEventListener('abort', () => {
            aborted = true;
            rej(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const p = a.presign(chunkRef(0));
    const caught = p.then(
      () => null,
      (e: unknown) => e as MediaApiError,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((await caught)?.kind).toBe('NETWORK');
    expect(aborted).toBe(true);
  });
});

// ---------- seq and segment continuity (recorder + pipeline) ----------

class FakeRecorder implements MediaRecorderLike {
  state = 'inactive';
  ondataavailable: MediaRecorderLike['ondataavailable'] = null;
  onstop: MediaRecorderLike['onstop'] = null;
  onerror: MediaRecorderLike['onerror'] = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  emit(size: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) });
  }
}

function pipelineRig(store: IdbStore, over: { offline?: boolean } = {}) {
  const presigned: ChunkRef[] = [];
  const recs: FakeRecorder[] = [];
  const api: MediaApi = {
    presign: (c) => {
      presigned.push(c);
      return Promise.resolve(okPresign());
    },
    confirm: () => Promise.resolve(),
  };
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
    recorderFactory: () => {
      const r = new FakeRecorder();
      recs.push(r);
      return r;
    },
    isTypeSupported: () => true,
    put: () => (over.offline ? Promise.reject(new Error('offline')) : Promise.resolve(200)),
  });
  return { p, presigned, recs };
}

describe('seq continues across segments and reloads (FR-701, TC-070, SEQ_CONFLICT)', () => {
  it('TC-070 FR-701: a recorder restart opens a new segment but the seq keeps counting, so the server never sees a seq under two segments', async () => {
    const r = pipelineRig(newStore());
    await r.p.recordWebcam();
    r.recs[0]?.emit(10);
    r.recs[0]?.emit(10);
    await r.p.recordWebcam(); // restart: the old recorder flushes one final chunk
    r.recs[1]?.emit(10);
    await run(1000);
    await r.p.stop();
    const webcam = r.presigned.filter((c) => c.stream === 'WEBCAM');
    const seqs = webcam.map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([...seqs.keys()]); // 0,1,2,3: no repeat, no restart at 0
    expect(seqs).toHaveLength(3);
    expect(new Set(webcam.map((c) => c.segment))).toEqual(new Set([0, 1]));
    const bySeq = new Map(webcam.map((c) => [c.seq, c.segment]));
    expect(bySeq.size).toBe(webcam.length); // every seq belongs to exactly one segment
  });

  it('TC-070 FR-701: every stream has its own counters', async () => {
    const r = pipelineRig(newStore());
    await r.p.recordWebcam();
    await r.p.recordAudio();
    r.recs[0]?.emit(5);
    r.recs[1]?.emit(5);
    await run(500);
    await r.p.stop();
    const first = (s: string) =>
      r.presigned
        .filter((c) => c.stream === s)
        .map((c) => c.seq)
        .sort();
    expect(first('WEBCAM')[0]).toBe(0);
    expect(first('AUDIO')[0]).toBe(0);
  });

  it('TC-063 FR-702: after a reload the next recording continues the seq and segment of the stream', async () => {
    const store = newStore();
    const a = pipelineRig(store, { offline: true });
    await a.p.recordWebcam();
    a.recs[0]?.emit(10);
    a.recs[0]?.emit(10);
    await run(300);
    await a.p.stop();
    const b = pipelineRig(store); // "reload": new pipeline, same IndexedDB
    await b.p.recordWebcam();
    b.recs[0]?.emit(10);
    await run(3000);
    await b.p.stop();
    const fresh = b.presigned.filter((c) => c.segment === 1);
    expect(fresh.length).toBeGreaterThan(0);
    expect(Math.min(...fresh.map((c) => c.seq))).toBeGreaterThanOrEqual(2); // seq 0 and 1 were used before the reload
  });

  it('FR-701: counters seeded from the server (proctor-key) lift the local ones, never lower them', async () => {
    const r = pipelineRig(newStore());
    r.p.seedCounters({ WEBCAM: { nextSeq: 40, nextSegment: 7 } });
    r.p.seedCounters({ WEBCAM: { nextSeq: 3, nextSegment: 1 } }); // older answer: ignored
    await r.p.recordWebcam();
    r.recs[0]?.emit(10);
    await run(500);
    await r.p.stop();
    const c = r.presigned.filter((x) => x.stream === 'WEBCAM');
    expect(Math.min(...c.map((x) => x.segment))).toBe(7);
    expect(Math.min(...c.map((x) => x.seq))).toBe(40);
  });

  it('FR-701: chunks carry startedAt and durationMs, bare types, and only the first chunk of a segment is marked first', async () => {
    let t = 1_800_000_000_000;
    const store = newStore();
    const presigned: ChunkRef[] = [];
    const recs: FakeRecorder[] = [];
    const p = new RecordingPipeline({
      sessionId: 's',
      api: {
        presign: (c) => {
          presigned.push(c);
          return Promise.resolve(okPresign());
        },
        confirm: () => Promise.resolve(),
      },
      assertConsent: () => undefined,
      store,
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [] } as unknown as MediaStream),
      },
      recorderFactory: () => {
        const r = new FakeRecorder();
        recs.push(r);
        return r;
      },
      isTypeSupported: () => true,
      put: () => Promise.resolve(200),
      now: () => t,
    });
    await p.recordAudio();
    t += 10_000;
    recs[0]?.emit(10);
    t += 9_500;
    recs[0]?.emit(10);
    await run(500);
    await p.stop();
    const a = presigned.sort((x, y) => x.seq - y.seq);
    expect(a.map((c) => c.contentType)).toEqual(['audio/webm', 'audio/webm']);
    expect(a[0]).toMatchObject({ startedAtMs: 1_800_000_000_000, durationMs: 10_000, first: true });
    expect(a[1]).toMatchObject({ startedAtMs: 1_800_000_010_000, durationMs: 9_500, first: false });
    expect(a.filter((c) => c.first)).toHaveLength(1);
  });
});

// ---------- upload queue behaviour ----------

type Script = {
  presign?: (c: ChunkRef, call: number) => Promise<PresignResult> | PresignResult;
  put?: (url: string, call: number) => Promise<number> | number;
  confirm?: (c: ChunkRef, call: number) => Promise<void> | void;
};

function qrig(script: Script = {}, over: Partial<UploadQueueOptions> = {}) {
  const log = {
    presign: [] as ChunkRef[],
    put: [] as { url: string; headers: Record<string, string> }[],
    confirm: [] as number[],
  };
  const api: MediaApi = {
    presign: async (c) => {
      log.presign.push(c);
      return script.presign
        ? script.presign(c, log.presign.length)
        : okPresign(`https://store.invalid/${c.stream}/${c.seq}`);
    },
    confirm: async (c) => {
      log.confirm.push(c.seq);
      if (script.confirm) await script.confirm(c, log.confirm.length);
    },
  };
  const ended: string[] = [];
  const blocked: string[] = [];
  const q = new UploadQueue({
    sessionId: 's',
    api,
    store: newStore(),
    jitter: 0,
    backoffBaseMs: 1000,
    put: async (url, _b, headers) => {
      log.put.push({ url, headers });
      return script.put ? script.put(url, log.put.length) : 201;
    },
    onEnded: (i) => ended.push(i.code ?? ''),
    onChunkBlocked: (i) => blocked.push(`${i.stream}:${i.segment}:${i.code ?? ''}`),
    ...over,
  });
  return { q, log, ended, blocked };
}

describe('lazy and reused presigns (FR-701, FR-702)', () => {
  it('FR-702: a backlog is not presigned up front: at most `concurrency` presigns are open at a time', async () => {
    let inUse = 0;
    let peak = 0;
    const r = qrig({
      put: async () => {
        inUse++;
        peak = Math.max(peak, inUse);
        await new Promise((res) => setTimeout(res, 200));
        inUse--;
        return 201;
      },
    });
    await r.q.start();
    for (let i = 0; i < 6; i++) await r.q.add(chunkRef(i, 10, 'WEBCAM'), buf(10));
    await run(60);
    expect(r.log.presign.length).toBeLessThanOrEqual(2); // two in flight, four still waiting
    await run(2000);
    expect(r.log.presign).toHaveLength(6);
    expect(peak).toBe(2);
  });

  it('FR-702: a retry after a failed PUT reuses the cached URL (no second presign) until 5 s before it expires', async () => {
    const r = qrig({ put: (_u, call) => (call === 1 ? 503 : 201) });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(1500);
    expect(r.log.put).toHaveLength(2);
    expect(r.log.presign).toHaveLength(1); // one presign for two PUTs
    expect(r.log.confirm).toEqual([0]);
  });

  it('FR-702: a URL that is about to expire (within 5 s) is not reused: the retry presigns again', async () => {
    const r = qrig({
      presign: (c) => okPresign(`https://store.invalid/${c.seq}`, 6000),
      put: (_u, call) => (call === 1 ? 503 : 201),
    });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(1500); // first retry at ~1 s: 5 s left, margin 5 s: expired for reuse
    expect(r.log.presign).toHaveLength(2);
  });

  it('FR-701: the PUT sends exactly the headers the presign returned (If-None-Match included)', async () => {
    const r = qrig({
      presign: () => ({
        url: 'https://store.invalid/x',
        headers: { 'Content-Type': 'video/webm', 'If-None-Match': '*' },
        expiresAtMs: Date.now() + 60_000,
      }),
    });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(200);
    expect(r.log.put[0]?.headers).toEqual({ 'Content-Type': 'video/webm', 'If-None-Match': '*' });
  });
});

describe('answers of the object store and of confirm (FR-701, FR-702, TC-063)', () => {
  it('FR-702: 412 on the conditional PUT means the object is already stored: go to confirm', async () => {
    const r = qrig({ put: () => 412 });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(200);
    expect(r.log.confirm).toEqual([0]);
    expect(r.q.health().chunksPending).toBe(0);
    expect(r.q.health().droppedChunks).toBe(0);
  });

  it('FR-702: alreadyUploaded skips the PUT and the confirm and clears the chunk', async () => {
    const r = qrig({ presign: () => ({ alreadyUploaded: true, url: '' }) });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(200);
    expect(r.log.put).toHaveLength(0);
    expect(r.log.confirm).toHaveLength(0);
    expect(r.q.health().chunksPending).toBe(0);
  });

  it('FR-702: confirm 422 UPLOAD_MISMATCH presigns again (it counts) and uploads again', async () => {
    const r = qrig({
      confirm: (_c, call) => {
        if (call === 1)
          throw new MediaApiError('REPRESIGN', 'mismatch', { code: 'UPLOAD_MISMATCH' });
      },
    });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(2500);
    expect(r.log.presign).toHaveLength(2);
    expect(r.log.put).toHaveLength(2);
    expect(r.log.confirm).toEqual([0, 0]);
    expect(r.q.health().chunksPending).toBe(0);
  });

  it('FR-702: confirm 409 UPLOAD_NOT_FOUND uploads again (the cached URL is reused while valid)', async () => {
    const r = qrig({
      confirm: (_c, call) => {
        if (call === 1)
          throw new MediaApiError('REUPLOAD', 'missing', { code: 'UPLOAD_NOT_FOUND' });
      },
    });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(2500);
    expect(r.log.put).toHaveLength(2);
    expect(r.log.presign).toHaveLength(1);
    expect(r.q.health().chunksPending).toBe(0);
  });

  it('FR-702: a refused PUT (403, expired URL) presigns again instead of dropping the chunk', async () => {
    const r = qrig({ put: (_u, call) => (call === 1 ? 403 : 201) });
    await r.q.start();
    await r.q.add(chunkRef(0), buf(10));
    await run(2500);
    expect(r.log.presign).toHaveLength(2);
    expect(r.q.health()).toMatchObject({ chunksPending: 0, droppedChunks: 0 });
  });

  it('FR-702: 429 PRESIGN_QUOTA_EXCEEDED waits Retry-After for that stream, keeps the chunk, and other streams carry on', async () => {
    let quota = true;
    const r = qrig(
      {
        presign: (c) => {
          if (c.stream === 'WEBCAM' && quota) {
            throw new MediaApiError('QUOTA', 'quota', {
              code: 'PRESIGN_QUOTA_EXCEEDED',
              retryAfterMs: 20_000,
            });
          }
          return okPresign(`https://store.invalid/${c.stream}/${c.seq}`);
        },
      },
      { concurrency: 1 },
    );
    await r.q.start();
    await r.q.add(chunkRef(0, 10, 'WEBCAM'), buf(10));
    await r.q.add(chunkRef(1, 10, 'WEBCAM', 0), buf(10));
    await r.q.add(chunkRef(0, 10, 'AUDIO'), buf(10));
    await run(1000);
    const webcamPresigns = () => r.log.presign.filter((c) => c.stream === 'WEBCAM').length;
    expect(webcamPresigns()).toBe(1); // the second WEBCAM chunk did not even try (stream hold)
    expect(r.log.confirm).toContain(0); // the AUDIO chunk went through
    expect(r.q.health()).toMatchObject({ quotaWait: true, droppedChunks: 0 });
    await run(15_000);
    expect(webcamPresigns()).toBe(1); // still holding
    quota = false;
    await run(8000);
    expect(r.q.health()).toMatchObject({ chunksPending: 0, droppedChunks: 0, quotaWait: false });
  });
});

describe('outage: no presigns while the connection is down (TC-063, NFR-08)', () => {
  it('TC-063: after a network failure nothing is presigned until the probe answers; then the backlog drains', async () => {
    let online = false;
    const probe = vi.fn(() => Promise.resolve(online));
    const r = qrig({}, { probe });
    const q = r.q as unknown as {
      put: (u: string, b: ArrayBuffer, h: Record<string, string>) => Promise<number>;
    };
    const orig = q.put;
    q.put = (u, b, h) =>
      online ? orig(u, b, h) : Promise.reject(new TypeError('Failed to fetch'));
    await r.q.start();
    for (let i = 0; i < 4; i++) await r.q.add(chunkRef(i, 10, 'WEBCAM'), buf(10));
    await run(1500);
    const presignsAtOutage = r.log.presign.length;
    expect(r.q.health().offline).toBe(true);
    await run(30_000);
    expect(r.log.presign.length).toBe(presignsAtOutage); // quiet: not one extra presign
    expect(probe).toHaveBeenCalled();
    online = true;
    await run(40_000);
    expect(r.q.health()).toMatchObject({ offline: false, chunksPending: 0, droppedChunks: 0 });
  });

  it('TC-063: without a probe exactly one chunk is let through as the probe', async () => {
    const r = qrig({ put: () => 201 });
    const realApi = r.q as unknown as {
      put: (u: string, b: ArrayBuffer, h: Record<string, string>) => Promise<number>;
    };
    const orig = realApi.put;
    let down = true;
    realApi.put = (u, b, h) => (down ? Promise.reject(new TypeError('offline')) : orig(u, b, h));
    await r.q.start();
    for (let i = 0; i < 5; i++) await r.q.add(chunkRef(i, 10, 'WEBCAM'), buf(10));
    await run(1000);
    expect(r.q.health().offline).toBe(true);
    const before = r.log.presign.length;
    await run(20_000);
    // a handful of probe presigns over 20 s of backoff, never one per waiting chunk per second
    expect(r.log.presign.length - before).toBeLessThanOrEqual(6);
    down = false;
    await run(60_000);
    expect(r.q.health().chunksPending).toBe(0);
  });

  it('NFR-08: the browser online event (retryNow) ends the quiet period at once', async () => {
    const r = qrig({ put: () => 201 }, { probe: () => Promise.resolve(false) });
    const realApi = r.q as unknown as {
      put: (u: string, b: ArrayBuffer, h: Record<string, string>) => Promise<number>;
    };
    const orig = realApi.put;
    let down = true;
    realApi.put = (u, b, h) => (down ? Promise.reject(new TypeError('offline')) : orig(u, b, h));
    await r.q.start();
    await r.q.add(chunkRef(0, 10, 'WEBCAM'), buf(10));
    await run(500);
    expect(r.q.health().offline).toBe(true);
    down = false;
    r.q.retryNow();
    await run(300);
    expect(r.q.health().chunksPending).toBe(0);
  });
});

describe('session over, refusals and the first chunk (FR-702, ADR 0013 5.5)', () => {
  it('FR-702: SESSION_NOT_ACTIVE stops uploading, signals once and keeps every chunk', async () => {
    const r = qrig({
      presign: () => {
        throw new MediaApiError('ENDED', 'over', { code: 'SESSION_NOT_ACTIVE' });
      },
    });
    await r.q.start();
    for (let i = 0; i < 3; i++) await r.q.add(chunkRef(i, 10, 'WEBCAM'), buf(10));
    await run(5000);
    expect(r.ended).toEqual(['SESSION_NOT_ACTIVE']);
    expect(r.q.health()).toMatchObject({ ended: true, chunksPending: 3, droppedChunks: 0 });
    const presigns = r.log.presign.length;
    await run(20_000);
    expect(r.log.presign.length).toBe(presigns); // stopped
  });

  it('FR-702: a FATAL answer drops an ordinary chunk but keeps the first chunk of its segment, flagged and retried slowly', async () => {
    const r = qrig({
      presign: () => {
        throw new MediaApiError('FATAL', 'conflict', { code: 'SEQ_CONFLICT' });
      },
    });
    await r.q.start();
    await r.q.add(chunkRef(0, 10, 'WEBCAM', 2, { first: true }), buf(10));
    await r.q.add(chunkRef(1, 10, 'WEBCAM', 2), buf(10));
    await run(2000);
    expect(r.q.health()).toMatchObject({ chunksPending: 1, droppedChunks: 1, blockedChunks: 1 });
    expect(r.blocked).toEqual(['WEBCAM:2:SEQ_CONFLICT']);
    const tries = r.log.presign.length;
    await run(60_000);
    expect(r.log.presign.length).toBe(tries); // retried slowly (5 minutes), not every second
  });

  it('FR-702: the buffer cap drops the oldest ordinary chunks but never the first chunk of a segment', async () => {
    const r = qrig({}, { maxBufferBytes: 350, concurrency: 0 });
    await r.q.start();
    await r.q.add(chunkRef(0, 100, 'WEBCAM', 0, { first: true }), buf(100)); // protected
    await r.q.add(chunkRef(1, 100, 'WEBCAM', 0), buf(100));
    await r.q.add(chunkRef(2, 100, 'WEBCAM', 0), buf(100));
    await r.q.add(chunkRef(3, 100, 'WEBCAM', 0), buf(100)); // over the cap: seq 1 goes
    const keys = (
      await (r.q as unknown as { o: { store: IdbStore } }).o.store.keys('chunks', 's:')
    ).map((k) => k.split(':')[3]);
    expect(keys).toEqual(['0000000000', '0000000002', '0000000003']);
    expect(r.q.health()).toMatchObject({ droppedChunks: 1, droppedBytes: 100 });
  });

  it('FR-702: when only protected chunks remain the incoming ordinary chunk is dropped and counted; an incoming first chunk is admitted and flagged', async () => {
    let capFlag = 0;
    const r = qrig({}, { maxBufferBytes: 250, concurrency: 0, onCapExceeded: () => capFlag++ });
    await r.q.start();
    await r.q.add(chunkRef(0, 100, 'WEBCAM', 0, { first: true }), buf(100));
    await r.q.add(chunkRef(0, 100, 'AUDIO', 0, { first: true }), buf(100));
    await r.q.add(chunkRef(1, 100, 'WEBCAM', 0), buf(100)); // no victim left: dropped
    expect(r.q.health()).toMatchObject({ chunksPending: 2, droppedChunks: 1, capExceeded: false });
    await r.q.add(chunkRef(0, 100, 'SCREEN', 0, { first: true }), buf(100)); // admitted above the cap
    expect(capFlag).toBe(1);
    expect(r.q.health()).toMatchObject({ chunksPending: 3, droppedChunks: 1, capExceeded: true });
  });

  it('FR-702: the default PUT is aborted by its own timeout and the chunk is retried, not lost', async () => {
    let aborted = 0;
    const fetchMock = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            aborted++;
            rej(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = newStore();
    const q = new UploadQueue({
      sessionId: 's',
      store,
      jitter: 0,
      putTimeoutMs: 500,
      api: { presign: () => Promise.resolve(okPresign()), confirm: () => Promise.resolve() },
    });
    await q.start();
    await q.add(chunkRef(0), buf(10));
    await run(1500);
    expect(aborted).toBeGreaterThanOrEqual(1);
    expect(q.health()).toMatchObject({ chunksPending: 1, droppedChunks: 0, offline: true });
    vi.unstubAllGlobals();
  });
});

describe('pipeline signals (FR-702)', () => {
  it('FR-702: SESSION_NOT_ACTIVE raises a recording-ended flag and the onEnded callback, once, and keeps the chunks', async () => {
    const caps: string[] = [];
    const ended: string[] = [];
    const recs: FakeRecorder[] = [];
    const p = new RecordingPipeline({
      sessionId: 's',
      api: {
        presign: () => {
          throw new MediaApiError('ENDED', 'over', { code: 'SESSION_NOT_ACTIVE' });
        },
        confirm: () => Promise.resolve(),
      },
      assertConsent: () => undefined,
      store: newStore(),
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [] } as unknown as MediaStream),
      },
      recorderFactory: () => {
        const r = new FakeRecorder();
        recs.push(r);
        return r;
      },
      isTypeSupported: () => true,
      put: () => Promise.resolve(201),
      onCapability: (f) => caps.push(`${f.id}:${f.status}`),
      onEnded: (i) => ended.push(i.code ?? ''),
    });
    await p.recordWebcam();
    recs[0]?.emit(10);
    recs[0]?.emit(10);
    await run(3000);
    expect(caps.filter((c) => c.startsWith('recording-ended'))).toEqual([
      'recording-ended:UNVERIFIABLE',
    ]);
    expect(ended).toEqual(['SESSION_NOT_ACTIVE']);
    expect(p.health()).toMatchObject({ ended: true, chunksPending: 2, droppedChunks: 0 });
    await p.stop();
  });
});

// ---------- review round 1 (PR #366) ----------

describe('alreadyUploaded is believed only for chunks this queue presigned or restored (FR-702, TC-070)', () => {
  it('TC-070 FR-702: alreadyUploaded for a chunk this page never got a URL for is a collision: the chunk is kept, given a fresh seq and uploaded, never deleted', async () => {
    const conflicts: string[] = [];
    let call = 0;
    const r = qrig(
      {
        presign: (c) => {
          call++;
          // the server has a DIFFERENT confirmed chunk under seq 5; the re-keyed seq is free
          return c.seq === 5
            ? { alreadyUploaded: true, url: '' }
            : okPresign(`https://store.invalid/${c.seq}`);
        },
      },
      {
        rekey: (ref, attempt) => Promise.resolve(ref.seq + 1000 * attempt),
        onSeqConflict: (i) => conflicts.push(`${i.stream}:${i.segment}`),
      },
    );
    await r.q.start();
    await r.q.add(chunkRef(5, 10, 'WEBCAM', 2), buf(10));
    await run(2000);
    expect(call).toBe(2);
    expect(conflicts).toEqual(['WEBCAM:2']);
    expect(r.log.put).toHaveLength(1); // the data was uploaded under the new identity
    expect(r.log.confirm).toEqual([1005]);
    expect(r.q.health()).toMatchObject({
      chunksPending: 0,
      droppedChunks: 0,
      seqConflicts: 1,
      rekeyedChunks: 1,
    });
  });

  it('TC-070 FR-702: without a way to re-key, an ordinary colliding chunk is dropped and COUNTED; a first chunk is kept and flagged', async () => {
    const blocked: string[] = [];
    const r = qrig(
      { presign: () => ({ alreadyUploaded: true, url: '' }) },
      { onChunkBlocked: (i) => blocked.push(`${i.stream}:${i.code ?? ''}`) },
    );
    await r.q.start();
    await r.q.add(chunkRef(1, 10, 'WEBCAM', 0), buf(10));
    await r.q.add(chunkRef(0, 10, 'WEBCAM', 0, { first: true }), buf(10));
    await run(1000);
    expect(r.log.put).toHaveLength(0);
    expect(r.q.health()).toMatchObject({
      chunksPending: 1,
      droppedChunks: 1,
      seqConflicts: 2,
      blockedChunks: 1,
    });
    expect(blocked).toEqual(['WEBCAM:SEQ_CONFLICT']);
  });

  it('FR-702: alreadyUploaded IS believed for a chunk restored from IndexedDB (our earlier page load got the URL) and for one this queue presigned', async () => {
    const store = newStore();
    const first = qrig({ presign: () => okPresign(), put: () => 0 }, { store }); // offline: chunk stays in IDB
    await first.q.start();
    await first.q.add(chunkRef(0), buf(10));
    await run(300);
    first.q.stop();
    const second = qrig({ presign: () => ({ alreadyUploaded: true, url: '' }) }, { store }); // "reload"
    await second.q.start();
    await run(500);
    expect(second.q.health()).toMatchObject({
      chunksPending: 0,
      droppedChunks: 0,
      seqConflicts: 0,
    });
    // presigned by this queue, PUT landed, the confirm answer got lost: alreadyUploaded next try
    let n2 = 0;
    const third = qrig({
      presign: () => (++n2 === 1 ? okPresign() : { alreadyUploaded: true, url: '' }),
      confirm: (_c, call) => {
        if (call === 1) throw new MediaApiError('RETRY', 'lost answer');
      },
    });
    await third.q.start();
    await third.q.add(chunkRef(0), buf(10));
    await run(3000);
    expect(third.q.health()).toMatchObject({ chunksPending: 0, seqConflicts: 0 });
  });

  it('FR-702 B1: after a reload in storage-degraded mode the counters fall behind; the pipeline re-keys the colliding chunk past the confirmed ones', async () => {
    const store = newStore();
    for (const m of ['put', 'get', 'keys'] as const)
      vi.spyOn(store, m).mockRejectedValue(new Error('idb'));
    const confirmedSeqs = new Set([0, 1, 2]);
    const sent: number[] = [];
    const flags: string[] = [];
    const recs: FakeRecorder[] = [];
    const p = new RecordingPipeline({
      sessionId: 's',
      api: {
        presign: (c) =>
          Promise.resolve(
            confirmedSeqs.has(c.seq)
              ? { alreadyUploaded: true, url: '' }
              : okPresign(`https://store.invalid/${c.seq}`),
          ),
        confirm: (c) => {
          sent.push(c.seq);
          return Promise.resolve();
        },
      },
      assertConsent: () => undefined,
      store,
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [] } as unknown as MediaStream),
      },
      recorderFactory: () => {
        const r = new FakeRecorder();
        recs.push(r);
        return r;
      },
      isTypeSupported: () => true,
      put: () => Promise.resolve(201),
      onCapability: (f) => flags.push(f.id),
    });
    await p.recordWebcam(); // counters start at 0: behind the three confirmed chunks
    recs[0]?.emit(10);
    await run(3000);
    expect(p.health()).toMatchObject({ droppedChunks: 0, seqConflicts: 1, rekeyedChunks: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeGreaterThan(2);
    expect(flags).toContain('recording-seq-conflict');
    await p.stop();
  });
});

describe('first chunk overflow is bounded per stream (FR-702, ADR 0013 5.5)', () => {
  const MIB = 1024 * 1024;
  it('FR-702: first chunks are admitted above the cap up to 16 MiB per stream, beyond that the segment is lost and reported; other streams have their own allowance', async () => {
    const lost: string[] = [];
    const r = qrig(
      {},
      {
        maxBufferBytes: 8 * MIB,
        concurrency: 0,
        onSegmentLost: (i) => lost.push(`${i.stream}:${i.segment}`),
      },
    );
    await r.q.start();
    await r.q.add(chunkRef(0, 8 * MIB, 'SCREEN', 0, { first: true }), new ArrayBuffer(8)); // fills the cap
    // four more first chunks of 4 MiB are protected: exactly the 16 MiB allowance
    for (let seg = 1; seg <= 4; seg++) {
      await r.q.add(
        chunkRef(seg * 10, 4 * MIB, 'SCREEN', seg, { first: true }),
        new ArrayBuffer(8),
      );
    }
    expect(lost).toEqual([]);
    expect(r.q.health().capExceeded).toBe(true);
    await r.q.add(chunkRef(99, 1, 'SCREEN', 9, { first: true }), new ArrayBuffer(8)); // 16 MiB + 1 byte
    expect(lost).toEqual(['SCREEN:9']);
    expect(r.q.health().droppedChunks).toBe(1);
    // another stream has its own allowance
    await r.q.add(chunkRef(0, 4 * MIB, 'AUDIO', 0, { first: true }), new ArrayBuffer(8));
    expect(lost).toEqual(['SCREEN:9']);
  });

  it('FR-702: the allowance is returned when overflow chunks have been uploaded', async () => {
    const lost: string[] = [];
    const r = qrig(
      {},
      { maxBufferBytes: 8 * MIB, concurrency: 0, onSegmentLost: (i) => lost.push(i.stream) },
    );
    await r.q.start();
    await r.q.add(chunkRef(0, 8 * MIB, 'SCREEN', 0, { first: true }), new ArrayBuffer(8));
    await r.q.add(chunkRef(1, 8 * MIB, 'SCREEN', 1, { first: true }), new ArrayBuffer(8));
    await r.q.add(chunkRef(2, 8 * MIB, 'SCREEN', 2, { first: true }), new ArrayBuffer(8)); // 16 MiB over
    await r.q.add(chunkRef(3, 1, 'SCREEN', 3, { first: true }), new ArrayBuffer(8));
    expect(lost).toEqual(['SCREEN']); // allowance used up
    await r.q.purge(); // everything left the buffer (stands in for a finished upload)
    await r.q.add(chunkRef(4, 8 * MIB, 'SCREEN', 4, { first: true }), new ArrayBuffer(8));
    await r.q.add(chunkRef(5, 8 * MIB, 'SCREEN', 5, { first: true }), new ArrayBuffer(8));
    expect(lost).toEqual(['SCREEN']); // nothing new lost
  });
});

describe('after SESSION_NOT_ACTIVE nothing new is captured or stored (privacy, FR-702)', () => {
  it('FR-702: onEnded stops every recorder and releases the devices; later chunks are refused and counted, never written to IndexedDB', async () => {
    const store = newStore();
    const recs: FakeRecorder[] = [];
    const stopTrack = vi.fn();
    const media = {
      getTracks: () => [{ stop: stopTrack, addEventListener: vi.fn() }],
    } as unknown as MediaStream;
    let ended = false;
    const p = new RecordingPipeline({
      sessionId: 's',
      api: {
        presign: () => {
          ended = true;
          throw new MediaApiError('ENDED', 'over', { code: 'SESSION_NOT_ACTIVE' });
        },
        confirm: () => Promise.resolve(),
      },
      assertConsent: () => undefined,
      store,
      mediaDevices: { getUserMedia: () => Promise.resolve(media) },
      recorderFactory: () => {
        const r = new FakeRecorder();
        recs.push(r);
        return r;
      },
      isTypeSupported: () => true,
      put: () => Promise.resolve(201),
    });
    await p.recordWebcam();
    recs[0]?.emit(10);
    await run(2000);
    expect(ended).toBe(true);
    expect(recs[0]?.state).toBe('inactive');
    expect(stopTrack).toHaveBeenCalled();
    const keysBefore = (await store.keys('chunks', 's:')).length;
    recs[0]?.emit(10); // a late emission after the end
    await p.recordWebcam().catch(() => undefined);
    await run(500);
    expect((await store.keys('chunks', 's:')).length).toBeLessThanOrEqual(keysBefore + 0);
    const q = (p as unknown as { queue: UploadQueue }).queue;
    const dropped = q.health().droppedChunks;
    await q.add(chunkRef(50, 10, 'WEBCAM', 5), buf(10));
    expect(q.health().droppedChunks).toBe(dropped + 1);
    expect((await store.keys('chunks', 's:')).length).toBeLessThanOrEqual(keysBefore);
    await p.stop();
  });
});

describe('small behaviours of review round 1 (FR-702, TC-063)', () => {
  it('FR-702: the request timeout covers the body: a stalled response body is aborted and reported as NETWORK', async () => {
    const fetchFn = vi.fn((_u: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      } as unknown as Response),
    );
    const api = createFetchMediaApi({
      baseUrl: 'https://a',
      getToken: () => 't',
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 800,
    });
    const caught = api.presign(chunkRef(0)).then(
      () => null,
      (e: unknown) => e as MediaApiError,
    );
    await vi.advanceTimersByTimeAsync(800);
    expect((await caught)?.kind).toBe('NETWORK');
  });

  it('TC-063 NFR-08: a probe that never answers times out as "still offline" and is retried later', async () => {
    let calls = 0;
    const r = qrig(
      {},
      {
        probe: () => {
          calls++;
          return new Promise(() => undefined);
        },
        probeTimeoutMs: 1000,
      },
    );
    const q = r.q as unknown as { put: () => Promise<number> };
    q.put = () => Promise.reject(new TypeError('offline'));
    await r.q.start();
    await r.q.add(chunkRef(0, 10, 'WEBCAM'), buf(10));
    await run(30_000);
    expect(calls).toBeGreaterThanOrEqual(2); // not stuck on the first probe
    expect(r.q.health().offline).toBe(true);
  });

  it('TC-063 FR-702: a PUT answering status 0 (a helper that maps network errors to 0) is offline, not a refused URL: no extra presigns', async () => {
    const r = qrig({ put: () => 0 });
    await r.q.start();
    for (let i = 0; i < 4; i++) await r.q.add(chunkRef(i, 10, 'WEBCAM'), buf(10));
    await run(10_000);
    expect(r.q.health().offline).toBe(true);
    expect(r.log.presign.length).toBeLessThanOrEqual(4);
  });

  it('FR-702: the quota raises a recording-quota flag once, and the online event does not release a quota hold', async () => {
    const flags: string[] = [];
    const r = qrig(
      {
        presign: () => {
          throw new MediaApiError('QUOTA', 'quota', {
            code: 'PRESIGN_QUOTA_EXCEEDED',
            retryAfterMs: 30_000,
          });
        },
      },
      { onQuota: (i) => flags.push(i.stream), concurrency: 1 },
    );
    await r.q.start();
    await r.q.add(chunkRef(0, 10, 'WEBCAM'), buf(10));
    await run(500);
    expect(flags).toEqual(['WEBCAM']);
    const presigns = r.log.presign.length;
    r.q.retryNow(); // the browser says online
    await run(500);
    expect(r.log.presign.length).toBe(presigns);
    expect(r.q.health().quotaWait).toBe(true);
    expect(flags).toEqual(['WEBCAM']);
  });

  it('FR-701: seedCounters ignores stream names this recorder does not know', async () => {
    const r = pipelineRig(newStore());
    expect(() =>
      r.p.seedCounters({ ROOM_SCAN: { nextSeq: 5, nextSegment: 1 } } as never),
    ).not.toThrow();
    await r.p.stop();
  });

  it('FR-701: a legacy <sid>:segment:<STREAM> key (last segment used) lifts nextSegment to the next one', async () => {
    const store = newStore();
    await store.put('meta', 's:segment:WEBCAM', 4);
    const r = pipelineRig(store);
    await r.p.recordWebcam();
    r.recs[0]?.emit(10);
    await run(500);
    await r.p.stop();
    expect(
      Math.min(...r.presigned.filter((c) => c.stream === 'WEBCAM').map((c) => c.segment)),
    ).toBe(5);
  });

  it('FR-701 TC-063: the counter is written to IndexedDB before the chunk it numbers is stored', async () => {
    const store = newStore();
    const order: string[] = [];
    const realPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation((name, key, value) => {
      if (name === 'meta' && key.includes(':media:'))
        order.push(`counter:${(value as { nextSeq: number }).nextSeq}`);
      if (name === 'chunks') order.push('chunk');
      return realPut(name, key, value);
    });
    const r = pipelineRig(store, { offline: true });
    await r.p.recordWebcam();
    r.recs[0]?.emit(10);
    await run(500);
    await r.p.stop();
    const firstChunk = order.indexOf('chunk');
    expect(firstChunk).toBeGreaterThan(-1);
    expect(order.slice(0, firstChunk).some((o) => o === 'counter:1')).toBe(true); // seq 0 taken, counter 1 saved
  });
});
