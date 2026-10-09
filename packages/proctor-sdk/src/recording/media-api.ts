import {
  MediaApiError,
  contentTypeFor,
  type ChunkRef,
  type MediaApi,
  type MediaApiErrorKind,
  type PresignResult,
} from './types';

export interface FetchMediaApiOptions {
  baseUrl: string;
  /** Candidate session token; never logged. */
  getToken: () => string;
  fetchFn?: typeof fetch;
  presignPath?: string;
  confirmPath?: string;
  /** Per request timeout (default 15 s): a hung request must not hold an upload slot forever. */
  timeoutMs?: number;
}

/** Retry-After in seconds (the form our API sends), else undefined. */
function retryAfterMs(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 3600) * 1000 : undefined;
}

/**
 * Decide the queue's reaction from the RFC 7807 `code` first, then the status (ADR 0013 5.5).
 * The body is read only for `code`; nothing from it is logged or put in a message.
 */
async function errorFor(res: Response): Promise<MediaApiError> {
  let code: string | undefined;
  try {
    const j = (await res.json()) as { code?: unknown };
    if (typeof j.code === 'string') code = j.code;
  } catch {
    // no problem body
  }
  const wait = retryAfterMs(res);
  const mk = (kind: MediaApiErrorKind): MediaApiError =>
    new MediaApiError(kind, `status ${String(res.status)}`, {
      ...(code ? { code } : {}),
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    });
  if (code === 'SESSION_NOT_ACTIVE') return mk('ENDED');
  if (code === 'PRESIGN_QUOTA_EXCEEDED') return mk('QUOTA');
  if (code === 'CHUNK_NOT_PRESIGNED' || code === 'UPLOAD_MISMATCH') return mk('REPRESIGN');
  if (code === 'UPLOAD_NOT_FOUND') return mk('REUPLOAD');
  if (code === 'SEQ_CONFLICT') return mk('FATAL');
  if (res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500) {
    return mk('RETRY'); // a token refresh is the app's job; storage trouble clears by itself
  }
  return mk('FATAL'); // 400 and the other 4xx will never succeed
}

/**
 * Media API of ADR 0013 5.5 as built: presign `{ stream, segment, seq, bytes, contentType (bare),
 * startedAt, durationMs }` returns `{ url, method: 'PUT', headers, expiresAt }` or
 * `{ alreadyUploaded: true }`; confirm `{ stream, segment, seq }`.
 */
export function createFetchMediaApi(o: FetchMediaApiOptions): MediaApi {
  const f = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  /**
   * POST and read the answer under ONE timeout: the timer is cleared only after the body has been
   * read, so a stalled body cannot hold an upload slot forever.
   */
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
    try {
      let res: Response;
      try {
        res = await f(`${o.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.getToken()}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch {
        throw new MediaApiError('NETWORK', 'network');
      }
      if (!res.ok) throw await errorFor(res);
      try {
        return (await res.json()) as unknown;
      } catch {
        if (ctl.signal.aborted) throw new MediaApiError('NETWORK', 'network');
        return null; // an empty or non-JSON success body (confirm)
      }
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async presign(c: ChunkRef): Promise<PresignResult> {
      const j = (await call(o.presignPath ?? '/candidate/session/media/presign', {
        stream: c.stream,
        segment: c.segment,
        seq: c.seq,
        bytes: c.bytes,
        // Always the bare type of the stream, never a recorder mime type with codecs.
        contentType: contentTypeFor(c.stream),
        startedAt: new Date(c.startedAtMs ?? Date.now() - 10_000).toISOString(),
        durationMs: Math.min(60_000, Math.max(1, Math.round(c.durationMs ?? 10_000))),
      })) as {
        alreadyUploaded?: unknown;
        url?: unknown;
        headers?: unknown;
        expiresAt?: unknown;
      } | null;
      if (j?.alreadyUploaded === true) return { alreadyUploaded: true, url: '' };
      if (typeof j?.url !== 'string') throw new MediaApiError('RETRY', 'bad presign response');
      const headers: Record<string, string> = {};
      if (j.headers && typeof j.headers === 'object') {
        for (const [k, v] of Object.entries(j.headers as Record<string, unknown>)) {
          if (typeof v === 'string') headers[k] = v;
        }
      }
      const exp = typeof j.expiresAt === 'string' ? Date.parse(j.expiresAt) : NaN;
      return {
        url: j.url,
        headers,
        // The URL lives 60 s; without a usable expiry assume a short life, never a long one.
        expiresAtMs: Number.isFinite(exp) ? exp : Date.now() + 30_000,
      };
    },
    async confirm(c: ChunkRef): Promise<void> {
      await call(o.confirmPath ?? '/candidate/session/media/confirm', {
        stream: c.stream,
        segment: c.segment,
        seq: c.seq,
      });
    },
  };
}
