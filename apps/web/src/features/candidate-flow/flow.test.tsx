import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import type { CheckOutcome, SystemChecker } from '@/features/precheck/checks';
import { MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { CandidateFlow } from './candidate-flow';
import { getSessionToken } from './session-store';
import { testRoutePath } from './start-step';
import {
  expectHeadingFocused,
  fakeScrollBox,
  passOtp,
  recordRequests,
  renderWithQuery,
  setupCandidateServer,
} from './test-helpers';
import { fireEvent } from '@testing-library/react';

// Mock mode on: uploads to the local mock URL and Start are only allowed then. There is no browser
// worker in jsdom, so the ready promise is replaced.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));

setupCandidateServer();

const ok = (message: string): CheckOutcome => ({ status: 'passed', message });
const checker: SystemChecker = {
  browser: () => ({
    brand: 'Chrome',
    majorVersion: 141,
    supported: true,
    ...ok('Chrome 141 is supported.'),
  }),
  camera: () => Promise.resolve({ ...ok('Your camera works.'), virtualCameraLabel: null }),
  microphone: () => Promise.resolve(ok('Your microphone works.')),
  screen: () => Promise.resolve({ ...ok('Sharing your entire screen works.'), kind: 'MONITOR' }),
  fullscreen: () => Promise.resolve(ok('Full-screen mode works.')),
  network: () => Promise.resolve({ ...ok('Fast enough.'), downlinkKbps: 20000, rttMs: 20 }),
  monitor: () =>
    Promise.resolve({ ...ok('One screen found.'), result: { kind: 'SINGLE' as const } }),
};
const identity = {
  openCamera: () =>
    Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
  snapshot: () => Promise.resolve(new Blob(['jpeg'], { type: 'image/jpeg' })),
  fileToJpeg: () => Promise.resolve(new Blob(['jpeg'], { type: 'image/jpeg' })),
  upload: () => Promise.resolve(true),
};

function open(token: string, navigate: (path: string) => void = vi.fn()) {
  window.history.replaceState(null, '', `/t/${token}`);
  return renderWithQuery(
    <CandidateFlow token={token} overrides={{ checker, identity, navigate }} />,
  );
}

describe('stepper end to end (FR-401 to FR-403)', () => {
  it('FR-401: walks welcome, OTP, consent, system check, identity and start, and enters the test by a full navigation', async () => {
    const navigate = vi.fn();
    const seen = recordRequests();
    const user = userEvent.setup();
    open(MOCK_TOKENS.open, navigate);

    await expectHeadingFocused(/welcome to your proctored coding test/i);
    await passOtp(user);

    await expectHeadingFocused(/please read and sign the consent document/i);
    fakeScrollBox(await screen.findByTestId('consent-scroll'));
    const box = screen.getByTestId('consent-scroll');
    box.scrollTop = 1700;
    fireEvent.scroll(box);
    await user.type(await screen.findByLabelText(/full legal name/i), 'Ada Lovelace');
    await user.click(screen.getByRole('checkbox', { name: /18 years old or older/i }));
    await user.click(screen.getByRole('button', { name: /i agree and sign/i }));
    await user.click(await screen.findByRole('button', { name: /continue to the system check/i }));

    await expectHeadingFocused(/check your computer/i);
    for (const name of [
      /check camera/i,
      /check microphone/i,
      /test screen sharing/i,
      /test full screen/i,
      /check screens/i,
    ]) {
      await user.click(screen.getByRole('button', { name }));
    }
    const toIdentity = screen.getByRole('button', { name: /continue to identity check/i });
    await waitFor(() => expect(toIdentity).toBeEnabled());
    await user.click(toIdentity);

    await expectHeadingFocused(/photo of your id/i);
    await user.click(await screen.findByRole('button', { name: /turn on camera/i }));
    await user.click(await screen.findByRole('button', { name: /take photo of my id/i }));
    await user.click(await screen.findByRole('button', { name: /use this photo, next: selfie/i }));
    for (let i = 0; i < 3; i += 1) {
      await user.click(
        await screen.findByRole('button', { name: /done, (next prompt|last step)/i }),
      );
    }
    await user.click(await screen.findByRole('button', { name: /take selfie/i }));
    await user.click(await screen.findByRole('button', { name: /use this selfie/i }));
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    await user.click(await screen.findByRole('button', { name: /continue/i }));

    await expectHeadingFocused(/you are ready to start/i);
    expect(screen.getAllByText(/\(done\)/i)).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /start the test/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(testRoutePath()));

    // CSP: only a full document navigation gets the test route's WebAssembly allowance (D-45).
    expect(navigate).toHaveBeenCalledTimes(1);
    const order = seen.map((r) => new URL(r.url).pathname.split('/').pop());
    expect(order.indexOf('consent')).toBeGreaterThan(order.indexOf('start'));
    expect(order.indexOf('system-check')).toBeGreaterThan(order.indexOf('sign'));
    expect(order.indexOf('identity')).toBeGreaterThan(order.indexOf('system-check'));
    expect(order.indexOf('start', order.indexOf('identity'))).toBeGreaterThan(
      order.indexOf('identity'),
    );
    // Nothing stored, ever.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(MOCK_TOKENS.open);
  });

  it('FR-401: the progress list marks the current step and completed steps in text, not colour alone', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.open);
    const progress = await screen.findByRole('navigation', { name: /progress/i });
    expect(within(progress).getByText('Welcome', { exact: false }).closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    await passOtp(user);
    await expectHeadingFocused(/please read and sign/i);
    const items = within(progress).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/welcome \(completed\)/i);
    expect(items[1]).toHaveTextContent(/verify email \(completed\)/i);
    expect(items[2]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).toHaveTextContent(/\(current step\)/i);
  });

  it('ADR 0002: reopening a link after consent resumes at the system check, after a fresh code', async () => {
    const user = userEvent.setup();
    open(MOCK_TOKENS.consented);
    await passOtp(user);
    await expectHeadingFocused(/check your computer/i);
  });

  it('ADR 0002: the session token is held in memory only, and leaving the flow forgets it', async () => {
    const user = userEvent.setup();
    const view = open(MOCK_TOKENS.open);
    await passOtp(user);
    await expectHeadingFocused(/please read and sign/i);
    expect(getSessionToken()).not.toBeNull();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    view.unmount();
    expect(getSessionToken()).toBeNull();
  });

  it('D-45: the start button builds a full-document navigation, not a router push', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    open(MOCK_TOKENS.resume, navigate);
    await passOtp(user);
    await user.click(await screen.findByRole('button', { name: /continue my test/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(testRoutePath()));
    expect(testRoutePath()).toMatch(/^\/t\/[^/]+\/test$/);
  });

  it('NFR-06: no axe violations on the start step', async () => {
    const user = userEvent.setup();
    const { container } = open(MOCK_TOKENS.resume);
    await passOtp(user);
    await screen.findByRole('heading', { level: 1, name: /welcome back/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
