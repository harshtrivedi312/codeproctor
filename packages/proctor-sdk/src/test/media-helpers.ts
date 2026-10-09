import { contentTypeFor, type ChunkRef, type PresignedPut } from '../recording/types';

/** A chunk reference with the fields the server needs (bare type, start time, duration). */
export function chunkRef(
  seq: number,
  bytes = 100,
  stream: ChunkRef['stream'] = 'SCREEN',
  segment = 0,
  over: Partial<ChunkRef> = {},
): ChunkRef {
  return {
    stream,
    segment,
    seq,
    bytes,
    contentType: contentTypeFor(stream),
    startedAtMs: 1_800_000_000_000,
    durationMs: 10_000,
    first: false,
    ...over,
  };
}

/** A presign answer valid for 60 s from now. */
export function okPresign(url = 'https://store.invalid/put', ttlMs = 60_000): PresignedPut {
  return {
    url,
    headers: { 'Content-Type': 'video/webm' },
    expiresAtMs: Date.now() + ttlMs,
  };
}
