import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { axe } from 'vitest-axe';
import { BusyNotice } from '@/components/busy-notice';
import { shouldRetryQuery } from '@/components/providers/providers';
import { UsersPage } from '@/features/admin/users-page';
import { LoginForm } from '@/features/auth/login-form';
import { RequireRole } from '@/features/auth/require-role';
import { TwoFactorVerifyForm } from '@/features/auth/two-factor-verify-form';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { mockFaultRequests, setMockAuditFailure, setMockBusy } from '@/mocks/fault-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { findLoadedRow } from '@/test/table-utils';
import { BUSY_CODE } from '@/lib/api/busy';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => {
  resetAuthTestState();
  vi.mocked(toast.error).mockClear();
});

const writes = () => mockFaultRequests().filter((r) => r.method !== 'GET');

describe('DL-37 a busy service is a calm state, not an error page', () => {
  it('while a list call waits to retry, a polite status says so; the list then loads', async () => {
    nav.pathname = '/admin/settings/users';
    setMockBusy({ route: '/v1/admin/users', methods: ['GET'], count: 1, retryAfter: '1' });
    const { container } = renderAsStaff(
      <>
        <BusyNotice />
        <UsersPage />
      </>,
      MOCK_USERS.admin,
    );
    const status = await screen.findByText('The service is busy; trying again…', undefined, {
      timeout: 4000,
    });
    expect(status.closest('[role="status"]')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    expect(await findLoadedRow('Casey Newhire')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('The service is busy; trying again…')).not.toBeInTheDocument(),
    );
  }, 15_000);

  it('after the retries run out: a calm message with Try again, never the error boundary; Try again reloads the list', async () => {
    nav.pathname = '/admin/settings/users';
    setMockBusy({ route: '/v1/admin/users', methods: ['GET'], count: 4, retryAfter: '1' });
    const u = userEvent.setup();
    const { container } = renderAsStaff(
      <>
        <BusyNotice />
        <UsersPage />
      </>,
      MOCK_USERS.admin,
    );
    expect(
      await screen.findByText(/Still busy\. Wait a moment and try again/, undefined, {
        timeout: 9000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await u.click(
      within(screen.getByTestId('busy-notice')).getByRole('button', { name: 'Try again' }),
    );
    expect(await findLoadedRow('Casey Newhire')).toBeInTheDocument();
    expect(mockFaultRequests()).toHaveLength(4); // 4 attempts, no extra layer of retries
  }, 20_000);

  it('TanStack does not retry a BUSY answer, retries another read failure once, and never retries a write', () => {
    expect(shouldRetryQuery(0, { status: 503, code: BUSY_CODE })).toBe(false);
    expect(shouldRetryQuery(0, { status: 503, code: '' })).toBe(true);
    expect(shouldRetryQuery(0, { status: 500, code: '' })).toBe(true);
    expect(shouldRetryQuery(1, { status: 500, code: '' })).toBe(false);
  });

  it('a 500 on a staff write is sent once and says to check before trying again', async () => {
    nav.pathname = '/admin/settings/users';
    setMockAuditFailure({ route: '/v1/admin/users', methods: ['POST'], count: 3 });
    const u = userEvent.setup();
    renderAsStaff(
      <>
        <BusyNotice />
        <UsersPage />
      </>,
      MOCK_USERS.admin,
    );
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo Newperson');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('Your password'), MOCK_USERS.admin.password);
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    // The unknown-outcome 500 (FU-BE-208): the list is read, the person is not in it.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /may have been sent[\s\S]*probably was not created/,
    );
    expect(writes()).toHaveLength(1);
    expect(
      await screen.findByText(/Check before trying again: look at the list or the status first/),
    ).toBeInTheDocument();
  });

  it('a BUSY on the user invite (a re-auth route) is not retried: one request and a gentle message', async () => {
    nav.pathname = '/admin/settings/users';
    setMockBusy({ route: '/v1/admin/users', methods: ['POST'], count: 3 });
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo Newperson');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('Your password'), MOCK_USERS.admin.password);
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /busy and nothing was changed/,
    );
    expect(writes()).toHaveLength(1);
  });
});

describe('DL-37 credential screens: BUSY is shown, never retried', () => {
  it('login: one attempt, a gentle busy message that says it was not counted twice', async () => {
    setMockBusy({ route: '/v1/auth/login', count: 3 });
    const u = userEvent.setup();
    renderWithAuth(<LoginForm />);
    await u.type(screen.getByLabelText('Work email'), MOCK_USERS.recruiter.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.recruiter.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The service is busy')).toBeInTheDocument();
    expect(screen.getByText(/not counted twice/)).toBeInTheDocument();
    expect(mockFaultRequests()).toHaveLength(1);
  });

  it('2FA verify: BUSY says to wait for the next code (the same code is refused as a replay) and is sent once', async () => {
    const u = userEvent.setup();
    renderWithAuth(
      <>
        <LoginForm />
        <TwoFactorVerifyForm />
      </>,
    );
    await u.type(screen.getAllByLabelText('Work email')[0]!, MOCK_USERS.admin.email);
    await u.type(screen.getByLabelText('Password'), MOCK_USERS.admin.password);
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText(/Authenticator code/);
    setMockBusy({ route: '/v1/auth/2fa/verify', count: 3 });
    await u.type(code, '123456');
    await u.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(/Wait for the next code/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be used twice/)).toBeInTheDocument();
    expect(mockFaultRequests()).toHaveLength(1);
  });
});

describe('DL-37 the first load and BUSY (FR-104)', () => {
  it('a refresh that stays BUSY does not sign anyone out: a calm message and a manual Try again', async () => {
    setMockBusy({ route: '/v1/auth/refresh', count: 4, retryAfter: '1' });
    const u = userEvent.setup();
    renderAsStaff(
      <RequireRole>
        <p>Dashboard</p>
      </RequireRole>,
      MOCK_USERS.recruiter,
    );
    expect(
      await screen.findByText(/We did not sign you out/, undefined, { timeout: 9000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Taking you to the sign-in page/)).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  }, 20_000);
});
