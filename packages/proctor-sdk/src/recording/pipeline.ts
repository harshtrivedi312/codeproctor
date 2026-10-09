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
  /**
   * Refresh the media counters from the server after an identity collision (the server confirmed
   * another chunk under a seq we hold). The app decides how (a new-epoch `proctor-key` answer after
   * an OTP resume today); return `counters.media` or null when it cannot. Without it the stream
   * stays held (chunks kept, `recording-seq-conflict` flagged) until the app calls `seedCounters`.
   */
  resyncCounters?: () => Promise<Partial<Record<string, Partial<MediaCounter>>> | null>;
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
  /** Bumped by every seedCounters call; a held stream resumes once it moved past the collision. */
  private seedStamp = 0;
  private readonly restartAfter = new Set<RecordingStream>();
  /** seedStamp when a stream's collision started: counters seeded after it resolve the hold. */
  private readonly heldStamp = new Map<RecordingStream, number>();

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
        // last chunk is refused by the queue, devices are released).
        for (const stream of [...this.recorders.keys()])
          void this.stopStream(stream).catch(() => undefined);
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
          detail: `A ${info.stream.toLowerCase()} chunk collided with one the server already confirmed (our counters were behind). The stream is held and its chunks are kept; they move to a fresh segment once the counters are refreshed. Chunks confirmed under stale numbers before are not recoverable.`,
        });
      },
      // Identity collision (counters behind the server's): see UploadQueue `collision`.
      collision: {
        prepare: async (stream) => {
          if (!this.heldStamp.has(stream)) this.heldStamp.set(stream, this.seedStamp);
          const stamp = this.heldStamp.get(stream) ?? this.seedStamp;
          // Stop the live recorder first: its last chunk joins the group that moves to a new segment.
          if (this.recorders.has(stream) && !this.ended) {
            this.restartAfter.add(stream);
            await this.recorders.get(stream)?.stop();
            this.recorders.delete(stream);
          }
          let fresh: Partial<Record<string, Partial<MediaCounter>>> | null;
          try {
            fresh = (await o.resyncCounters?.()) ?? null;
          } catch {
            fresh = null;
          }
          if (fresh) this.seedCounters(fresh);
          // True when counters were refreshed now, or by the app (seedCounters) since the collision.
          return fresh !== null || this.seedStamp > stamp;
        },
        allocate: async (stream, count) => {
          const segment = await this.counters.newSegment(stream);
          const firstSeq = this.counters.reserveSeqs(stream, count);
          await this.counters.persist(stream);
          return { segment, firstSeq };
        },
        done: async (stream) => {
          this.heldStamp.delete(stream);
          if (!this.restartAfter.delete(stream) || this.ended) return;
          const src = this.sources.get(stream);
          if (src) await this.begin(stream, src); // a new segment, numbered past the moved group
        },
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
    this.seedStamp++;
    this.queue.resyncHeld(); // a stream held after a collision can move on now
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
    if (this.ended) return false; // session over: no recorder may start (before anything else)
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
    if (this.ended) return null;
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
    if (this.ended) {
      // The session ended while the permission prompt was open: release the device at once.
      s.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.owned.set('WEBCAM', s);
    await this.begin('WEBCAM', s);
    if (this.ended) return null; // ended during begin(): it released the device
    return s;
  }

  async recordAudio(): Promise<MediaStream | null> {
    if (this.ended) return null;
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
    if (this.ended) {
      // The session ended while the permission prompt was open: release the device at once.
      s.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.owned.set('AUDIO', s);
    await this.begin('AUDIO', s);
    if (this.ended) return null; // ended during begin(): it released the device
    return s;
  }

  private async begin(stream: RecordingStream, media: MediaStream): Promise<void> {
    if (!this.started) await this.start();
    await this.recorders.get(stream)?.stop();
    const segment = await this.counters.newSegment(stream);
    if (this.ended) {
      // SESSION_NOT_ACTIVE arrived while we waited: register nothing, release what we own.
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
    globalThis.removeEventListener?.('online', this.onOnline);
    for (const s of [...this.recorders.keys()]) await this.stopStream(s);
    await this.queue.waitUntilIdle(opts.drainTimeoutMs ?? 15_000);
    this.queue.stop();
    await this.queue.purge();
    await this.store.deletePrefix(STORES.meta, `${this.o.sessionId}:segment:`).catch(() => 0);
    this.started = false;
    return this.queue.health();
  }

  /** Stop recording; unsent chunks stay in IndexedDB and upload on the next load. */
  async stop(): Promise<void> {
    globalThis.removeEventListener?.('online', this.onOnline);
    for (const s of [...this.recorders.keys()]) await this.stopStream(s);
    this.queue.stop();
  }
}
