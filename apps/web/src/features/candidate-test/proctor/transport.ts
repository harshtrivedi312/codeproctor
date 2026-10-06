import type { EventTransport, SendResult, SignedBatch } from '@codeproctor/proctor-sdk';
import { requestAt } from '@/features/candidate-flow/api';
import { getSessionToken, setSessionToken } from '@/features/candidate-flow/session-store';
import { apiBaseUrl } from '@/lib/env';
import { mockingReady } from '@/lib/mock-ready';
import { heartbeatSchema, type HeartbeatState } from './wire';

/**
 * The SDK's event and heartbeat transport, written for the app because the SDK's own fetch
 * transport (`createFetchTransport`) hides what the app needs (ADR 0013 sections 5.2 and 5.3):
 * the heartbeat's state (pause reasons, deadlines, server time) and the 401 and 409 codes.
 *
 * Rules: the body is the exact signed string; the session token is read from memory per request and
 * never logged; no cookies, no Referer; the batch is never retried on a 4xx that cannot succeed.
 */
export interface TransportHooks {
  /** A heartbeat answered. `startedAt` and `endedAt` are performance.now() around the request. */
  onState: (state: HeartbeatState, timing: { startedAt: number; endedAt: number }) => void;
  /** 409 SESSION_NOT_ACTIVE: the session is over (submitted, expired). Stop; do not report offline. */
  onNotActive: () => void;
  /** 401 SESSION_TAKEN_OVER, or three 401s in a row: the candidate must pass the OTP again. */
  onReauthRequired: () => void;
}

async function problemCode(response: Response): Promise<string | null> {
  try {
    const json: unknown = await response.json();
    if (typeof json === 'object' && json !== null && 'code' in json) {
      const code = json.code;
      return typeof code === 'string' ? code : null;
    }
  } catch {
    // no body
  }
  return null;
}

export function createProctorTransport(hooks: TransportHooks): EventTransport & {
  heartbeat(): Promise<boolean>;
} {
  let unauthorized = 0;
  const handle401 = (code: string | null): void => {
    unauthorized += 1;
    if (code === 'SESSION_TAKEN_OVER' || unauthorized >= 3) hooks.onReauthRequired();
  };

  return {
    async sendBatch(batch: SignedBatch): Promise<SendResult> {
      const token = getSessionToken();
      if (token === null) return 'RETRY';
      let response: Response;
      try {
        await mockingReady;
        response = await fetch(`${apiBaseUrl}/v1/candidate/session/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Signature': batch.signature,
          },
          body: batch.body,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          keepalive: batch.body.length < 60_000,
        });
      } catch {
        return 'RETRY';
      }
      if (response.ok) {
        unauthorized = 0;
        return 'OK';
      }
      const code = await problemCode(response);
      if (response.status === 401) {
        handle401(code);
        return code === 'SESSION_TAKEN_OVER' ? 'REJECTED' : 'RETRY';
      }
      if (response.status === 409 && code === 'SESSION_NOT_ACTIVE') {
        hooks.onNotActive();
        return 'REJECTED';
      }
      // KEY_EPOCH_STALE: the SDK cannot re-sign yet (no setKey hook), so keep the batch and retry.
      if (response.status === 409 && code === 'KEY_EPOCH_STALE') return 'RETRY';
      if (response.status === 408 || response.status === 429 || response.status >= 500)
        return 'RETRY';
      // 400, 403, SEQ_CONFLICT, 413, 415: dropped by the SDK and counted, never silently.
      return 'REJECTED';
    },

    async heartbeat(): Promise<boolean> {
      const startedAt = performance.now();
      const result = await requestAt(heartbeatSchema, '/session/heartbeat', {
        method: 'POST',
        body: {},
        authed: true,
      });
      const endedAt = performance.now();
      if (result.ok) {
        unauthorized = 0;
        // The server may renew the token. It goes to memory only (ADR 0013 5.3).
        if (result.data.sessionToken) setSessionToken(result.data.sessionToken);
        hooks.onState(result.data, { startedAt, endedAt });
        return true;
      }
      if (result.kind === 'problem') {
        if (result.status === 401) handle401(result.code);
        if (result.status === 409 && result.code === 'SESSION_NOT_ACTIVE') hooks.onNotActive();
      }
      return false;
    },
  };
}
