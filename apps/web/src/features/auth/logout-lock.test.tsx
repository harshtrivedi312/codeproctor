import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_EPOCH_KEY, beginSession, refreshSession, settleSession } from '@/lib/auth-session';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { LoginForm } from './login-form';
import { SignOutButton } from './sign-out-button';
import { useAuth } from './auth-provider';

/*
 * A logout runs inside the cross-tab refresh lock (FR-104, TC-005) and is sent only if it is still
 * the current sign-out: a sign-in that landed while it waited must keep its new cookie.
 */

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

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
