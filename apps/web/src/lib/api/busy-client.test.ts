import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '@/lib/auth-token';
import {
  getGeneration,
  onSessionChange,
  publishSession,
  refreshSession,
  type AuthSession,
} from '@/lib/auth-session';
import { MOCK_USERS, seedMockRefresh } from '@/mocks/auth-handlers';
import {
  mockFaultRequests,
  resetMockFaults,
  setMockAuditFailure,
  setMockBusy,
  setMockPlain503,
} from '@/mocks/fault-handlers';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';
import { api } from './client';
import { MAX_BUSY_RETRIES, NO_BUSY_RETRY_HEADER, busyStore } from './busy';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.useRealTimers();
});
afterAll(() => server.close());
beforeEach(() => {
  resetAuthTestState();
  resetMockFaults();
  setAccessToken('mock-access-SUPER_ADMIN-direct');
});

const users = '/v1/admin/users';
/** Runs the call with fake timers and lets every wait pass. */
async function settle<T>(call: Promise<T>, ms = 30_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return call;
}
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const seen = (path: string) => mockFaultRequests().filter((r) => r.path === path).length;

describe('DL-37 503 BUSY: the API client retries only BUSY', () => {
  it('BUSY once, then success: sent again after the Retry-After wait and the data arrives', async () => {
    fakeTimers();
    setMockBusy({ route: users, methods: ['GET'], count: 1, retryAfter: '2' });
    const call = api.GET('/v1/admin/users');
    await vi.advanceTimersByTimeAsync(1900);
    expect(busyStore.get().retrying).toBe(true); // still waiting: Retry-After 2 s
    const { data, response } = await settle(call, 1000);
    expect(response.status).toBe(200);
    expect(data?.items.length).toBeGreaterThan(0);
    expect(seen(users)).toBe(1);
    expect(busyStore.get()).toMatchObject({ retrying: false, exhausted: false });
  });

  it('is bounded: 4 attempts in all, then the BUSY answer comes back and the state says so', async () => {
    fakeTimers();
    setMockBusy({ route: users, methods: ['GET'], count: 99 });
    const { response } = await settle(api.GET('/v1/admin/users'));
    expect(response.status).toBe(503);
    expect(seen(users)).toBe(MAX_BUSY_RETRIES + 1);
    expect(busyStore.get()).toMatchObject({ retrying: false, exhausted: true });
  });

  it('a missing Retry-After waits 1 second; a huge one waits at most 5', async () => {
    fakeTimers();
    setMockBusy({ route: users, methods: ['GET'], count: 1, retryAfter: null });
    const a = api.GET('/v1/admin/users');
    await vi.advanceTimersByTimeAsync(999);
    expect(seen(users)).toBe(1);
    expect((await settle(a, 500)).response.status).toBe(200);
    resetMockFaults();
    setMockBusy({ route: users, methods: ['GET'], count: 1, retryAfter: '600' });
    const b = api.GET('/v1/admin/users');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(busyStore.get().retrying).toBe(true);
    expect((await settle(b, 600)).response.status).toBe(200);
  });

  it('the total wait stays around 10 seconds even with Retry-After 5 on every answer', async () => {
    fakeTimers();
    setMockBusy({ route: users, methods: ['GET'], count: 99, retryAfter: '5' });
    const call = api.GET('/v1/admin/users');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await settle(call, 100)).response.status).toBe(503);
    expect(seen(users)).toBeLessThanOrEqual(3); // 5 s + 5 s fits, a third wait would pass 10 s
  });

  it('a 503 without the BUSY code and a 500 are passed through, sent exactly once', async () => {
    setMockPlain503({ route: users, methods: ['GET'], count: 5 });
    expect((await api.GET('/v1/admin/users')).response.status).toBe(503);
    expect(seen(users)).toBe(1);
    resetMockFaults();
    setMockAuditFailure({ route: users, methods: ['GET'], count: 5 });
    expect((await api.GET('/v1/admin/users')).response.status).toBe(500);
    expect(seen(users)).toBe(1);
  });

  it('a 500 on a staff write is sent once, never retried, and raises the check-before-retrying state', async () => {
    setMockAuditFailure({ route: '/v1/admin/settings', methods: ['PATCH'], count: 5 });
    const { response } = await api.PATCH('/v1/admin/settings', { body: { retentionDays: 30 } });
    expect(response.status).toBe(500);
    expect(seen('/v1/admin/settings')).toBe(1);
    expect(busyStore.get().writeFailed).toBe(true);
  });

  it('a write that is not a credential route is retried on BUSY (settings)', async () => {
    fakeTimers();
    setMockBusy({ route: '/v1/admin/settings', methods: ['PATCH'], count: 1 });
    const call = api.PATCH('/v1/admin/settings', { body: { retentionDays: 30 } });
    const { response } = await settle(call, 2000);
    expect(response.status).toBe(200);
    expect(seen('/v1/admin/settings')).toBe(1);
  });

  it('credential and re-auth routes are NOT retried on BUSY: login, 2FA verify, 2FA disable, user invite', async () => {
    setMockBusy({ route: '/v1/auth/login', count: 9 });
    setMockBusy({ route: '/v1/auth/2fa/verify', count: 9 });
    setMockBusy({ route: '/v1/auth/2fa/disable', count: 9 });
    setMockBusy({ route: users, methods: ['POST'], count: 9 });
    const login = await api.POST('/v1/auth/login', {
      body: { email: 'a@example.test', password: 'x' },
    });
    const verify = await api.POST('/v1/auth/2fa/verify', {
      body: { challengeToken: 't', code: '123456' },
    });
    const disable = await api.POST('/v1/auth/2fa/disable', {
      body: { currentPassword: 'x', totpCode: '123456' },
    });
    const invite = await api.POST('/v1/admin/users', {
      body: { email: 'n@example.test', name: 'N', role: 'RECRUITER' },
    });
    for (const r of [login, verify, disable, invite]) expect(r.response.status).toBe(503);
    expect(mockFaultRequests()).toHaveLength(4); // one request each
    expect(busyStore.get().retrying).toBe(false);
  });

  it('a call can opt out with the header, and the header never reaches the server', async () => {
    setMockBusy({ route: users, methods: ['GET'], count: 9 });
    let header: string | null = 'unset';
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes(users)) header = request.headers.get(NO_BUSY_RETRY_HEADER);
    });
    const { response } = await api.GET('/v1/admin/users', {
      headers: { [NO_BUSY_RETRY_HEADER]: '1' },
    });
    expect(response.status).toBe(503);
    expect(seen(users)).toBe(1);
    expect(header).toBeNull();
  });

  it('the retry sends the same body again', async () => {
    fakeTimers();
    setMockBusy({ route: '/v1/admin/settings', methods: ['PATCH'], count: 1 });
    const bodies: string[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH') bodies.push(await request.clone().text());
    });
    await settle(api.PATCH('/v1/admin/settings', { body: { retentionDays: 45 } }), 2000);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('stops when the call is aborted (the screen left): no request after', async () => {
    fakeTimers();
    setMockBusy({ route: users, methods: ['GET'], count: 9 });
    const controller = new AbortController();
    const call = api.GET('/v1/admin/users', { signal: controller.signal }).catch(() => null);
    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    await settle(call, 20_000);
    expect(seen(users)).toBe(1);
    expect(busyStore.get().retrying).toBe(false);
  });

  it('stops when the session generation changes (another person or a role change): no request after', async () => {
    fakeTimers();
    setMockBusy({ route: users, methods: ['GET'], count: 9 });
    const before = getGeneration();
    const call = api.GET('/v1/admin/users');
    await vi.advanceTimersByTimeAsync(300);
    // Someone else signs in on this tab.
    const other = { user: { id: 'other-user', role: 'AUTHOR' } } as unknown as AuthSession;
    publishSession(other);
    expect(getGeneration()).toBeGreaterThan(before);
    const { response } = await settle(call, 20_000);
    expect(response.status).toBe(503);
    expect(seen(users)).toBe(1); // never replayed for the new person
  });
});

