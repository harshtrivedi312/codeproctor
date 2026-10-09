import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_EPOCH_KEY, beginSession, refreshSession, settleSession } from '@/lib/auth-session';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { router } from '@/test/nav-mock';
import { renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { LoginForm } from './login-form';
import { SignOutButton } from './sign-out-button';
import { useAuth } from './auth-provider';

/*
 * A logout runs inside the cross-tab refresh lock (FR-104, TC-005) and is sent only if it is still
 * the current sign-out: a sign-in that landed while it waited must keep its new cookie.
 */

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
// A short lock wait so the bound can be tested with real timers (AbortSignal.timeout is not faked).
// The mock does not reach settleSession: it reads the real constant inside auth-session.ts.
vi.mock('@/lib/auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth-session')>()),
  LOGOUT_LOCK_WAIT_MS: 300,
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

function Who() {
  const { user } = useAuth();
  return <p data-testid="who">{user ? user.role : 'nobody'}</p>;
}

function countLogouts() {
  const n = { logout: 0 };
  server.events.on('request:start', ({ request }) => {
    if (request.url.endsWith('/v1/auth/logout')) n.logout += 1;
  });
  return n;
}

/** Another tab's refresh holding the lock; call the result to let it go. */
function holdRefreshLock(): () => void {
  let release: () => void = () => undefined;
  void navigator.locks.request('cp.refresh', () => new Promise<void>((r) => (release = r)));
  return () => release();
}

async function signedInPage() {
  renderWithAuth(
    <>
      <LoginForm />
      <SignOutButton />
      <Who />
    </>,
  );
  const u = userEvent.setup();
  await u.type(screen.getByLabelText('Work email'), MOCK_USERS.recruiter.email);
  await u.type(screen.getByLabelText('Password'), MOCK_USERS.recruiter.password);
  await u.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
  return u;
}
const tick = () => new Promise((r) => setTimeout(r, 30));

describe('logout and the refresh lock (FR-104, TC-005)', () => {
  it('TC-005: the logout is sent inside the lock: nothing goes out while another tab holds it', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    const release = holdRefreshLock();
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    await tick();
    expect(calls.logout).toBe(0);
    release();
    await waitFor(() => expect(calls.logout).toBe(1));
  });

  it('TC-005: a logout queued behind a refresh sends nothing after a sign-in in this tab', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    const release = holdRefreshLock();
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    await tick();
    beginSession('user-recruiter'); // the user signed in again while the logout was queued
    release();
    await tick();
    await tick();
    expect(calls.logout).toBe(0);
  });

  it('TC-005: same for a sign-in announced by another tab', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    const release = holdRefreshLock();
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    await tick();
    // Another tab signed in: it cleared the marker and announced a new epoch.
    window.localStorage.removeItem('cp.signOutPending');
    window.dispatchEvent(
      new StorageEvent('storage', { key: SESSION_EPOCH_KEY, newValue: 'nonce|user-other' }),
    );
    release();
    await tick();
    await tick();
    expect(calls.logout).toBe(0);
  });

  it('TC-005: a sign-in during the wait for a running refresh does not get the old logout', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    server.use(
      http.post('*/v1/auth/refresh', async () => {
        await gate;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const pending = refreshSession();
    await tick();
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    // The sign-out is tracked from its start: a sign-in waits for it.
    let settled = false;
    void settleSession().then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    beginSession('user-recruiter'); // a login lands inside the `await settled` window
    open();
    await pending;
    await tick();
    await tick();
    expect(calls.logout).toBe(0);
  });
});

