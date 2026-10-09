import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/features/auth/auth-provider';
import { MOCK_TOTP_CODE, MOCK_USERS, seedMockTwoFactor } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { router } from '@/test/nav-mock';
import { LoginForm } from '@/features/auth/login-form';
import { SecurityPage } from './security-page';
import { TwoFactorNudge } from './two-factor-nudge';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('qrcode', () => ({
  default: { toDataURL: () => Promise.resolve('data:image/png;base64,AA==') },
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

function Who() {
  const { user } = useAuth();
  return (
    <p data-testid="who">{user ? `${user.role}:${String(user.twoFactorRecommended)}` : '-'}</p>
  );
}

describe('two-factor recommendation (FR-102, optional for every role)', () => {
  it.each(Object.values(MOCK_USERS).filter((u) => !('totp' in u && u.totp)))(
    'FR-102 TC-003 (D-70): $role without TOTP signs in with a password alone and sees the nudge',
    async (user) => {
      renderWithAuth(
        <>
          <LoginForm />
          <Who />
          <TwoFactorNudge />
        </>,
      );
      const u = userEvent.setup();
      await u.type(screen.getByLabelText('Work email'), user.email);
      await u.type(screen.getByLabelText('Password'), user.password);
      await u.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent(`${user.role}:true`));
      const nudge = screen.getByTestId('two-factor-nudge');
      expect(nudge).toHaveTextContent('We recommend turning on two-factor sign-in');
      expect(within(nudge).getByRole('link')).toHaveAttribute('href', '/admin/security');
    },
  );

  it('FR-102: dismissing the nudge hides it', async () => {
    renderAsStaff(<TwoFactorNudge />, MOCK_USERS.reviewer);
    const u = userEvent.setup();
    await screen.findByTestId('two-factor-nudge');
    expect(await axe(document.body)).toHaveNoViolations();
    await u.click(screen.getByRole('button', { name: 'Dismiss the two-factor recommendation' }));
    expect(screen.queryByTestId('two-factor-nudge')).not.toBeInTheDocument();
  });

  it('FR-102: a user with 2FA on sees no nudge', async () => {
    seedMockTwoFactor(MOCK_USERS.admin.email);
    renderAsStaff(
      <>
        <Who />
        <TwoFactorNudge />
      </>,
      MOCK_USERS.admin,
    );
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('SUPER_ADMIN:false'));
    expect(screen.queryByTestId('two-factor-nudge')).not.toBeInTheDocument();
  });

  it('FR-102: the nudge is gone after set-up completes: the user is signed out and signs in again', async () => {
    renderAsStaff(
      <main>
        <TwoFactorNudge />
        <SecurityPage />
      </main>,
      MOCK_USERS.reviewer,
    );
    const u = userEvent.setup();
    await screen.findByTestId('two-factor-nudge');
    await u.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    const dialog = screen.getByRole('dialog');
    await u.type(within(dialog).getByLabelText('Current password'), MOCK_USERS.reviewer.password);
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('6-digit code'), MOCK_TOTP_CODE);
    await u.click(within(dialog).getByRole('button', { name: 'Confirm and turn on' }));
    await u.click(await within(dialog).findByLabelText(/I have saved these recovery codes/));
    await u.click(within(dialog).getByRole('button', { name: 'Done' }));
    // The server ended every session: the user is sent to sign-in, so the nudge is gone.
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/admin/login?reason=two-factor-on'),
    );
    await waitFor(() => expect(screen.queryByTestId('two-factor-nudge')).not.toBeInTheDocument());
  });
});
