import { describe, expect, it } from 'vitest';
import { JITTER_MS, busyDelayMs, isBusyResponse, isNoRetryRoute, retryAfterMs } from './busy';

const problem = (status: number, code?: string) =>
  new Response(JSON.stringify({ status, ...(code ? { code } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('DL-37 503 BUSY: the pure rules', () => {
  it('only a 503 whose body has code BUSY counts as busy (and the body stays readable)', async () => {
    const busy = problem(503, 'BUSY');
    expect(await isBusyResponse(busy)).toBe(true);
    expect(await busy.json()).toMatchObject({ code: 'BUSY' });
    expect(await isBusyResponse(problem(503))).toBe(false); // Redis outage style
    expect(await isBusyResponse(problem(503, 'OTHER'))).toBe(false);
    expect(await isBusyResponse(problem(500, 'BUSY'))).toBe(false);
    expect(await isBusyResponse(new Response('<html>', { status: 503 }))).toBe(false);
  });

  it('Retry-After is clamped to 1..5 seconds; a missing or unusable header is 1 second', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('0')).toBe(1000);
    expect(retryAfterMs('-3')).toBe(1000);
    expect(retryAfterMs('60')).toBe(5000);
    expect(retryAfterMs('soon')).toBe(1000);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs('1.5')).toBe(1500);
  });

  it('jitter is added and bounded', () => {
    expect(busyDelayMs('1', () => 0)).toBe(1000);
    expect(busyDelayMs('1', () => 0.999999)).toBeLessThan(1000 + JITTER_MS);
    for (let i = 0; i < 50; i += 1) {
      const d = busyDelayMs('2');
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThan(2000 + JITTER_MS);
    }
  });

  it('credential, re-auth and candidate routes are never retried; staff reads and ordinary writes are', () => {
    for (const [path, method] of [
      ['/v1/auth/login', 'POST'],
      ['/v1/auth/2fa/verify', 'POST'],
      ['/v1/auth/2fa/enroll/confirm', 'POST'],
      ['/v1/auth/2fa/setup/start', 'POST'],
      ['/v1/auth/2fa/disable', 'POST'],
      ['/v1/auth/2fa/recovery-codes/regenerate', 'POST'],
      ['/v1/auth/password/reset', 'POST'],
      ['/v1/auth/refresh', 'POST'],
      ['/v1/admin/users', 'POST'],
      ['/v1/admin/users/abc', 'PATCH'],
      ['/v1/admin/users/abc/unlock', 'POST'],
      ['/v1/admin/users/abc/2fa/reset/start', 'POST'],
      ['/api/v1/auth/login', 'POST'],
      ['/v1/candidate/questions/q1/run', 'POST'],
      ['/v1/candidate/session', 'GET'], // candidate routes: never, whatever the method (FR-502)
      ['/api/v1/candidate/session', 'GET'],
    ] as const) {
      expect(isNoRetryRoute(path, method), `${method} ${path}`).toBe(true);
    }
    for (const [path, method] of [
      ['/v1/admin/users', 'GET'],
      ['/v1/admin/settings', 'PATCH'],
      ['/v1/admin/candidates/c1/erasure', 'POST'],
      ['/v1/questions/q1', 'PATCH'],
      ['/v1/tests', 'POST'],
      ['/v1/tests/t1/invitations', 'POST'],
      ['/v1/candidates/c1', 'GET'], // "candidates" is a staff path, not the candidate API
    ] as const) {
      expect(isNoRetryRoute(path, method), `${method} ${path}`).toBe(false);
    }
  });
});
