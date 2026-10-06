import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { setSessionToken } from '@/features/candidate-flow/session-store';
import {
  recordRequests,
  renderWithQuery,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import type { CheckOutcome, SystemChecker } from './checks';
import { SystemCheckStep } from './system-check-step';

setupCandidateServer();

const ok = (message: string): CheckOutcome => ({ status: 'passed', message });

function fakeChecker(overrides: Partial<SystemChecker> = {}): SystemChecker {
  return {
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
    network: () =>
      Promise.resolve({ ...ok('Your connection is fast enough.'), downlinkKbps: 20000, rttMs: 30 }),
    monitor: () =>
      Promise.resolve({ ...ok('One screen found.'), result: { kind: 'SINGLE' as const } }),
    ...overrides,
  };
}

async function signIn(): Promise<void> {
  const r = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
  if (!r.ok) throw new Error('mock sign-in failed');
  setSessionToken(r.data.sessionToken);
}

async function runAll(user: ReturnType<typeof userEvent.setup>) {
  for (const name of [
    /check camera/i,
    /check microphone/i,
    /test screen sharing/i,
    /test full screen/i,
    /check screens/i,
  ]) {
    await user.click(screen.getByRole('button', { name }));
  }
}

describe('system check step (FR-402)', () => {
  it('FR-402: continue stays disabled and names what is still to do', async () => {
    await signIn();
    renderWithQuery(
      <SystemCheckStep checker={fakeChecker()} onPassed={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    const next = screen.getByRole('button', { name: /continue to identity check/i });
    expect(next).toBeDisabled();
    expect(
      screen.getByText(/still to do: camera, microphone, screen sharing/i),
    ).toBeInTheDocument();
    // Browser and network ran on their own.
    expect(await screen.findByText('Your connection is fast enough.')).toBeInTheDocument();
  });

  it('FR-402: after every check passes, continue posts the result and moves on', async () => {
    await signIn();
    const seen = recordRequests();
    const onPassed = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <SystemCheckStep checker={fakeChecker()} onPassed={onPassed} onSessionEnded={vi.fn()} />,
    );
    await runAll(user);
    const next = screen.getByRole('button', { name: /continue to identity check/i });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
    await waitFor(() => expect(onPassed).toHaveBeenCalledTimes(1));
    const post = seen.find((r) => r.url.endsWith('/system-check'));
    expect(post?.body).toMatchObject({
      browser: { brand: 'Chrome', majorVersion: 141 },
      devices: { camera: true, microphone: true, screenShare: 'MONITOR' },
      network: { downlinkKbps: 20000, rttMs: 30 },
    });
  });

  it('TC-031: an unsupported browser is blocked with a clear message and the other checks stay off', async () => {
    await signIn();
    const user = userEvent.setup();
    const checker = fakeChecker({
      browser: () => ({
        brand: 'Firefox',
        majorVersion: 130,
        supported: false,
        status: 'failed',
        message: 'Firefox is not supported for this test.',
        help: 'Open the link from your invitation email in the latest Google Chrome or Microsoft Edge on a computer.',
      }),
    });
    renderWithQuery(
      <SystemCheckStep checker={checker} onPassed={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /this browser cannot be used for the test/i,
    );
    expect(screen.getByText(/firefox is not supported/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check camera/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /continue to identity check/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /continue to identity check/i }));
  });

  it('TC-032: a denied camera shows what happened and what to do, and can be retried', async () => {
    await signIn();
    const user = userEvent.setup();
    let allowed = false;
    const checker = fakeChecker({
      camera: () =>
        Promise.resolve(
          allowed
            ? { ...ok('Your camera works.'), virtualCameraLabel: null }
            : {
                status: 'failed' as const,
                message: 'Camera access was blocked.',
                help: 'Click the camera or lock icon in the address bar, set Camera to "Allow", then press "Try again".',
              },
        ),
    });
    renderWithQuery(
      <SystemCheckStep checker={checker} onPassed={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /check camera/i }));
    expect(await screen.findByText(/camera access was blocked/i)).toBeInTheDocument();
    expect(screen.getByText(/what to do:/i)).toBeInTheDocument();
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0);
    allowed = true;
    await user.click(screen.getByRole('button', { name: /check camera again/i }));
    expect(await screen.findByText('Your camera works.')).toBeInTheDocument();
  });

  it('FR-605: a server answer that blocks (more than one screen) is explained in plain words', async () => {
    await signIn();
    const user = userEvent.setup();
    const checker = fakeChecker({
      monitor: () =>
        Promise.resolve({
          status: 'warning' as const,
          message: 'We could not check how many screens you use.',
          result: { kind: 'MULTI' as const, api: 'SCREEN_IS_EXTENDED' as const },
        }),
    });
    renderWithQuery(
      <SystemCheckStep checker={checker} onPassed={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await runAll(user);
    const next = screen.getByRole('button', { name: /continue to identity check/i });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
    expect(await screen.findByRole('alert')).toHaveTextContent(/more than one screen was found/i);
  });

  it('FR-402: a microphone that works shows a level meter and says when sound is heard', async () => {
    await signIn();
    const user = userEvent.setup();
    let push: (n: number) => void = () => undefined;
    const checker = fakeChecker({
      microphone: (onLevel) => {
        push = onLevel;
        return Promise.resolve({ ...ok('Your microphone works.'), handle: { stop: vi.fn() } });
      },
    });
    renderWithQuery(
      <SystemCheckStep checker={checker} onPassed={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /check microphone/i }));
    const meter = await screen.findByRole('meter', { name: /microphone level/i });
    expect(screen.getByText(/we have not heard anything yet/i)).toBeInTheDocument();
    const { act } = await import('@testing-library/react');
    act(() => push(55));
    expect(meter).toHaveAttribute('aria-valuenow', '55');
    expect(screen.getByText(/we can hear you/i)).toBeInTheDocument();
  });

  it('FR-402: camera and microphone are stopped when the step closes', async () => {
    await signIn();
    const user = userEvent.setup();
    const stop = vi.fn();
    const micStop = vi.fn();
    const track = { stop } as unknown as MediaStreamTrack;
    const checker = fakeChecker({
      camera: () =>
        Promise.resolve({
          ...ok('Your camera works.'),
          stream: { getTracks: () => [track] } as unknown as MediaStream,
          virtualCameraLabel: null,
        }),
      microphone: () =>
        Promise.resolve({ ...ok('Your microphone works.'), handle: { stop: micStop } }),
    });
    const view = renderWithQuery(
      <SystemCheckStep checker={checker} onPassed={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /check camera/i }));
    await user.click(screen.getByRole('button', { name: /check microphone/i }));
    await screen.findByRole('meter', { name: /microphone level/i });
    view.unmount();
    expect(stop).toHaveBeenCalled();
    expect(micStop).toHaveBeenCalled();
  });

  it('FR-402: a session that ended while checking says so', async () => {
    const user = userEvent.setup();
    const onSessionEnded = vi.fn();
    setSessionToken('not-a-known-session');
    renderWithQuery(
      <SystemCheckStep
        checker={fakeChecker()}
        onPassed={vi.fn()}
        onSessionEnded={onSessionEnded}
      />,
    );
    await runAll(user);
    const next = screen.getByRole('button', { name: /continue to identity check/i });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });

  it('NFR-06: no axe violations on the system check, with passes and failures showing', async () => {
    await signIn();
    const user = userEvent.setup();
    const checker = fakeChecker({
      camera: () =>
        Promise.resolve({
          status: 'failed' as const,
          message: 'Camera access was blocked.',
          help: 'Allow the camera, then try again.',
        }),
    });
    const { container } = renderWithQuery(
      <SystemCheckStep checker={checker} onPassed={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /check camera/i }));
    await screen.findByText(/camera access was blocked/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
