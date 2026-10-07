import { http, HttpResponse } from 'msw';
import { apiBaseUrl } from '@/lib/env';

/*
 * Faults for tests and the demo, shaped like the real API (docs/api-contract.md section 8):
 *  - BUSY: lock contention answers 503, `Retry-After` and the problem code BUSY. The action did NOT
 *    happen (the mock answers before touching its state). `setMockBusy` answers it a number of
 *    times and then lets the request through to the normal mock.
 *  - Audit failure: a staff write whose audit row failed after the action committed answers a FIXED
 *    500: no detail, no code, no Retry-After. The REAL action DID happen; this mock answers the
 *    500 WITHOUT applying it (a MSW handler cannot run the next one and rewrite its answer), so a
 *    test that needs "it happened" must check the list as the screen tells the user to.
 *  - Outcome unknown (FU-BE-208): the five routes whose transaction may or may not have committed
 *    (2FA setup/confirm, enroll/confirm, disable, recovery-code verify, staff invite and re-issue)
 *    answer the SAME fixed 500 as the audit failure. `setMockOutcomeUnknown` adds an optional
 *    `landed` callback that runs when the fault fires, so a test can leave the mock in the state a
 *    committed action would have produced (for example `seedMockTwoFactor`), or omit it for "did not land".
 *  - A 503 without a code (Redis being down) is its own fault: not BUSY, never retried.
 * Matching is by method and path pattern only: no request data is read or kept.
 */

export interface FaultTarget {
  /** Matched against the path without the API base (for example /v1/admin/users). A string is a prefix. */
  route: string | RegExp;
  /** Methods to hit; all when omitted. */
  methods?: string[];
}
interface Fault extends FaultTarget {
  kind: 'busy' | 'audit500' | 'plain503';
  /** Runs when the fault fires: the effect of an action that did commit. */
  landed?: () => void;
  remaining: number;
  retryAfter: string | null;
}

let faults: Fault[] = [];
const seen: { method: string; path: string }[] = [];

export function resetMockFaults(): void {
  faults = [];
  seen.length = 0;
}

/** Answers 503 BUSY (with `Retry-After`, in seconds as the header text) `count` times on the route, then goes through. */
export function setMockBusy(
  target: FaultTarget & { count: number; retryAfter?: string | null },
): void {
  faults.push({
    ...target,
    kind: 'busy',
    remaining: target.count,
    retryAfter: target.retryAfter === undefined ? '1' : target.retryAfter,
  });
}

/** Answers the fixed audit-failure 500 `count` times on the route (the action is NOT applied here). */
export function setMockAuditFailure(target: FaultTarget & { count: number }): void {
  faults.push({ ...target, kind: 'audit500', remaining: target.count, retryAfter: null });
}

/**
 * Answers the fixed unknown-outcome 500 `count` times. `landed` (optional) applies the action's
 * effect to the mock, because a MSW handler cannot run the real handler and rewrite its answer.
 */
export function setMockOutcomeUnknown(
  target: FaultTarget & { count: number; landed?: () => void },
): void {
  faults.push({
    ...target,
    kind: 'audit500',
    remaining: target.count,
    retryAfter: null,
    ...(target.landed ? { landed: target.landed } : {}),
  });
}

/** Answers a 503 with no BUSY code (Redis outage style) `count` times. */
export function setMockPlain503(target: FaultTarget & { count: number }): void {
  faults.push({ ...target, kind: 'plain503', remaining: target.count, retryAfter: null });
}

/** How many requests each fault saw: method and path only. */
export const mockFaultRequests = (): readonly { method: string; path: string }[] => seen;

const matches = (f: Fault, method: string, path: string): boolean =>
  (!f.methods || f.methods.map((m) => m.toUpperCase()).includes(method)) &&
  (typeof f.route === 'string' ? path.startsWith(f.route) : f.route.test(path));

const base = new URL(apiBaseUrl).pathname.replace(/\/+$/, '');

export function createFaultHandlers() {
  return [
    http.all(`${apiBaseUrl}/v1/*`, ({ request }) => {
      const url = new URL(request.url);
      const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
      const fault = faults.find((f) => f.remaining > 0 && matches(f, request.method, path));
      if (!fault) return undefined;
      seen.push({ method: request.method, path });
      fault.remaining -= 1;
      fault.landed?.();
      if (fault.kind === 'busy') {
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Service Unavailable',
            status: 503,
            detail: 'The service is busy. Try again in a moment.',
            instance: path,
            traceId: 'mock-trace',
            code: 'BUSY',
          },
          {
            status: 503,
            headers: fault.retryAfter === null ? {} : { 'Retry-After': fault.retryAfter },
          },
        );
      }
      if (fault.kind === 'plain503') {
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Service Unavailable',
            status: 503,
            detail: 'Verification is temporarily unavailable.',
            instance: path,
            traceId: 'mock-trace',
          },
          { status: 503 },
        );
      }
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Internal server error',
          instance: path,
          traceId: 'mock-trace',
        },
        { status: 500 },
      );
    }),
  ];
}
