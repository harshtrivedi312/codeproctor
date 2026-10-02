import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api/client';
import { getAccessToken } from '@/lib/auth-token';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { LoginForm } from './login-form';
import { RequireRole } from './require-role';
import { SignOutButton } from './sign-out-button';
import { useAuth } from './auth-provider';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

function Who() {
  const { user, role } = useAuth();
  return <p data-testid="who">{user ? `${user.email}|${role}` : 'nobody'}</p>;
}

async function signInAs(user: { email: string; password: string }) {
  const u = userEvent.setup();
  await u.type(screen.getByLabelText('Work email'), user.email);
  await u.type(screen.getByLabelText('Password'), user.password);
  await u.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('session handling', () => {
  it('FR-104: the access token is held in memory only', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    const token = getAccessToken();
    expect(token).toBeTruthy();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(token!);
    expect(document.cookie).not.toContain(token!);
  });

  it('FR-104: with no session and a failed silent refresh, RequireRole redirects to login', async () => {
    nav.pathname = '/admin/questions';
    renderWithAuth(
      <RequireRole>
        <p>secret</p>
      </RequireRole>,
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        '/admin/login?reason=expired&next=%2Fadmin%2Fquestions',
      ),
    );
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('FR-104: a valid refresh cookie restores the session silently', async () => {
    // Sign in once to plant the mock refresh cookie, then reload by rendering fresh.
    const first = renderWithAuth(<LoginForm />);
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(getAccessToken()).toBeTruthy());
    first.unmount();
    const { setAccessTokenForTest } = await import('@/test/auth-test-utils');
    setAccessTokenForTest(null);
    router.replace.mockClear();
    renderWithAuth(
      <RequireRole>
        <Who />
      </RequireRole>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('who')).toHaveTextContent('recruiter@example.test|RECRUITER'),
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('FR-104: an expired access token (401) is refreshed once and the call retried', async () => {
    const first = renderWithAuth(<LoginForm />);
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(getAccessToken()).toBeTruthy());
    first.unmount();
    let calls = 0;
    const seen: (string | null)[] = [];
    server.use(
      http.get('*/v1/time', ({ request }) => {
        calls++;
        seen.push(request.headers.get('authorization'));
        return calls === 1
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ serverNow: new Date().toISOString() });
      }),
    );
    const { data } = await api.GET('/v1/time');
    expect(data?.serverNow).toBeTruthy();
    expect(calls).toBe(2);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('FR-104: if the refresh fails after a 401 the user is signed out', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    server.use(
      http.get('*/v1/time', () => new HttpResponse(null, { status: 401 })),
      http.post('*/v1/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    );
    await api.GET('/v1/time');
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(getAccessToken()).toBeNull();
  });

  it('FR-103: RequireRole shows the fallback for a role that is not allowed', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <RequireRole roles={['SUPER_ADMIN']}>
          <p>settings</p>
        </RequireRole>
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    expect(await screen.findByText(/Your role does not have access/)).toBeInTheDocument();
    expect(screen.queryByText('settings')).not.toBeInTheDocument();
  });

  it('FR-103: RequireRole shows the children for an allowed role', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <RequireRole roles={['RECRUITER', 'SUPER_ADMIN']}>
          <p>settings</p>
        </RequireRole>
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    expect(await screen.findByText('settings')).toBeInTheDocument();
  });

  it('FR-104: logout clears the token and returns to login', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/admin/login'));
    expect(getAccessToken()).toBeNull();
  });
});
