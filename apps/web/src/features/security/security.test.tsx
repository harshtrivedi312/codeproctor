import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/features/auth/auth-provider';
import { LoginForm } from '@/features/auth/login-form';
import { TwoFactorEnroll } from '@/features/auth/two-factor-enroll';
import { UserMenu } from '@/features/staff/user-menu';
import { api } from '@/lib/api/client';
import {
  getSessionUserId,
  handleSignInElsewhere,
  isSignOutPending,
  publishSession,
} from '@/lib/auth-session';
import { getAccessToken } from '@/lib/auth-token';
import { apiBaseUrl } from '@/lib/env';
import {
  MOCK_ADMIN_RECOVERY_CODE,
  MOCK_TOTP_CODE,
  MOCK_USERS,
  seedMockRefresh,
  seedMockTwoFactor,
} from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { SecurityPage } from './security-page';
import { isTwoFactorMandatory, reauthBodySchema, setupConfirmBodySchema } from './schemas';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('qrcode', () => ({
  default: { toDataURL: () => Promise.resolve('data:image/png;base64,AA==') },
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  // watchSessionCalls and the request spies add listeners; do not let them leak across tests.
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const base = `${apiBaseUrl}/v1/auth`;
const DISABLED_LOGIN = '/admin/login?reason=two-factor-off';

/** Counts the calls that would sign a user out or restore a session. */
function watchSessionCalls() {
  const calls = { refresh: 0, logout: 0 };
  server.events.on('request:start', ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/auth/refresh')) calls.refresh += 1;
    if (pathname.endsWith('/auth/logout')) calls.logout += 1;
  });
  return calls;
}

async function pageAs(user: { email: string }, opts: { twoFactorOn?: boolean } = {}) {
  if (opts.twoFactorOn) seedMockTwoFactor(user.email);
  // The staff shell supplies the <main> landmark in the app.
  renderAsStaff(
    <main>
      <SecurityPage />
    </main>,
    user,
  );
  await screen.findByTestId('two-factor-status');
  return userEvent.setup();
}
const dialog = () => screen.getByRole('dialog');
const passwordField = () => within(dialog()).getByLabelText('Current password');

async function openAndSubmit(
  u: ReturnType<typeof userEvent.setup>,
  button: string,
  pw: string,
  totpCode: string = MOCK_TOTP_CODE,
) {
  await u.click(screen.getByRole('button', { name: button }));
  await u.type(passwordField(), pw);
  // Disable also asks for the authenticator code (backend PR #51).
  if (button === 'Disable 2FA')
    await u.type(within(dialog()).getByLabelText('6-digit code'), totpCode);
  await u.click(
    within(dialog()).getByRole('button', { name: /^(Continue|Turn off 2FA|Get new codes)$/ }),
  );
}

describe('web-local schemas (FR-102)', () => {
  it('FR-102: currentPassword is required on every body and the confirm body also needs a 6-digit code', () => {
    expect(reauthBodySchema.safeParse({ currentPassword: '' }).success).toBe(false);
    expect(reauthBodySchema.safeParse({ currentPassword: 'x' }).success).toBe(true);
    expect(setupConfirmBodySchema.safeParse({ currentPassword: 'x', code: '12' }).success).toBe(
      false,
    );
    expect(setupConfirmBodySchema.safeParse({ currentPassword: 'x', code: '123456' }).success).toBe(
      true,
    );
    expect(isTwoFactorMandatory('SUPER_ADMIN')).toBe(true);
    expect(isTwoFactorMandatory('REVIEWER')).toBe(true);
    expect(isTwoFactorMandatory('RECRUITER')).toBe(false);
    expect(isTwoFactorMandatory('AUTHOR')).toBe(false);
  });
});

describe('Security page: wrong password (FR-102, FU-BE-39)', () => {
  it('FR-102: a wrong password shows "Password incorrect", keeps the dialog open and keeps the user signed in', async () => {
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.recruiter);
    const token = getAccessToken();
    expect(token).not.toBeNull();
    const refreshBefore = calls.refresh;

    await openAndSubmit(u, 'Set up 2FA', 'not-my-password');

    expect(await within(dialog()).findByText('Password incorrect')).toBeInTheDocument();
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(/^Password incorrect$/);
    // Still open, field emptied for the retry, still signed in, no refresh, no logout, no redirect.
    expect(passwordField()).toHaveValue('');
    expect(getAccessToken()).toBe(token);
    expect(calls.refresh).toBe(refreshBefore);
    expect(calls.logout).toBe(0);
    expect(router.replace).not.toHaveBeenCalled();

    // The retry works in the same dialog.
    await u.type(passwordField(), MOCK_USERS.recruiter.password);
    await u.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog()).findByTestId('manual-key')).toBeInTheDocument();
  });

  it('FR-102: the password field is type=password with autocomplete=current-password', async () => {
    const u = await pageAs(MOCK_USERS.recruiter);
    await u.click(screen.getByRole('button', { name: 'Set up 2FA' }));
    expect(passwordField()).toHaveAttribute('type', 'password');
    expect(passwordField()).toHaveAttribute('autocomplete', 'current-password');
  });

  it('FR-102: the password is cleared when the dialog closes', async () => {
    const u = await pageAs(MOCK_USERS.recruiter);
    await u.click(screen.getByRole('button', { name: 'Set up 2FA' }));
    await u.type(passwordField(), 'half-typed-secret');
    await u.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Set up 2FA' }));
    expect(passwordField()).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('half-typed-secret');
  });

  it('FR-102: a network failure gets a fix-it hint and does not sign the user out', async () => {
    const calls = watchSessionCalls();
    server.use(http.post(`${base}/2fa/setup/start`, () => HttpResponse.error()));
    const u = await pageAs(MOCK_USERS.recruiter);
    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    expect(await within(dialog()).findByText(/Check your connection/)).toBeInTheDocument();
    expect(calls.logout).toBe(0);
    expect(getAccessToken()).not.toBeNull();
  });

  it('FR-102: a 403 with another code is not shown as a password problem and does not sign out', async () => {
    const calls = watchSessionCalls();
    server.use(
      http.post(`${base}/2fa/setup/start`, () =>
        HttpResponse.json({ code: 'forbidden', message: 'No.' }, { status: 403 }),
      ),
    );
    const u = await pageAs(MOCK_USERS.recruiter);
    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    expect(await within(dialog()).findByText('Your role cannot do this')).toBeInTheDocument();
    expect(within(dialog()).queryByText('Password incorrect')).not.toBeInTheDocument();
    expect(calls.logout).toBe(0);
  });
});

