import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from '@/features/auth/login-form';
import { TwoFactorEnroll } from '@/features/auth/two-factor-enroll';
import { TwoFactorVerifyForm } from '@/features/auth/two-factor-verify-form';
import { UsersPage } from '@/features/admin/users-page';
import { api } from '@/lib/api/client';
import { getSessionUserId, isSignOutPending } from '@/lib/auth-session';
import { getAccessToken } from '@/lib/auth-token';
import { apiBaseUrl } from '@/lib/env';
import { addMockInvitedUser } from '@/mocks/admin-handlers';
import {
  MOCK_RECOVERY_CODES,
  MOCK_TOTP_CODE,
  MOCK_USERS,
  seedMockTwoFactor,
  seedMockTwoFactorOff,
} from '@/mocks/auth-handlers';
import { mockFaultRequests, setMockOutcomeUnknown } from '@/mocks/fault-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { findLoadedRow } from '@/test/table-utils';
import { SecurityPage } from './security-page';

/*
 * The fixed 500 "outcome unknown" (api-contract section 8, FU-BE-208): never auto-retried, a fixed
 * message, and a recovery step per route. FR-102, FR-103, FR-104, TC-003, TC-005.
 */

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('qrcode', () => ({
  default: { toDataURL: () => Promise.resolve('data:image/png;base64,AA==') },
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const dialog = () => screen.getByRole('dialog');
const seen = (method: string, path: string) =>
  mockFaultRequests().filter((r) => r.method === method && r.path === path).length;

function watchCalls() {
  const calls: Record<string, number> = {};
  server.events.on('request:start', ({ request }) => {
    const key = `${request.method} ${new URL(request.url).pathname.replace(/^.*\/v1/, '/v1')}`;
    calls[key] = (calls[key] ?? 0) + 1;
  });
  return calls;
}

async function pageAs(user: { email: string }, twoFactorOn: boolean) {
  if (twoFactorOn) seedMockTwoFactor(user.email);
  renderAsStaff(
    <main>
      <SecurityPage />
    </main>,
    user,
  );
  await screen.findByTestId('two-factor-status');
  return userEvent.setup();
}

async function reachConfirm(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole('button', { name: 'Set up 2FA' }));
  await u.type(within(dialog()).getByLabelText('Current password'), MOCK_USERS.recruiter.password);
  await u.click(within(dialog()).getByRole('button', { name: 'Continue' }));
  await within(dialog()).findByTestId('manual-key');
}

describe('2FA setup/confirm answers the fixed 500 (FR-102, FU-BE-208)', () => {
  it('FR-102: it landed: says so, offers new recovery codes, never confirms again with the same code', async () => {
    const calls = watchCalls();
    setMockOutcomeUnknown({
      route: '/v1/auth/2fa/setup/confirm',
      methods: ['POST'],
      count: 1,
      landed: () => seedMockTwoFactor(MOCK_USERS.recruiter.email),
    });
    const u = await pageAs(MOCK_USERS.recruiter, false);
    await reachConfirm(u);
    await u.type(within(dialog()).getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));

    // The check (setup/start with the held password) answers 409: 2FA is on.
    expect(await within(dialog()).findByText('Two-factor sign-in is on')).toBeInTheDocument();
    expect(dialog()).toHaveTextContent('We could not confirm the result');
    expect(calls['POST /v1/auth/2fa/setup/confirm']).toBe(1); // never sent again
    await u.click(within(dialog()).getByRole('button', { name: 'Get new recovery codes' }));
    expect(await within(dialog()).findByTestId('recovery-codes')).toBeInTheDocument();
    expect(calls['POST /v1/auth/2fa/recovery-codes/regenerate']).toBe(1);
    expect(calls['POST /v1/auth/2fa/setup/confirm']).toBe(1);
  });

  it('FR-102: it did not land: set-up starts again with a new QR code and says the old code is void', async () => {
    const calls = watchCalls();
    setMockOutcomeUnknown({ route: '/v1/auth/2fa/setup/confirm', methods: ['POST'], count: 1 });
    const u = await pageAs(MOCK_USERS.recruiter, false);
    await reachConfirm(u);
    await u.type(within(dialog()).getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));
    expect(
      await within(dialog()).findByText('Set-up is not on, so we started it again'),
    ).toBeInTheDocument();
    expect(within(dialog()).getByLabelText('6-digit code')).toHaveValue('');
    expect(calls['POST /v1/auth/2fa/setup/start']).toBe(2);
    expect(calls['POST /v1/auth/2fa/setup/confirm']).toBe(1);
    // A fresh code now works.
    await u.type(within(dialog()).getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));
    expect(await within(dialog()).findByTestId('recovery-codes')).toBeInTheDocument();
  });

  it('FR-102: when the check itself fails, the dialog offers Check again and still sends nothing twice', async () => {
    const calls = watchCalls();
    setMockOutcomeUnknown({ route: '/v1/auth/2fa/setup/confirm', methods: ['POST'], count: 1 });
    const u = await pageAs(MOCK_USERS.recruiter, false);
    await reachConfirm(u);
    server.use(http.post('*/v1/auth/2fa/setup/start', () => HttpResponse.error()));
    await u.type(within(dialog()).getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Confirm and turn on' }));
    expect(await within(dialog()).findByText('We could not check yet')).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(calls['POST /v1/auth/2fa/setup/confirm']).toBe(1);
  });
});

