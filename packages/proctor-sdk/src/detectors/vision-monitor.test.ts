import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProctorSession } from '../core/session';
import { TEST_KEY_B64 } from '../test/helpers';
import { fakeContext } from '../test/helpers';
import { NO_FACE_SEQUENCE, PHONE_STRONG, secondsOf } from './__fixtures__/samples';
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
      120_000,
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
    await vi.advanceTimersByTimeAsync(120_000);
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

  it('FR-606: a worker that errors after ready is terminated and RUNTIME_ERROR is emitted', async () => {
    const h = fakeContext();
    const { m, worker } = setup();
    await m.start(h.ctx);
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

afterEach(() => vi.restoreAllMocks());

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

  it('TC-070 FR-606: a reused instance whose second start fails reports DETECTOR_UNAVAILABLE for every task, not a silent pass', async () => {
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
