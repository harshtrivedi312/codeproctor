import type { Detector, DetectorContext } from '../core/types';
import { DEFAULT_AI_CONFIG, type AiDetectorConfig } from './config';
import { SpeechRules } from './rules';

export interface VadHandle {
  start(): void | Promise<void>;
  destroy(): void | Promise<void>;
}
export interface VadCallbacks {
  onSpeechStart(): void;
  onSpeechEnd(): void;
}
/** Creates a voice activity detector on a stream; the default one wraps @ricky0123/vad-web. */
export type VadFactory = (stream: MediaStream, cb: VadCallbacks) => Promise<VadHandle>;

/**
 * Silero VAD in the browser through vad-web (FR-607). Assets (ONNX model, worklet, onnxruntime
 * wasm) come from the self-hosted `assetBase`. The dynamic import keeps vad-web and onnxruntime out
 * of the bundle until a candidate actually has the voice detector enabled.
 */
export function createVadWebFactory(assetBase: string): VadFactory {
  return async (stream, cb) => {
    const { MicVAD } = await import('@ricky0123/vad-web');
    const vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: assetBase,
      onnxWASMBasePath: assetBase,
      getStream: () => Promise.resolve(stream),
      // The recorder owns these tracks and consent gating: vad-web must neither stop them on pause
      // nor call getUserMedia itself on resume.
      pauseStream: () => Promise.resolve(),
      resumeStream: (s) => Promise.resolve(s),
      onSpeechRealStart: () => cb.onSpeechStart(),
      onSpeechEnd: () => cb.onSpeechEnd(),
    });
    return { start: () => vad.start(), destroy: () => vad.destroy() };
  };
}

export interface VoiceMonitorOptions {
  /** The audio stream also used by the recorder; the monitor never opens the microphone itself. */
  getStream: () => MediaStream | null;
  createVad: VadFactory;
  config?: Partial<AiDetectorConfig>;
  /** Give up on VAD model load after this long (default 30 s). */
  initTimeoutMs?: number;
  now?: () => number;
}

/** FR-607: SPEECH_DETECTED with duration. MULTIPLE_VOICES is a server-side result (audio re-check). */
export class VoiceMonitor implements Detector {
  readonly id = 'voice';
  readonly accommodationId = 'VOICE' as const;
  private handle: VadHandle | null = null;
  private stopped = false;
  private rules: SpeechRules | null = null;
  private ctx: DetectorContext | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: VoiceMonitorOptions) {}

  private emitEvents(ctx: DetectorContext, events: ReturnType<SpeechRules['flush']>): void {
    for (const e of events) {
      ctx.emit(
        'SPEECH_DETECTED',
        {},
        { occurredAt: new Date(e.startedAtMs), durationMs: e.durationMs ?? 0 },
      );
    }
  }

  async start(ctx: DetectorContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false; // a monitor instance can be started again after stop()
    const gen = ++this.gen;
    const stream = this.o.getStream();
    if (!stream) {
      ctx.setCapability({ id: 'voice', status: 'DENIED', detail: 'No microphone stream.' });
      ctx.emit('DETECTOR_UNAVAILABLE', { detector: 'VOICE', reason: 'PERMISSION_DENIED' });
      return;
    }
    // Through the same queue as attachStream: two VADs must never run at once.
    await this.serial(() => this.begin(ctx, stream, gen));
  }

  reportStartTimeout(ctx: DetectorContext): void {
    // The session emits DETECTOR_UNAVAILABLE for detectors that declare an accommodationId.
    ctx.setCapability({ id: 'voice', status: 'UNSUPPORTED', detail: 'Voice start timed out.' });
  }

  /**
   * A new microphone stream (for example after `recordAudio()` restarted following a device
   * loss): restart the VAD on it instead of listening to a dead stream.
   */
  attachStream(stream: MediaStream): Promise<void> {
    const gen = this.gen; // an attach queued before stop() must not act after a restart
    return this.serial(async () => {
      const ctx = this.ctx;
      if (!ctx || this.stopped || gen !== this.gen) return;
      await this.begin(ctx, stream, gen);
    });
  }

  /** Runs `fn` after every earlier start or attach has finished. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.attachChain.then(fn);
    this.attachChain = run.catch(() => undefined);
    return run;
  }

  private attachChain: Promise<void> = Promise.resolve();
  /** Bumped by start() and stop(): work queued under an older generation is dropped. */
  private gen = 0;
  /** Identifies the live VAD; callbacks of an older one are ignored. */
  private token = 0;

  private async destroyHandle(): Promise<void> {
    const old = this.handle;
    this.handle = null;
    await old?.destroy();
  }

  private async begin(ctx: DetectorContext, stream: MediaStream, gen: number): Promise<void> {
    // Exactly one live VAD: release any existing one first and ignore its late callbacks.
    const token = ++this.token;
    await this.destroyHandle();
    const cfg = { ...DEFAULT_AI_CONFIG, ...this.o.config };
    // Reuse the rules on a stream swap so speech held back by the cooldown is not lost.
    const rules = (this.rules ??= new SpeechRules(cfg));
    const now = this.o.now ?? Date.now;
    let startedAt: number | null = null;
    try {
      const creating = this.o.createVad(stream, {
        onSpeechStart: () => {
          if (token !== this.token) return;
          startedAt = now();
        },
        onSpeechEnd: () => {
          if (token !== this.token || startedAt === null) return;
          const s = startedAt;
          startedAt = null;
          ctx.measure('voice', () => {
            this.emitEvents(ctx, rules.onSegment(s, now()));
            if (rules.hasPending && !this.flushTimer) {
              // Speech held back by the cooldown must still be reported.
              this.flushTimer = setTimeout(
                () => {
                  this.flushTimer = null;
                  this.emitEvents(ctx, rules.flush(now()));
                },
                Math.min(cfg.cooldownMs, 10_000),
              );
            }
          });
        },
      });
      // MicVAD.new can hang on a missing model or wasm; give up and say so.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('vad init timeout')),
          this.o.initTimeoutMs ?? 30_000,
        );
      });
      try {
        const created = await Promise.race([creating, timeout]);
        if (gen !== this.gen || this.stopped || token !== this.token) {
          // Abandoned (stop, restart or a newer attach) while loading: release it, keep none.
          await created.destroy();
          return;
        }
        this.handle = created;
      } catch (err) {
        // If the VAD finishes loading after the timeout, release it.
        void creating.then((h) => h.destroy()).catch(() => undefined);
        throw err;
      } finally {
        clearTimeout(timer);
      }
      await this.handle?.start();
      ctx.setCapability({ id: 'voice', status: 'SUPPORTED' });
    } catch {
      ctx.setCapability({
        id: 'voice',
        status: 'UNSUPPORTED',
        detail: 'Voice model failed to load.',
      });
      ctx.emit('DETECTOR_UNAVAILABLE', { detector: 'VOICE', reason: 'MODEL_LOAD_FAILED' });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.gen++;
    this.token++;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.ctx && this.rules) {
      this.emitEvents(this.ctx, this.rules.flush((this.o.now ?? Date.now)()));
    }
    await this.handle?.destroy();
    this.handle = null;
    this.ctx = null;
    this.rules = null;
  }
}
