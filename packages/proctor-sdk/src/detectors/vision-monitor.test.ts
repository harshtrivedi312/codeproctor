import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProctorSession } from '../core/session';
import { TEST_KEY_B64 } from '../test/helpers';
import { fakeContext } from '../test/helpers';
import { NO_FACE_SEQUENCE, PHONE_STRONG, secondsOf } from './__fixtures__/samples';
import { IDENTITY_RECHECK_INTERVAL_MS } from './config';
import { uploadEvidence, needsEvidence, type EvidenceApi } from './evidence';
import { IdentityScheduler } from './identity';
import { InferenceClient, type WorkerLike } from './inference-client';
import type { FromWorker, InferenceTask, ResultMessage, ToWorker } from './protocol';
import { VisionMonitor, type VisionMonitorOptions } from './vision-monitor';
import { VoiceMonitor, type VadCallbacks } from './voice-monitor';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  initTasks: InferenceTask[] = [];
  frames: ToWorker[] = [];
  terminated = false;
  script: Partial<ResultMessage>[] = [];
  constructor(private readonly loaded: Partial<Record<InferenceTask, boolean>> = {}) {}
  postMessage(msg: ToWorker): void {
    if (msg.type === 'init') {
      this.initTasks = msg.tasks;
      const loaded = { face: true, gaze: true, objects: true, ...this.loaded };
      queueMicrotask(() => this.reply({ type: 'ready', loaded }));
    } else {
      this.frames.push(msg);
      const next = this.script.shift() ?? {};
      queueMicrotask(() => this.reply({ type: 'result', id: msg.id, busyMs: 5, ...next }));
    }
  }
  private reply(m: FromWorker): void {
    this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;
const fakeVideo = () =>
  ({
    muted: false,
    playsInline: false,
    srcObject: null,
    play: () => Promise.resolve(),
    videoWidth: 640,
    videoHeight: 360,
  }) as unknown as HTMLVideoElement;
const stream = {} as MediaStream;

function setup(
  over: Partial<VisionMonitorOptions> = {},
  loaded: Partial<Record<InferenceTask, boolean>> = {},
) {
  const worker = new FakeWorker(loaded);
  const createWorker = vi.fn(() => worker);
  let clock = 1_000_000;
  const m = new VisionMonitor({
    getWebcamStream: () => stream,
    createWorker,
    modelBaseUrl: '/models/proctor',
    now: () => clock,
    grabFrame: () => Promise.resolve(bitmap()),
    createVideo: fakeVideo,
    autoStart: false,
    ...over,
  });
  return { m, worker, createWorker, advance: (ms: number) => (clock += ms) };
}

describe('VisionMonitor accommodations and honesty (FR-106, FR-606)', () => {
  it('FR-106: when every vision detector is disabled nothing loads', async () => {
    const h = fakeContext();
    h.ctx.isDisabled = () => true;
    const { m, createWorker } = setup();
    await m.start(h.ctx);
    expect(createWorker).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it('FR-106: a disabled detector is not even asked of the worker', async () => {
    const h = fakeContext();
    h.ctx.isDisabled = (d) => d === 'OBJECT' || d === 'GAZE';
    const { m, worker } = setup();
    await m.start(h.ctx);
    expect(worker.initTasks).toEqual(['face']);
    m.stop();
  });

  it('FR-606: a model that fails to load is DETECTOR_UNAVAILABLE, not a pass', async () => {
    const h = fakeContext();
    const { m } = setup({}, { objects: false });
    await m.start(h.ctx);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: 'DETECTOR_UNAVAILABLE',
        payload: { detector: 'OBJECT', reason: 'MODEL_LOAD_FAILED' },
      }),
    ]);
    expect(m.getStats().tasks.sort()).toEqual(['face', 'gaze']);
    m.stop();
  });

  it('FR-606: no webcam stream gives PERMISSION_DENIED for each enabled detector', async () => {
    const h = fakeContext();
    const { m, createWorker } = setup({ getWebcamStream: () => null });
    await m.start(h.ctx);
    expect(h.events.map((e) => (e.payload as { detector: string }).detector).sort()).toEqual([
      'FACE',
      'GAZE',
      'OBJECT',
    ]);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('FR-606: a worker that cannot start is reported as UNSUPPORTED', async () => {
    const h = fakeContext();
    const { m } = setup({
      createWorker: () => {
        throw new Error('no workers');
      },
    });
    await m.start(h.ctx);
    expect(h.events.every((e) => (e.payload as { reason: string }).reason === 'UNSUPPORTED')).toBe(
      true,
    );
    expect(h.events).toHaveLength(3);
  });

  it('FR-606: refuses a cross-origin model base', async () => {
    const h = fakeContext();
    const { m } = setup({ modelBaseUrl: 'https://cdn.example.net/models' });
    await m.start(h.ctx);
    expect(h.events.map((e) => e.type)).toEqual([
      'DETECTOR_UNAVAILABLE',
      'DETECTOR_UNAVAILABLE',
      'DETECTOR_UNAVAILABLE',
    ]);
    expect(h.events.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'MODEL_LOAD_FAILED',
      'MODEL_LOAD_FAILED',
      'MODEL_LOAD_FAILED',
    ]);
  });

  it('FR-606: three runtime failures in a row disable the task with RUNTIME_ERROR', async () => {
    const h = fakeContext();
    const { m, worker, advance } = setup();
    worker.script = [{ failed: ['objects'] }, { failed: ['objects'] }, { failed: ['objects'] }];
    await m.start(h.ctx);
    for (let i = 0; i < 3; i++) {
      advance(2000);
      await m.tick();
    }
    expect(h.events.filter((e) => e.type === 'DETECTOR_UNAVAILABLE')).toEqual([
      expect.objectContaining({ payload: { detector: 'OBJECT', reason: 'RUNTIME_ERROR' } }),
    ]);
    m.stop();
  });
});

