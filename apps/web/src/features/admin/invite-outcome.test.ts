import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { beginSession } from '@/lib/auth-session';
import { setAccessToken } from '@/lib/auth-token';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';
import { checkInviteOutcome } from './queries';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  resetAuthTestState();
  setAccessToken('mock-access-SUPER_ADMIN-direct');
});

const user = (n: number) => ({
  id: `u${n}`,
  email: `person${n}@example.test`,
  name: `P ${n}`,
  role: 'RECRUITER',
  status: 'active',
  locked: false,
  lockedUntil: null,
  totpEnabled: false,
  createdAt: '2026-10-01T09:00:00.000Z',
});

describe('checkInviteOutcome (FR-103, FU-BE-208)', () => {
  it('FR-103: pages the list, and a long list without the person is "unknown", not "missing"', async () => {
    // 1100 people: more than the 10 pages of 100 the web reads, so a miss proves nothing.
    const all = Array.from({ length: 1100 }, (_, i) => user(i));
    server.use(
      http.get('*/v1/admin/users', ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get('page'));
        const pageSize = Number(url.searchParams.get('pageSize'));
        return HttpResponse.json({
          items: all.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: all.length,
        });
      }),
    );
    expect(await checkInviteOutcome(new QueryClient(), 'nobody@example.test')).toBe('unknown');
    expect(await checkInviteOutcome(new QueryClient(), 'person750@example.test')).toBe('found');
  });

  it('FR-103: a list read in full without the person is "missing"', async () => {
    const all = Array.from({ length: 150 }, (_, i) => user(i));
    server.use(
      http.get('*/v1/admin/users', ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get('page'));
        const pageSize = Number(url.searchParams.get('pageSize'));
        return HttpResponse.json({
          items: all.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: all.length,
        });
      }),
    );
    expect(await checkInviteOutcome(new QueryClient(), 'nobody@example.test')).toBe('missing');
  });

  it('FR-103: an answer that arrives after the session changed is ignored and not cached', async () => {
    server.use(
      http.get('*/v1/admin/users', () => {
        beginSession('someone-else');
        return HttpResponse.json({ items: [user(1)] });
      }),
    );
    const qc = new QueryClient();
    expect(await checkInviteOutcome(qc, 'person1@example.test')).toBe('unknown');
    expect(qc.getQueryData(['admin', 'users'])).toBeUndefined();
  });
});
