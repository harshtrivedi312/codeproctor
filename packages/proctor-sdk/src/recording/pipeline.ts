import { IdbStore, STORES } from '../core/idb';
import {
  ChunkRecorder,
  isProfileSupported,
  SCREEN_FRAME_RATE,
  WEBCAM_CONSTRAINTS,
  type RecorderFactory,
} from './recorder';
import { MediaCounters, type MediaCounter } from './counters';
import { UploadQueue, type UploadQueueOptions } from './upload-queue';
import type { CapabilityFlag } from '../core/types';
import {
  RECORDING_STREAMS,
  type DeviceLoss,
  type MediaApi,
  type RecorderHealth,
  type RecordingStream,
} from './types';

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
  /** A device track ended or the MediaRecorder failed. Call the record* method again to restart as a new segment. */
  onDeviceLost?: (loss: DeviceLoss) => void;
  staleAfterMs?: number;
  maxMemoryBytes?: number;
  maxBufferBytes?: number;
  backoffBaseMs?: number;
  /** Reachability probe while the connection is down, for example the session heartbeat. */
  probe?: UploadQueueOptions['probe'];
  /** The server said the session is over: uploading stopped, chunks kept (SESSION_NOT_ACTIVE). */
  onEnded?: UploadQueueOptions['onEnded'];
  /** A segment's first chunk was refused for good; it is kept and retried slowly. */
  onChunkBlocked?: UploadQueueOptions['onChunkBlocked'];
  /** Injected clock for chunk start times and durations (tests). */
  now?: () => number;
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
  private readonly counters: MediaCounters;
  /** The MediaStream each recorder reads, to restart a recorder without asking for the device again. */
  private readonly sources = new Map<RecordingStream, MediaStream>();
  /** The server said the session is over: no device may be opened or recorder started any more. */
  private ended = false;
  /** stop() or finish() began: no recorder may start any more, whatever is still awaiting. */
  private closing = false;

  constructor(private readonly o: RecordingPipelineOptions) {
    this.store = o.store ?? new IdbStore();
    this.counters = new MediaCounters(this.store, o.sessionId);
    this.queue = new UploadQueue({
      sessionId: o.sessionId,
      api: o.api,
      store: this.store,
      ...(o.put ? { put: o.put } : {}),
      ...(o.probe ? { probe: o.probe } : {}),
      onEnded: (info) => {
        this.ended = true;
        // Privacy: the session is over, so nothing more may be captured (recorders stop, their
        // last chunk is refused by the queue, every device is released).
        void this.releaseAll().catch(() => undefined);
        o.onCapability?.({
          id: 'recording-ended',
          status: 'UNVERIFIABLE',
          detail:
            'The server says the session is over: recording uploads stopped, chunks are kept.',
        });
        o.onEnded?.(info);
      },
      onSegmentLost: (info) => {
        o.onCapability?.({
          id: 'recording-segment-lost',
          status: 'UNVERIFIABLE',
          detail: `The first chunk of a ${info.stream.toLowerCase()} segment could not be buffered: that segment is lost.`,
        });
      },
      onQuota: (info) => {
        o.onCapability?.({
          id: 'recording-quota',
          status: 'UNVERIFIABLE',
          detail: `The upload quota for ${info.stream.toLowerCase()} is used up for this session; chunks wait and may never be sent.`,
        });
      },
      onSeqConflict: (info) => {
        o.onCapability?.({
          id: 'recording-seq-conflict',
          status: 'UNVERIFIABLE',
          detail: `A ${info.stream.toLowerCase()} chunk collided with one the server already confirmed (our counters were behind). The stream is held: recording continues and its chunks are kept until the counters are refreshed (seedCounters), then the held chunks are dropped and counted. Chunks confirmed under stale numbers before are not recoverable.`,
        });
      },
      onStaleIdentityLoss: (info) => {
        o.onCapability?.({
          id: 'recording-stale-identity',
          status: 'UNVERIFIABLE',
          detail: `${String(info.chunks)} ${info.stream.toLowerCase()} chunks were dropped when the counters were refreshed: they carried numbers the server had already confirmed for other chunks.`,
        });
      },
      onChunkBlocked: (info) => {
        o.onCapability?.({
          id: 'recording-blocked',
          status: 'UNVERIFIABLE',
          detail: `The server refused the first chunk of a ${info.stream.toLowerCase()} segment; it is kept and retried slowly.`,
        });
        o.onChunkBlocked?.(info);
      },
      onCapExceeded: () =>
        o.onCapability?.({
          id: 'recording-buffer',
          status: 'UNVERIFIABLE',
          detail: 'The recording buffer is full of protected chunks; it is above its cap.',
        }),
      ...(o.onHealth ? { onHealth: o.onHealth } : {}),
      ...(o.staleAfterMs === undefined ? {} : { staleAfterMs: o.staleAfterMs }),
      ...(o.maxMemoryBytes === undefined ? {} : { maxMemoryBytes: o.maxMemoryBytes }),
      onStorageRecovered: () => o.onCapability?.({ id: 'recording-storage', status: 'SUPPORTED' }),
      onStorageDegraded: (reason) =>
        o.onCapability?.({
          id: 'recording-storage',
          // A failed open means no IndexedDB at all; a failed write may be transient (quota).
          status: reason === 'OPEN_FAILED' ? 'UNSUPPORTED' : 'UNVERIFIABLE',
          detail:
            reason === 'OPEN_FAILED'
              ? 'IndexedDB unavailable: recording is buffered in memory only (a reload loses unsent chunks).'
              : 'IndexedDB writes are failing: recording is buffered in memory only.',
        }),
      ...(o.maxBufferBytes === undefined ? {} : { maxBufferBytes: o.maxBufferBytes }),
      ...(o.backoffBaseMs === undefined ? {} : { backoffBaseMs: o.backoffBaseMs }),
    });
  }

  /** Resume uploads left over from a previous page load (FR-702). Needs no device access. */
  async start(): Promise<void> {
    await this.queue.start();
    await this.counters.load();
    // Never restart below a chunk still waiting from an earlier page load.
    for (const stream of RECORDING_STREAMS) {
      this.counters.seed(stream, {
        nextSeq: this.queue.maxSeq(stream) + 1,
        nextSegment: this.queue.maxSegment(stream) + 1,
      });
    }
    globalThis.addEventListener?.('online', this.onOnline);
    this.started = true;
  }

  health(): RecorderHealth {
    return this.queue.health();
  }

  get audioStream(): MediaStream | null {
    return this.owned.get('AUDIO') ?? null;
  }

  get webcamStream(): MediaStream | null {
    return this.owned.get('WEBCAM') ?? null;
  }

  /**
   * Lift a stream's counters to the server's (`proctor-key` `counters.media`), keeping the larger
   * of local and server so a new device never reuses a seq or segment.
   */
  seedCounters(counters: Partial<Record<RecordingStream, Partial<MediaCounter>>>): void {
    for (const [stream, v] of Object.entries(counters)) {
      // Streams this recorder does not know (a future ROOM_SCAN) are ignored, not an error.
      if (!v || !(RECORDING_STREAMS as readonly string[]).includes(stream)) continue;
      this.counters.seed(stream as RecordingStream, v);
      void this.counters.persist(stream as RecordingStream); // best effort, also on later loads
    }
    void this.releaseHeldStreams().catch(() => undefined);
  }

  /**
   * End the holds after a collision (the app refreshed the counters from the server): stop the
   * live recorder of each held stream (its last chunk joins the held chunks), drop the held
   * chunks as counted stale-identity losses, and restart the recorder into a fresh segment whose
   * seqs continue from the seeded counters. Nothing is guessed and no seq is reused.
   */
  private async releaseHeldStreams(): Promise<void> {
    const held = this.queue.health().heldStreams;
    if (held.length === 0 || this.ended || this.closing) return;
    const restart: RecordingStream[] = [];
    for (const stream of held) {
      if (this.recorders.has(stream)) {
        restart.push(stream);
        await this.recorders.get(stream)?.stop(); // the device stays open
        this.recorders.delete(stream);
      }
    }
    await this.queue.releaseHeld();
    if (this.ended || this.closing) return;
    for (const stream of restart) {
      const src = this.sources.get(stream);
      if (src) await this.begin(stream, src);
    }
  }

  /** Stop every recorder and release every device this pipeline opened (recorders UNION owned). */
  private async releaseAll(): Promise<void> {
    const streams = new Set<RecordingStream>([...this.recorders.keys(), ...this.owned.keys()]);
    for (const stream of streams) await this.stopStream(stream).catch(() => undefined);
    this.sources.clear();
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
    if (this.ended || this.closing) return false; // no recorder may start (before anything else)
    this.o.assertConsent();
    if (!this.supported('SCREEN')) return false;
    // 5 fps keeps files small; some browsers ignore it, which is fine.
    await stream
      .getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: SCREEN_FRAME_RATE, max: SCREEN_FRAME_RATE } })
      .catch(() => undefined);
    if (this.ended || this.closing) return false;
    await this.begin('SCREEN', stream);
    return !(this.ended || this.closing);
  }

  async recordWebcam(): Promise<MediaStream | null> {
    if (this.ended || this.closing) return null;
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
    if (this.ended || this.closing) {
      // The session ended (or stop() began) while the permission prompt was open: release the device at once.
      s.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.owned.set('WEBCAM', s);
    await this.begin('WEBCAM', s);
    if (this.ended || this.closing) return null; // ended during begin(): it released the device
    return s;
  }

  async recordAudio(): Promise<MediaStream | null> {
    if (this.ended || this.closing) return null;
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
    if (this.ended || this.closing) {
      // The session ended while the permission prompt was open: release the device at once.
      s.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.owned.set('AUDIO', s);
    await this.begin('AUDIO', s);
    if (this.ended || this.closing) return null; // ended during begin(): it released the device
    return s;
  }

  private async begin(stream: RecordingStream, media: MediaStream): Promise<void> {
    if (!this.started) await this.start();
    await this.recorders.get(stream)?.stop();
    const segment = await this.counters.newSegment(stream);
    if (this.ended || this.closing) {
      // SESSION_NOT_ACTIVE or stop()/finish() arrived while we waited: register nothing, release.
      this.owned
        .get(stream)
        ?.getTracks()
        .forEach((t) => t.stop());
      this.owned.delete(stream);
      return;
    }
    this.sources.set(stream, media);
    const rec = new ChunkRecorder(
      stream,
      segment,
      async (c, d) => {
        // The counter is persisted before the chunk is stored, so a reload never reuses its seq.
        await this.counters.persist(stream);
        await this.queue.add(c, d);
      },
      this.o.recorderFactory,
      () => this.counters.allocSeq(stream), // continues across segments and restarts
      this.o.now,
    );
    this.recorders.set(stream, rec);
    let reported = false;
    const lost = (reason: DeviceLoss['reason']): void => {
      if (reported || this.recorders.get(stream) !== rec) return;
      reported = true;
      // Flush what we have, then tell the UI; the caller restarts as a new segment.
      void this.stopStream(stream)
        .catch(() => undefined) // a failing stop must not hide the device loss
        .then(() => {
          this.o.onCapability?.({
            id: `record-${stream.toLowerCase()}`,
            status: 'UNVERIFIABLE',
            detail: `Recording stopped (${reason}).`,
          });
          this.o.onDeviceLost?.({ stream, reason });
        });
    };
    for (const t of media.getTracks())
      t.addEventListener('ended', () => lost('TRACK_ENDED'), { once: true });
    rec.start(media, { onError: () => lost('RECORDER_ERROR') });
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

  /**
   * End of session (FR-702). Stops recorders (final chunks are flushed), waits up to
   * `drainTimeoutMs` for uploads, then deletes every buffered chunk of this session from IndexedDB.
   * Chunks that did not make it are counted in `droppedChunks` and `droppedBytes`; the caller
   * should show that gap. The per-stream media counters (`<sessionId>:media:<STREAM>`, small
   * integers, no candidate data) are KEPT on purpose, like the event counter: a new load of the
   * same session must continue the seq and segment numbers or the server answers SEQ_CONFLICT or
   * `alreadyUploaded`. The stale-session sweep removes them later. The legacy
   * `<sessionId>:segment:` keys are removed.
   */
  async finish(opts: { drainTimeoutMs?: number } = {}): Promise<RecorderHealth> {
    this.closing = true; // first: no recorder may start while the queue drains
    globalThis.removeEventListener?.('online', this.onOnline);
    await this.releaseAll();
    await this.queue.waitUntilIdle(opts.drainTimeoutMs ?? 15_000);
    this.queue.stop();
    await this.queue.purge();
    await this.store.deletePrefix(STORES.meta, `${this.o.sessionId}:segment:`).catch(() => 0);
    this.started = false;
    return this.queue.health();
  }

  /** Stop recording; unsent chunks stay in IndexedDB and upload on the next load. */
  async stop(): Promise<void> {
    this.closing = true; // first: nothing may start while we tear down
    globalThis.removeEventListener?.('online', this.onOnline);
    await this.releaseAll();
    this.queue.stop();
  }
}
