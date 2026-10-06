import {
  MediaApiError,
  type ChunkRef,
  type MediaApi,
  type PresignedPut,
} from '@codeproctor/proctor-sdk';
import { requestAt } from '@/features/candidate-flow/api';
import { mediaConfirmSchema, mediaPresignSchema } from '@/features/candidate-flow/wire';

/**
 * The SDK's `MediaApi` on ADR 0013 section 5.5 (PROVISIONAL until BE-09 merges). Two bridges, both
 * listed in docs/followups/frontend.md: the wire wants a bare content type, `startedAt` and
 * `durationMs`, and a `seq` that is unique per stream across segments, while the SDK restarts `seq`
 * in every segment, so the wire seq is `segment * 100000 + seq` (the same bridge as the SDK demo).
 *
 * Never logs a URL, key or body. A chunk already confirmed (`alreadyUploaded`) is reported with a
 * marker URL that the `put` override in the controller answers with 200.
 */
export const ALREADY_UPLOADED_URL = 'already-uploaded:';

const wireSeq = (c: ChunkRef): number => c.segment * 100_000 + c.seq;

export function createAdrMediaApi(): MediaApi {
  return {
    async presign(c: ChunkRef): Promise<PresignedPut> {
      const contentType = c.stream === 'AUDIO' ? 'audio/webm' : 'video/webm';
      const r = await requestAt(mediaPresignSchema, '/session/media/presign', {
        method: 'POST',
        authed: true,
        body: {
          stream: c.stream,
          segment: c.segment,
          seq: wireSeq(c),
          bytes: c.bytes,
          contentType,
          // The chunk is 10 s long and was just recorded (FR-701).
          startedAt: new Date(Date.now() - 10_000).toISOString(),
          durationMs: 10_000,
        },
      });
      if (r.ok) {
        if ('alreadyUploaded' in r.data) return { url: ALREADY_UPLOADED_URL };
        return { url: r.data.url, headers: { 'Content-Type': contentType, ...r.data.headers } };
      }
      if (r.kind === 'problem') {
        // Fatal: the server will never take this chunk (session over, bad request, seq conflict).
        if (r.status === 400 || r.code === 'SEQ_CONFLICT' || r.code === 'SESSION_NOT_ACTIVE')
          throw new MediaApiError('FATAL', r.code ?? `status ${r.status}`);
      }
      throw new MediaApiError('RETRY', 'presign');
    },

    async confirm(c: ChunkRef): Promise<void> {
      const r = await requestAt(mediaConfirmSchema, '/session/media/confirm', {
        method: 'POST',
        authed: true,
        body: { stream: c.stream, segment: c.segment, seq: wireSeq(c) },
      });
      if (r.ok) return;
      // 404 CHUNK_NOT_PRESIGNED, 409 UPLOAD_NOT_FOUND, 422 UPLOAD_MISMATCH: presign and upload again.
      if (r.kind === 'problem' && r.code === 'SESSION_NOT_ACTIVE')
        throw new MediaApiError('FATAL', 'SESSION_NOT_ACTIVE');
      throw new MediaApiError('RETRY', 'confirm');
    },
  };
}

/** A PUT of a chunk body to the presigned URL; `ALREADY_UPLOADED_URL` needs no upload. */
export async function putChunk(
  url: string,
  body: ArrayBuffer,
  headers: Record<string, string>,
): Promise<number> {
  if (url === ALREADY_UPLOADED_URL) return 200;
  try {
    const response = await fetch(url, {
      method: 'PUT',
      body,
      headers,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    // 412: `If-None-Match` says the chunk is already stored: continue to confirm (ADR 0013 5.5).
    return response.status === 412 ? 200 : response.status;
  } catch {
    return 0;
  }
}
