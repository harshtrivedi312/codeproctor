import type { ProctorDetector } from '@codeproctor/shared';
import type { Detector, DetectorContext } from '../core/types';
import { DEFAULT_AI_CONFIG, resolveModelUrls, type AiDetectorConfig } from './config';
import { needsEvidence, captureJpeg, uploadEvidence, type EvidenceApi } from './evidence';
import { IdentityScheduler, type IdentityRechecker } from './identity';
import { InferenceClient, type WorkerLike } from './inference-client';
import type { InferenceTask, ResultMessage } from './protocol';
import { FaceRules, GazeRules, ObjectRules, type RuleEvent } from './rules';

export interface VisionMonitorOptions {
  /** Webcam stream owned by the recording pipeline; the monitor never opens the camera itself. */
  getWebcamStream: () => MediaStream | null;
  createWorker: () => WorkerLike;
  /** Same-origin base of the self-hosted model files. */
  modelBaseUrl: string;
  config?: Partial<AiDetectorConfig>;
  /** Give up on worker init after this long (default 30 s). */
  initTimeoutMs?: number;
  evidenceApi?: EvidenceApi;
  recheckIdentity?: IdentityRechecker;
  /** Test seams. */
  now?: () => number;
  grabFrame?: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  captureSnapshot?: () => Promise<Blob | null>;
  createVideo?: () => HTMLVideoElement;
  /** Set false in tests to drive tick() by hand. */
  autoStart?: boolean;
}

const TASK_TO_DETECTOR: Record<InferenceTask, ProctorDetector> = {
  face: 'FACE',
  gaze: 'GAZE',
  objects: 'OBJECT',
};
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Webcam analysis (FR-606): face (NO_FACE, MULTIPLE_FACES), gaze, phone and book detection, the
 * periodic identity re-check, and JPEG evidence for HIGH events. Inference runs in a Web Worker;
 * this class samples frames, applies thresholds and debouncing (rules.ts) and emits events.
 * A detector that an accommodation disabled (ctx.isDisabled) never loads its model or runs.
 * If a model fails to load, DETECTOR_UNAVAILABLE is emitted instead of a silent pass.
 */
/** play() can hang (autoplay policy, no frames); never let it hold a start or a swap open. */
async function playBounded(video: HTMLVideoElement, ms = 5000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    video.play().catch(() => undefined),
    new Promise<void>((r) => {
      timer = setTimeout(r, ms);
    }),
  ]);
  clearTimeout(timer);
}

export class VisionMonitor implements Detector {
  readonly id = 'vision';
  private ctx: DetectorContext | null = null;
  private client: InferenceClient | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private identity: IdentityScheduler | null = null;
  private tasks = new Set<InferenceTask>();
  private failures = new Map<InferenceTask, number>();
  private face!: FaceRules;
  private gaze!: GazeRules;
  private objects!: ObjectRules;
  private cfg: AiDetectorConfig = DEFAULT_AI_CONFIG;
  private readonly now: () => number;
  private lastTaskAt: Record<InferenceTask, number> = {
    face: -Infinity,
    gaze: -Infinity,
    objects: -Infinity,
  };

  constructor(private readonly o: VisionMonitorOptions) {
    this.now = o.now ?? Date.now;
  }

  private unavailable(
    ctx: DetectorContext,
    task: InferenceTask,
    reason: 'MODEL_LOAD_FAILED' | 'PERMISSION_DENIED' | 'UNSUPPORTED' | 'RUNTIME_ERROR',
  ): void {
    this.reported.add(task);
    ctx.setCapability({
      id: `vision-${task}`,
      status: reason === 'PERMISSION_DENIED' ? 'DENIED' : 'UNSUPPORTED',
      detail: reason,
    });
    ctx.emit('DETECTOR_UNAVAILABLE', { detector: TASK_TO_DETECTOR[task], reason });
  }

  async start(ctx: DetectorContext): Promise<void> {
    await this.run(ctx);
  }