describe('2FA disable answers the fixed 500 (FR-102, FR-104, TC-005)', () => {
  async function disable(u: ReturnType<typeof userEvent.setup>) {
    await u.click(screen.getByRole('button', { name: 'Disable 2FA' }));
    await u.type(
      within(dialog()).getByLabelText('Current password'),
      MOCK_USERS.recruiter.password,
    );
    await u.type(within(dialog()).getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog()).getByRole('button', { name: 'Turn off 2FA' }));
  }

  for (const landed of [true, false]) {
    it(`FR-102: ${landed ? 'landed' : 'not landed'}: logs out once, goes to sign-in, and a later 401 starts no refresh`, async () => {
      const calls = watchCalls();
      setMockOutcomeUnknown({
        route: '/v1/auth/2fa/disable',
        methods: ['POST'],
        count: 1,
        ...(landed ? { landed: () => seedMockTwoFactorOff(MOCK_USERS.recruiter.email) } : {}),
      });
      const u = await pageAs(MOCK_USERS.recruiter, true);
      await disable(u);
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith('/admin/login?reason=two-factor-unconfirmed'),
      );
      expect(calls['POST /v1/auth/2fa/disable']).toBe(1); // never auto-retried
      expect(calls['POST /v1/auth/logout']).toBe(1);
      expect(getAccessToken()).toBeNull();
      expect(getSessionUserId()).toBeNull();
      expect(isSignOutPending()).toBe(false); // the logout was confirmed
      // The logout cleared the mock refresh cookie either way: a silent refresh finds no session.
      expect((await fetch(`${apiBaseUrl}/v1/auth/refresh`, { method: 'POST' })).status).toBe(401);
      const refreshBefore2 = calls['POST /v1/auth/refresh'] ?? 0;

      // A 401 that shows up afterwards (the family was revoked) must not start a refresh loop.
      server.use(http.get('*/v1/admin/users', () => new HttpResponse(null, { status: 401 })));
      const { response } = await api.GET('/v1/admin/users');
      expect(response.status).toBe(401);
      expect(calls['POST /v1/auth/refresh'] ?? 0).toBe(refreshBefore2);
    });
  }

  it('FR-102: the sign-in page explains the unconfirmed result without claiming 2FA is off', async () => {
    nav.search = new URLSearchParams('reason=two-factor-unconfirmed');
    renderWithAuth(<LoginForm />);
    const note = await screen.findByText(/If sign-in no longer asks for an authenticator code/);
    expect(note.closest('[role=status]')).not.toBeNull();
    expect(screen.queryByText(/turned off and you were signed out/)).not.toBeInTheDocument();
  });
});

