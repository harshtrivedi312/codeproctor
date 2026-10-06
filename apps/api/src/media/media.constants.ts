// Limits of the media routes (ADR 0013 section 5.5). One place, so the DTO, the service and the
// tests agree.
import type { MediaStream } from '../generated/prisma/enums.js';

/** SIDE_CAMERA waits for ARC-03 part 2. */
export const MEDIA_STREAMS = ['SCREEN', 'WEBCAM', 'AUDIO', 'ROOM_SCAN'] as const;
export type CandidateMediaStream = (typeof MEDIA_STREAMS)[number];

/** Exactly these, no codecs parameter, so the signed header matches the PUT. */
export const MEDIA_CONTENT_TYPES = ['video/webm', 'audio/webm'] as const;
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

export const MAX_SEGMENT = 9_999;
export const MAX_SEQ = 99_999_999;
export const MAX_CHUNK_DURATION_MS = 60_000;
const MIB = 1024 * 1024;

export function maxChunkBytes(stream: MediaStream): number {
  return stream === 'AUDIO' ? 4 * MIB : 16 * MIB;
}

/** 60 per minute per stream, for presign and for confirm (ADR 0013 section 5.5). */
export const MEDIA_LIMIT_PER_MINUTE = 60;

/** At most ceil(duration / 10 s) x 1.5 + 50 presigns per stream and session. */
export function presignCap(durationSeconds: number): number {
  return Math.ceil(Math.ceil(durationSeconds / 10) * 1.5) + 50;
}

/** The pre-start floor for ROOM_SCAN, which runs before any deadline exists. */
export const MIN_CAP_DURATION_SECONDS = 600;
