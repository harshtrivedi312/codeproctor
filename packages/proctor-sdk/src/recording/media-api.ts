import { MediaApiError, type ChunkRef, type MediaApi, type PresignedPut } from './types';

export interface FetchMediaApiOptions {
  baseUrl: string;
  /** Candidate session token; never logged. */
  getToken: () => string;
  fetchFn?: typeof fetch;
  presignPath?: string;
  confirmPath?: string;
}

/**
 * Assumed wire format (ARC-03 pending): POST presign with `{ stream, segment, seq, bytes,
 * contentType }` returns `{ url, headers? }`; POST confirm with `{ stream, segment, seq }`.
 * 5xx, 408, 429 and 401 are retried (a token refresh is the app's job); other 4xx are fatal.
 */
export function createFetchMediaApi(o: FetchMediaApiOptions): MediaApi {
  const f = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const post = async (path: string, body: unknown): Promise<Response> => {
    let res: Response;
    try {
      res = await f(`${o.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.getToken()}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new MediaApiError('RETRY', 'network');
    }
    if (res.ok) return res;
    const transient =
      res.status === 408 || res.status === 429 || res.status === 401 || res.status >= 500;
    throw new MediaApiError(transient ? 'RETRY' : 'FATAL', `status ${res.status}`);
  };
  return {
    async presign(c: ChunkRef): Promise<PresignedPut> {
      const res = await post(o.presignPath ?? '/candidate/session/media/presign', c);
      const j = (await res.json()) as Partial<PresignedPut>;
      if (typeof j.url !== 'string') throw new MediaApiError('RETRY', 'bad presign response');
      return { url: j.url, ...(j.headers ? { headers: j.headers } : {}) };
    },
    async confirm(c: ChunkRef): Promise<void> {
      await post(o.confirmPath ?? '/candidate/session/media/confirm', {
        stream: c.stream,
        segment: c.segment,
        seq: c.seq,
      });
    },
  };
}
