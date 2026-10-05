import { describe, expect, it, vi } from 'vitest';
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
  it('FR-606: replays the NO_FACE fixture and emits one NO_FACE with its duration, no evidence', async () => {
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

  it('FR-801: a HIGH event (phone) carries an evidenceKey from the snapshot upload', async () => {
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

  it('FR-801: if the snapshot cannot be uploaded the event is still sent, without evidence', async () => {
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
