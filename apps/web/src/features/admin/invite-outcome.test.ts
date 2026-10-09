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
  lastLoginAt: null,
});

describe('checkInviteOutcome (FR-103, FU-BE-208)', () => {
  it('FR-103: a full first page without the person is "unknown", not "missing"', async () => {
    const items = Array.from({ length: 50 }, (_, i) => user(i));
    server.use(http.get('*/v1/admin/users', () => HttpResponse.json({ items })));
    expect(await checkInviteOutcome(new QueryClient(), 'nobody@example.test')).toBe('unknown');
    expect(await checkInviteOutcome(new QueryClient(), 'person3@example.test')).toBe('found');
  });

  it('FR-103: a short list without the person is "missing"', async () => {
    server.use(http.get('*/v1/admin/users', () => HttpResponse.json({ items: [user(1)] })));
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
