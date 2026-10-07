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
/** A part could not be downloaded (non-2xx, network error). */
export class PartDownloadError extends Error {}

export async function downloadParts(
  parts: readonly PlaybackPart[],
  contentType: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Blob> {
  const chunks: ArrayBuffer[] = [];
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
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && bytes + declared > MAX_RECORDING_BYTES) {
      throw new RecordingTooLargeError();
    }
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (e) {
      if (signal.aborted) throw e;
      throw new PartDownloadError('body');
    }
    bytes += buf.byteLength;
    if (bytes > MAX_RECORDING_BYTES) throw new RecordingTooLargeError();
    chunks.push(buf);
    onProgress(i + 1, parts.length);
  }
  return new Blob(chunks, { type: contentType });
}
