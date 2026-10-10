import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { candidateApi } from './api';
import { CandidateFlow } from './candidate-flow';
import { setSessionToken } from './session-store';
import { StartStep } from './start-step';
import {
  passOtp,
  recordRequests,
  renderWithQuery,
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
    renderWithQuery(<StartStep resuming={false} onStarted={onStarted} onSessionEnded={vi.fn()} />);
    const button = screen.getByRole('button', { name: /start the test/i });
    expect(button).toBeEnabled();
    await user.dblClick(button);
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(seen.filter((r) => r.url.endsWith('/session/test/start'))).toHaveLength(1);
  });
});
