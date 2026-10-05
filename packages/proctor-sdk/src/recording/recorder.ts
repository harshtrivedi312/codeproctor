import { CHUNK_MS, type ChunkRef, type RecordingStream } from './types';

/** The slice of MediaRecorder we use, so tests can fake it. */
export interface MediaRecorderLike {
  start(timeslice?: number): void;
  stop(): void;
  readonly state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
}
export type RecorderFactory = (
  stream: MediaStream,
  options: MediaRecorderOptions,
) => MediaRecorderLike;

export interface StreamProfile {
  mimeType: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

/** Modest bitrates to save storage (FR-701): VP8/Opus in webm. */
export const PROFILES: Readonly<Record<RecordingStream, StreamProfile>> = {
  SCREEN: { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 400_000 },
  WEBCAM: { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 250_000 },
  AUDIO: { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 },
};

/** Constraints for the capture itself: 5 fps screen, 640x360 webcam. */
export const SCREEN_FRAME_RATE = 5;
export const WEBCAM_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 15, max: 15 },
};

export function isProfileSupported(
  stream: RecordingStream,
  isTypeSupported: (t: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): boolean {
  return isTypeSupported(PROFILES[stream].mimeType);
}

export type ChunkSink = (chunk: ChunkRef, data: ArrayBuffer) => Promise<void>;

/**
 * One MediaRecorder for one stream. start(CHUNK_MS) makes the browser emit a Blob every 10 s;
 * each blob goes to the sink with the next seq. Only the first chunk of a segment carries the
 * webm header, so chunks are concatenated in seq order within a segment (worker side); a restart
 * opens a new segment (ADR 0004).
 */
export class ChunkRecorder {
  private rec: MediaRecorderLike | null = null;
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private stopped: Promise<void> = Promise.resolve();

  constructor(
    readonly stream: RecordingStream,
    private readonly segment: number,
    private readonly sink: ChunkSink,
    private readonly factory: RecorderFactory = (s, o) =>
      new MediaRecorder(s, o) as unknown as MediaRecorderLike,
  ) {}

  start(media: MediaStream, onEnded?: () => void): void {
    const p = PROFILES[this.stream];
    const rec = this.factory(media, {
      mimeType: p.mimeType,
      ...(p.videoBitsPerSecond ? { videoBitsPerSecond: p.videoBitsPerSecond } : {}),
      ...(p.audioBitsPerSecond ? { audioBitsPerSecond: p.audioBitsPerSecond } : {}),
    });
    this.rec = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      const blob = e.data;
      const seq = this.seq++;
      // Serialise so seq order equals storage order; the editor thread only awaits arrayBuffer().
      this.chain = this.chain
        .then(() => blob.arrayBuffer())
        .then((data) =>
          this.sink(
            {
              stream: this.stream,
              segment: this.segment,
              seq,
              bytes: data.byteLength,
              contentType: p.mimeType,
            },
            data,
          ),
        )
        .catch(() => undefined);
    };
    this.stopped = new Promise<void>((resolve) => {
      rec.onstop = () => {
        resolve();
        onEnded?.();
      };
    });
    rec.onerror = () => {
      if (rec.state !== 'inactive') rec.stop();
    };
    rec.start(CHUNK_MS);
  }

  /** Stop and wait until the final chunk has been handed to the sink. */
  async stop(): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    if (rec.state !== 'inactive') rec.stop();
    await this.stopped;
    await this.chain;
    this.rec = null;
  }
}
