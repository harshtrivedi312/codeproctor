import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { clearCandidateCredentials, getInvitationToken, scrubTokenFromUrl } from './session-store';
import { TokenHandoff } from './token-handoff';

const replace = vi.fn();
let routeToken: string | string[] | undefined = MOCK_TOKENS.open;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useParams: () => ({ token: routeToken }),
}));

beforeEach(() => {
  replace.mockReset();
  routeToken = MOCK_TOKENS.open;
  clearCandidateCredentials();
});

describe('token hand-off from /t/[token] (FR-401, ADR 0003)', () => {
  it('FR-401: moves the token into memory and replaces the route with the static /t/link', async () => {
    render(<TokenHandoff />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/t/link'));
    expect(getInvitationToken()).toBe(MOCK_TOKENS.open);
    // Handing over must not forget the token it just stored.
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('FR-401: a missing or odd segment still leaves the route, with nothing stored', async () => {
    routeToken = 'short';
    render(<TokenHandoff />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/t/link'));
    expect(getInvitationToken()).toBeNull();
  });
});

describe('history state scrub (FR-401, ADR 0003)', () => {
  it('FR-401: a Next-like history state that holds the token in its route tree is dropped', () => {
    const nextState = {
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: [
        '',
        {
          children: [
            't',
            { children: [['token', MOCK_TOKENS.open, 'd'], { children: ['__PAGE__', {}] }] },
          ],
        },
      ],
    };
    window.history.replaceState(nextState, '', `/t/${MOCK_TOKENS.open}`);
    expect(JSON.stringify(window.history.state)).toContain(MOCK_TOKENS.open);
    scrubTokenFromUrl(MOCK_TOKENS.open);
    expect(window.history.state).toBeNull();
    expect(JSON.stringify(window.history.state)).not.toContain(MOCK_TOKENS.open);
    expect(window.location.href).not.toContain(MOCK_TOKENS.open);
    expect(window.location.pathname).toBe('/t/link');
  });

  it('FR-401: a clean state (already on /t/link) is kept so the router keeps working', () => {
    const clean = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['', { children: ['t', {}] }] };
    window.history.replaceState(clean, '', '/t/link');
    scrubTokenFromUrl(MOCK_TOKENS.open);
    expect(window.history.state).toEqual(clean);
  });
});
