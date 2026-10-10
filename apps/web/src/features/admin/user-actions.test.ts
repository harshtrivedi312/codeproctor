import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { beginSession } from '@/lib/auth-session';
import { setAccessToken } from '@/lib/auth-token';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';
import { resetStaffTwoFactor } from './user-actions';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  resetAuthTestState();
  beginSession('user-super_admin');
  setAccessToken('mock-access-SUPER_ADMIN-direct');
});

describe('resetStaffTwoFactor unknown outcome (FR-102, contract section 8)', () => {
  it('FR-102: a list that was read after the session changed is not trusted', async () => {
    server.use(
      http.post('*/v1/auth/2fa/reset/:id', () =>
        HttpResponse.json({ title: 'Internal Server Error', status: 500 }, { status: 500 }),
      ),
      http.get('*/v1/admin/users', () => {
        // Someone else signed in while the list was being read: it is another organisation's.
        beginSession('someone-else');
        return HttpResponse.json({
          items: [
            {
              id: 'user-secure',
              email: 's@example.test',
              name: 'S',
              role: 'AUTHOR',
              status: 'active',
              locked: false,
              lockedUntil: null,
              totpEnabled: false,
              createdAt: '2026-06-06T09:00:00.000Z',
            },
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        });
      }),
    );
    const out = await resetStaffTwoFactor(new QueryClient(), 'user-secure', 'x');
    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') return;
    expect(out.hint).toContain('could not read the list');
    expect(out.hint).not.toContain('went through');
  });
});
