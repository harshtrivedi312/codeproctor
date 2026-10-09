import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, isAuthRequest } from '@/lib/api/client';
import {
  LOGOUT_LOCK_WAIT_MS,
  REQUEST_TIMEOUT_MS,
  getSessionUserId,
  trackLogout,
  invalidateRefreshes,
  refreshSession,
  resetInMemorySignOutFlagForTests,
  settleSession,
} from '@/lib/auth-session';
import { getAccessToken } from '@/lib/auth-token';
import { MOCK_USERS, seedMockRefresh } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { LoginForm } from './login-form';
import { RequireRole } from './require-role';
import { SignOutButton } from './sign-out-button';
import { useAuth } from './auth-provider';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('qrcode', () => ({
  default: { toDataURL: () => Promise.resolve('data:image/png;base64,AA==') },
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

function Who() {
  const { user, role } = useAuth();
  return <p data-testid="who">{user ? `${user.email}|${role}` : 'nobody'}</p>;
}

/** Resolves once the mocked logout response has been sent (no fixed sleeps before negative checks). */
function nextLogoutAnswer(): Promise<void> {
  return new Promise((resolve) => {
    const on = ({ request }: { request: Request }) => {
      if (request.url.endsWith('/v1/auth/logout')) {
        server.events.removeListener('response:mocked', on);
        resolve();
      }
    };
    server.events.on('response:mocked', on);
  });
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
            totpEnabled: false,
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
            totpEnabled: false,
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
    const captured: { auth: ReturnType<typeof useAuth> | null } = { auth: null };
    function Capture() {
      const value = useAuth();
      React.useEffect(() => {
        captured.auth = value;
      });
      return null;
    }
    renderWithAuth(
      <>
        <Capture />
        <Who />
      </>,
    );
    await waitFor(() => expect(refreshes).toBe(1));
    const firstLoadRefresh = refreshSession(); // the same promise the provider is waiting on
    const login = await api.POST('/v1/auth/login', {
      body: { email: MOCK_USERS.recruiter.email, password: MOCK_USERS.recruiter.password },
    });
    if (login.data?.status !== 'authenticated' || !login.data.session) throw new Error('login');
    captured.auth!.signIn(login.data.session);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    release();
    expect(await firstLoadRefresh).toBeNull();
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
          user: {
            id: 'o',
            email: 'old@example.test',
            name: 'Old',
            role: 'AUTHOR',
            orgName: 'x',
            totpEnabled: false,
          },
        });
      }),
    );
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/v1/auth/login')) loginStarted = true;
    });
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await waitFor(() => expect(refreshes).toBe(1));
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Work email'), MOCK_USERS.recruiter.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.recruiter.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(loginStarted).toBe(false);
    release();
    await waitFor(() => expect(loginStarted).toBe(true));
    await waitFor(() => expect(getAccessToken()).not.toBe('old-session-token'));
    await waitFor(() =>
      expect(screen.getByTestId('who')).toHaveTextContent(MOCK_USERS.recruiter.email),
    );
    server.events.removeAllListeners();
  });
});

describe('requests from an earlier session', () => {
  it('FR-104 FR-103: a 401 for user X that arrives after Y signed in is not replayed with Y token', async () => {
    const captured: { auth: ReturnType<typeof useAuth> | null } = { auth: null };
    function Capture() {
      const value = useAuth();
      React.useEffect(() => {
        captured.auth = value;
      });
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
    captured.auth!.signIn(login.data.session);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('AUTHOR'));

    release();
    const { response } = await inFlight;
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(1); // no replay
    expect(screen.getByTestId('who')).toHaveTextContent('AUTHOR');
  });
});