describe('VisionMonitor event flow with recorded fixtures (FR-606)', () => {
  it('TC-057: replays the NO_FACE fixture and emits one NO_FACE with its duration, no evidence', async () => {
    const h = fakeContext();
    const presign = vi.fn();
    const evidenceApi: EvidenceApi = { presign };
    const { m, worker, advance } = setup({ evidenceApi });
    worker.script = NO_FACE_SEQUENCE.map((faceCount) => ({ faceCount }));
    await m.start(h.ctx);
    for (let i = 0; i < NO_FACE_SEQUENCE.length; i++) {
      await m.tick();
      advance(1000);
    }
    const noFace = h.events.filter((e) => e.type === 'NO_FACE');
    expect(noFace).toHaveLength(1);
    expect(noFace[0]?.options).toMatchObject({ durationMs: 5000 });
    expect(presign).not.toHaveBeenCalled(); // MEDIUM events carry no snapshot
    m.stop();
  });

  it('TC-059: a phone (HIGH event) carries an evidenceKey from the snapshot upload', async () => {
    const h = fakeContext();
    const evidenceApi: EvidenceApi = {
      presign: vi.fn(() =>
        Promise.resolve({ url: 'https://store.invalid/x', key: 'evidence/s1/abc.jpg' }),
      ),
    };
    const { m, worker, advance } = setup({
      evidenceApi,
      captureSnapshot: () => Promise.resolve(new Blob(['jpeg'])),
    });
    worker.script = secondsOf(6, { faceCount: 1, objects: PHONE_STRONG });
    // stub the evidence PUT
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    );
    await m.start(h.ctx);
    for (let i = 0; i < 6; i++) {
      await m.tick();
      advance(2000);
    }
    await vi.waitFor(() => expect(h.events.some((e) => e.type === 'PHONE_DETECTED')).toBe(true));
    const phone = h.events.find((e) => e.type === 'PHONE_DETECTED');
    expect(phone?.options).toMatchObject({ evidenceKey: 'evidence/s1/abc.jpg', confidence: 0.82 });
    vi.unstubAllGlobals();
    m.stop();
  });

  it('TC-058: if the MULTIPLE_FACES snapshot cannot be uploaded the event is still sent, without evidence', async () => {
    const h = fakeContext();
    const evidenceApi: EvidenceApi = { presign: () => Promise.reject(new Error('down')) };
    const { m, worker, advance } = setup({
      evidenceApi,
      captureSnapshot: () => Promise.resolve(new Blob(['j'])),
    });
    worker.script = secondsOf(3, { faceCount: 2 });
    await m.start(h.ctx);
    for (let i = 0; i < 3; i++) {
      await m.tick();
      advance(1000);
    }
    await vi.waitFor(() => expect(h.events.some((e) => e.type === 'MULTIPLE_FACES')).toBe(true));
    expect(h.events.find((e) => e.type === 'MULTIPLE_FACES')?.options).not.toHaveProperty(
      'evidenceKey',
    );
    m.stop();
  });

  it('FR-606: skips gaze/objects frames that are not due (face every 1 s, objects every 2 s)', async () => {
    const h = fakeContext();
    const { m, worker, advance } = setup();
    await m.start(h.ctx);
    for (let i = 0; i < 4; i++) {
      await m.tick();
      advance(1000);
    }
    const asked = worker.frames.map((f) =>
      f.type === 'frame' ? f.tasks.includes('objects') : false,
    );
    expect(asked).toEqual([true, false, true, false]);
    m.stop();
  });
});

