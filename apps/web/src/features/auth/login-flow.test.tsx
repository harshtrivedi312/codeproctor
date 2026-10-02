import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderWithAuth, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { LoginForm } from './login-form';

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

  it('TC-003 FR-102: reviewer without TOTP is sent to enrollment before any page', async () => {
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.reviewer.email, MOCK_USERS.reviewer.password);
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/admin/2fa/enroll?next=%2Fadmin'),
    );
    expect(router.replace).not.toHaveBeenCalledWith('/admin');
  });

  it('FR-101: wrong password shows a fix-it message and stays on the page', async () => {
    renderWithAuth(<LoginForm />);
    await signIn(MOCK_USERS.recruiter.email, 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
    expect(screen.getByRole('alert')).toHaveTextContent('Forgot password');
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
    await waitFor(() => expect(alert).toHaveTextContent('temporarily locked'));
    expect(screen.getByRole('alert')).toHaveTextContent('15 minutes');
    expect(router.replace).not.toHaveBeenCalled();
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
