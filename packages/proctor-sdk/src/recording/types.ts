export const RECORDING_STREAMS = ['SCREEN', 'WEBCAM', 'AUDIO'] as const;
export type RecordingStream = (typeof RECORDING_STREAMS)[number];

/** FR-701: 10-second chunks. */
export const CHUNK_MS = 10_000;
/** FR-702: IndexedDB buffer cap. */
export const MAX_BUFFER_BYTES = 200 * 1024 * 1024;

/** Bare content type of a stream's chunks: no codecs parameter (the server signs it into the PUT). */
export type MediaContentType = 'video/webm' | 'audio/webm';
export function contentTypeFor(stream: RecordingStream): MediaContentType {
  return stream === 'AUDIO' ? 'audio/webm' : 'video/webm';
}

export interface ChunkRef {
  stream: RecordingStream;
  /** A recorder restart (reload, re-share) starts a new segment (ADR 0004). Per stream. */
  segment: number;
  /** Unique per (session, stream) ACROSS segments: it keeps counting over restarts and reloads. */
  seq: number;
  bytes: number;
  /**
   * The recorder sets the bare `video/webm` or `audio/webm`. Whatever is here, the media API sends
   * `contentTypeFor(stream)`: a codecs parameter never reaches the server.
   */
  contentType: string;
  /**
   * Client clock when the chunk's recording started (ms since epoch); the server clamps it.
   * Optional only so that code written against the first version of this type still compiles;
   * the recorder always sets it (a missing value means "10 s ago").
   */
  startedAtMs?: number;
  /** Recorded length, 1..60 000 ms (missing means 10 s). */
  durationMs?: number;
  /**
   * First chunk of its segment: it carries the WebM header, so without it the whole segment is
   * unplayable. It is never dropped by the buffer cap or by a refusal (ADR 0013 5.5).
   */
  first?: boolean;
}

/**
 * A presigned PUT. `headers` are sent exactly as given (Content-Type, maybe If-None-Match).
 * `alreadyUploaded: true` means the chunk is already confirmed: no URL is issued (`url` is empty),
 * the presign did not count, and there is nothing to PUT or confirm.
 */
export interface PresignedPut {
  alreadyUploaded?: boolean;
  url: string;
  /** Sent exactly as given. Missing: only the stream's Content-Type is sent. */
  headers?: Record<string, string>;
  /**
   * When the URL stops working (ms since epoch); it is reused for retries until 5 s before.
   * Missing means a 30 s life from the answer.
   */
  expiresAtMs?: number;
}
/** Kept for readers of the first version of this file. */
export type PresignResult = PresignedPut;

/**
 * How the queue should react to a failed media call (decided from the RFC 7807 `code`, then the
 * status):
 * - NETWORK: no connection or timeout; the queue goes quiet and probes instead of presigning;
 * - RETRY: server trouble or rate limit; back off (honouring `retryAfterMs`);
 * - REPRESIGN: the URL or object is no good (CHUNK_NOT_PRESIGNED, UPLOAD_MISMATCH); presign again;
 * - REUPLOAD: the object is missing at confirm (UPLOAD_NOT_FOUND); upload again;
 * - QUOTA: PRESIGN_QUOTA_EXCEEDED; wait `retryAfterMs`, keep the chunk;
 * - ENDED: SESSION_NOT_ACTIVE; stop uploading, keep the chunks, signal;
 * - FATAL: the server will never take this chunk (never applied to a segment's first chunk).
 */
export type MediaApiErrorKind =
  | 'NETWORK'
  | 'RETRY'
  | 'REPRESIGN'
  | 'REUPLOAD'
  | 'QUOTA'
  /** The server confirmed ANOTHER chunk under this identity (alreadyUploaded for a chunk never presigned). */
  | 'SEQ_COLLISION'
  | 'ENDED'
  | 'FATAL';

/**
 * Server side of the pipeline (ADR 0013 5.5): presign returns a PUT URL valid 60 s or
 * `alreadyUploaded`; confirm makes the API HEAD the object and mark it uploaded. Methods throw
 * MediaApiError. Presigns are counted by the server (every request counts, even a repeat for the
 * same chunk), so the queue presigns lazily and reuses a URL for retries.
 */
export interface MediaApi {
  presign(chunk: ChunkRef): Promise<PresignResult>;
  confirm(chunk: ChunkRef): Promise<void>;
}

export class MediaApiError extends Error {
  constructor(
    readonly kind: MediaApiErrorKind,
    message: string,
    readonly detail: { code?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'MediaApiError';
  }
  get code(): string | undefined {
    return this.detail.code;
  }
  get retryAfterMs(): number | undefined {
    return this.detail.retryAfterMs;
  }
}

export interface RecorderHealth {
  bytesPending: number;
  chunksPending: number;
  inFlight: number;
  lastSuccessfulUploadAt: number | null;
  consecutiveFailures: number;
  droppedChunks: number;
  droppedBytes: number;
  /** True when the last upload attempt failed (offline or server trouble). */
  degraded: boolean;
  bytesPendingByStream: Record<RecordingStream, number>;
  /** IndexedDB could not be used (unavailable or failing); chunks wait in memory only. */
  storageDegraded: boolean;
  /** Bytes currently held only in memory (lost on reload). */
  memoryBytes: number;
  /** The server said the session is over (SESSION_NOT_ACTIVE): uploading stopped, chunks are kept. */
  ended: boolean;
  /** No connection: the queue is not presigning and waits for a probe. */
  offline: boolean;
  /** Waiting for the presign quota (429 PRESIGN_QUOTA_EXCEEDED); chunks are kept. */
  quotaWait: boolean;
  /** First chunks the server refused for good; they are kept (never dropped) and retried slowly. */
  blockedChunks: number;
  /** A first chunk was admitted above the buffer cap because only protected chunks remain. */
  capExceeded: boolean;
  /** Chunks whose identity collided with a confirmed chunk (counters were behind). */
  seqConflicts: number;
  /** Of those, chunks that were given a fresh seq and kept. */
  rekeyedChunks: number;
}

export type DeviceLossReason = 'TRACK_ENDED' | 'RECORDER_ERROR';
/** A recorder stopped because its device or the MediaRecorder failed. Restart = new segment. */
export interface DeviceLoss {
  stream: RecordingStream;
  reason: DeviceLossReason;
}
