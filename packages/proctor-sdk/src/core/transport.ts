import type { EventTransport, SendResult, SignedBatch } from './event-queue';

export interface FetchTransportOptions {
  /** API origin plus prefix, for example https://api.example.com/v1 . */
  baseUrl: string;
  /** Candidate session token. Never logged by the SDK. */
  getToken: () => string;
  fetchFn?: typeof fetch;
  eventsPath?: string;
  keystrokesPath?: string;
  heartbeatPath?: string;
}

/**
 * Wire format (assumption until ARC-03 fixes it): the request body is the exact signed string,
 * `X-Signature` carries the hex HMAC, auth is the candidate token. Paths follow fsd.md section 4;
 * the heartbeat path is not listed there, so it is configurable.
 */
export function createFetchTransport(o: FetchTransportOptions): EventTransport & {
  heartbeat(): Promise<boolean>;
  sendKeystrokeBatch(batch: SignedBatch): Promise<SendResult>;
} {
  const f = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const eventsPath = o.eventsPath ?? '/candidate/session/events';
  const keystrokesPath = o.keystrokesPath ?? '/candidate/session/keystrokes';
  const heartbeatPath = o.heartbeatPath ?? '/candidate/session/heartbeat';
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${o.getToken()}`,
    ...extra,
  });
  const post = async (path: string, batch: SignedBatch): Promise<SendResult> => {
    try {
      const res = await f(`${o.baseUrl}${path}`, {
        method: 'POST',
        headers: headers({ 'X-Signature': batch.signature }),
        body: batch.body,
        // keepalive requests are capped at 64 KiB by browsers; larger bodies go without.
        keepalive: batch.body.length < 60_000,
      });
      if (res.ok) return 'OK';
      // 408 and 429 are transient; other 4xx will never succeed (bad signature, bad schema).
      if (res.status === 408 || res.status === 429 || res.status >= 500) return 'RETRY';
      if (res.status === 401) return 'RETRY'; // token refresh is the app's job; keep the batch
      return 'REJECTED';
    } catch {
      return 'RETRY';
    }
  };
  return {
    sendBatch: (batch: SignedBatch) => post(eventsPath, batch),
    sendKeystrokeBatch: (batch: SignedBatch) => post(keystrokesPath, batch),
    async heartbeat(): Promise<boolean> {
      try {
        const res = await f(`${o.baseUrl}${heartbeatPath}`, { method: 'POST', headers: headers() });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
