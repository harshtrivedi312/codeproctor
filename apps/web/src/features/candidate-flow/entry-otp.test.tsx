import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_OTP, MOCK_RECRUITER_CONTACT, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { candidateApi } from './api';
import { CandidateFlow } from './candidate-flow';
import { getInvitationToken, getSessionToken, SCRUBBED_PATH } from './session-store';
import {
  expectHeadingFocused,
  passOtp,
  recordRequests,
  renderWithQuery,
  startAtStepper,
  setupCandidateServer,
} from './test-helpers';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

setupCandidateServer();

function open(token: string) {
  startAtStepper(token);
  return renderWithQuery(<CandidateFlow />);
}

describe('invitation link and token handling (FR-303, FR-401, ADR 0003)', () => {
  it('FR-401: on /t/link the stepper starts from the in-memory token and leaves the URL and state alone', async () => {
    open(MOCK_TOKENS.open);
    await screen.findByRole('heading', {
      level: 1,
      name: /welcome to your proctored coding test/i,
    });
    expect(window.location.pathname).toBe(SCRUBBED_PATH);
    expect(window.location.href).not.toContain(MOCK_TOKENS.open);
    expect(JSON.stringify(window.history.state)).not.toContain(MOCK_TOKENS.open);
    // The token lives in memory only.
    expect(getInvitationToken()).toBe(MOCK_TOKENS.open);
  });

  it('FR-401: the token is only ever sent in a POST body, never in a URL, storage, or the console', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const seen = recordRequests();
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    await passOtp(user);
    await expectHeadingFocused(/please read and sign the consent document/i);
    expect(seen.length).toBeGreaterThan(2);
    for (const r of seen) {
      expect(r.url).not.toContain(MOCK_TOKENS.open);
      expect(r.url).not.toContain(MOCK_OTP);
      expect(['POST', 'GET']).toContain(r.method);
    }
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    for (const spy of [log, error, warn]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(MOCK_TOKENS.open);
        expect(JSON.stringify(call)).not.toContain(MOCK_OTP);
      }
    }
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  });

  it('FR-401: a fragment on /t/link is never read or trusted: it shows the open-the-email-link-again page and sends nothing', async () => {
    const seen = recordRequests();
    window.history.replaceState(null, '', `/t/link#${MOCK_TOKENS.open}`);
    renderWithQuery(<CandidateFlow />);
    expect(
      await screen.findByRole('heading', { level: 1, name: /could not open this link/i }),
    ).toBeInTheDocument();
    expect(getInvitationToken()).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('FR-401: a reload (token already gone from the URL) shows how to open the link again', async () => {
    open('link');
    expect(
      await screen.findByRole('heading', { level: 1, name: /could not open this link/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/open the link from your invitation email again/i)).toBeInTheDocument();
  });

  it('TC-021: a used link shows "already used" and sends no code', async () => {
    const seen = recordRequests();
    open(MOCK_TOKENS.used);
    expect(
      await screen.findByRole('heading', { level: 1, name: /already been used/i }),
    ).toBeInTheDocument();
    expect(seen.some((r) => r.url.endsWith('/otp'))).toBe(false);
    expect(screen.queryByRole('button', { name: /one-time code/i })).not.toBeInTheDocument();
  });

  it('TC-022: an expired link shows the expired page and what to do next', async () => {
    open(MOCK_TOKENS.expired);
    expect(
      await screen.findByRole('heading', { level: 1, name: /invitation has expired/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ask your recruiter for a new invitation/i)).toBeInTheDocument();
  });

  it('TC-096: a declined link shows the declined page with the recruiter contact and retention link', async () => {
    open(MOCK_TOKENS.declined);
    expect(
      await screen.findByRole('heading', { level: 1, name: /chose not to continue/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('recruiter-contact')).toHaveTextContent(MOCK_RECRUITER_CONTACT);
    expect(screen.getByRole('link', { name: /retention schedule/i })).toHaveAttribute(
      'href',
      '/retention',
    );
    expect(screen.queryByRole('button', { name: /one-time code/i })).not.toBeInTheDocument();
  });

  it('FR-303: a window that has not opened says when it opens', async () => {
    open(MOCK_TOKENS.notYetOpen);
    expect(
      await screen.findByRole('heading', { level: 1, name: /window has not opened yet/i }),
    ).toBeInTheDocument();
  });
});

describe('email OTP step (FR-106, TC-007, TC-097)', () => {
  it('FR-401: welcome page shows rules, what is recorded and retention, with no device access', async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, getDisplayMedia: getUserMedia },
    });
    open(MOCK_TOKENS.open);
    await screen.findByRole('heading', { level: 2, name: /the rules/i });
    expect(
      screen.getByRole('heading', { level: 2, name: /what is recorded/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /how long we keep it/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Acme Hiring', { selector: '[data-testid="org-name"]' }),
    ).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('FR-106: a wrong code shows a fix-it message and keeps the form usable', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    await passOtp(user, '111111');
    expect(await screen.findByText(/that code is not right/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/6-digit code/i)).toHaveValue('');
    expect(getSessionToken()).toBeNull();
  });

  it('FR-106: a malformed code is explained before anything is sent', async () => {
    const user = userEvent.setup();
    const seen = recordRequests();
    open(MOCK_TOKENS.open);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    await user.type(await screen.findByLabelText(/6-digit code/i), '12');
    await user.click(screen.getByRole('button', { name: /check code/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/enter the 6 digits/i);
    expect(seen.some((r) => r.url.endsWith('/start'))).toBe(false);
  });

  it('FR-106: an expired code offers a new one', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    await passOtp(user, '000000');
    expect(await screen.findByText(/that code has expired/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send a new code/i })).toBeInTheDocument();
  });

  it('FR-106: a new code can only be asked for after the wait, and says how long', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    const resend = await screen.findByRole('button', { name: /send a new code \(wait \d+ s\)/i });
    expect(resend).toBeDisabled();
  });

  it('TC-007: five wrong codes pause the link and the screen says so, with no further attempts', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    for (let i = 0; i < 5; i += 1) {
      const input = await screen.findByLabelText(/6-digit code/i);
      await user.type(input, '111111');
      await user.click(screen.getByRole('button', { name: /check code/i }));
      if (i < 4) await screen.findByText(/that code is not right/i);
    }
    expect(
      await screen.findByRole('heading', { level: 1, name: /link is paused for a short while/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/about 30 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/your recruiter has been told/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/6-digit code/i)).not.toBeInTheDocument();
  });

  it('TC-007: a link that is already paused shows the paused page on arrival', async () => {
    open(MOCK_TOKENS.blocked);
    expect(
      await screen.findByRole('heading', { level: 1, name: /paused for a short while/i }),
    ).toBeInTheDocument();
  });

  it('TC-097: during a test a wrong code shows the cooldown and never locks the candidate out', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.resume);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    const input = await screen.findByLabelText(/6-digit code/i);
    await user.type(input, '111111');
    await user.click(screen.getByRole('button', { name: /check code/i }));
    await screen.findByText(/that code is not right/i);
    // A second wrong code inside 30 s is refused with the wait time.
    await user.type(screen.getByLabelText(/6-digit code/i), '222222');
    await user.click(screen.getByRole('button', { name: /check code/i }));
    expect(
      await screen.findByText(/please wait \d+ seconds before trying again/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check code/i })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: /paused/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument();
  });

  it('TC-097: the wait is announced once with its full length, and the ticking countdown is hidden from screen readers', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.resume);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    for (const code of ['111111', '222222']) {
      await user.type(await screen.findByLabelText(/6-digit code/i), code);
      await user.click(screen.getByRole('button', { name: /check code/i }));
      await screen.findByLabelText(/6-digit code/i);
    }
    const live = (await screen.findByText(/please wait 30 seconds before trying again/i)).closest(
      '[aria-live]',
    );
    expect(live).not.toBeNull();
    const ticking = screen.getByText(/\(\d+ s left\)/);
    expect(ticking).toHaveAttribute('aria-hidden', 'true');
    // The live text itself is the fixed sentence, not the changing number.
    expect(live?.textContent?.replace(ticking.textContent ?? '', '')).toMatch(/30 seconds/);
  });

  it('FR-106: a code sent a moment ago (OTP_COOLDOWN on the first press) goes on to the code entry with the wait', async () => {
    const user = userEvent.setup();
    await candidateApi.sendOtp(MOCK_TOKENS.cooldown);
    open(MOCK_TOKENS.cooldown);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    expect(await screen.findByLabelText(/6-digit code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send a new code \(wait \d+ s\)/i })).toBeDisabled();
  });

  it('TC-097: the right code resumes a running test at the start step', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.resume);
    await passOtp(user);
    expect(
      await screen.findByRole('heading', { level: 1, name: /welcome back/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue my test/i })).toBeInTheDocument();
  });

  it('FR-106: focus moves to the new heading when the step changes', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    await expectHeadingFocused(/welcome to your proctored coding test/i);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    await expectHeadingFocused(/enter your one-time code/i);
  });

  it('FR-401: a network failure when sending the code says what to do', async () => {
    const { server } = await import('./test-helpers');
    const { http, HttpResponse } = await import('msw');
    const { apiBaseUrl } = await import('@/lib/env');
    server.use(http.post(`${apiBaseUrl}/v1/candidate/session/otp`, () => HttpResponse.error()));
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/check your internet connection/i);
  });
});

describe('axe: welcome and OTP steps (NFR-06)', () => {
  it('NFR-06: no axe violations on the welcome step', async () => {
    const { container } = open(MOCK_TOKENS.open);
    await screen.findByRole('heading', { level: 1, name: /welcome/i });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('NFR-06: no axe violations on the OTP step, including after an error', async () => {
    const user = userEvent.setup();
    const { container } = open(MOCK_TOKENS.open);
    await passOtp(user, '111111');
    await screen.findByText(/that code is not right/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('NFR-06: no axe violations on end screens', async () => {
    const { container } = open(MOCK_TOKENS.declined);
    await screen.findByRole('heading', { level: 1, name: /chose not to continue/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('loading state (FR-401)', () => {
  it('FR-401: waits for the link before showing anything', async () => {
    open(MOCK_TOKENS.open);
    expect(screen.getByRole('status')).toHaveTextContent(/opening your invitation/i);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/welcome/i),
    );
  });
});