describe('DL-37 the silent refresh and BUSY (FR-104)', () => {
  const session = async (): Promise<AuthSession | null> => {
    seedMockRefresh(MOCK_USERS.recruiter.email);
    return refreshSession();
  };

  it('BUSY then success: retried after the wait and the user is signed in', async () => {
    fakeTimers();
    setMockBusy({ route: '/v1/auth/refresh', count: 1 });
    const out = await settle(session(), 2000);
    expect(out?.user.email).toBe(MOCK_USERS.recruiter.email);
    expect(mockFaultRequests()).toHaveLength(1);
  });

  it('still BUSY after the retries: nobody is signed out, the session state is unchanged and "busy" is raised', async () => {
    fakeTimers();
    publishSession({
      accessToken: 'mock-access-SUPER_ADMIN-direct',
      user: { id: 'u-rec', role: 'RECRUITER', email: MOCK_USERS.recruiter.email },
    } as unknown as AuthSession);
    const events: (AuthSession | null)[] = [];
    const off = onSessionChange((s) => events.push(s));
    setMockBusy({ route: '/v1/auth/refresh', count: 99 });
    const out = await settle(session());
    off();
    expect(out).toBeNull();
    expect(events).toEqual([]); // no publish at all: no sign-out
    expect(busyStore.get().refreshBusy).toBe(true);
    expect(mockFaultRequests()).toHaveLength(MAX_BUSY_RETRIES + 1);
  });

  it('a 401 on refresh still signs out (unchanged)', async () => {
    const events: (AuthSession | null)[] = [];
    const off = onSessionChange((s) => events.push(s));
    // No cookie planted: the mock answers 401.
    const out = await refreshSession();
    off();
    expect(out).toBeNull();
    expect(events).toEqual([null]);
  });

  it('a 403 on refresh also signs out', async () => {
    const events: (AuthSession | null)[] = [];
    const off = onSessionChange((s) => events.push(s));
    server.use(
      (await import('msw')).http.post(
        `${(await import('@/lib/env')).apiBaseUrl}/v1/auth/refresh`,
        () => new Response(JSON.stringify({ status: 403 }), { status: 403 }),
      ),
    );
    await refreshSession();
    off();
    expect(events).toEqual([null]);
  });

  it('the refresh retry stops when the session changes during the wait', async () => {
    fakeTimers();
    setMockBusy({ route: '/v1/auth/refresh', count: 99 });
    seedMockRefresh(MOCK_USERS.recruiter.email);
    const call = refreshSession();
    await vi.advanceTimersByTimeAsync(300);
    publishSession({
      user: { id: 'x', role: 'AUTHOR' },
      accessToken: 't',
    } as unknown as AuthSession);
    await settle(call, 20_000);
    expect(mockFaultRequests()).toHaveLength(1);
  });
});
