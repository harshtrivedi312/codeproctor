import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_INVITE_TOKEN, MOCK_RESET_TOKEN } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';
import { router } from '@/test/nav-mock';
import { FORGOT_CONFIRMATION, ForgotPasswordForm } from './forgot-password-form';
import { SetPasswordForm } from './set-password-form';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

describe('ForgotPasswordForm', () => {
  it('TC-098 FR-107: shows the same confirmation for a known and an unknown email', async () => {
    const texts: string[] = [];
    for (const email of ['reviewer@example.test', 'nobody@example.test']) {
      const { unmount } = render(<ForgotPasswordForm />);
      const u = userEvent.setup();
      await u.type(screen.getByLabelText('Work email'), email);
      await u.click(screen.getByRole('button', { name: 'Send reset link' }));
      const status = await screen.findByRole('status');
      texts.push(status.textContent ?? '');
      expect(status).toHaveTextContent(FORGOT_CONFIRMATION);
      expect(document.body).not.toHaveTextContent(email);
      unmount();
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it('FR-107: an invalid email is caught with a fix-it message', async () => {
    render(<ForgotPasswordForm />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
  });

  it('FR-107: a failed request says to retry and does not claim a link was sent', async () => {
    server.use(
      http.post('*/v1/auth/password/forgot', () => new HttpResponse(null, { status: 429 })),
    );
    render(<ForgotPasswordForm />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Work email'), 'a@example.test');
    await u.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('try again');
    expect(screen.queryByText(FORGOT_CONFIRMATION)).not.toBeInTheDocument();
  });

  it('WCAG 2.1 AA: forgot password has no axe violations', async () => {
    const { container } = render(<ForgotPasswordForm />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SetPasswordForm', () => {
  function openLink(token: string, how: 'hash' | 'query' = 'hash') {
    window.history.replaceState(
      null,
      '',
      how === 'hash'
        ? `/admin/reset-password#token=${token}`
        : `/admin/reset-password?token=${token}`,
    );
  }

  it('FR-107: removes the token from the address bar and keeps it out of storage and logs', async () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    openLink(MOCK_RESET_TOKEN);
    render(<SetPasswordForm purpose="reset" />);
    await screen.findByLabelText('New password');
    expect(window.location.href).not.toContain(MOCK_RESET_TOKEN);
    expect(window.location.hash).toBe('');
    expect(JSON.stringify({ ...localStorage })).not.toContain(MOCK_RESET_TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(MOCK_RESET_TOKEN);
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls])).not.toContain(MOCK_RESET_TOKEN);
  });

  it('FR-107: still finds the token when React Strict Mode runs the effect twice', async () => {
    openLink(MOCK_RESET_TOKEN);
    render(
      <React.StrictMode>
        <SetPasswordForm purpose="reset" />
      </React.StrictMode>,
    );
    expect(await screen.findByLabelText('New password')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('FR-107: also accepts a ?token= link and still strips it', async () => {
    openLink(MOCK_RESET_TOKEN, 'query');
    render(<SetPasswordForm purpose="reset" />);
    await screen.findByLabelText('New password');
    expect(window.location.search).toBe('');
  });

  it('FR-107: shows the strength rules and ticks them as they are met', async () => {
    openLink(MOCK_RESET_TOKEN);
    render(<SetPasswordForm purpose="reset" />);
    const rules = await screen.findByRole('list', { name: 'Password rules' });
    expect(rules).toHaveTextContent('At least 12 characters');
    expect(rules).toHaveTextContent('One upper-case letter');
    await userEvent.setup().type(screen.getByLabelText('New password'), 'abc');
    expect(screen.getByText('One lower-case letter').closest('li')).toHaveAttribute(
      'data-met',
      'true',
    );
    expect(screen.getByText('One number').closest('li')).toHaveAttribute('data-met', 'false');
  });

  it('TC-098 FR-107: a valid link sets the password, then goes to login (never signs in)', async () => {
    openLink(MOCK_RESET_TOKEN);
    render(<SetPasswordForm purpose="reset" />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('New password'), 'Correct-Horse-9');
    await u.type(screen.getByLabelText('Repeat the new password'), 'Correct-Horse-9');
    await u.click(screen.getByRole('button', { name: 'Save new password' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login?reset=done'));
  });

  it('TC-098 FR-107: the same token cannot be used twice', async () => {
    const u = userEvent.setup();
    for (const attempt of [1, 2]) {
      openLink(MOCK_RESET_TOKEN);
      const { unmount } = render(<SetPasswordForm purpose="reset" />);
      await u.type(await screen.findByLabelText('New password'), 'Correct-Horse-9');
      await u.type(screen.getByLabelText('Repeat the new password'), 'Correct-Horse-9');
      await u.click(screen.getByRole('button', { name: 'Save new password' }));
      if (attempt === 2) {
        expect(await screen.findByRole('alert')).toHaveTextContent('expired or was already used');
      } else {
        await waitFor(() => expect(router.replace).toHaveBeenCalled());
      }
      unmount();
    }
  });

  it('TC-098 FR-107: an expired link is refused with one message and a way forward', async () => {
    openLink('mock-expired-token');
    render(<SetPasswordForm purpose="reset" />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('New password'), 'Correct-Horse-9');
    await u.type(screen.getByLabelText('Repeat the new password'), 'Correct-Horse-9');
    await u.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link cannot be used');
    expect(screen.getByRole('link', { name: 'request a new reset link' })).toHaveAttribute(
      'href',
      '/admin/forgot-password',
    );
  });

  it('FR-107: a weak password or mismatch is stopped before the API call', async () => {
    openLink(MOCK_RESET_TOKEN);
    render(<SetPasswordForm purpose="reset" />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('New password'), 'short');
    await u.type(screen.getByLabelText('Repeat the new password'), 'different');
    await u.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(/Choose a stronger password/)).toBeInTheDocument();
    expect(screen.getByText(/do not match/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('FR-107: without a token in the link it says how to get a new one', async () => {
    render(<SetPasswordForm purpose="reset" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Open the link from your email again',
    );
  });

  it('ADR 0003 section 4: the staff invite flow uses the same form', async () => {
    openLink(MOCK_INVITE_TOKEN);
    render(<SetPasswordForm purpose="invite" />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('New password'), 'Correct-Horse-9');
    await u.type(screen.getByLabelText('Repeat the new password'), 'Correct-Horse-9');
    await u.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/admin/login?reset=done'));
  });

  it('WCAG 2.1 AA: set-password form has no axe violations', async () => {
    openLink(MOCK_RESET_TOKEN);
    const { container } = render(<SetPasswordForm purpose="reset" />);
    await screen.findByLabelText('New password');
    expect(await axe(container)).toHaveNoViolations();
  });
});