describe('Security page: set up, disable, regenerate (FR-102)', () => {
  it('FR-102: a recruiter sets up 2FA, sees the recovery codes once, and then Disable appears; disabling turns it off again', async () => {
    const u = await pageAs(MOCK_USERS.recruiter);
    expect(screen.queryByRole('button', { name: 'Disable 2FA' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Regenerate recovery codes' }),
    ).not.toBeInTheDocument();

    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    expect(await within(dialog()).findByTestId('manual-key')).toBeInTheDocument();
    expect(within(dialog()).getByAltText(/QR code/)).toBeInTheDocument();
    // A wrong first code keeps the dialog on this step.
    await u.type(within(dialog()).getByLabelText('6-digit code'), '000000');
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));
    expect(await within(dialog()).findByText('That code did not match')).toBeInTheDocument();
    await u.type(within(dialog()).getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));

    const codes = await within(dialog()).findByTestId('recovery-codes');
    expect(within(codes).getAllByRole('listitem')).toHaveLength(10);
    expect(within(dialog()).getByRole('button', { name: 'Download recovery codes' })).toBeVisible();
    const done = within(dialog()).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await u.click(within(dialog()).getByRole('checkbox'));
    await u.click(done);

    expect(await screen.findByRole('button', { name: 'Disable 2FA' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Set up 2FA' })).not.toBeInTheDocument();

    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(DISABLED_LOGIN));
    expect(getAccessToken()).toBeNull();
  });

  it('FR-102: an author can enable and then disable 2FA too, and is signed out everywhere', async () => {
    const u = await pageAs(MOCK_USERS.author, { twoFactorOn: true });
    expect(screen.getByRole('button', { name: 'Disable 2FA' })).toBeVisible();
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.author.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(DISABLED_LOGIN));
  });

  it.each([
    ['SUPER_ADMIN', MOCK_USERS.admin],
    ['REVIEWER', MOCK_USERS.reviewer],
  ])('FR-102: Disable 2FA is hidden for %s and the page explains why', async (_role, user) => {
    await pageAs(user, { twoFactorOn: true });
    expect(screen.queryByRole('button', { name: 'Disable 2FA' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeVisible();
    expect(screen.getByTestId('two-factor-required')).toHaveTextContent(
      'Two-factor sign-in is required for your role',
    );
  });

  it('FR-102: regenerating shows new codes once and the old codes stop working', async () => {
    const u = await pageAs(MOCK_USERS.admin, { twoFactorOn: true });
    const verify = (code: string) =>
      fetch(`${base}/2fa/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeToken: `mock-challenge-${MOCK_USERS.admin.email}`, code }),
      });

    await openAndSubmit(u, 'Regenerate recovery codes', MOCK_USERS.admin.password);
    const list = await within(dialog()).findByTestId('recovery-codes');
    const fresh = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent.replace(/-/g, ''));
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(MOCK_ADMIN_RECOVERY_CODE);
    expect(screen.getByRole('dialog')).toHaveTextContent('Your old recovery codes no longer work');

    // Esc does not dismiss the one-time codes.
    await u.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeVisible();

    expect((await verify(MOCK_ADMIN_RECOVERY_CODE)).status).toBe(400);
    expect((await verify(fresh[0]!)).status).toBe(200);
    expect((await verify(fresh[0]!)).status).toBe(400); // each works once
  });

  it('FR-102: the mock refuses a wrong password with 403 REAUTH_FAILED on every endpoint', async () => {
    renderAsStaff(<SecurityPage />, MOCK_USERS.recruiter);
    await screen.findByTestId('two-factor-status');
    for (const path of [
      '2fa/setup/start',
      '2fa/setup/confirm',
      '2fa/disable',
      '2fa/recovery-codes/regenerate',
    ]) {
      const res = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({
          currentPassword: 'nope',
          code: MOCK_TOTP_CODE,
          totpCode: MOCK_TOTP_CODE,
        }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('REAUTH_FAILED');
    }
  });
});

describe('Security page: PR #26 error contract (FR-102, FU-BE-39)', () => {
  const post = (path: string, body: unknown, token: string | null = getAccessToken()) =>
    fetch(`${base}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const stripVolatile = (b: object) => ({ ...b, instance: undefined, traceId: undefined });

  it('FR-102: a wrong password is a 403 problem body with code REAUTH_FAILED and the exact detail', async () => {
    await pageAs(MOCK_USERS.recruiter);
    const res = await post('2fa/setup/start', { currentPassword: 'nope' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      status: 403,
      title: 'Forbidden',
      detail: 'The current password is incorrect.',
      code: 'REAUTH_FAILED',
    });
  });

  it('FR-102: a missing password is 400, no token is 401', async () => {
    await pageAs(MOCK_USERS.recruiter);
    expect((await post('2fa/setup/start', {})).status).toBe(400);
    expect((await post('2fa/disable', {})).status).toBe(400);
    // A recovery code or a malformed code is 400 too.
    expect(
      (await post('2fa/disable', { currentPassword: 'x', totpCode: 'ABCD-EFGH-2345-6723' })).status,
    ).toBe(400);
    expect((await post('2fa/disable', { currentPassword: 'x', totpCode: '12345' })).status).toBe(
      400,
    );
    expect((await post('2fa/setup/confirm', { currentPassword: 'x' })).status).toBe(400);
    expect(
      (await post('2fa/disable', { currentPassword: 'x', totpCode: '123456' }, null)).status,
    ).toBe(401);
  });

  it('FR-102: 5 wrong passwords lock the account; the correct one is then refused with the identical 403 REAUTH_FAILED body', async () => {
    await pageAs(MOCK_USERS.recruiter);
    let lastWrong: object = {};
    for (let i = 0; i < 5; i++) {
      const res = await post('2fa/setup/start', { currentPassword: `wrong-${i}` });
      expect(res.status).toBe(403);
      lastWrong = (await res.json()) as object;
    }
    const locked = await post('2fa/setup/start', {
      currentPassword: MOCK_USERS.recruiter.password,
    });
    expect(locked.status).toBe(403);
    expect(stripVolatile((await locked.json()) as object)).toEqual(stripVolatile(lastWrong));
    // The same lock stops a login: generic 401.
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: MOCK_USERS.recruiter.email,
        password: MOCK_USERS.recruiter.password,
      }),
    });
    expect(login.status).toBe(401);
  });

  it('FR-102: failures from login and from re-auth share one counter, and a correct password resets it', async () => {
    await pageAs(MOCK_USERS.recruiter);
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: MOCK_USERS.recruiter.email, password: 'bad-password-1' }),
      });
    }
    for (let i = 0; i < 2; i++)
      await post('2fa/disable', { currentPassword: 'bad-password-1', totpCode: '123456' });
    expect(
      (await post('2fa/setup/start', { currentPassword: MOCK_USERS.recruiter.password })).status,
    ).toBe(403);
  });

  it('FR-102: disable as SUPER_ADMIN or REVIEWER with the right password is 403 TWO_FACTOR_REQUIRED_FOR_ROLE; a wrong password is REAUTH_FAILED first', async () => {
    for (const user of [MOCK_USERS.admin, MOCK_USERS.reviewer]) {
      resetAuthTestState();
      await pageAs(user, { twoFactorOn: true });
      const wrong = await post('2fa/disable', { currentPassword: 'nope', totpCode: '123456' });
      expect(((await wrong.json()) as { code: string }).code).toBe('REAUTH_FAILED');
      const right = await post('2fa/disable', {
        currentPassword: user.password,
        totpCode: '123456',
      });
      expect(right.status).toBe(403);
      expect(await right.json()).toMatchObject({
        detail: 'Two-factor authentication is required for your role.',
        code: 'TWO_FACTOR_REQUIRED_FOR_ROLE',
      });
      document.body.innerHTML = '';
    }
  });

  it('FR-102: disable and regenerate with 2FA off are 409', async () => {
    await pageAs(MOCK_USERS.recruiter);
    const pw = { currentPassword: MOCK_USERS.recruiter.password };
    expect((await post('2fa/disable', { ...pw, totpCode: '123456' })).status).toBe(409);
    expect((await post('2fa/recovery-codes/regenerate', pw)).status).toBe(409);
  });

  it('FR-102: the dialog shows a clear role message for 403 TWO_FACTOR_REQUIRED_FOR_ROLE and stays signed in', async () => {
    const calls = watchSessionCalls();
    server.use(
      http.post(`${base}/2fa/disable`, () =>
        HttpResponse.json(
          { status: 403, detail: 'x', code: 'TWO_FACTOR_REQUIRED_FOR_ROLE' },
          { status: 403 },
        ),
      ),
    );
    const u = await pageAs(MOCK_USERS.author, { twoFactorOn: true });
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.author.password);
    expect(
      await within(dialog()).findByText('Two-factor sign-in is required for your role'),
    ).toBeInTheDocument();
    expect(within(dialog()).queryByText('Password incorrect')).not.toBeInTheDocument();
    expect(calls.logout).toBe(0);
    expect(getAccessToken()).not.toBeNull();
  });

  it('FR-102: a 400 on the password step shows a field message, a 409 a state-conflict message', async () => {
    server.use(
      http.post(`${base}/2fa/setup/start`, () =>
        HttpResponse.json({ status: 400 }, { status: 400 }),
      ),
    );
    const u = await pageAs(MOCK_USERS.recruiter);
    await openAndSubmit(u, 'Set up 2FA', 'anything');
    expect(await within(dialog()).findByText('Enter your current password.')).toBeInTheDocument();
    await u.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    server.use(
      http.post(`${base}/2fa/setup/start`, () =>
        HttpResponse.json({ status: 409 }, { status: 409 }),
      ),
    );
    await openAndSubmit(u, 'Set up 2FA', 'anything');
    expect(await within(dialog()).findByText('This changed in the meantime')).toBeInTheDocument();
    expect(getAccessToken()).not.toBeNull();
  });

  it('FR-102: an empty password is stopped in the form before any request (400 never needed)', async () => {
    const u = await pageAs(MOCK_USERS.recruiter);
    await u.click(screen.getByRole('button', { name: 'Set up 2FA' }));
    await u.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog()).findByText('Enter your current password.')).toBeInTheDocument();
  });
});

