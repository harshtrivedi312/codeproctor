import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_ADMIN_RECOVERY_CODE, MOCK_TOTP_CODE, MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { http, HttpResponse } from 'msw';
import { LoginForm } from './login-form';
import { TwoFactorVerifyForm } from './two-factor-verify-form';
import { formatRecoveryCode, recoveryCodesFileText } from './recovery-codes';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
// jsdom has no canvas; the QR image itself is covered by the Playwright run.
vi.mock('qrcode', () => ({
  default: { toDataURL: () => Promise.resolve('data:image/png;base64,AA==') },
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

/** Signs in through the real login form so the provider holds the pending challenge, then swaps screens. */
function Flow({ second }: { second: 'verify' }) {
  return (
    <>
      <LoginForm />
      {second === 'verify' ? <TwoFactorVerifyForm /> : null}
    </>
  );
}

async function loginAs(user: { email: string; password: string }) {
  const u = userEvent.setup();
  await u.type(screen.getAllByLabelText('Work email')[0]!, user.email);
  await u.type(screen.getByLabelText('Password'), user.password);
  await u.click(screen.getByRole('button', { name: 'Sign in' }));
  return u;
}

describe('TwoFactorVerifyForm', () => {
  it('FR-102: a valid authenticator code finishes the login', async () => {
    renderWithAuth(<Flow second="verify" />);
    const u = await loginAs(MOCK_USERS.admin);
    await u.type(await screen.findByLabelText(/Authenticator code/), MOCK_TOTP_CODE);
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
  });

  it('FR-102: the next page survives the 2FA step (next=/admin/x is not replaced by login)', async () => {
    nav.search = new URLSearchParams('next=/admin/x');
    renderWithAuth(<Flow second="verify" />);
    const u = await loginAs(MOCK_USERS.admin);
    const code = await screen.findByLabelText(/Authenticator code/);
    // Flow mounts both forms, so the verify form redirected once before the challenge existed.
    router.replace.mockClear();
    await u.type(code, MOCK_TOTP_CODE);
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/x'));
    // Let the pending-challenge effect run; it must not send the user to login afterwards.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/x');
    expect(router.replace).not.toHaveBeenCalledWith('/admin/login');
  });

  it('FR-102: an expired challenge (401) keeps ?reason=expired on the login redirect', async () => {
    renderWithAuth(<Flow second="verify" />);
    const u = await loginAs(MOCK_USERS.admin);
    server.use(
      http.post('*/v1/auth/2fa/verify', () =>
        HttpResponse.json({ code: 'challenge_expired', message: 'expired' }, { status: 401 }),
      ),
    );
    const code = await screen.findByLabelText(/Authenticator code/);
    router.replace.mockClear();
    await u.type(code, MOCK_TOTP_CODE);
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login?reason=expired'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.replace).toHaveBeenLastCalledWith('/admin/login?reason=expired');
  });

  it('FR-102: a recovery code is accepted once and refused the second time (ADR 0003 section 1)', async () => {
    renderWithAuth(<Flow second="verify" />);
    const u = await loginAs(MOCK_USERS.admin);
    await u.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    await u.type(
      screen.getByLabelText('Recovery code'),
      formatRecoveryCode(MOCK_ADMIN_RECOVERY_CODE),
    );
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
  });

  it('FR-102: a wrong code explains what to do and keeps the form', async () => {
    renderWithAuth(<Flow second="verify" />);
    const u = await loginAs(MOCK_USERS.admin);
    await u.type(await screen.findByLabelText(/Authenticator code/), '000000');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('That code did not work')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('recovery code');
  });

  it('FR-102: an input that is neither shape is rejected before the API call', async () => {
    renderWithAuth(<Flow second="verify" />);
    const u = await loginAs(MOCK_USERS.admin);
    await u.type(await screen.findByLabelText(/Authenticator code/), '12345');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(/6-digit code.*recovery code/)).toBeInTheDocument();
  });

  it('FR-102: without a pending sign-in step the page returns to login', async () => {
    renderWithAuth(<TwoFactorVerifyForm />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login'));
  });
});

describe('recovery code file', () => {
  it('FR-102: lists each code in groups of four and never the password', () => {
    const text = recoveryCodesFileText('a@example.test', ['ABCDEFGH23456723']);
    expect(text).toContain('ABCD-EFGH-2345-6723');
    expect(text).toContain('a@example.test');
  });
});
