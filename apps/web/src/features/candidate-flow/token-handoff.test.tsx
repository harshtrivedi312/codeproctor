import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { clearCandidateCredentials, getInvitationToken, hasUrlFragment } from './session-store';
import { EmailLinkEntry, FragmentHandoff, TokenHandoff } from './token-handoff';

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
  it('FR-401: stores the token in memory and calls router.replace with the static /t/link', async () => {
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

describe('fragment hand-off from /t/start#<token> (FR-401, ADR 0003)', () => {
  it('FR-401: reads #<token> into memory and calls router.replace with /t/link', async () => {
    window.history.replaceState(null, '', `/t/start#${MOCK_TOKENS.open}`);
    render(<FragmentHandoff />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/t/link'));
    expect(getInvitationToken()).toBe(MOCK_TOKENS.open);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('FR-401: also accepts #token=<token>', async () => {
    window.history.replaceState(null, '', `/t/start#token=${MOCK_TOKENS.open}`);
    render(<FragmentHandoff />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/t/link'));
    expect(getInvitationToken()).toBe(MOCK_TOKENS.open);
  });

  it('FR-401: a missing or odd fragment still leaves the route and stores nothing', async () => {
    window.history.replaceState(null, '', '/t/start#nope');
    render(<FragmentHandoff />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/t/link'));
    expect(getInvitationToken()).toBeNull();
  });
});

describe('fragment detection (FR-401)', () => {
  it('FR-401: reports a fragment on the address bar', () => {
    window.history.replaceState(null, '', '/t/link');
    expect(hasUrlFragment()).toBe(false);
    window.history.replaceState(null, '', `/t/link#${MOCK_TOKENS.open}`);
    expect(hasUrlFragment()).toBe(true);
  });
});

describe('email link entry /t#<token> (FR-407, TC-107, ADR 0003)', () => {
  it('FR-407 TC-107: forwards /t#<token> to /t/start#<token> with a full document load, token only in the fragment', async () => {
    window.history.replaceState(null, '', `/t#${MOCK_TOKENS.open}`);
    const replaceLocation = vi.fn();
    render(<EmailLinkEntry replaceLocation={replaceLocation} />);
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledTimes(1));
    expect(replaceLocation).toHaveBeenCalledWith(`/t/start#${MOCK_TOKENS.open}`);
    // Nothing is stored here and the soft router is not used: the next document takes over.
    expect(getInvitationToken()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(String(replaceLocation.mock.calls[0]?.[0])).not.toContain('?');
  });

  it('FR-407: also accepts #token=<token>, still forwarding as a plain fragment', async () => {
    window.history.replaceState(null, '', `/t#token=${MOCK_TOKENS.open}`);
    const replaceLocation = vi.fn();
    render(<EmailLinkEntry replaceLocation={replaceLocation} />);
    await waitFor(() =>
      expect(replaceLocation).toHaveBeenCalledWith(`/t/start#${MOCK_TOKENS.open}`),
    );
  });

  it('FR-407: a bare /t goes to /t/start with no fragment (the stepper then shows the invalid-link state)', async () => {
    window.history.replaceState(null, '', '/t');
    const replaceLocation = vi.fn();
    render(<EmailLinkEntry replaceLocation={replaceLocation} />);
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('/t/start'));
  });

  it('FR-407: an odd or empty fragment, or a query string, is never carried over', async () => {
    for (const url of ['/t#', '/t#nope', `/t?token=${MOCK_TOKENS.open}`, '/t#<script>']) {
      window.history.replaceState(null, '', url);
      const replaceLocation = vi.fn();
      const view = render(<EmailLinkEntry replaceLocation={replaceLocation} />);
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('/t/start'));
      view.unmount();
    }
  });
});
