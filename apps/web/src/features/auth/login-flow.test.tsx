import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { api } from '@/lib/api/client';
import { LoginForm, SIGN_IN_FAILED_MESSAGE } from './login-form';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

async function signIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Work email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  it('TC-001 FR-101: valid login without 2FA goes to the dashboard', async () => {
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.recruiter.email, MOCK_USERS.recruiter.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
  });

  it('TC-001 FR-102: valid login for a user with TOTP goes to the 2FA prompt', async () => {
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.admin.email, MOCK_USERS.admin.password);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/admin/2fa?next=%2Fadmin'));
  });

  it.each([
    ['reviewer', MOCK_USERS.reviewer],
    ['recruiter', MOCK_USERS.recruiter],
    ['author', MOCK_USERS.author],
  ])(
    'TC-003 FR-102: a %s without TOTP signs in with a password alone, no enrolment step',
    async (_name, user) => {
      renderWithAuth(<LoginForm />);
      await signIn(user.email, user.password);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it('FR-101: wrong password shows the neutral failed-sign-in message and stays on the page', async () => {
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.recruiter.email, 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(SIGN_IN_FAILED_MESSAGE);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('FR-101: shows field errors from the shared schema before calling the API', async () => {
    renderWithAuth(<LoginForm />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
  });

  it('TC-002 FR-101: five wrong passwords lock the account; a sixth, correct attempt is refused', async () => {
    renderWithAuth(<LoginForm />);
    const user = userEvent.setup();
    for (let i = 0; i < 5; i++) {
      await user.clear(screen.getByLabelText('Work email'));
      await user.type(screen.getByLabelText('Work email'), MOCK_USERS.recruiter.email);
      await user.clear(screen.getByLabelText('Password'));
      await user.type(screen.getByLabelText('Password'), 'nope-nope-nope');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByRole('alert');
    }
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), MOCK_USERS.recruiter.password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(SIGN_IN_FAILED_MESSAGE));
    expect(alert).toHaveTextContent(
      'Sign-in failed. If this keeps happening, wait 15 minutes or contact your administrator.',
    );
    expect(alert).not.toHaveTextContent(/locked/i);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('TC-002 FR-101: a locked account answers exactly like a wrong password (no 423, no lock details)', async () => {
    const attempt = (password: string) =>
      api.POST('/v1/auth/login', { body: { email: MOCK_USERS.recruiter.email, password } });
    const wrong = await attempt('nope-nope-nope');
    for (let i = 0; i < 4; i++) await attempt('nope-nope-nope');
    const lockedCorrect = await attempt(MOCK_USERS.recruiter.password);
    expect(lockedCorrect.response.status).toBe(401);
    expect(lockedCorrect.response.status).toBe(wrong.response.status);
    expect(lockedCorrect.error).toEqual(wrong.error);
    expect(lockedCorrect.response.headers.get('retry-after')).toBeNull();
  });

  it('TC-002 FR-101: an unknown email and a wrong password show the identical message', async () => {
    const first = renderWithAuth(<LoginForm />);
    await signIn('nobody@example.test', 'whatever-123456');
    const unknown = (await screen.findByRole('alert')).textContent;
    first.unmount();
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.recruiter.email, 'wrong-password');
    const wrong = (await screen.findByRole('alert')).textContent;
    expect(unknown).toBe(SIGN_IN_FAILED_MESSAGE);
    expect(wrong).toBe(unknown);
  });

  it('FR-101: a network failure says what to do', async () => {
    const { http, HttpResponse } = await import('msw');
    server.use(http.post('*/v1/auth/login', () => HttpResponse.error()));
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.recruiter.email, MOCK_USERS.recruiter.password);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
  });

  it('FR-101: only a same-app next path is followed after login', async () => {
    nav.search = new URLSearchParams({ next: 'https://evil.test' });
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.recruiter.email, MOCK_USERS.recruiter.password);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin'));
  });

  it('FR-107: after a password reset the login page says to sign in again', () => {
    nav.search = new URLSearchParams({ reset: 'done' });
    renderWithAuth(<LoginForm />);
    expect(screen.getByRole('status')).toHaveTextContent('Sign in with your new password');
  });

  it('WCAG 2.1 AA: login form has no axe violations', async () => {
    const { container } = renderWithAuth(<LoginForm />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
