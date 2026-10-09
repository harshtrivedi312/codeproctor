import type { EndReason } from './batch-queue';
import type { EventTransport, SendResult, SignedBatch } from './event-queue';

/** Only small bodies use keepalive: the 64 KiB quota is shared by concurrent keepalive fetches. */
const KEEPALIVE_MAX_BYTES = 32 * 1024;

export interface FetchTransportOptions {
  /** API origin plus prefix, for example https://api.example.com/v1 . */
  baseUrl: string;
  /** Candidate session token. Never logged by the SDK. */
  getToken: () => string;
  fetchFn?: typeof fetch;
  eventsPath?: string;
  keystrokesPath?: string;
  heartbeatPath?: string;
  /** Whole-request limit for a batch, body read included (default 20 s). */
  batchTimeoutMs?: number;
  /** Whole-request limit for a heartbeat, body read included (default 8 s, under the 10 s interval). */
  heartbeatTimeoutMs?: number;
}

/** Heartbeat answer: a plain boolean, or the news that the session is over. */
export type HeartbeatResult = boolean | { ended: EndReason };

interface Answer {
  status: number;
  ok: boolean;
  code: string;
  retryAfterMs: number | undefined;
}

/** Retry-After as seconds or an HTTP date, in ms; undefined when absent or unusable. */
export function parseRetryAfter(
  raw: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (/^\d+$/.test(t)) return Math.min(Number(t), 300) * 1000;
  const at = Date.parse(t);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - now), 300_000);
}

/**
 * Map one answer to a SendResult by the RFC 7807 `code` first, then by status (ADR 0013 5.8).
 * Plain strings are returned when there is nothing more to say.
 */
export function classifyAnswer(a: Pick<Answer, 'status' | 'code' | 'retryAfterMs'>): SendResult {
  switch (a.code) {
    case 'KEY_EPOCH_STALE':
      return { kind: 'KEY_STALE' };
    case 'KEY_ALREADY_ISSUED':
      return { kind: 'KEY_UNAVAILABLE' };
    case 'SESSION_NOT_ACTIVE':
      return { kind: 'ENDED', reason: 'SESSION_NOT_ACTIVE' };
    case 'SESSION_TAKEN_OVER':
      return { kind: 'ENDED', reason: 'TAKEN_OVER' };
    case 'TOKEN_EXPIRED':
      return { kind: 'AUTH', code: 'TOKEN_EXPIRED' };
    case 'SEQ_CONFLICT':
    case 'SIGNATURE_INVALID':
      return { kind: 'REJECTED', code: a.code };
    default:
  }
  if (a.status === 401) return a.code ? { kind: 'AUTH', code: a.code } : { kind: 'AUTH' };
  // 408, 429 and 5xx (503 BUSY included) are transient and may carry a Retry-After.
  if (a.status === 408 || a.status === 429 || a.status >= 500) {
    return a.retryAfterMs === undefined ? 'RETRY' : { kind: 'RETRY', retryAfterMs: a.retryAfterMs };
  }
  // 400, 403, 413, 415 and other 4xx will never succeed: drop and count.
  return a.code ? { kind: 'REJECTED', code: a.code } : 'REJECTED';
}

/**
 * Wire format (assumption until ARC-03 fixes it): the request body is the exact signed string,
 * `X-Signature` carries the hex HMAC, auth is the candidate token. Paths follow fsd.md section 4;
 * the heartbeat path is not listed there, so it is configurable.
 *
 * Every call has a hard time limit that covers reading the body, so one stalled request can never
 * block the head of a queue or finish() (FR-601, FR-609, TC-063, TC-065).
 */
export function createFetchTransport(o: FetchTransportOptions): EventTransport & {
  heartbeat(): Promise<HeartbeatResult>;
  sendKeystrokeBatch(batch: SignedBatch): Promise<SendResult>;
} {
  const f = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const eventsPath = o.eventsPath ?? '/candidate/session/events';
  const keystrokesPath = o.keystrokesPath ?? '/candidate/session/keystrokes';
  const heartbeatPath = o.heartbeatPath ?? '/candidate/session/heartbeat';
  const batchTimeout = o.batchTimeoutMs ?? 20_000;
  const heartbeatTimeout = o.heartbeatTimeoutMs ?? 8000;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${o.getToken()}`,
    ...extra,
  });

  /**
   * One request with an AbortController and a race against a timer, so a fetch that ignores the
   * signal is bounded too. The timer is cleared only after the body has been read. Throws on
   * timeout or network error.
   */
  const request = async (
    path: string,
    init: Omit<RequestInit, 'signal'>,
    timeoutMs: number,
  ): Promise<Answer> => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    const run = (async (): Promise<Answer> => {
      const res = await f(`${o.baseUrl}${path}`, { ...init, signal: ctl.signal });
      const text = await res.text().catch(() => {
        if (ctl.signal.aborted) throw new Error('timeout');
        return '';
      });
      let code = '';
      if (!res.ok) {
        try {
          const j = JSON.parse(text) as { code?: unknown } | null;
          if (typeof j?.code === 'string') code = j.code.slice(0, 64);
        } catch {
          // not JSON: map by status
        }
      }
      return {
        status: res.status,
        ok: res.ok,
        code,
        retryAfterMs: parseRetryAfter(res.headers?.get?.('Retry-After')),
      };
    })();
    run.catch(() => undefined); // a late rejection after the timeout must not be unhandled
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const post = async (path: string, batch: SignedBatch): Promise<SendResult> => {
    // The browser's keepalive quota (64 KiB, shared by all concurrent keepalive requests) counts
    // BYTES, not UTF-16 characters, so measure the UTF-8 size and leave headroom.
    const bytes = new TextEncoder().encode(batch.body).length;
    const send = (keepalive: boolean): Promise<Answer> =>
      request(
        path,
        {
          method: 'POST',
          headers: headers({ 'X-Signature': batch.signature }),
          body: batch.body,
          keepalive,
        },
        batchTimeout,
      );
    try {
      let a: Answer;
      if (bytes < KEEPALIVE_MAX_BYTES) {
        try {
          a = await send(true);
        } catch (err) {
          // A TypeError can be the keepalive quota (not the network): try once without it.
          if (!(err instanceof TypeError)) throw err;
          a = await send(false);
        }
      } else {
        a = await send(false);
      }
      return a.ok ? 'OK' : classifyAnswer(a);
    } catch {
      return 'RETRY';
    }
  };
  return {
    sendBatch: (batch: SignedBatch) => post(eventsPath, batch),
    sendKeystrokeBatch: (batch: SignedBatch) => post(keystrokesPath, batch),
    async heartbeat(): Promise<HeartbeatResult> {
      try {
        const a = await request(
          heartbeatPath,
          { method: 'POST', headers: headers() },
          heartbeatTimeout,
        );
        if (a.ok) return true;
        const r = classifyAnswer(a);
        if (typeof r === 'object' && r.kind === 'ENDED') return { ended: r.reason };
        return false;
      } catch {
        return false;
      }
    },
  };
}
