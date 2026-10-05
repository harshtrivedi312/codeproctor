import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, isAuthRequest } from '@/lib/api/client';
import { refreshSession } from '@/lib/auth-session';
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
  it('FR-104: a failed logout call still signs out locally, with no unhandled rejection', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    server.use(http.post('*/v1/auth/logout', () => HttpResponse.error()));
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/admin/login'));
    expect(getAccessToken()).toBeNull();
  });

  it('FR-104: a refresh still in flight when the user signs out cannot restore the session', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post('*/v1/auth/refresh', async () => {
        await gate;
        return HttpResponse.json({
          accessToken: 'stale-token',
          user: {
            id: 'u',
            email: 'recruiter@example.test',
            name: 'R',
            role: 'RECRUITER',
            orgName: 'x',
          },
        });
      }),
    );
    const pending = refreshSession();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    // Sign-out waits for the refresh to settle before it calls logout.
    release();
    expect(await pending).toBeNull();
    await waitFor(() => expect(getAccessToken()).toBeNull());
    expect(getAccessToken()).toBeNull();
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
  });

  it('FR-104: a refresh triggered by a 401 while logout is in flight cannot sign the user back in', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lateRefresh: Promise<unknown> = Promise.resolve();
    server.use(
      http.post('*/v1/auth/logout', () => {
        // Another request got a 401 meanwhile, and its handler asks for a refresh.
        lateRefresh = refreshSession();
        return new HttpResponse(null, { status: 204 });
      }),
      http.post('*/v1/auth/refresh', async () => {
        await gate;
        return HttpResponse.json({
          accessToken: 'resurrected-token',
          user: {
            id: 'u',
            email: 'recruiter@example.test',
            name: 'R',
            role: 'RECRUITER',
            orgName: 'x',
          },
        });
      }),
    );
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/admin/login'));
    release();
    await lateRefresh;
    expect(getAccessToken()).toBeNull();
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
  });

  it('FR-104: a slow first-load refresh that ends in 401 cannot sign out a fresh login', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let refreshes = 0;
    server.use(
      http.post('*/v1/auth/refresh', async () => {
        refreshes++;
        await gate;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    let auth: ReturnType<typeof useAuth> | null = null;
    function Capture() {
      auth = useAuth();
      return null;
    }
    renderWithAuth(
      <>
        <Capture />
        <Who />
      </>,
    );
    await waitFor(() => expect(refreshes).toBe(1));
    const login = await api.POST('/v1/auth/login', {
      body: { email: MOCK_USERS.recruiter.email, password: MOCK_USERS.recruiter.password },
    });
    if (login.data?.status !== 'authenticated' || !login.data.session) throw new Error('login');
    auth!.signIn(login.data.session);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER');
    expect(getAccessToken()).toBeTruthy();
  });

  it('FR-101 FR-104: sign-in waits for a slow first-load refresh, so a late 200 cannot overwrite the login cookie', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let refreshes = 0;
    let loginStarted = false;
    server.use(
      http.post('*/v1/auth/refresh', async () => {
        refreshes++;
        await gate;
        return HttpResponse.json({
          accessToken: 'old-session-token',
          user: { id: 'o', email: 'old@example.test', name: 'Old', role: 'AUTHOR', orgName: 'x' },
        });
      }),
    );
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/v1/auth/login')) loginStarted = true;
    });
    renderWithAuth(<LoginForm />);
    await waitFor(() => expect(refreshes).toBe(1));
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Work email'), MOCK_USERS.recruiter.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.recruiter.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(loginStarted).toBe(false);
    release();
    await waitFor(() => expect(loginStarted).toBe(true));
    server.events.removeAllListeners();
  });
});

describe('requests from an earlier session', () => {
  it('FR-104 FR-103: a 401 for user X that arrives after Y signed in is not replayed with Y token', async () => {
    let auth: ReturnType<typeof useAuth> | null = null;
    function Capture() {
      auth = useAuth();
      return null;
    }
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
        <Capture />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: (string | null)[] = [];
    server.use(
      http.get('*/v1/time', async ({ request }) => {
        seen.push(request.headers.get('authorization'));
        await gate;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const inFlight = api.GET('/v1/time'); // sent as X (recruiter)
    await waitFor(() => expect(seen).toHaveLength(1));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(getAccessToken()).toBeNull());
    const login = await api.POST('/v1/auth/login', {
      body: { email: MOCK_USERS.author.email, password: MOCK_USERS.author.password },
    });
    if (login.data?.status !== 'authenticated' || !login.data.session) throw new Error('login');
    auth!.signIn(login.data.session);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('AUTHOR'));

    release();
    const { response } = await inFlight;
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(1); // no replay
    expect(screen.getByTestId('who')).toHaveTextContent('AUTHOR');
  });
});

describe('sign-out that the server did not confirm', () => {
  it('FR-104: after a failed logout, a reload does not restore the session and retries the logout', async () => {
    const first = renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    server.use(http.post('*/v1/auth/logout', () => HttpResponse.error()));
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('We could not confirm you were signed out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry sign-out' })).toBeInTheDocument();
    first.unmount();

    // "Reload": a fresh provider. The refresh cookie is still valid on the mock server.
    server.resetHandlers();
    let refreshCalls = 0;
    let logoutCalls = 0;
    server.use(
      http.post('*/v1/auth/refresh', () => {
        refreshCalls++;
        return new HttpResponse(null, { status: 401 });
      }),
      http.post('*/v1/auth/logout', () => {
        logoutCalls++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await waitFor(() => expect(logoutCalls).toBe(1));
    expect(refreshCalls).toBe(0);
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
    expect(getAccessToken()).toBeNull();
    await waitFor(() =>
      expect(
        screen.queryByText('We could not confirm you were signed out'),
      ).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem('cp.signOutPending')).toBeNull();
  });

  it('FR-104: the pending marker holds no token', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    const token = getAccessToken()!;
    server.use(http.post('*/v1/auth/logout', () => HttpResponse.error()));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(localStorage.getItem('cp.signOutPending')).toBe('1'));
    expect(JSON.stringify({ ...localStorage })).not.toContain(token);
  });
});

describe('isAuthRequest', () => {
  it('FR-104: recognises auth endpoints relative to the API base, not a hard-coded prefix', () => {
    expect(isAuthRequest('http://localhost:4000/v1/auth/refresh')).toBe(true);
    expect(isAuthRequest('http://localhost:4000/api/v1/auth/login')).toBe(true);
    expect(isAuthRequest('http://localhost:4000/v1/time')).toBe(false);
    expect(isAuthRequest('http://localhost:4000/v1/settings/auth/x')).toBe(false);
  });
});
