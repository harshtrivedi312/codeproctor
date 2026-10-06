import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_TOKENS } from '@/mocks/candidate/handlers';
import {
  clearCandidateCredentials,
  getInvitationToken,
  SCRUBBED_PATH,
  urlNeedsScrub,
} from './session-store';
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

describe('when the URL needs a router replace (FR-401, ADR 0003)', () => {
  const nextState = {
    __NA: true,
    __PRIVATE_NEXTJS_INTERNALS_TREE: [
      '',
      { children: ['t', { children: [['token', MOCK_TOKENS.open, 'd'], {}] }] },
    ],
  };

  it('FR-401: a history state that holds the token in its route tree is flagged', () => {
    window.history.replaceState(nextState, '', SCRUBBED_PATH);
    expect(urlNeedsScrub(MOCK_TOKENS.open)).toBe(true);
  });

  it('FR-401: a fragment or another path is flagged, because the router keeps its own copy', () => {
    window.history.replaceState(null, '', `${SCRUBBED_PATH}#${MOCK_TOKENS.open}`);
    expect(urlNeedsScrub(MOCK_TOKENS.open)).toBe(true);
    window.history.replaceState(null, '', `/t/${MOCK_TOKENS.open}`);
    expect(urlNeedsScrub(MOCK_TOKENS.open)).toBe(true);
  });

  it('FR-401: a clean /t/link with a clean state is left alone', () => {
    window.history.replaceState(
      { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['', {}] },
      '',
      SCRUBBED_PATH,
    );
    expect(urlNeedsScrub(MOCK_TOKENS.open)).toBe(false);
    expect(urlNeedsScrub(null)).toBe(false);
  });
});
