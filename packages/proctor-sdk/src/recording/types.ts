export const RECORDING_STREAMS = ['SCREEN', 'WEBCAM', 'AUDIO'] as const;
export type RecordingStream = (typeof RECORDING_STREAMS)[number];

/** FR-701: 10-second chunks. */
export const CHUNK_MS = 10_000;
/** FR-702: IndexedDB buffer cap. */
export const MAX_BUFFER_BYTES = 200 * 1024 * 1024;

export interface ChunkRef {
  stream: RecordingStream;
  /** A recorder restart (reload, re-share) starts a new segment (ADR 0004). */
  segment: number;
  seq: number;
  bytes: number;
  contentType: string;
}

export interface PresignedPut {
  url: string;
  headers?: Record<string, string>;
}

export type MediaApiErrorKind = 'RETRY' | 'FATAL';

/**
 * Server side of the pipeline (backend.md Step 11): presign returns a PUT URL valid 60 s, confirm
 * makes the API HEAD the object and mark it uploaded. The wire format is an assumption until ARC-03
 * (see docs/followups/proctor-sdk.md). Methods throw MediaApiError.
 */
export interface MediaApi {
  presign(chunk: ChunkRef): Promise<PresignedPut>;
  confirm(chunk: ChunkRef): Promise<void>;
}

export class MediaApiError extends Error {
  constructor(
    readonly kind: MediaApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'MediaApiError';
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
}