describe('Disable 2FA needs a code and signs out everywhere (FR-102, backend PR #51)', () => {
  const disable = (body: object) =>
    fetch(`${base}/2fa/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getAccessToken()}` },
      body: JSON.stringify(body),
    });

  it('FR-102: a successful disable signs out locally with no refresh and no logout call, clears the cache and the marker, and goes to login with the notice', async () => {
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.recruiter, { twoFactorOn: true });
    const refreshBefore = calls.refresh;
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(DISABLED_LOGIN));
    expect(getAccessToken()).toBeNull();
    expect(getSessionUserId()).toBeNull();
    expect(calls.logout).toBe(0);
    expect(calls.refresh).toBe(refreshBefore);
    // No stuck "could not confirm sign-out" state: nothing is pending, so no retry loop.
    expect(isSignOutPending()).toBe(false);
    // The server revoked the refresh token: a later silent refresh finds no session.
    expect((await fetch(`${base}/refresh`, { method: 'POST' })).status).toBe(401);
    // And 2FA is off for the next login.
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: MOCK_USERS.recruiter.email,
        password: MOCK_USERS.recruiter.password,
      }),
    });
    expect(((await login.json()) as { status: string }).status).toBe('authenticated');
  });

  it('FR-102: the login page shows the notice once, in a calm status style', async () => {
    nav.search = new URLSearchParams('reason=two-factor-off');
    renderWithAuth(<LoginForm />);
    const note = await screen.findByText(
      'Two-factor sign-in is turned off and you were signed out on all devices. Sign in again.',
    );
    expect(note.closest('[role=status]')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('FR-102: a wrong code keeps the dialog open with "Password or code incorrect", empties both fields and keeps the session', async () => {
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.recruiter, { twoFactorOn: true });
    const token = getAccessToken();
    const refreshBefore = calls.refresh;
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password, '000000');
    expect(await within(dialog()).findByText('Password or code incorrect')).toBeInTheDocument();
    expect(passwordField()).toHaveValue('');
    expect(within(dialog()).getByLabelText('6-digit code')).toHaveValue('');
    expect(getAccessToken()).toBe(token);
    expect(calls.logout).toBe(0);
    expect(calls.refresh).toBe(refreshBefore);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('FR-102: the code field is numeric with autocomplete one-time-code, and a bad code is stopped with a field message', async () => {
    const u = await pageAs(MOCK_USERS.recruiter, { twoFactorOn: true });
    await u.click(screen.getByRole('button', { name: 'Disable 2FA' }));
    const code = within(dialog()).getByLabelText('6-digit code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await u.type(passwordField(), MOCK_USERS.recruiter.password);
    await u.type(code, 'ABCD-EFGH-2345-6723');
    await u.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
    expect(
      await within(dialog()).findByText('Enter the 6-digit code from your authenticator app'),
    ).toBeInTheDocument();
  });

  it('FR-102: a server 400 on the code shows the field message and a 503 says to try again, neither signs out', async () => {
    server.use(
      http.post(`${base}/2fa/disable`, () => HttpResponse.json({ status: 400 }, { status: 400 }), {
        once: true,
      }),
    );
    const u = await pageAs(MOCK_USERS.recruiter, { twoFactorOn: true });
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password);
    expect(
      await within(dialog()).findByText('Enter the 6-digit code from your authenticator app'),
    ).toBeInTheDocument();
    server.use(
      http.post(`${base}/2fa/disable`, () => HttpResponse.json({ status: 503 }, { status: 503 }), {
        once: true,
      }),
    );
    await u.type(passwordField(), MOCK_USERS.recruiter.password);
    await u.type(within(dialog()).getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
    expect(await within(dialog()).findByText('Please try again in a moment')).toBeInTheDocument();
    expect(getAccessToken()).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('FR-102: the mock checks in order password, 409 if off, code, role; a replayed code is REAUTH_FAILED', async () => {
    await pageAs(MOCK_USERS.admin, { twoFactorOn: true });
    const pw = MOCK_USERS.admin.password;
    // Wrong password first, even with a valid code.
    expect(
      (
        (await (await disable({ currentPassword: 'nope', totpCode: '123456' })).json()) as {
          code: string;
        }
      ).code,
    ).toBe('REAUTH_FAILED');
    // Wrong code before the role refusal.
    expect(
      (
        (await (await disable({ currentPassword: pw, totpCode: '000000' })).json()) as {
          code: string;
        }
      ).code,
    ).toBe('REAUTH_FAILED');
    // Right password and code: now the role refusal.
    const role = await disable({ currentPassword: pw, totpCode: ' 123456 ' });
    expect(role.status).toBe(403);
    expect(((await role.json()) as { code: string }).code).toBe('TWO_FACTOR_REQUIRED_FOR_ROLE');
    // The same code again is a replay.
    const replay = await disable({ currentPassword: pw, totpCode: '123456' });
    expect(replay.status).toBe(403);
    expect(((await replay.json()) as { code: string }).code).toBe('REAUTH_FAILED');
  });

  it('FR-102: wrong codes and wrong passwords share one lockout with login', async () => {
    await pageAs(MOCK_USERS.recruiter, { twoFactorOn: true });
    const pw = MOCK_USERS.recruiter.password;
    for (let i = 0; i < 3; i++) await disable({ currentPassword: pw, totpCode: '000000' });
    for (let i = 0; i < 2; i++)
      await disable({ currentPassword: 'nope-nope-1', totpCode: '123456' });
    // Locked now: even the right password and code get the same 403 REAUTH_FAILED.
    const locked = await disable({ currentPassword: pw, totpCode: '123456' });
    expect(locked.status).toBe(403);
    expect(((await locked.json()) as { code: string }).code).toBe('REAUTH_FAILED');
  });
});

describe('Disable sign-out is airtight (FR-102, FR-103, TC-005)', () => {
  function renderOwnClient(user: { email: string }) {
    seedMockRefresh(user.email);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <main>
            <SecurityPage />
          </main>
        </AuthProvider>
      </QueryClientProvider>,
    );
    return client;
  }
  const open = async (client: QueryClient) => {
    await screen.findByTestId('two-factor-status');
    expect(client).toBeDefined();
    return userEvent.setup();
  };

  it('FR-102 TC-005: the session is forgotten before queries are cancelled, so a 401 in that window starts no refresh', async () => {
    let usersCalls = 0;
    server.use(
      http.get('*/v1/admin/users', () => {
        usersCalls += 1;
        return HttpResponse.json({ status: 401 }, { status: 401 });
      }),
    );
    seedMockTwoFactor(MOCK_USERS.recruiter.email);
    const calls = watchSessionCalls();
    const client = renderOwnClient(MOCK_USERS.recruiter);
    const u = await open(client);
    const refreshBefore = calls.refresh;
    const tokens: (string | null)[] = [];
    const original = client.cancelQueries.bind(client);
    vi.spyOn(client, 'cancelQueries').mockImplementation(async (...args) => {
      tokens.push(getAccessToken());
      await api.GET('/v1/admin/users');
      return original(...args);
    });
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(DISABLED_LOGIN));
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t === null)).toBe(true);
    expect(calls.refresh).toBe(refreshBefore);
    expect(calls.logout).toBe(0);
    expect(usersCalls).toBeGreaterThanOrEqual(0);
  });

  it('FR-102: the query cache is emptied and other tabs are told (marker 1 then cleared)', async () => {
    seedMockTwoFactor(MOCK_USERS.recruiter.email);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const client = renderOwnClient(MOCK_USERS.recruiter);
    const u = await open(client);
    await client.prefetchQuery({ queryKey: ['seed'], queryFn: () => 'org data' });
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(DISABLED_LOGIN));
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(setItem).toHaveBeenCalledWith('cp.signOutPending', '1');
    expect(removeItem).toHaveBeenLastCalledWith('cp.signOutPending');
    expect(isSignOutPending()).toBe(false);
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it('FR-103 TC-005: if another tab signed in as someone else while the 204 was in flight, nobody is signed out', async () => {
    server.use(
      http.post(`${base}/2fa/disable`, () => {
        publishSession({
          accessToken: 'mock-access-AUTHOR-other',
          user: {
            id: 'user-author',
            email: MOCK_USERS.author.email,
            name: 'Avery Author',
            role: 'AUTHOR',
            orgName: 'x',
            totpEnabled: false,
          },
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    seedMockTwoFactor(MOCK_USERS.recruiter.email);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const client = renderOwnClient(MOCK_USERS.recruiter);
    const u = await open(client);
    setItem.mockClear();
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getSessionUserId()).toBe('user-author');
    expect(getAccessToken()).toBe('mock-access-AUTHOR-other');
    expect(setItem).not.toHaveBeenCalledWith('cp.signOutPending', '1');
    expect(router.replace).not.toHaveBeenCalledWith(DISABLED_LOGIN);
    setItem.mockRestore();
  });

  it('FR-103 TC-005: a staff request still waiting when the 204 arrives is not replayed after its 401', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let usersCalls = 0;
    server.use(
      http.get('*/v1/admin/users', async () => {
        usersCalls += 1;
        await gate;
        return HttpResponse.json({ status: 401 }, { status: 401 });
      }),
    );
    seedMockTwoFactor(MOCK_USERS.recruiter.email);
    const calls = watchSessionCalls();
    const client = renderOwnClient(MOCK_USERS.recruiter);
    const u = await open(client);
    const refreshBefore = calls.refresh;
    const pending = api.GET('/v1/admin/users');
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(DISABLED_LOGIN));
    release();
    const { response } = await pending;
    expect(response.status).toBe(401);
    expect(usersCalls).toBe(1);
    expect(calls.refresh).toBe(refreshBefore);
  });

  it('FR-102: a code typed with spaces is sent trimmed', async () => {
    const bodies: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname.endsWith('/2fa/disable')) {
        void request
          .clone()
          .text()
          .then((t) => bodies.push(t));
      }
    });
    const u = await pageAs(MOCK_USERS.recruiter, { twoFactorOn: true });
    await openAndSubmit(u, 'Disable 2FA', MOCK_USERS.recruiter.password, ' 123456 ');
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0]!)).toMatchObject({ totpCode: '123456' });
  });
});