  /**
   * Webcam stream that arrived after start() (for example `pipeline.recordWebcam()` ran later).
   * If the monitor reported PERMISSION_DENIED for lack of a stream, it initialises now; the earlier
   * DETECTOR_UNAVAILABLE stays in the log, which is truthful about that period.
   */
  async attachStream(stream: MediaStream): Promise<void> {
    this.attached = stream;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.video) {
      // Already running (for example the webcam was restarted after a device loss): follow the
      // new stream instead of sampling a dead one.
      this.video.srcObject = stream;
      await playBounded(this.video);
      return;
    }
    if (this.tasks.size > 0 || this.client || this.down !== 'NO_STREAM') return;
    await this.run(ctx); // run() starts from clean per-run state (reported, failures, down)
  }

  private attached: MediaStream | null = null;
  /** Why no detector is running: only a missing stream is worth retrying on attachStream(). */
  private down: 'NO_STREAM' | 'FAILED' | null = null;
  /** Bumped by stop() and by a start timeout so a late startInner() can tell it was abandoned. */
  private generation = 0;

  reportStartTimeout(ctx: DetectorContext): void {
    for (const t of ['face', 'gaze', 'objects'] as const) {
      if (!ctx.isDisabled(TASK_TO_DETECTOR[t]) && !this.reported.has(t)) {
        this.unavailable(ctx, t, 'RUNTIME_ERROR');
      }
    }
  }

  private async run(ctx: DetectorContext): Promise<void> {
    const gen = this.generation;
    // stop() already clears this state, which closes the silent-pass bug; clearing here again is a
    // backstop for callers that start a reused instance without calling stop() first.
    this.reported.clear();
    this.failures.clear();
    try {
      await this.startInner(ctx);
    } catch {
      // Abandoned (stop() or a start timeout bumped the generation): a later run may own the
      // shared state now, so touch nothing.
      if (gen !== this.generation) return;
      // Cross-origin model base, video failure, anything unexpected: say so, never a silent pass.
      // Tasks that already reported SUPPORTED are included; their capability flag is reset too.
      this.client?.terminate();
      this.client = null;
      for (const t of ['face', 'gaze', 'objects'] as const) {
        if (!ctx.isDisabled(TASK_TO_DETECTOR[t]) && !this.reported.has(t)) {
          this.unavailable(ctx, t, 'MODEL_LOAD_FAILED');
        }
      }
      this.tasks.clear();
    }
  }

  private readonly reported = new Set<InferenceTask>();

  private async startInner(ctx: DetectorContext): Promise<void> {
    const gen = this.generation;
    this.ctx = ctx;
    this.cfg = { ...DEFAULT_AI_CONFIG, ...this.o.config };
    this.face = new FaceRules(this.cfg);
    this.gaze = new GazeRules(this.cfg);
    this.objects = new ObjectRules(this.cfg);

    const wanted: InferenceTask[] = (['face', 'gaze', 'objects'] as const).filter(
      (t) => !ctx.isDisabled(TASK_TO_DETECTOR[t]),
    );
    if (wanted.length === 0) return; // everything disabled by accommodations: nothing loads

    const stream = this.o.getWebcamStream() ?? this.attached;
    if (!stream) {
      for (const t of wanted) this.unavailable(ctx, t, 'PERMISSION_DENIED');
      this.down = 'NO_STREAM';
      return;
    }
    if (typeof createImageBitmap !== 'function' && !this.o.grabFrame) {
      for (const t of wanted) this.unavailable(ctx, t, 'UNSUPPORTED');
      return;
    }

    const urls = resolveModelUrls(this.o.modelBaseUrl);
    const client = new InferenceClient(this.o.createWorker, this.o.initTimeoutMs);
    this.client = client;
    client.onDead = () => {
      if (gen !== this.generation) return;
      // The worker died after it was ready: stop sampling and say so.
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      for (const t of [...this.tasks]) this.unavailable(ctx, t, 'RUNTIME_ERROR');
      this.tasks.clear();
      this.identity?.stop();
      this.identity = null;
    };
    const ready = await client.init({
      tasks: wanted,
      urls: {
        faceDetector: urls.faceDetector,
        faceLandmarker: urls.faceLandmarker,
        mediapipeWasm: urls.mediapipeWasm,
        cocoSsd: urls.cocoSsd,
      },
    });
    if (gen !== this.generation) {
      // Abandoned while the models were loading: release only OUR worker; a later run of this
      // instance owns this.client and this.tasks now.
      client.terminate();
      return;
    }
    if (!ready) {
      for (const t of wanted) this.unavailable(ctx, t, 'UNSUPPORTED');
      client.terminate();
      this.client = null;
      return;
    }
    for (const t of wanted) {
      if (ready.loaded[t]) {
        this.tasks.add(t);
        ctx.setCapability({ id: `vision-${t}`, status: 'SUPPORTED' });
      } else {
        this.unavailable(ctx, t, 'MODEL_LOAD_FAILED');
      }
    }
    if (this.tasks.size === 0) {
      client.terminate();
      this.client = null;
      return;
    }

    const video = (this.o.createVideo ?? (() => document.createElement('video')))();
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // play() can hang (autoplay policy, no frames); do not let it hold start() open.
    await playBounded(video);
    if (gen !== this.generation) {
      // Abandoned while waiting for the first frame: release our own resources only.
      video.srcObject = null;
      client.terminate();
      return;
    }
    this.video = video;
    this.down = null;

    if (this.o.recheckIdentity && this.tasks.has('face')) {
      this.identity = new IdentityScheduler(
        this.cfg.identityIntervalMs,
        () => this.snapshot(),
        this.o.recheckIdentity,
        (r) =>
          ctx.emit(
            'FACE_MISMATCH',
            r.similarity === undefined
              ? {}
              : { similarity: Math.max(-1, Math.min(1, r.similarity)) },
          ),
      );
      this.identity.start();
    }
    if (this.o.autoStart !== false) {
      this.timer = setInterval(
        () => void this.tick(),
        Math.min(this.cfg.faceIntervalMs, this.cfg.gazeIntervalMs),
      );
    }
  }

  private dueTasks(nowMs: number): InferenceTask[] {
    const due: InferenceTask[] = [];
    const every: Record<InferenceTask, number> = {
      face: this.cfg.faceIntervalMs,
      gaze: this.cfg.gazeIntervalMs,
      objects: this.cfg.objectIntervalMs,
    };
    for (const t of this.tasks) if (nowMs - this.lastTaskAt[t] >= every[t] - 50) due.push(t);
    return due;
  }

  /** One sampling step. Public so tests and the calibration screen can drive it. */
  async tick(): Promise<void> {
    const ctx = this.ctx;
    const video = this.video;
    const client = this.client;
    if (!ctx || !video || !client) return;
    const at = this.now();
    const due = this.dueTasks(at);
    if (due.length === 0) return;
    let bitmap: ImageBitmap;
    try {
      bitmap = await (this.o.grabFrame ?? ((v) => createImageBitmap(v)))(video);
    } catch {
      return; // video not ready yet
    }
    for (const t of due) this.lastTaskAt[t] = at;
    const result = await client.analyze(bitmap, due);
    if (result) this.handleResult(result, at, due);
  }

  /** Apply one worker result: thresholds, debouncing, events. */
  handleResult(r: ResultMessage, nowMs: number, asked: readonly InferenceTask[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.measure('vision', () => {
      const failed = new Set(r.failed ?? []);
      for (const t of asked) {
        const n = failed.has(t) ? (this.failures.get(t) ?? 0) + 1 : 0;
        this.failures.set(t, n);
        if (n >= MAX_CONSECUTIVE_FAILURES && this.tasks.delete(t)) {
          this.unavailable(ctx, t, 'RUNTIME_ERROR');
        }
      }
      const events: RuleEvent[] = [];
      if (r.faceCount !== undefined)
        events.push(...this.face.process({ faceCount: r.faceCount }, nowMs));
      if (asked.includes('gaze') && !failed.has('gaze')) {
        events.push(...this.gaze.process(r.gaze ?? null, nowMs));
      }
      if (r.objects) events.push(...this.objects.process(r.objects, nowMs));
      for (const e of events) void this.emitRuleEvent(ctx, e);
    });
  }

  private async emitRuleEvent(ctx: DetectorContext, e: RuleEvent): Promise<void> {
    const opts = {
      occurredAt: new Date(e.startedAtMs),
      ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
      ...(e.confidence === undefined ? {} : { confidence: e.confidence }),
    };
    const evidenceKey = needsEvidence(e.type) ? await this.captureEvidence() : null;
    const full = evidenceKey ? { ...opts, evidenceKey } : opts;
    switch (e.type) {
      case 'MULTIPLE_FACES':
        ctx.emit('MULTIPLE_FACES', { faceCount: Math.max(2, e.faceCount ?? 2) }, full);
        break;
      case 'NO_FACE':
        ctx.emit('NO_FACE', {}, full);
        break;
      case 'GAZE_AWAY':
        ctx.emit('GAZE_AWAY', {}, full);
        break;
      case 'PHONE_DETECTED':
        ctx.emit('PHONE_DETECTED', {}, full);
        break;
      case 'BOOK_DETECTED':
        ctx.emit('BOOK_DETECTED', {}, full);
        break;
    }
  }

  private async snapshot(): Promise<Blob | null> {
    if (this.o.captureSnapshot) return this.o.captureSnapshot();
    const v = this.video;
    if (!v || v.videoWidth === 0) return null;
    try {
      return await captureJpeg(
        v,
        v.videoWidth,
        v.videoHeight,
        this.cfg.snapshotMaxWidth,
        this.cfg.snapshotQuality,
      );
    } catch {
      return null;
    }
  }

  private async captureEvidence(): Promise<string | null> {
    if (!this.o.evidenceApi) return null;
    const jpeg = await this.snapshot();
    if (!jpeg) return null;
    return uploadEvidence(this.o.evidenceApi, jpeg, this.cfg.evidenceTimeoutMs);
  }

  /** Worker CPU and skipped frames, for the calibration screen and the CPU report. */
  getStats(): {
    workerBusyPercent: number;
    skippedFrames: number;
    frames: number;
    tasks: InferenceTask[];
  } {
    return {
      workerBusyPercent: this.client?.workerBusyPercent() ?? 0,
      skippedFrames: this.client?.skippedFrames ?? 0,
      frames: this.client?.frames ?? 0,
      tasks: [...this.tasks],
    };
  }

  stop(): void {
    this.generation++;
    this.reported.clear();
    this.failures.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.identity?.stop();
    this.identity = null;
    this.client?.terminate();
    this.client = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.tasks.clear();
    this.ctx = null;
  }
}
