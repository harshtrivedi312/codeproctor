import type { PlaybackPart } from './model';

/*
 * Recording playback by download. A recording is many MediaRecorder chunks; only the first holds the
 * WebM header, so the chunks cannot be played one by one. We fetch every part in seq order,
 * concatenate the bytes into ONE Blob and play it from an object URL. Presigned urls and the object
 * URL are never logged, stored or put in a label.
 */

/** A sane cap on what one Play may pull into memory. */
export const MAX_RECORDING_BYTES = 500 * 1024 * 1024;

/** A part answered 403 or 401: the presigned link expired. The caller refreshes once. */
export class ExpiredPartError extends Error {}
/** The recording is bigger than MAX_RECORDING_BYTES. */
export class RecordingTooLargeError extends Error {}
/** The playback answer names a content type that is not WebM audio or video. */
export class BadContentTypeError extends Error {}
/** A part could not be downloaded (non-2xx, network error). */
export class PartDownloadError extends Error {}

const ALLOWED_TYPES: ReadonlySet<string> = new Set(['video/webm', 'audio/webm']);
/** True for video/webm and audio/webm, ignoring parameters such as ;codecs=opus. */
export function isAllowedContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_TYPES.has(base);
}

/** Reads a body, stopping as soon as the running total passes the cap. */
async function readCapped(
  res: Response,
  soFar: number,
  signal: AbortSignal,
): Promise<Uint8Array[]> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (soFar + buf.byteLength > MAX_RECORDING_BYTES) throw new RecordingTooLargeError();
    return [buf];
  }
  const reader = res.body.getReader();
  const out: Uint8Array[] = [];
  let total = soFar;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RECORDING_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new RecordingTooLargeError();
      }
      out.push(value);
    }
  } catch (e) {
    if (e instanceof RecordingTooLargeError || signal.aborted) throw e;
    throw new PartDownloadError('body');
  }
  return out;
}

export async function downloadParts(
  parts: readonly PlaybackPart[],
  contentType: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Blob> {
  // Refuse a hostile or odd type before any part is fetched.
  if (!isAllowedContentType(contentType)) throw new BadContentTypeError();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  onProgress(0, parts.length);
  for (const [i, part] of parts.entries()) {
    let res: Response;
    try {
      res = await fetch(part.url, { credentials: 'omit', signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new PartDownloadError('network');
    }
    if (res.status === 403 || res.status === 401) throw new ExpiredPartError();
    if (!res.ok) throw new PartDownloadError(`status ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    // A missing, NaN or negative length is unknown: the streaming count below still applies.
    if (Number.isFinite(declared) && declared > 0 && bytes + declared > MAX_RECORDING_BYTES) {
      void res.body?.cancel().catch(() => undefined);
      throw new RecordingTooLargeError();
    }
    const read = await readCapped(res, bytes, signal);
    for (const c of read) bytes += c.byteLength;
    chunks.push(...read);
    onProgress(i + 1, parts.length);
  }
  return new Blob(chunks as BlobPart[], { type: contentType });
}