describe('worker that never answers (FR-606)', () => {
  const silent: WorkerLike = {
    postMessage: () => undefined,
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  };
  it('FR-606: InferenceClient.init resolves null after the timeout and terminates the worker', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const c = new InferenceClient(() => ({ ...silent, terminate }), 30_000);
    const p = c.init({
      tasks: ['face'],
      urls: { faceDetector: '', faceLandmarker: '', mediapipeWasm: '', cocoSsd: '' },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toBeNull();
    expect(terminate).toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('FR-606: VisionMonitor.start finishes and reports DETECTOR_UNAVAILABLE for every wanted task', async () => {
    vi.useFakeTimers();
    const h = fakeContext();
    const { m } = setup({ createWorker: () => ({ ...silent }), initTimeoutMs: 1000 });
    const p = m.start(h.ctx);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(h.events.map((e) => (e.payload as { detector: string }).detector).sort()).toEqual([
      'FACE',
      'GAZE',
      'OBJECT',
    ]);
    vi.useRealTimers();
  });
});

describe('evidence helpers (FR-801)', () => {
  it('FR-801: only HIGH event types need a snapshot', () => {
    expect(needsEvidence('PHONE_DETECTED')).toBe(true);
    expect(needsEvidence('MULTIPLE_FACES')).toBe(true);
    expect(needsEvidence('NO_FACE')).toBe(false);
    expect(needsEvidence('GAZE_AWAY')).toBe(false);
  });
  it('FR-801: an upload slower than the timeout yields no key instead of delaying the event', async () => {
    vi.useFakeTimers();
    const api: EvidenceApi = { presign: () => new Promise(() => undefined) };
    const p = uploadEvidence(api, new Blob(['x']), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBeNull();
    vi.useRealTimers();
  });
});

describe('InferenceClient back-pressure (FR-606)', () => {
  it('FR-606: skips a frame while the worker is busy instead of queueing it', async () => {
    const w = new FakeWorker();
    const c = new InferenceClient(() => w);
    await c.init({
      tasks: ['face'],
      urls: { faceDetector: '', faceLandmarker: '', mediapipeWasm: '', cocoSsd: '' },
    });
    const first = c.analyze(bitmap(), ['face']);
    const close = vi.fn();
    const b = { close } as unknown as ImageBitmap;
    const second = await c.analyze(b, ['face']);
    expect(second).toBeNull();
    expect(c.skippedFrames).toBe(1);
    expect(close).toHaveBeenCalled();
    expect(await first).not.toBeNull();
  });
});

describe('identity re-check (FR-606, ADR 0004)', () => {
  it('FR-606: a mismatch emits FACE_MISMATCH, a match emits nothing, an error is ignored', async () => {
    const got: unknown[] = [];
    const results = [
      { matched: false, similarity: 0.12 },
      { matched: true, similarity: 0.9 },
    ];
    let calls = 0;
    const s = new IdentityScheduler(
      IDENTITY_RECHECK_INTERVAL_MS,
      () => Promise.resolve(new Blob(['f'])),
      () => {
        calls++;
        const r = results.shift();
        return r ? Promise.resolve(r) : Promise.reject(new Error('api down'));
      },
      (r) => got.push(r),
    );
    await s.tick();
    await s.tick();
    await s.tick();
    expect(calls).toBe(3);
    expect(got).toEqual([{ matched: false, similarity: 0.12 }]);
  });

  it('FR-606: the monitor wires a mismatch to FACE_MISMATCH with the similarity', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = fakeContext();
    const { m } = setup({
      recheckIdentity: () => Promise.resolve({ matched: false, similarity: 0.2 }),
      captureSnapshot: () => Promise.resolve(new Blob(['f'])),
    });
    await m.start(h.ctx);
    await vi.advanceTimersByTimeAsync(IDENTITY_RECHECK_INTERVAL_MS);
    expect(h.events.find((e) => e.type === 'FACE_MISMATCH')?.payload).toEqual({ similarity: 0.2 });
    m.stop();
    vi.useRealTimers();
  });
});

describe('VoiceMonitor (FR-607, TC-061)', () => {
  it('TC-061: logs SPEECH_DETECTED with duration when a segment ends', async () => {
    const h = fakeContext();
    let cb!: VadCallbacks;
    let t = 5_000_000;
    const destroy = vi.fn();
    const m = new VoiceMonitor({
      getStream: () => stream,
      now: () => t,
      createVad: (_s, c) => {
        cb = c;
        return Promise.resolve({ start: vi.fn(), destroy });
      },
    });
    await m.start(h.ctx);
    cb.onSpeechStart();
    t += 10_000;
    cb.onSpeechEnd();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'SPEECH_DETECTED', options: { durationMs: 10_000 } });
    await m.stop();
    expect(destroy).toHaveBeenCalled();
  });

  it('FR-607: a VAD model load failure is DETECTOR_UNAVAILABLE', async () => {
    const h = fakeContext();
    const m = new VoiceMonitor({
      getStream: () => stream,
      createVad: () => Promise.reject(new Error('404')),
    });
    await m.start(h.ctx);
    expect(h.events[0]).toMatchObject({
      type: 'DETECTOR_UNAVAILABLE',
      payload: { detector: 'VOICE', reason: 'MODEL_LOAD_FAILED' },
    });
  });

  it('FR-607: without a microphone stream it reports PERMISSION_DENIED and never opens one itself', async () => {
    const h = fakeContext();
    const createVad = vi.fn();
    const m = new VoiceMonitor({ getStream: () => null, createVad });
    await m.start(h.ctx);
    expect(createVad).not.toHaveBeenCalled();
    expect(h.events[0]).toMatchObject({
      payload: { detector: 'VOICE', reason: 'PERMISSION_DENIED' },
    });
  });
});

describe('review fixes: late stream, failure reporting, dead worker (FR-606)', () => {
  it('FR-606: a webcam stream attached after start() brings the detectors up', async () => {
    const h = fakeContext();
    let current: MediaStream | null = null;
    const { m, worker } = setup({ getWebcamStream: () => current });
    await m.start(h.ctx);
    expect(h.events.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'PERMISSION_DENIED',
      'PERMISSION_DENIED',
      'PERMISSION_DENIED',
    ]);
    current = null;
    await m.attachStream(stream);
    expect(worker.initTasks.sort()).toEqual(['face', 'gaze', 'objects']);
    expect(m.getStats().tasks.sort()).toEqual(['face', 'gaze', 'objects']);
    expect(h.capabilities.at(-1)?.status).toBe('SUPPORTED');
    m.stop();
  });

  it('FR-606: if start fails after some tasks were SUPPORTED, those tasks are reported unavailable too', async () => {
    const h = fakeContext();
    const { m } = setup({
      createVideo: () => {
        throw new Error('no video');
      },
    });
    await m.start(h.ctx);
    const unavailable = h.events.filter((e) => e.type === 'DETECTOR_UNAVAILABLE');
    expect(unavailable.map((e) => (e.payload as { detector: string }).detector).sort()).toEqual([
      'FACE',
      'GAZE',
      'OBJECT',
    ]);
    expect(h.capabilities.filter((c) => c.status === 'UNSUPPORTED')).toHaveLength(3);
    expect(m.getStats().tasks).toEqual([]);
  });

  it('FR-606: one error event after ready is only a strike; three terminate the worker and emit RUNTIME_ERROR', async () => {
    const h = fakeContext();
    const { m, worker } = setup();
    await m.start(h.ctx);
    worker.onerror?.({});
    expect(worker.terminated).toBe(false); // an uncaught handler exception does not kill a worker
    expect(m.getStats().tasks).toHaveLength(3);
    worker.onerror?.({});
    worker.onerror?.({});
    expect(worker.terminated).toBe(true);
    expect(
      h.events
        .filter((e) => e.type === 'DETECTOR_UNAVAILABLE')
        .map((e) => (e.payload as { reason: string }).reason),
    ).toEqual(['RUNTIME_ERROR', 'RUNTIME_ERROR', 'RUNTIME_ERROR']);
    expect(m.getStats().tasks).toEqual([]);
    m.stop();
  });

  it('FR-606: frames the worker never answers time out; three in a row kill the worker', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const orig = w.postMessage.bind(w);
    w.postMessage = (msg) => {
      if (msg.type === 'init') orig(msg);
    };
    const c = new InferenceClient(() => w, 30_000, 1000);
    const init = c.init({
      tasks: ['face'],
      urls: { faceDetector: '', faceLandmarker: '', mediapipeWasm: '', cocoSsd: '' },
    });
    await vi.advanceTimersByTimeAsync(1);
    await init;
    const dead = vi.fn();
    c.onDead = dead;
    for (let i = 0; i < 3; i++) {
      const p = c.analyze(bitmap(), ['face']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await p).toBeNull();
    }
    expect(dead).toHaveBeenCalledTimes(1);
    expect(w.terminated).toBe(true);
    vi.useRealTimers();
  });
});

