import { IdbStore, STORES } from '../core/idb';
import {
  ChunkRecorder,
  isProfileSupported,
  SCREEN_FRAME_RATE,
  WEBCAM_CONSTRAINTS,
  type RecorderFactory,
} from './recorder';
import { UploadQueue } from './upload-queue';
import type { CapabilityFlag } from '../core/types';
import type { MediaApi, RecorderHealth, RecordingStream } from './types';

export interface RecordingPipelineOptions {
  sessionId: string;
  api: MediaApi;
  /** Throws ConsentRequiredError until consent is recorded. Called before every device request. */
  assertConsent: () => void;
  store?: IdbStore;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  recorderFactory?: RecorderFactory;
  isTypeSupported?: (t: string) => boolean;
  put?: ConstructorParameters<typeof UploadQueue>[0]['put'];
  onHealth?: (h: RecorderHealth) => void;
  onCapability?: (f: CapabilityFlag) => void;
  maxBufferBytes?: number;
  backoffBaseMs?: number;
}

/**
 * Ties recorders to the upload queue (FR-701, FR-702). The screen stream comes from
 * ScreenShareMonitor.request() so the picker is shown once; webcam and audio use getUserMedia.
 * Every device request calls assertConsent() first, so nothing is requested before consent.
 */
export class RecordingPipeline {
  private readonly queue: UploadQueue;
  private readonly store: IdbStore;
  private readonly recorders = new Map<RecordingStream, ChunkRecorder>();
  private readonly owned = new Map<RecordingStream, MediaStream>();
  private readonly onOnline = (): void => this.queue.retryNow();
  private started = false;

  constructor(private readonly o: RecordingPipelineOptions) {
    this.store = o.store ?? new IdbStore();
    this.queue = new UploadQueue({
      sessionId: o.sessionId,
      api: o.api,
      store: this.store,
      ...(o.put ? { put: o.put } : {}),
      ...(o.onHealth ? { onHealth: o.onHealth } : {}),
      ...(o.maxBufferBytes === undefined ? {} : { maxBufferBytes: o.maxBufferBytes }),
      ...(o.backoffBaseMs === undefined ? {} : { backoffBaseMs: o.backoffBaseMs }),
    });
  }

  /** Resume uploads left over from a previous page load (FR-702). Needs no device access. */
  async start(): Promise<void> {
    await this.queue.start();
    globalThis.addEventListener?.('online', this.onOnline);
    this.started = true;
  }

  health(): RecorderHealth {
    return this.queue.health();
  }

  get webcamStream(): MediaStream | null {
    return this.owned.get('WEBCAM') ?? null;
  }

  private async nextSegment(stream: RecordingStream): Promise<number> {
    const key = `${this.o.sessionId}:segment:${stream}`;
    const stored = (await this.store.get<number>(STORES.meta, key)) ?? -1;
    const next = Math.max(stored, this.queue.maxSegment(stream)) + 1;
    await this.store.put(STORES.meta, key, next);
    return next;
  }

  private supported(stream: RecordingStream): boolean {
    const ok = isProfileSupported(stream, this.o.isTypeSupported);
    if (!ok) {
      this.o.onCapability?.({
        id: `record-${stream.toLowerCase()}`,
        status: 'UNSUPPORTED',
        detail: 'This browser cannot record webm VP8/Opus; this stream is not recorded.',
      });
    }
    return ok;
  }

  /** Record a screen stream the caller already obtained (displaySurface was checked there). */
  async recordScreen(stream: MediaStream): Promise<boolean> {
    this.o.assertConsent();
    if (!this.supported('SCREEN')) return false;
    // 5 fps keeps files small; some browsers ignore it, which is fine.
    await stream
      .getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: SCREEN_FRAME_RATE, max: SCREEN_FRAME_RATE } })
      .catch(() => undefined);
    await this.begin('SCREEN', stream);
    return true;
  }

  async recordWebcam(): Promise<MediaStream | null> {
    this.o.assertConsent();
    if (!this.supported('WEBCAM')) return null;
    const md = this.o.mediaDevices ?? navigator.mediaDevices;
    let s: MediaStream;
    try {
      s = await md.getUserMedia({ video: WEBCAM_CONSTRAINTS, audio: false });
    } catch {
      this.o.onCapability?.({ id: 'record-webcam', status: 'DENIED' });
      return null;
    }
    this.owned.set('WEBCAM', s);
    await this.begin('WEBCAM', s);
    return s;
  }

  async recordAudio(): Promise<MediaStream | null> {
    this.o.assertConsent();
    if (!this.supported('AUDIO')) return null;
    const md = this.o.mediaDevices ?? navigator.mediaDevices;
    let s: MediaStream;
    try {
      s = await md.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch {
      this.o.onCapability?.({ id: 'record-audio', status: 'DENIED' });
      return null;
    }
    this.owned.set('AUDIO', s);
    await this.begin('AUDIO', s);
    return s;
  }

  private async begin(stream: RecordingStream, media: MediaStream): Promise<void> {
    if (!this.started) await this.start();
    await this.recorders.get(stream)?.stop();
    const segment = await this.nextSegment(stream);
    const rec = new ChunkRecorder(
      stream,
      segment,
      (c, d) => this.queue.add(c, d),
      this.o.recorderFactory,
    );
    this.recorders.set(stream, rec);
    rec.start(media);
  }

  /** Stop one stream (for example when the screen share ended). The final chunk is flushed. */
  async stopStream(stream: RecordingStream): Promise<void> {
    await this.recorders.get(stream)?.stop();
    this.recorders.delete(stream);
    this.owned
      .get(stream)
      ?.getTracks()
      .forEach((t) => t.stop());
    this.owned.delete(stream);
  }

  /** Stop recording; unsent chunks stay in IndexedDB and upload on the next load. */
  async stop(): Promise<void> {
    globalThis.removeEventListener?.('online', this.onOnline);
    for (const s of [...this.recorders.keys()]) await this.stopStream(s);
    this.queue.stop();
  }
}