describe('Session user carries totpEnabled (FR-102)', () => {
  const sessionOf = async (email: string) => {
    seedMockRefresh(email);
    const res = await fetch(`${base}/refresh`, { method: 'POST' });
    return ((await res.json()) as { user: { totpEnabled: boolean } }).user.totpEnabled;
  };

  it('FR-102: the mock refresh reflects the per-user 2FA state: seeded for admin, off for recruiter until set up', async () => {
    expect(await sessionOf(MOCK_USERS.admin.email)).toBe(true);
    expect(await sessionOf(MOCK_USERS.recruiter.email)).toBe(false);
    seedMockTwoFactor(MOCK_USERS.recruiter.email);
    expect(await sessionOf(MOCK_USERS.recruiter.email)).toBe(true);
  });
});

describe('Security page: recovery codes are shown once (FR-102)', () => {
  it('FR-102: a reload or tab close is warned about while the codes show, and not after Done', async () => {
    const u = await pageAs(MOCK_USERS.admin, { twoFactorOn: true });
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await openAndSubmit(u, 'Regenerate recovery codes', MOCK_USERS.admin.password);
    await within(dialog()).findByTestId('recovery-codes');
    expect(unload()).toBe(true);
    await u.click(within(dialog()).getByRole('checkbox'));
    await u.click(within(dialog()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(unload()).toBe(false);
  });

  it('FR-102: the session user (totpEnabled) is re-read when set-up is acknowledged (Done), not while the codes show', async () => {
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.recruiter);
    const before = calls.refresh;
    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    await u.type(await within(dialog()).findByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));
    await within(dialog()).findByTestId('recovery-codes');
    expect(calls.refresh).toBe(before);
    await u.click(within(dialog()).getByRole('checkbox'));
    await u.click(within(dialog()).getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('button', { name: 'Disable 2FA' })).toBeVisible();
    expect(calls.refresh).toBe(before + 1);
  });

  it('FR-102: a failing refresh while the one-time codes show does not unmount them', async () => {
    const u = await pageAs(MOCK_USERS.recruiter);
    server.use(http.post(`${base}/refresh`, () => new HttpResponse(null, { status: 500 })));
    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    await u.type(await within(dialog()).findByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));
    expect(await within(dialog()).findByTestId('recovery-codes')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('recovery-codes')).toBeInTheDocument();
    expect(getAccessToken()).not.toBeNull();
  });

  it('FR-102: regenerating makes no refresh call (totpEnabled does not change)', async () => {
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.admin, { twoFactorOn: true });
    const before = calls.refresh;
    await openAndSubmit(u, 'Regenerate recovery codes', MOCK_USERS.admin.password);
    await within(dialog()).findByTestId('recovery-codes');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.refresh).toBe(before);
  });

  it('FR-102: an older session without totpEnabled shows a neutral checking state and no actions, without crashing', async () => {
    server.use(
      http.post(`${base}/refresh`, () =>
        HttpResponse.json({
          accessToken: 'mock-access-RECRUITER-old',
          user: {
            id: 'user-recruiter',
            email: MOCK_USERS.recruiter.email,
            name: 'Riley Recruiter',
            role: 'RECRUITER',
            orgName: 'Acme Hiring (demo)',
          },
        }),
      ),
    );
    seedMockRefresh(MOCK_USERS.recruiter.email);
    renderAsStaff(
      <main>
        <SecurityPage />
      </main>,
      MOCK_USERS.recruiter,
    );
    expect(await screen.findByText('Checking your two-factor status…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /2FA|recovery/i })).not.toBeInTheDocument();
  });
});