describe('other tabs (shared refresh cookie)', () => {
  it('FR-103 FR-104: a 401 in a tab whose cookie now belongs to another user is not replayed as that user', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    // Another tab signs in as the author: the shared cookie now belongs to them.
    seedMockRefresh(MOCK_USERS.author.email);
    const seen: (string | null)[] = [];
    server.use(
      http.get('*/v1/time', ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return seen.length === 1
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ serverNow: new Date().toISOString() });
      }),
    );
    const { response } = await api.GET('/v1/time');
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(1); // not replayed with the author's token
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(getAccessToken()).toBeNull();
  });

  function refreshCounter(): { count: () => number; stop: () => void } {
    let n = 0;
    const listener = ({ request }: { request: Request }) => {
      if (request.url.endsWith('/v1/auth/refresh')) n++;
    };
    server.events.on('request:start', listener);
    return { count: () => n, stop: () => server.events.removeListener('request:start', listener) };
  }

  it('FR-103 FR-104 TC-005: a sign-in as someone else in another tab signs two other tabs out with no network call', async () => {
    const tabA = renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    const tabB = renderWithAuth(<Who />);
    await act(() => Promise.resolve()); // let tab B start and finish its first-load refresh
    await settleSession();
    const refreshes = refreshCounter();
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'cp.sessionEpoch', newValue: 'n1|someone-else' }),
      );
    });
    await waitFor(() => expect(screen.getAllByTestId('who')[0]).toHaveTextContent('nobody'));
    expect(screen.getAllByTestId('who')[1]).toHaveTextContent('nobody');
    expect(getAccessToken()).toBeNull();
    expect(refreshes.count()).toBe(0);
    refreshes.stop();
    tabA.unmount();
    tabB.unmount();
  });

  it('FR-104 TC-005: a sign-in in another tab as the same user keeps this tab signed in, with no network call', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    const refreshes = refreshCounter();
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'cp.sessionEpoch',
          newValue: `n2|${getSessionUserId()}`,
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER');
    expect(refreshes.count()).toBe(0);
    refreshes.stop();
  });

  it('FR-104: a sign-in writes a non-secret epoch for other tabs and no token', async () => {
    renderWithAuth(<LoginForm />);
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(getAccessToken()).toBeTruthy());
    const epoch = localStorage.getItem('cp.sessionEpoch');
    expect(epoch).toBeTruthy();
    expect(epoch).not.toContain(getAccessToken()!);
    expect(epoch).toMatch(/\|.+$/); // "nonce|userId"
    expect(epoch!.endsWith(`|${getSessionUserId()}`)).toBe(true);
  });

  it('FR-104: when another tab confirms the sign-out, this tab drops the unconfirmed warning', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    server.use(http.post('*/v1/auth/logout', () => HttpResponse.error()));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByText('We could not confirm you were signed out');
    localStorage.removeItem('cp.signOutPending');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'cp.signOutPending', newValue: null }),
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByText('We could not confirm you were signed out'),
      ).not.toBeInTheDocument(),
    );
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
    // A real reload loses module state; only the stored marker can stop the silent refresh.
    resetInMemorySignOutFlagForTests();

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

  async function failLogoutAndReload(): Promise<void> {
    const first = renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    server.use(http.post('*/v1/auth/logout', () => HttpResponse.error()));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByText('We could not confirm you were signed out');
    first.unmount();
    resetInMemorySignOutFlagForTests();
    server.resetHandlers();
  }

  it('FR-104 TC-005: after a reload, another tab signing in (marker cleared first, then the epoch event) supersedes the failing logout retry: no warning, no Retry, no second logout', async () => {
    await failLogoutAndReload();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let logoutCalls = 0;
    server.use(
      http.post('*/v1/auth/logout', async () => {
        logoutCalls++;
        await gate;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await waitFor(() => expect(logoutCalls).toBe(1));
    // The real browser order: the other tab writes the marker removal, then announces its sign-in.
    localStorage.removeItem('cp.signOutPending');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'cp.signOutPending', newValue: null }),
      );
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'cp.sessionEpoch', newValue: 'nonce|user-author' }),
      );
    });
    const answered = nextLogoutAnswer();
    release();
    await answered;
    await act(async () => {});
    expect(screen.queryByText('We could not confirm you were signed out')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry sign-out' })).not.toBeInTheDocument();
    expect(logoutCalls).toBe(1);
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
  });

  it('FR-104 TC-005: Retry sign-out sends nothing when the marker is gone (another sign-in happened)', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    let logoutCalls = 0;
    server.use(
      http.post('*/v1/auth/logout', () => {
        logoutCalls++;
        return HttpResponse.error();
      }),
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Sign out' }));
    const retry = await screen.findByRole('button', { name: 'Retry sign-out' });
    expect(logoutCalls).toBe(1);
    // Another tab signed in: the marker is gone, but this click still got through somehow.
    localStorage.removeItem('cp.signOutPending');
    await u.click(retry);
    expect(logoutCalls).toBe(1);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry sign-out' })).not.toBeInTheDocument(),
    );
  });

  it('FR-104: a legitimate Retry sends exactly one more logout; a failure keeps the warning and Retry, a 204 clears both and the marker', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    let logoutCalls = 0;
    let answer: 'fail' | 'ok' = 'fail';
    server.use(
      http.post('*/v1/auth/logout', () => {
        logoutCalls++;
        return answer === 'ok' ? new HttpResponse(null, { status: 204 }) : HttpResponse.error();
      }),
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByText('We could not confirm you were signed out');
    expect(logoutCalls).toBe(1);
    expect(localStorage.getItem('cp.signOutPending')).toBe('1');

    await u.click(screen.getByRole('button', { name: 'Retry sign-out' }));
    await waitFor(() => expect(logoutCalls).toBe(2));
    // Still failing: the warning stays and Retry still works.
    expect(await screen.findByRole('button', { name: 'Retry sign-out' })).toBeEnabled();
    expect(screen.getByText('We could not confirm you were signed out')).toBeInTheDocument();

    answer = 'ok';
    await u.click(screen.getByRole('button', { name: 'Retry sign-out' }));
    await waitFor(() => expect(logoutCalls).toBe(3));
    await waitFor(() =>
      expect(
        screen.queryByText('We could not confirm you were signed out'),
      ).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem('cp.signOutPending')).toBeNull();
  });

  it('FR-101 FR-104: a login right after a reload waits for the logout retry, and the old warning does not come back', async () => {
    await failLogoutAndReload();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let loginStarted = false;
    server.use(
      http.post('*/v1/auth/logout', async () => {
        await gate;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/v1/auth/login')) loginStarted = true;
    });
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Work email'), MOCK_USERS.recruiter.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.recruiter.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(loginStarted).toBe(false);
    release();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    expect(screen.queryByText('We could not confirm you were signed out')).not.toBeInTheDocument();
    expect(localStorage.getItem('cp.signOutPending')).toBeNull();
    server.events.removeAllListeners();
  });

  it('FR-104: a 401 from logout counts as confirmed, so the marker cannot stick', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <SignOutButton />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    server.use(http.post('*/v1/auth/logout', () => new HttpResponse(null, { status: 401 })));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/admin/login'));
    expect(localStorage.getItem('cp.signOutPending')).toBeNull();
    expect(screen.queryByText('We could not confirm you were signed out')).not.toBeInTheDocument();
  });

  it('FR-104: signing out in another tab signs this tab out at once', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'cp.signOutPending', newValue: '1' }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(getAccessToken()).toBeNull();
  });

  it('FR-104: with the marker set, a refresh signs this tab out instead of leaving it signed in', async () => {
    renderWithAuth(
      <>
        <LoginForm />
        <Who />
      </>,
    );
    await signInAs(MOCK_USERS.recruiter);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    localStorage.setItem('cp.signOutPending', '1');
    expect(await refreshSession()).toBeNull();
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(getAccessToken()).toBeNull();
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

describe('settleSession limit', () => {
  it('FR-101 FR-104: a stuck refresh cannot hold a sign-in for longer than the limit', async () => {
    // The handler never answers. The request's own real-timer abort (10 s) would fire long after
    // this test, so the finally block invalidates it: a late abort must not sign out a later test.
    server.use(http.post('*/v1/auth/refresh', () => new Promise(() => undefined)));
    void refreshSession();
    // And a logout that never settles: the bound covers a queued logout (lock wait + request).
    let endLogout: () => void = () => undefined;
    trackLogout(new Promise<void>((resolve) => (endLogout = resolve)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let done = false;
      const waiting = settleSession().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(LOGOUT_LOCK_WAIT_MS + REQUEST_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await waiting;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      endLogout(); // do not leave a never-settling logout for the next test
      invalidateRefreshes();
    }
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