describe('review fixes: voice (FR-607, TC-061)', () => {
  it('FR-607: MicVAD.new that never finishes is abandoned after the timeout with DETECTOR_UNAVAILABLE', async () => {
    vi.useFakeTimers();
    const h = fakeContext();
    const destroy = vi.fn();
    let resolveLate!: (v: { start: () => void; destroy: () => void }) => void;
    const m = new VoiceMonitor({
      getStream: () => stream,
      initTimeoutMs: 1000,
      createVad: () => new Promise((r) => (resolveLate = r)),
    });
    const p = m.start(h.ctx);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(h.events[0]).toMatchObject({
      payload: { detector: 'VOICE', reason: 'MODEL_LOAD_FAILED' },
    });
    resolveLate({ start: vi.fn(), destroy });
    await vi.advanceTimersByTimeAsync(1);
    expect(destroy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('TC-061: speech inside the cooldown is merged into the next event instead of dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = fakeContext();
    let cb!: VadCallbacks;
    let t = 1_000_000;
    const m = new VoiceMonitor({
      getStream: () => stream,
      now: () => t,
      createVad: (_s, c) => {
        cb = c;
        return Promise.resolve({ start: vi.fn(), destroy: vi.fn() });
      },
    });
    await m.start(h.ctx);
    const speak = (ms: number) => {
      cb.onSpeechStart();
      t += ms;
      cb.onSpeechEnd();
    };
    speak(5000);
    t += 1000;
    speak(2000);
    t += 1000;
    speak(3000);
    expect(h.events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.events).toHaveLength(2);
    expect(h.events[1]?.options).toMatchObject({ durationMs: 5000 });
    await m.stop();
    vi.useRealTimers();
  });

  it('TC-061: stop() reports speech still held back by the cooldown', async () => {
    const h = fakeContext();
    let cb!: VadCallbacks;
    let t = 5_000_000;
    const m = new VoiceMonitor({
      getStream: () => stream,
      now: () => t,
      createVad: (_s, c) => {
        cb = c;
        return Promise.resolve({ start: vi.fn(), destroy: vi.fn() });
      },
    });
    await m.start(h.ctx);
    cb.onSpeechStart();
    t += 2000;
    cb.onSpeechEnd();
    t += 500;
    cb.onSpeechStart();
    t += 1500;
    cb.onSpeechEnd();
    await m.stop();
    expect(h.events.map((e) => e.options?.durationMs)).toEqual([2000, 1500]);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('review blockers: abandoned start, bounded play, stream swap (FR-606, FR-607)', () => {
  it('FR-606: a vision start that completes after the session timeout is stopped, silent and leaks nothing', async () => {
    const worker = new FakeWorker();
    let releaseReady!: () => void;
    const origPost = worker.postMessage.bind(worker);
    worker.postMessage = (msg) => {
      if (msg.type === 'init') releaseReady = () => origPost(msg);
      else origPost(msg);
    };
    const vision = new VisionMonitor({
      getWebcamStream: () => stream,
      createWorker: () => worker,
      modelBaseUrl: '/models/proctor',
      grabFrame: () => Promise.resolve(bitmap()),
      createVideo: fakeVideo,
      initTimeoutMs: 60_000,
    });
    const session = new ProctorSession();
    const seen: string[] = [];
    session.on('event', (e) =>
      seen.push(`${e.type}:${(e.payload as { detector?: string }).detector ?? ''}`),
    );
    await session.start({
      sessionId: 'late',
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: { sendBatch: () => Promise.resolve('OK'), heartbeat: () => Promise.resolve(true) },
      detectors: [vision],
      detectorStartTimeoutMs: 30,
    });
    // timeout: every task reported unavailable, worker not started sampling
    expect(seen.sort()).toEqual([
      'DETECTOR_UNAVAILABLE:FACE',
      'DETECTOR_UNAVAILABLE:GAZE',
      'DETECTOR_UNAVAILABLE:OBJECT',
    ]);
    releaseReady(); // the models "finish loading" late
    await new Promise((r) => setTimeout(r, 30));
    expect(worker.terminated).toBe(true);
    expect(vision.getStats().tasks).toEqual([]);
    expect(seen).toHaveLength(3); // no events after the timeout report
    await session.stop();
  });

  it('FR-606: video.play() that never resolves does not hold start() open beyond 5 s', async () => {
    vi.useFakeTimers();
    const h = fakeContext();
    const { m } = setup({
      createVideo: () => ({
        ...fakeVideo(),
        play: () => new Promise<void>(() => undefined),
      }),
    });
    const p = m.start(h.ctx);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(m.getStats().tasks.sort()).toEqual(['face', 'gaze', 'objects']);
    m.stop();
    vi.useRealTimers();
  });

  it('FR-606: attachStream on a running monitor swaps the video source to the restarted webcam', async () => {
    const h = fakeContext();
    const video = fakeVideo();
    const { m } = setup({ createVideo: () => video });
    await m.start(h.ctx);
    expect(video.srcObject).toBe(stream);
    const fresh = {} as MediaStream;
    await m.attachStream(fresh);
    expect(video.srcObject).toBe(fresh);
    expect(m.getStats().tasks.sort()).toEqual(['face', 'gaze', 'objects']);
    m.stop();
  });

  it('FR-607: VoiceMonitor.attachStream restarts the VAD on the new microphone stream', async () => {
    const h = fakeContext();
    const used: MediaStream[] = [];
    const destroys: number[] = [];
    const m = new VoiceMonitor({
      getStream: () => stream,
      createVad: (s) => {
        used.push(s);
        const id = used.length;
        return Promise.resolve({ start: vi.fn(), destroy: () => void destroys.push(id) });
      },
    });
    await m.start(h.ctx);
    const fresh = {} as MediaStream;
    await m.attachStream(fresh);
    expect(used).toEqual([stream, fresh]);
    expect(destroys).toEqual([1]);
    await m.stop();
    expect(destroys).toEqual([1, 2]);
  });

  it('FR-606: an old run resuming from video.play() after a new run started cannot tear that run down', async () => {
    const workerA = new FakeWorker();
    const workerB = new FakeWorker();
    const workers = [workerA, workerB];
    let releasePlay!: () => void;
    const video1 = {
      ...fakeVideo(),
      play: () =>
        new Promise<void>((r) => {
          releasePlay = r;
        }),
    };
    const video2 = fakeVideo();
    const videos = [video1, video2];
    const vision = new VisionMonitor({
      getWebcamStream: () => stream,
      createWorker: () => workers.shift() as FakeWorker,
      modelBaseUrl: '/models/proctor',
      grabFrame: () => Promise.resolve(bitmap()),
      createVideo: () => videos.shift() as HTMLVideoElement,
      autoStart: false,
    });
    const cfg = (id: string, startTimeout: number) => ({
      sessionId: id,
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: {
        sendBatch: () => Promise.resolve('OK' as const),
        heartbeat: () => Promise.resolve(true),
      },
      detectors: [vision],
      detectorStartTimeoutMs: startTimeout,
    });
    const s1 = new ProctorSession();
    // (workerA.terminated is not asserted: the session's stop() of the abandoned run already
    // terminates it, so it would be true with or without the generation guard.)
    await s1.start(cfg('run1', 30)); // run 1 sits in video.play(); the session abandons it
    const s2 = new ProctorSession();
    await s2.start(cfg('run2', 5000)); // same instance, new session, worker B and video 2
    expect(vision.getStats().tasks.sort()).toEqual(['face', 'gaze', 'objects']);
    releasePlay(); // run 1's play() finally resolves, after run 2 started
    await new Promise((r) => setTimeout(r, 20));
    expect(video1.srcObject).toBeNull(); // run 1 released only its own video
    expect(video2.srcObject).toBe(stream); // run 2's video is intact
    expect(workerB.terminated).toBe(false);
    expect(vision.getStats().tasks.sort()).toEqual(['face', 'gaze', 'objects']);
    await vision.tick(); // run 2 can still sample
    expect(workerB.frames.length).toBeGreaterThan(0);
    await s2.stop();
    await s1.stop();
  });

  it('FR-606: a reused instance whose second start fails reports DETECTOR_UNAVAILABLE for every task, not a silent pass', async () => {
    const workerA = new FakeWorker();
    workerA.postMessage = () => undefined; // run 1: init never answered, session times out
    const workerB = new FakeWorker();
    const workers = [workerA, workerB];
    let calls = 0;
    const vision = new VisionMonitor({
      getWebcamStream: () => stream,
      createWorker: () => workers.shift() as FakeWorker,
      modelBaseUrl: '/models/proctor',
      grabFrame: () => Promise.resolve(bitmap()),
      createVideo: () => {
        calls++;
        throw new Error('no video'); // run 2 fails after the models loaded
      },
      initTimeoutMs: 60_000,
      autoStart: false,
    });
    const cfg = (id: string, startTimeout: number) => ({
      sessionId: id,
      hmacKeyBase64: TEST_KEY_B64,
      root: document.createElement('div'),
      consent: { recordedAt: '2026-01-01T00:00:00Z' },
      transport: {
        sendBatch: () => Promise.resolve('OK' as const),
        heartbeat: () => Promise.resolve(true),
      },
      detectors: [vision],
      detectorStartTimeoutMs: startTimeout,
    });
    const s1 = new ProctorSession();
    await s1.start(cfg('sfc1', 30));
    const s2 = new ProctorSession();
    const events: string[] = [];
    const caps: string[] = [];
    s2.on('event', (e) =>
      events.push(`${e.type}:${(e.payload as { detector?: string }).detector ?? ''}`),
    );
    s2.on('capability', (c) => caps.push(`${c.id}:${c.status}`));
    await s2.start(cfg('sfc2', 5000));
    expect(calls).toBe(1);
    expect(events.sort()).toEqual([
      'DETECTOR_UNAVAILABLE:FACE',
      'DETECTOR_UNAVAILABLE:GAZE',
      'DETECTOR_UNAVAILABLE:OBJECT',
    ]);
    // SUPPORTED flags set before the failure are reset to UNSUPPORTED
    for (const t of ['face', 'gaze', 'objects']) {
      expect(caps.filter((c) => c.startsWith(`vision-${t}:`)).at(-1)).toBe(
        `vision-${t}:UNSUPPORTED`,
      );
    }
    await s2.stop();
    await s1.stop();
  });
});

describe('should-fix round (FR-606, FR-607)', () => {
  it('FR-606: after a frame timeout the worker keeps back-pressure until it answers late, then is free again', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const frames: number[] = [];
    const orig = w.postMessage.bind(w);
    w.postMessage = (msg) => {
      if (msg.type === 'init') orig(msg);
      else frames.push(msg.id);
    };
    const c = new InferenceClient(() => w, 30_000, 1000);
    const init = c.init({
      tasks: ['face'],
      urls: { faceDetector: '', faceLandmarker: '', mediapipeWasm: '', cocoSsd: '' },
    });
    await vi.advanceTimersByTimeAsync(1);
    await init;
    const p1 = c.analyze(bitmap(), ['face']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p1).toBeNull(); // timed out
    expect(await c.analyze(bitmap(), ['face'])).toBeNull(); // still busy: skipped, not posted
    expect(frames).toHaveLength(1);
    w.onmessage?.({
      data: { type: 'result', id: frames[0] as number, busyMs: 5 },
    } as MessageEvent<FromWorker>);
    const p2 = c.analyze(bitmap(), ['face']); // the worker answered late: free again
    expect(frames).toHaveLength(2);
    w.onmessage?.({
      data: { type: 'result', id: frames[1] as number, busyMs: 5 },
    } as MessageEvent<FromWorker>);
    expect(await p2).not.toBeNull();
    vi.useRealTimers();
  });

  it('FR-606: if the worker never answers the frame it timed out on, it is declared dead after another timeout', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const orig = w.postMessage.bind(w);
    w.postMessage = (msg) => {
      if (msg.type === 'init') orig(msg);
    };
    const c = new InferenceClient(() => w, 30_000, 1000);
    const init = c.init({
      tasks: ['face'],
      urls: { faceDetector: '', faceLandmarker: '', mediapipeWasm: '', cocoSsd: '' },
    });
    await vi.advanceTimersByTimeAsync(1);
    await init;
    const dead = vi.fn();
    c.onDead = dead;
    const p = c.analyze(bitmap(), ['face']);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(dead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dead).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('FR-606: attachStream retries only when the monitor was down for lack of a stream, not after a model failure', async () => {
    const h = fakeContext();
    const { m, worker, createWorker } = setup({ getWebcamStream: () => null }, { objects: false });
    await m.start(h.ctx);
    expect(createWorker).not.toHaveBeenCalled(); // no stream: nothing loaded yet
    const before = h.events.length;
    await m.attachStream(stream); // the missing stream arrived: load now
    expect(createWorker).toHaveBeenCalledTimes(1);
    const afterLoad = h.events.length;
    expect(afterLoad).toBeGreaterThan(before); // OBJECT model failed: reported once
    m.stop();
    // second monitor: models fail to load, a later stream swap must not re-run and re-emit
    const h2 = fakeContext();
    const s2 = setup({}, { face: false, gaze: false, objects: false });
    await s2.m.start(h2.ctx);
    const reported = h2.events.length;
    await s2.m.attachStream(stream);
    expect(h2.events).toHaveLength(reported);
    expect(s2.createWorker).toHaveBeenCalledTimes(1);
    expect(worker).toBeDefined();
  });

  it('FR-606: attachStream on a running monitor does not hang when play() never resolves', async () => {
    vi.useFakeTimers();
    const h = fakeContext();
    const video = {
      ...fakeVideo(),
      play: () => new Promise<void>(() => undefined),
    };
    const { m } = setup({ createVideo: () => video });
    const started = m.start(h.ctx);
    await vi.advanceTimersByTimeAsync(5000);
    await started;
    const swap = m.attachStream({} as MediaStream);
    await vi.advanceTimersByTimeAsync(5000);
    await swap; // resolved: the swap is bounded
    m.stop();
    vi.useRealTimers();
  });

  it('FR-606: reportStartTimeout does not re-emit for tasks that were already reported', () => {
    const h = fakeContext();
    const { m } = setup();
    // first report all three, then a second report must stay silent
    m.reportStartTimeout(h.ctx);
    const n = h.events.length;
    expect(n).toBe(3);
    m.reportStartTimeout(h.ctx);
    expect(h.events).toHaveLength(n);
  });

  it('FR-607: VoiceMonitor attachStream calls are serialised, keep held-back speech, and the monitor can restart after stop()', async () => {
    const h = fakeContext();
    const order: string[] = [];
    let cb!: VadCallbacks;
    const m = new VoiceMonitor({
      getStream: () => stream,
      createVad: async (_s, c) => {
        cb = c;
        order.push('create');
        await new Promise((r) => setTimeout(r, 5));
        return {
          start: vi.fn(),
          destroy: () => {
            order.push('destroy');
          },
        };
      },
    });
    await m.start(h.ctx);
    const a = m.attachStream({} as MediaStream);
    const b = m.attachStream({} as MediaStream);
    await Promise.all([a, b]);
    // never two live VADs: each create is preceded by the destroy of the previous one
    expect(order).toEqual(['create', 'destroy', 'create', 'destroy', 'create']);
    expect(cb).toBeDefined();
    await m.stop();
    await m.start(h.ctx); // restart on the same instance
    expect(order.at(-1)).toBe('create');
    await m.stop();
  });
});

describe('voice: exactly one live VAD (B2, FR-607)', () => {
  function vadRig(delayMs = 0) {
    let live = 0;
    let maxLive = 0;
    const callbacks: VadCallbacks[] = [];
    const createVad = async (_s: MediaStream, c: VadCallbacks) => {
      callbacks.push(c);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      live++;
      maxLive = Math.max(maxLive, live);
      return {
        start: vi.fn(),
        destroy: () => {
          live--;
        },
      };
    };
    return { createVad, live: () => live, maxLive: () => maxLive, callbacks };
  }

  it('FR-607: attachStream during a slow start ends with exactly one live handle', async () => {
    const h = fakeContext();
    const r = vadRig(30);
    const m = new VoiceMonitor({ getStream: () => stream, createVad: r.createVad });
    const starting = m.start(h.ctx);
    const attaching = m.attachStream({} as MediaStream); // arrives while the first VAD is loading
    await Promise.all([starting, attaching]);
    expect(r.live()).toBe(1);
    expect(r.maxLive()).toBe(1);
    await m.stop();
    expect(r.live()).toBe(0);
  });

  it('FR-607: stop() then start() with an attach queued before the stop leaves one live handle and no duplicate SPEECH_DETECTED', async () => {
    const h = fakeContext();
    let t = 1_000_000;
    const r = vadRig(20);
    const m = new VoiceMonitor({ getStream: () => stream, createVad: r.createVad, now: () => t });
    const first = m.start(h.ctx);
    const staleAttach = m.attachStream({} as MediaStream); // queued under the old generation
    await m.stop();
    const second = m.start(h.ctx);
    await Promise.all([first, staleAttach, second]);
    expect(r.live()).toBe(1);
    const speech = () => h.events.filter((e) => e.type === 'SPEECH_DETECTED');
    const live = r.callbacks.at(-1) as VadCallbacks;
    const stale = r.callbacks.slice(0, -1);
    expect(stale.length).toBeGreaterThan(0);
    // callbacks of every older VAD are ignored: a full segment on them reports nothing
    for (const cb of stale) {
      cb.onSpeechStart();
      t += 2000;
      cb.onSpeechEnd();
    }
    expect(speech()).toHaveLength(0);
    // the live VAD reports exactly one event for its segment
    live.onSpeechStart();
    t += 2000;
    live.onSpeechEnd();
    expect(speech()).toHaveLength(1);
    await m.stop();
    expect(speech()).toHaveLength(1); // stop() flushes nothing extra
  });

  it('FR-607: start() on a running monitor replaces the VAD instead of adding a second one', async () => {
    const h = fakeContext();
    const r = vadRig();
    const m = new VoiceMonitor({ getStream: () => stream, createVad: r.createVad });
    await m.start(h.ctx);
    await m.start(h.ctx);
    expect(r.live()).toBe(1);
    await m.stop();
  });
});

describe('vision: down state (S5, FR-606)', () => {
  it('FR-606: NO_STREAM then attach that fails to load: a further attach does not re-run or re-emit', async () => {
    const h = fakeContext();
    let current: MediaStream | null = null;
    const { m, createWorker } = setup(
      { getWebcamStream: () => current },
      { face: false, gaze: false, objects: false },
    );
    await m.start(h.ctx); // no stream: PERMISSION_DENIED x3, down for lack of a stream
    expect(createWorker).not.toHaveBeenCalled();
    await m.attachStream(stream); // loads, every model fails: now down for FAILED
    expect(createWorker).toHaveBeenCalledTimes(1);
    const emitted = h.events.length;
    await m.attachStream(stream);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(emitted);
    current = null;
    m.stop();
  });
});

describe('voice: an abandoned begin reports nothing (S-B, FR-607)', () => {
  it('FR-607: a createVad that rejects after stop() and restart emits no DETECTOR_UNAVAILABLE and keeps the newer SUPPORTED flag', async () => {
    const h = fakeContext();
    let rejectFirst!: (e: Error) => void;
    let calls = 0;
    const m = new VoiceMonitor({
      getStream: () => stream,
      createVad: () => {
        calls++;
        if (calls === 1) {
          return new Promise((_r, rej) => {
            rejectFirst = rej;
          });
        }
        return Promise.resolve({ start: vi.fn(), destroy: vi.fn() });
      },
    });
    const first = m.start(h.ctx); // hangs in createVad
    await new Promise((r) => setTimeout(r, 5));
    await m.stop();
    const second = m.start(h.ctx); // queued behind the first
    rejectFirst(new Error('model 404')); // the abandoned begin fails late
    await Promise.all([first, second]);
    expect(h.events.filter((e) => e.type === 'DETECTOR_UNAVAILABLE')).toHaveLength(0);
    expect(h.capabilities.at(-1)).toMatchObject({ id: 'voice', status: 'SUPPORTED' });
    await m.stop();
  });

  it('FR-607: a throwing destroy() of an abandoned VAD does not fall into the load-failure handling', async () => {
    const h = fakeContext();
    const m = new VoiceMonitor({
      getStream: () => stream,
      createVad: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          start: vi.fn(),
          destroy: () => {
            throw new Error('destroy failed');
          },
        };
      },
    });
    const starting = m.start(h.ctx);
    await m.stop();
    await starting;
    expect(h.events.filter((e) => e.type === 'DETECTOR_UNAVAILABLE')).toHaveLength(0);
  });
});