describe('2FA enroll/confirm answers the fixed 500 (FR-102, TC-003)', () => {
  function Flow() {
    return (
      <>
        <LoginForm />
        <TwoFactorEnroll />
      </>
    );
  }
  it('TC-003: goes to sign-in with no session, never re-confirms, and the sign-in page explains both outcomes', async () => {
    const calls = watchCalls();
    setMockOutcomeUnknown({ route: '/v1/auth/2fa/enroll/confirm', methods: ['POST'], count: 1 });
    renderWithAuth(<Flow />);
    const u = userEvent.setup();
    await u.type(screen.getAllByLabelText('Work email')[0]!, MOCK_USERS.reviewer.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.reviewer.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByTestId('manual-key');
    await u.type(screen.getByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(screen.getByRole('button', { name: 'Confirm and continue' }));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/admin/login?reason=enroll-unconfirmed'),
    );
    expect(calls['POST /v1/auth/2fa/enroll/confirm']).toBe(1);
    expect(getAccessToken()).toBeNull();
  });

  it('FR-102: the sign-in page says what to expect and that the codes were lost', async () => {
    nav.search = new URLSearchParams('reason=enroll-unconfirmed');
    renderWithAuth(<LoginForm />);
    expect(await screen.findByText(/get new recovery codes/)).toBeInTheDocument();
  });
});

describe('recovery-code sign-in answers the fixed 500 (FR-102)', () => {
  function Flow() {
    return (
      <>
        <LoginForm />
        <TwoFactorVerifyForm />
      </>
    );
  }
  async function toVerify() {
    renderWithAuth(<Flow />);
    const u = userEvent.setup();
    await u.type(screen.getAllByLabelText('Work email')[0]!, MOCK_USERS.admin.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.admin.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByLabelText(/Authenticator code/);
    return u;
  }

  it('FR-102: a recovery code that gets the 500 restarts sign-in from the password step, once', async () => {
    const calls = watchCalls();
    setMockOutcomeUnknown({ route: '/v1/auth/2fa/verify', methods: ['POST'], count: 1 });
    const u = await toVerify();
    await u.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await u.type(screen.getByLabelText('Recovery code'), MOCK_RECOVERY_CODES[0]!);
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/admin/login?reason=recovery-unconfirmed'),
    );
    expect(calls['POST /v1/auth/2fa/verify']).toBe(1);
    expect(getAccessToken()).toBeNull();
  });

  it('FR-102: a 6-digit code that gets a 500 is not treated as a recovery outcome', async () => {
    setMockOutcomeUnknown({ route: '/v1/auth/2fa/verify', methods: ['POST'], count: 1 });
    const u = await toVerify();
    await u.type(screen.getByLabelText(/Authenticator code/), MOCK_TOTP_CODE);
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await screen.findByRole('alert');
    expect(router.replace).not.toHaveBeenCalledWith('/admin/login?reason=recovery-unconfirmed');
  });

  it('FR-102: the sign-in page explains that a spent recovery code is refused', async () => {
    nav.search = new URLSearchParams('reason=recovery-unconfirmed');
    renderWithAuth(<LoginForm />);
    expect(await screen.findByText(/it was already used/)).toBeInTheDocument();
  });
});

describe('staff invite answers the fixed 500 (FR-103, FU-BE-208)', () => {
  async function invite(email: string, beforeSend?: () => void) {
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const d = await screen.findByRole('dialog');
    await u.type(within(d).getByLabelText('Full name'), 'Jo Newperson');
    await u.type(within(d).getByLabelText('Work email'), email);
    beforeSend?.();
    await u.click(within(d).getByRole('button', { name: 'Send invitation' }));
    return d;
  }

  it('FR-103: it landed: the list is read, the person is there, the message says it may have been sent, nothing is resent', async () => {
    const calls = watchCalls();
    setMockOutcomeUnknown({
      route: '/v1/admin/users',
      methods: ['POST'],
      count: 1,
      landed: () => addMockInvitedUser('jo@example.test', 'Jo Newperson', 'RECRUITER'),
    });
    const d = await invite('jo@example.test');
    expect(await within(d).findByText('Invitation may have been sent')).toBeInTheDocument();
    expect(d).toHaveTextContent('The person is now in the list');
    expect(calls['POST /v1/admin/users']).toBe(1);
    await userEvent.setup().keyboard('{Escape}');
    expect(await findLoadedRow('Jo Newperson')).toBeInTheDocument();
  });

  it('FR-103: it did not land: says it probably was not created and still never resends', async () => {
    const calls = watchCalls();
    setMockOutcomeUnknown({ route: '/v1/admin/users', methods: ['POST'], count: 1 });
    const d = await invite('jo@example.test');
    expect(await within(d).findByText(/probably was not created/)).toBeInTheDocument();
    expect(calls['POST /v1/admin/users']).toBe(1);
    expect(seen('POST', '/v1/admin/users')).toBe(1);
  });

  it('FR-103: when the list cannot be read the message says to reload and look', async () => {
    setMockOutcomeUnknown({ route: '/v1/admin/users', methods: ['POST'], count: 1 });
    // The list loaded before the fault; the read after the 500 is the one that fails.
    const d = await invite('jo@example.test', () =>
      server.use(http.get('*/v1/admin/users', () => HttpResponse.error())),
    );
    expect(await within(d).findByText(/could not read the list/)).toBeInTheDocument();
  });
});