describe('logout lock bound and queued sign-outs (FR-104, TC-005)', () => {
  it('FR-104 TC-005: with the lock held for good, the logout is sent exactly once after the bounded wait', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    holdRefreshLock(); // never released
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    await tick();
    expect(calls.logout).toBe(0);
    await waitFor(() => expect(calls.logout).toBe(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.logout).toBe(1);
    expect(window.localStorage.getItem('cp.signOutPending')).toBeNull();
  });

  it('FR-104 TC-005: signOutRevoked(unconfirmed) queued behind a held lock still sends its logout once the lock is released', async () => {
    function RevokedButton() {
      const { signOutRevoked } = useAuth();
      return (
        <button type="button" onClick={() => void signOutRevoked('unconfirmed')}>
          Revoked sign out
        </button>
      );
    }
    const calls = countLogouts();
    renderWithAuth(
      <>
        <LoginForm />
        <RevokedButton />
        <Who />
      </>,
    );
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Work email'), MOCK_USERS.recruiter.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.recruiter.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('RECRUITER'));
    const release = holdRefreshLock();
    await u.click(screen.getByRole('button', { name: 'Revoked sign out' }));
    await tick();
    expect(calls.logout).toBe(0);
    release();
    await waitFor(() => expect(calls.logout).toBe(1));
    await waitFor(() => expect(window.localStorage.getItem('cp.signOutPending')).toBeNull());
  });

  it('FR-104 TC-005: two tabs signing out at once send exactly one logout and leave the marker cleared', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    // The other tab holds the lock, sends its own logout, clears the shared marker, then releases.
    let release: () => void = () => undefined;
    const otherTab = navigator.locks.request('cp.refresh', async () => {
      await new Promise<void>((r) => (release = r));
      await fetch(`${apiBaseUrl}/v1/auth/logout`, { method: 'POST' });
      window.localStorage.removeItem('cp.signOutPending');
    });
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    await tick();
    expect(window.localStorage.getItem('cp.signOutPending')).toBe('1');
    release();
    await otherTab;
    await tick();
    await tick();
    expect(calls.logout).toBe(1); // the other tab's; this tab saw the marker cleared and sent none
    expect(window.localStorage.getItem('cp.signOutPending')).toBeNull();
    expect(screen.queryByText('We could not confirm you were signed out')).not.toBeInTheDocument();
  });
});

describe('sign-out marker edge cases (FR-104, TC-005)', () => {
  it('FR-104 TC-005: storage readable but not writable: Sign out still sends exactly one logout', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key: string) => {
      if (key === 'cp.signOutPending') throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      await u.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(calls.logout).toBe(1));
      await tick();
      expect(calls.logout).toBe(1);
      expect(router.replace).toHaveBeenCalledWith('/admin/login');
      expect(
        screen.queryByText('We could not confirm you were signed out'),
      ).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('FR-104 TC-005: storage unreadable: a queued logout still sends once the lock is released', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    const release = holdRefreshLock();
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      await u.click(screen.getByRole('button', { name: 'Sign out' }));
      await tick();
      expect(calls.logout).toBe(0);
      release();
      await waitFor(() => expect(calls.logout).toBe(1));
    } finally {
      spy.mockRestore();
    }
  });

  it('FR-104 TC-005: marker cleared by another tab with no epoch event: no logout is sent and no warning shows', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    const release = holdRefreshLock();
    await u.click(screen.getByRole('button', { name: 'Sign out' }));
    await tick();
    window.localStorage.removeItem('cp.signOutPending'); // another tab signed in or confirmed
    release();
    await tick();
    await tick();
    expect(calls.logout).toBe(0);
    expect(screen.queryByText('We could not confirm you were signed out')).not.toBeInTheDocument();
  });
});

describe.each([
  ['setItem throws, getItem works', 'set'],
  ['getItem throws, setItem works', 'get'],
  ['both throw', 'both'],
] as const)('Retry sign-out with unusable storage (%s) (FR-104, TC-005)', (_name, mode) => {
  function breakStorage() {
    const blocked = (): never => {
      throw new DOMException('blocked', 'SecurityError');
    };
    const spies: { mockRestore: () => void }[] = [];
    if (mode !== 'get') {
      spies.push(
        vi.spyOn(window.localStorage, 'setItem').mockImplementation((key: string) => {
          if (key === 'cp.signOutPending') blocked();
        }),
      );
    }
    if (mode !== 'set')
      spies.push(vi.spyOn(window.localStorage, 'getItem').mockImplementation(blocked));
    return () => spies.forEach((spy) => spy.mockRestore());
  }

  it('FR-104 TC-005: after a failed logout, Retry sends one more logout; a failed retry keeps the warning, an ok one clears it', async () => {
    const calls = countLogouts();
    const u = await signedInPage();
    server.use(http.post('*/v1/auth/logout', () => HttpResponse.error()));
    const restore = breakStorage();
    try {
      await u.click(screen.getByRole('button', { name: 'Sign out' }));
      const warning = 'We could not confirm you were signed out';
      expect(await screen.findByText(warning)).toBeInTheDocument();
      expect(calls.logout).toBe(1);
      await u.click(screen.getByRole('button', { name: 'Retry sign-out' }));
      await waitFor(() => expect(calls.logout).toBe(2));
      expect(await screen.findByText(warning)).toBeInTheDocument(); // still failing
      server.use(http.post('*/v1/auth/logout', () => new HttpResponse(null, { status: 204 })));
      await u.click(screen.getByRole('button', { name: 'Retry sign-out' }));
      await waitFor(() => expect(calls.logout).toBe(3));
      await waitFor(() => expect(screen.queryByText(warning)).not.toBeInTheDocument());
    } finally {
      restore();
    }
  });
});