describe('Security page: 401 replay is for the same user only (FR-102, FR-103, TC-005)', () => {
  const unauthorized = () =>
    HttpResponse.json({ status: 401, title: 'Unauthorized' }, { status: 401 });

  it('FR-102 TC-005: a 401 then a refresh as the same user replays the request once and succeeds', async () => {
    let posts = 0;
    server.use(
      http.post(
        `${base}/2fa/setup/start`,
        () => {
          posts += 1;
          return unauthorized();
        },
        { once: true },
      ),
    );
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.recruiter);
    const refreshBefore = calls.refresh;
    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    expect(await within(dialog()).findByTestId('manual-key')).toBeInTheDocument();
    expect(posts).toBe(1);
    expect(calls.refresh).toBe(refreshBefore + 1);
  });

  it('FR-103 TC-005: after another tab signs in as someone else, the 401 is not replayed, the other user is not published and no second POST is sent', async () => {
    let posts = 0;
    server.use(
      http.post(`${base}/2fa/setup/start`, () => {
        posts += 1;
        // Meanwhile tab B signed in as the admin: this tab learns it through the storage event.
        handleSignInElsewhere('nonce|user-super_admin');
        return unauthorized();
      }),
    );
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.recruiter);
    // The refresh cookie now belongs to the admin, as it would after tab B signed in.
    seedMockRefresh(MOCK_USERS.admin.email);
    const refreshBefore = calls.refresh;
    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    expect(await within(dialog()).findByText('Your session has expired')).toBeInTheDocument();
    expect(posts).toBe(1);
    expect(calls.refresh).toBe(refreshBefore);
    expect(getSessionUserId()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('FR-102 TC-005: a 401 whose refresh returns a different user is not replayed either', async () => {
    let posts = 0;
    server.use(
      http.post(`${base}/2fa/setup/start`, () => {
        posts += 1;
        // The shared cookie is swapped to the admin before this tab refreshes.
        seedMockRefresh(MOCK_USERS.admin.email);
        return unauthorized();
      }),
    );
    const u = await pageAs(MOCK_USERS.recruiter);
    await openAndSubmit(u, 'Set up 2FA', MOCK_USERS.recruiter.password);
    expect(await within(dialog()).findByText('Your session has expired')).toBeInTheDocument();
    expect(posts).toBe(1);
    expect(getSessionUserId()).not.toBe('user-super_admin');
  });

  it('FR-102: a 403 REAUTH_FAILED makes no refresh call', async () => {
    const calls = watchSessionCalls();
    const u = await pageAs(MOCK_USERS.recruiter);
    const before = calls.refresh;
    await openAndSubmit(u, 'Set up 2FA', 'wrong-password-1');
    await within(dialog()).findByText('Password incorrect');
    expect(calls.refresh).toBe(before);
  });
});

describe('Security page: entry point, forced enrollment, accessibility', () => {
  it.each(Object.values(MOCK_USERS))(
    'FR-102: the user menu links every staff role ($role) to /admin/security',
    async (user) => {
      renderAsStaff(<UserMenu />, user);
      const u = userEvent.setup();
      await u.click(await screen.findByTestId('user-menu'));
      expect(await screen.findByRole('menuitem', { name: 'Security' })).toHaveAttribute(
        'href',
        '/admin/security',
      );
    },
  );

  it('FR-102: forced enrollment is unchanged and asks for no password', async () => {
    const bodies: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname.includes('/2fa/enroll/')) {
        void request
          .clone()
          .text()
          .then((t) => bodies.push(t));
      }
    });
    renderWithAuth(
      <>
        <LoginForm />
        <TwoFactorEnroll />
      </>,
    );
    const u = userEvent.setup();
    await u.type(screen.getAllByLabelText('Work email')[0]!, MOCK_USERS.reviewer.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.reviewer.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByTestId('manual-key');
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    await u.type(screen.getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    expect(await screen.findByTestId('recovery-codes')).toBeInTheDocument();
    await waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(2));
    expect(bodies.join('')).not.toContain('currentPassword');
  });

  it('FR-102: axe finds no violations on the page or on the open dialog', async () => {
    const u = await pageAs(MOCK_USERS.recruiter);
    expect(await axe(document.body)).toHaveNoViolations();
    await u.click(screen.getByRole('button', { name: 'Set up 2FA' }));
    await act(async () => {});
    expect(await axe(document.body)).toHaveNoViolations();
    await u.type(passwordField(), 'wrong-password-1');
    await u.click(within(dialog()).getByRole('button', { name: 'Continue' }));
    await within(dialog()).findByText('Password incorrect');
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
