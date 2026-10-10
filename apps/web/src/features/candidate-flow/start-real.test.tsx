import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { candidateApi } from './api';
import { CandidateFlow } from './candidate-flow';
import { setSessionToken } from './session-store';
import { StartStep } from './start-step';
import {
  passOtp,
  recordRequests,
  renderWithQuery,
  server,
  setupCandidateServer,
  startAtStepper,
} from './test-helpers';

// Mock mode is OFF in this file (the default), as in a real build: the client talks to the API
// routes (answered by the MSW test server, which has the same shapes as the merged API).
vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

// The mock tokens are not JWTs; the real API's token carries the session id as `sid`.
vi.mock('@/features/candidate-test/proctor/controller', async (original) => ({
  ...(await original<typeof import('@/features/candidate-test/proctor/controller')>()),
  sessionIdFromToken: () => '11111111-1111-4111-8111-111111111111',
}));

setupCandidateServer();

describe('Start works with the real client (D-06, FU-FEB-10 option (c))', () => {
  it('FR-505: with mocks off Start is enabled and a running test opens with no second start call', async () => {
    const seen = recordRequests();
    const user = userEvent.setup();
    startAtStepper(MOCK_TOKENS.resume);
    renderWithQuery(<CandidateFlow />);
    await passOtp(user);
    const button = await screen.findByRole('button', { name: /continue my test/i });
    expect(button).toBeEnabled();
    expect(screen.queryByTestId('start-unavailable')).not.toBeInTheDocument();
    await user.click(button);
    expect(
      await screen.findByRole('dialog', { name: /share your entire screen/i }),
    ).toBeInTheDocument();
    expect(seen.some((r) => r.url.endsWith('/test/start'))).toBe(false);
  });

  it('FR-505: with mocks off the first Start posts /session/test/start once, even on a double click, then reports started', async () => {
    const started = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
    if (!started.ok) throw new Error('mock sign-in failed');
    setSessionToken(started.data.sessionToken);
    const seen = recordRequests();
    const onStarted = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <StartStep
        resuming={false}
        onStarted={onStarted}
        onSessionEnded={vi.fn()}
        onTerminal={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: /start the test/i });
    expect(button).toBeEnabled();
    await user.dblClick(button);
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(seen.filter((r) => r.url.endsWith('/session/test/start'))).toHaveLength(1);
  });

  it.each([
    [
      '409 with an unfinished step',
      409,
      { code: 'SESSION_STATE_CONFLICT' },
      /earlier steps are not finished/i,
    ],
    [
      '409 test set-up fault',
      409,
      { code: 'RANDOM_RULE_UNSATISFIABLE' },
      /contact the person who invited you/i,
    ],
    [
      '429 start rate limit',
      429,
      { code: 'RATE_LIMITED', retryAfterSeconds: 7 },
      /wait 7 seconds/i,
    ],
    ['500', 500, { code: 'INTERNAL' }, /service had a problem/i],
  ])(
    'FR-505: a failed start (%s) says what to do, keeps the button usable and a second click posts again',
    async (_name, status, body, message) => {
      const started = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
      if (!started.ok) throw new Error('mock sign-in failed');
      setSessionToken(started.data.sessionToken);
      let posts = 0;
      server.use(
        http.post(`${apiBaseUrl}/v1/candidate/session/test/start`, () => {
          posts += 1;
          return HttpResponse.json(body, { status });
        }),
      );
      const onStarted = vi.fn();
      const user = userEvent.setup();
      renderWithQuery(
        <StartStep
          resuming={false}
          onStarted={onStarted}
          onSessionEnded={vi.fn()}
          onTerminal={vi.fn()}
        />,
      );
      await user.click(screen.getByRole('button', { name: /start the test/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: /start the test/i })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: /start the test/i }));
      await waitFor(() => expect(posts).toBe(2));
      expect(onStarted).not.toHaveBeenCalled();
    },
  );

  it('FR-505: an expired link at Start ends the flow with its own screen, and a 401 ends the session', async () => {
    const started = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
    if (!started.ok) throw new Error('mock sign-in failed');
    setSessionToken(started.data.sessionToken);
    let status = 409;
    let code = 'LINK_EXPIRED';
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/test/start`, () =>
        HttpResponse.json({ code }, { status }),
      ),
    );
    const onTerminal = vi.fn();
    const onSessionEnded = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <StartStep
        resuming={false}
        onStarted={vi.fn()}
        onSessionEnded={onSessionEnded}
        onTerminal={onTerminal}
      />,
    );
    await user.click(screen.getByRole('button', { name: /start the test/i }));
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith({ reason: 'EXPIRED' }));
    status = 401;
    code = 'TOKEN_EXPIRED';
    await user.click(screen.getByRole('button', { name: /start the test/i }));
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));
  });
});
