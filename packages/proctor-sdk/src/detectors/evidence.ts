import { DEFAULT_EVENT_SEVERITY, type ClientEventType } from '@codeproctor/shared';

/** `evidence/<ULID>.jpg`: the only shape that goes into an event's `evidenceKey`. */
export const EVIDENCE_NAME_RE = /^evidence\/[0-9A-HJKMNP-TV-Z]{26}\.jpg$/;

/** HIGH events carry a JPEG snapshot (FR-801 evidence reference). Severity is the server default table. */
export function needsEvidence(type: ClientEventType): boolean {
  return DEFAULT_EVENT_SEVERITY[type] === 'HIGH';
}

export interface EvidenceUpload {
  /** Object key to put in `evidenceKey`; the server checks it belongs to this session. */
  key: string;
}

/**
 * Presign for one evidence JPEG (backend ARC-03; wire format assumed, see follow-ups). The upload
 * itself is a PUT to the presigned URL.
 */
export interface EvidenceApi {
  presign(input: { contentType: 'image/jpeg'; bytes: number }): Promise<{
    url: string;
    /** The session-relative name `evidence/<ULID>.jpg` (ADR 0013 section 5.6). */
    evidenceKey?: string;
    /** Older shape of the same value. */
    key?: string;
    headers?: Record<string, string>;
  }>;
}

/** Output size of a snapshot: scaled down to `maxWidth`, never up, aspect ratio kept. */
export function scaledSize(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / sourceWidth);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/** Encode a video frame as a JPEG, scaled to at most `maxWidth`. */
export async function captureJpeg(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  quality: number,
): Promise<Blob> {
  const { width: w, height: h } = scaledSize(sourceWidth, sourceHeight, maxWidth);
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  g.drawImage(source, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

/**
 * Upload a snapshot and return its key, or null on any failure within `timeoutMs`. Evidence is a
 * bonus: the event is sent without it rather than delayed or lost.
 */
export async function uploadEvidence(
  api: EvidenceApi,
  jpeg: Blob,
  timeoutMs: number,
  put: (url: string, body: Blob, headers: Record<string, string>) => Promise<number> = async (
    url,
    body,
    headers,
  ) => (await fetch(url, { method: 'PUT', body, headers })).status,
  onRefused?: (e: unknown) => void,
): Promise<string | null> {
  const work = (async (): Promise<string | null> => {
    try {
      const p = await api.presign({ contentType: 'image/jpeg', bytes: jpeg.size });
      const status = await put(p.url, jpeg, { 'Content-Type': 'image/jpeg', ...p.headers });
      const name = p.evidenceKey ?? p.key;
      // Only a well-formed session-relative name goes into an event.
      return status >= 200 &&
        status < 300 &&
        typeof name === 'string' &&
        EVIDENCE_NAME_RE.test(name)
        ? name
        : null;
    } catch (err) {
      try {
        onRefused?.(err); // for example QUOTA_EXCEEDED: the caller stops asking
      } catch {
        // ignore
      }
      return null;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
