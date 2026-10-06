import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { CandidateFlow } from './candidate-flow';
import { START_ENABLED } from './start-step';
import {
  passOtp,
  recordRequests,
  renderWithQuery,
  setupCandidateServer,
  startAtStepper,
} from './test-helpers';

// Mock mode is OFF in this file (the default), as in a real build.
vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

setupCandidateServer();

describe('start is held back until the token hand-off is decided (FU-FEB-10)', () => {
  it('D-45: with mocks off Start is disabled, explained, and never starts the test clock', async () => {
    expect(START_ENABLED).toBe(false);
    const seen = recordRequests();
    const user = userEvent.setup();
    startAtStepper(MOCK_TOKENS.resume);
    renderWithQuery(<CandidateFlow />);
    await passOtp(user);
    const button = await screen.findByRole('button', { name: /continue my test/i });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('start-unavailable')).toHaveTextContent(
      /cannot be started from this page yet/i,
    );
    await user.click(button);
    expect(
      screen.queryByRole('dialog', { name: /share your entire screen/i }),
    ).not.toBeInTheDocument();
    expect(seen.some((r) => r.url.endsWith('/test/start'))).toBe(false);
  });
});
