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
  now?: () => number;
}

/** FR-607: SPEECH_DETECTED with duration. MULTIPLE_VOICES is a server-side result (audio re-check). */
export class VoiceMonitor implements Detector {
  readonly id = 'voice';
  readonly accommodationId = 'VOICE' as const;
  private handle: VadHandle | null = null;
  private stopped = false;

  constructor(private readonly o: VoiceMonitorOptions) {}

  async start(ctx: DetectorContext): Promise<void> {
    const stream = this.o.getStream();
    if (!stream) {
      ctx.setCapability({ id: 'voice', status: 'DENIED', detail: 'No microphone stream.' });
      ctx.emit('DETECTOR_UNAVAILABLE', { detector: 'VOICE', reason: 'PERMISSION_DENIED' });
      return;
    }
    const cfg = { ...DEFAULT_AI_CONFIG, ...this.o.config };
    const rules = new SpeechRules(cfg);
    const now = this.o.now ?? Date.now;
    let startedAt: number | null = null;
    try {
      this.handle = await this.o.createVad(stream, {
        onSpeechStart: () => {
          startedAt = now();
        },
        onSpeechEnd: () => {
          if (startedAt === null) return;
          const s = startedAt;
          startedAt = null;
          ctx.measure('voice', () => {
            for (const e of rules.onSegment(s, now())) {
              ctx.emit(
                'SPEECH_DETECTED',
                {},
                { occurredAt: new Date(s), durationMs: e.durationMs ?? 0 },
              );
            }
          });
        },
      });
      if (this.stopped) {
        await this.handle.destroy();
        return;
      }
      await this.handle.start();
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
    await this.handle?.destroy();
    this.handle = null;
  }
}
