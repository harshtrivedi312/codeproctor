import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { CandidateFlow } from './candidate-flow';
import { defaultNavigate, START_ENABLED } from './start-step';
import { passOtp, recordRequests, renderWithQuery, setupCandidateServer } from './test-helpers';

// Mock mode is OFF in this file (the default), as in a real build.
setupCandidateServer();

describe('start is held back until the token hand-off is decided (FU-FEB-10)', () => {
  it('D-45: with mocks off Start is disabled, explained, and never starts the test clock', async () => {
    expect(START_ENABLED).toBe(false);
    const seen = recordRequests();
    const navigate = vi.fn();
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/t/${MOCK_TOKENS.resume}`);
    renderWithQuery(<CandidateFlow token={MOCK_TOKENS.resume} overrides={{ navigate }} />);
    await passOtp(user);
    const button = await screen.findByRole('button', { name: /continue my test/i });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('start-unavailable')).toHaveTextContent(
      /cannot be started from this page yet/i,
    );
    await user.click(button);
    expect(navigate).not.toHaveBeenCalled();
    expect(seen.some((r) => r.url.endsWith('/test/start'))).toBe(false);
  });
});

describe('default navigation (D-45)', () => {
  it('D-45: the default navigate is a real window.location.assign (a full document load)', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      defaultNavigate('/t/session/test');
      expect(assign).toHaveBeenCalledWith('/t/session/test');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
