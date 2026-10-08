import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { getSessionToken, setSessionToken } from '@/features/candidate-flow/session-store';
import {
  recordRequests,
  renderWithQuery,
  server,
  setupCandidateServer,
  storedKeys,
} from '@/features/candidate-flow/test-helpers';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { testState } from '@/mocks/candidate/test-handlers';
import {
  fakeStream,
  installFullscreen,
  setFullscreen,
  setupDevices,
  startedSession,
} from './proctor/test-support';
import { createAdrSource } from './adr-source';
import { ProctoredTest } from './proctored-test';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));
const toastMessage = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { message: toastMessage, error: vi.fn() } }));
vi.mock('next/dynamic', async () => {
  const { editorStub } = await import('@/features/candidate-flow/test-helpers');
  return { default: () => editorStub() };
});

setupCandidateServer();

const cand = `${apiBaseUrl}/v1/candidate`;
const TIMING = { heartbeatIntervalMs: 60, flushIntervalMs: 60, finishDrainMs: 300 };

beforeEach(() => installFullscreen());
afterEach(async () => {
  // Unmount now and let the controller's async stop() settle: it leaves fullscreen, which would
  // otherwise land in the next test's page.
  cleanup();
  await new Promise((r) => setTimeout(r, 150));
  vi.unstubAllGlobals();
});

function mount(handlers: { onSessionEnded?: () => void; onSubmitted?: () => void } = {}) {
  const onSessionEnded = handlers.onSessionEnded ?? vi.fn();
  const onSubmitted = handlers.onSubmitted ?? vi.fn();
  const view = renderWithQuery(
    <main id="main">
      <ProctoredTest
        source={createAdrSource({ onSessionEnded })}
        onSessionEnded={onSessionEnded}
        onSubmitted={onSubmitted}
        timing={TIMING}
      />
    </main>,
  );
  return { ...view, onSessionEnded, onSubmitted };
}

async function passGate(user: ReturnType<typeof userEvent.setup>) {
  const share = await screen.findByRole('button', { name: /share your entire screen/i });
  await waitFor(() => expect(share).toBeEnabled());
  await user.click(share);
  const enter = await screen.findByRole('button', { name: /enter fullscreen and continue/i });
  await user.click(enter);
  await screen.findByRole('button', { name: /run sample tests/i });
}

describe('proctored test (ADR 0013, FR-601..FR-603, FR-609, FR-701, TC-030)', () => {
  it('TC-030: with no consent signature nothing is requested or started', async () => {
    const devices = setupDevices();
    const seen = recordRequests();
    // A session still at OPENED: consent not signed.
    const r = await candidateApi.startSession(MOCK_TOKENS.open, MOCK_OTP);
    if (!r.ok) throw new Error('sign-in');
    setSessionToken(r.data.sessionToken);
    const { onSessionEnded } = mount();
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(devices.getDisplayMedia).not.toHaveBeenCalled();
    expect(seen.some((q) => q.url.endsWith('/proctor-key'))).toBe(false);
  });

  it('FR-604 FR-601: the gate asks for the entire screen first, then fullscreen, and starts the recorders', async () => {
    const devices = setupDevices();
    await startedSession();
    const user = userEvent.setup();
    mount();
    expect(
      await screen.findByRole('dialog', { name: /share your entire screen/i }),
    ).toBeInTheDocument();
    // Nothing is asked for before the candidate presses the button.
    expect(devices.getDisplayMedia).not.toHaveBeenCalled();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    await passGate(user);
    expect(devices.getDisplayMedia).toHaveBeenCalledTimes(1);
    // Webcam and microphone start with fullscreen.
    await waitFor(() => expect(devices.getUserMedia).toHaveBeenCalledTimes(2));
  });

  it('ADR 0013 section 4: the key is fetched once, kept out of URLs and storage, and the beat starts', async () => {
    setupDevices();
    const session = await startedSession();
    const seen = recordRequests();
    mount();
    await waitFor(() => expect(testState(session).keyIssued).toBe(true));
    await waitFor(() => expect(testState(session).heartbeats).toBeGreaterThan(1));
    expect(seen.filter((q) => q.url.endsWith('/proctor-key'))).toHaveLength(1);
    const token = getSessionToken() ?? 'none';
    for (const q of seen) {
      expect(q.url).not.toContain(token);
      expect(q.url.toLowerCase()).not.toContain('key=');
    }
    expect(storedKeys()).toEqual([]);
    expect(document.cookie).toBe('');
  });

  it('FR-603 ADR 0013 section 2: a blocked paste becomes a signed event batch the server verifies', async () => {
    setupDevices();
    const session = await startedSession();
    const user = userEvent.setup();
    mount();
    await passGate(user);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    document.getElementById('main')?.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    // The mock verifies HMAC-SHA256 over the exact body (a wrong signature would be a 403).
    await waitFor(async () => expect(await sentTypes(session)).toContain('PASTE_ATTEMPT'), {
      timeout: 8000,
    });
    expect(testState(session).batches.every((b) => /^[0-9a-f]{64}$/.test(b.signature))).toBe(true);
    await waitFor(() =>
      expect(toastMessage).toHaveBeenCalledWith(
        expect.stringMatching(/copy and paste are turned off/i),
        expect.anything(),
      ),
    );
  });

  it('FR-601: leaving fullscreen locks the editor with an overlay, logs the event, and re-entering restores it', async () => {
    setupDevices();
    const session = await startedSession();
    const user = userEvent.setup();
    mount();
    await passGate(user);
    act(() => setFullscreen(false));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/you left fullscreen/i);
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
    await waitFor(async () => expect(await sentTypes(session)).toContain('FULLSCREEN_EXIT'), {
      timeout: 8000,
    });
    await user.click(screen.getByRole('button', { name: /re-enter fullscreen/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'false');
  });

  it('FR-604: a stopped screen share locks the editor, says time keeps running, and sharing again unlocks', async () => {
    const devices = setupDevices();
    const session = await startedSession();
    const user = userEvent.setup();
    mount();
    await passGate(user);
    act(() => devices.display.end());
    const overlay = await screen.findByRole('alertdialog');
    expect(overlay).toHaveTextContent(/no longer shared/i);
    expect(overlay).toHaveTextContent(/your time keeps running/i);
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
    await waitFor(async () => expect(await sentTypes(session)).toContain('SCREEN_SHARE_STOPPED'), {
      timeout: 8000,
    });
    await user.click(screen.getByRole('button', { name: /share your entire screen again/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('FR-604: a window or tab share is refused at the gate with how to fix it', async () => {
    const devices = setupDevices();
    devices.getDisplayMedia.mockResolvedValueOnce(fakeStream({ displaySurface: 'window' }).stream);
    await startedSession();
    const user = userEvent.setup();
    mount();
    const share = await screen.findByRole('button', { name: /share your entire screen/i });
    await waitFor(() => expect(share).toBeEnabled());
    await user.click(share);
    expect(await screen.findByRole('alert')).toHaveTextContent(/window or a tab/i);
    expect(screen.queryByRole('button', { name: /enter fullscreen/i })).not.toBeInTheDocument();
  });

  it('ADR 0002 P-2: a proctor pause stops the clock, shows a pause overlay and turns the editor and finish off; resume restores', async () => {
    setupDevices();
    const session = await startedSession();
    const user = userEvent.setup();
    mount();
    await passGate(user);
    const before = screen.getByRole('timer', { name: 'Test time left', hidden: true }).textContent;
    testState(session).pauseReasons = ['PROCTOR'];
    const overlay = await screen.findByRole('alertdialog', undefined, { timeout: 4000 });
    expect(overlay).toHaveTextContent(/the test is paused/i);
    expect(overlay).toHaveTextContent(/your time is stopped/i);
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByRole('button', { name: 'Finish section', hidden: true })).toBeDisabled();
    // The countdown is frozen at the pause.
    const frozen = screen.getByRole('timer', { name: 'Test time left', hidden: true }).textContent;
    await new Promise((r) => setTimeout(r, 1300));
    expect(screen.getByRole('timer', { name: 'Test time left', hidden: true }).textContent).toBe(
      frozen,
    );
    expect(before).toMatch(/\d\d:\d\d/);
    testState(session).pauseReasons = [];
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByRole('button', { name: 'Finish section' })).toBeEnabled();
  }, 15_000);

  it('FR-609: a failing heartbeat shows an offline notice that keeps work, and clears when it recovers', async () => {
    setupDevices();
    await startedSession();
    const user = userEvent.setup();
    mount();
    await passGate(user);
    let fail = true;
    server.use(
      http.post(`${cand}/session/heartbeat`, () =>
        fail
          ? HttpResponse.json({ code: 'UNAVAILABLE' }, { status: 503 })
          : HttpResponse.json({
              serverTime: new Date().toISOString(),
              status: 'IN_PROGRESS',
              startedAt: new Date().toISOString(),
              deadlineAt: new Date(Date.now() + 600_000).toISOString(),
              sectionDeadlineAt: new Date(Date.now() + 300_000).toISOString(),
              pauseReasons: [],
            }),
      ),
    );
    expect(
      await screen.findByTestId('offline-banner', undefined, { timeout: 4000 }),
    ).toHaveTextContent(/kept and sent again/i);
    fail = false;
    await waitFor(() => expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument(), {
      timeout: 4000,
    });
  }, 15_000);

  it('ADR 0013 5.3: 409 SESSION_NOT_ACTIVE on the heartbeat ends the test with a calm screen, not "offline"', async () => {
    setupDevices();
    const session = await startedSession();
    mount();
    await screen.findByRole('dialog', { name: /share your entire screen/i });
    testState(session).submitted = true;
    expect(
      await screen.findByTestId('test-inactive', undefined, { timeout: 4000 }),
    ).toHaveTextContent(/no longer running/i);
    expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();
  });

  it('ADR 0013 section 4: KEY_ALREADY_ISSUED (a reload on the same epoch) needs a new code', async () => {
    setupDevices();
    const session = await startedSession();
    testState(session).keyIssued = true;
    const { onSessionEnded } = mount();
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });

  it('ADR 0013 5.2: SESSION_TAKEN_OVER on a batch needs a new code', async () => {
    setupDevices();
    await startedSession();
    server.use(
      http.post(`${cand}/session/events`, () =>
        HttpResponse.json({ code: 'SESSION_TAKEN_OVER' }, { status: 401 }),
      ),
    );
    const { onSessionEnded } = mount();
    // The first batch the SDK sends (a detector report at start) gets the 401, which asks for a
    // new code at once.
    await waitFor(
      () => {
        window.dispatchEvent(new Event('pagehide'));
        expect(onSessionEnded).toHaveBeenCalled();
      },
      { timeout: 6000 },
    );
  });

  it('FR-701: recorded chunks are presigned and confirmed per stream with the bare content type', async () => {
    const devices = setupDevices();
    const session = await startedSession();
    const seen = recordRequests();
    const user = userEvent.setup();
    mount();
    await passGate(user);
    await waitFor(() => expect(devices.recorders.length).toBeGreaterThanOrEqual(2));
    act(() => devices.recorders.forEach((r) => r.emit()));
    await waitFor(() =>
      expect(Object.keys(getMockConfirmed(session)).length).toBeGreaterThanOrEqual(2),
    );
    const presign = seen.find((q) => q.url.endsWith('/media/presign'));
    expect((presign?.body as { contentType: string }).contentType).toMatch(/^(video|audio)\/webm$/);
    expect(JSON.stringify(presign?.body)).not.toContain('codecs');
  });

  it('FR-701: a denied camera or microphone is reported, not hidden, and the test goes on', async () => {
    setupDevices({ deny: 'all' });
    await startedSession();
    const user = userEvent.setup();
    mount();
    await passGate(user);
    expect(await screen.findByTestId('devices-banner')).toHaveTextContent(
      /recording could not start/i,
    );
    expect(screen.getByRole('button', { name: /run sample tests/i })).toBeEnabled();
  });

  it('FR-505 ADR 0002: finishing the last section flushes events, stops every device and leaves fullscreen', async () => {
    const devices = setupDevices();
    const session = await startedSession();
    const user = userEvent.setup();
    const { onSubmitted } = mount();
    await passGate(user);
    for (let i = 0; i < 2; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Finish section' }));
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish section' }),
      );
      if (i === 0) {
        await user.click(
          await screen.findByRole('button', { name: /continue to the next section/i }),
        );
        // Wait for section 2 to be on screen before touching its buttons.
        await screen.findByText(/section 2 of 2/i);
      }
    }
    expect(await screen.findByTestId('test-submitted')).toBeInTheDocument();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled(), { timeout: 6000 });
    expect(devices.display.stops).toHaveBeenCalled();
    expect(document.fullscreenElement).toBeNull();
    expect(testState(session).submitted).toBe(true);
    // The events queued during the test were flushed before the end, not dropped.
    expect(testState(session).batches.flatMap((b) => b.events.map((e) => e.type))).toContain(
      'FULLSCREEN_RESTORED',
    );
  });

  it('FU-FEB-60 FR-505 ADR 0002: a heartbeat that meets "not active" while the candidate submits the last section does not replace the submitted page', async () => {
    const devices = setupDevices();
    const session = await startedSession();
    const user = userEvent.setup();
    const { onSubmitted } = mount();
    await passGate(user);
    // The server closes the last section the moment the finish arrives and answers 202 only after a
    // while, so several heartbeats (60 ms apart) see 409 SESSION_NOT_ACTIVE in between: the exact
    // window in which the screen used to show "no longer running" and purge the recording.
    let finishing = false;
    let heartbeatsDuringFinish = 0;
    server.use(
      // Counts every heartbeat sent while the last finish is pending (the mock only counts the
      // ones the server accepts), then lets the normal handler answer it.
      http.post(`${cand}/session/heartbeat`, () => {
        if (finishing) heartbeatsDuringFinish += 1;
        return undefined;
      }),
      http.post(`${cand}/session/section/finish`, async ({ request }) => {
        const body = (await request.clone().json()) as { position?: number };
        if (body.position !== 2) return undefined;
        finishing = true;
        testState(session).submitted = true;
        await delay(400);
        finishing = false;
        return HttpResponse.json({ accepted: true }, { status: 202 });
      }),
    );
    for (let i = 0; i < 2; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Finish section' }));
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish section' }),
      );
      if (i === 0) {
        await user.click(
          await screen.findByRole('button', { name: /continue to the next section/i }),
        );
        await screen.findByText(/section 2 of 2/i);
      }
    }
    expect(await screen.findByTestId('test-submitted')).toBeInTheDocument();
    expect(screen.queryByTestId('test-inactive')).not.toBeInTheDocument();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled(), { timeout: 6000 });
    expect(devices.display.stops).toHaveBeenCalled();
    // The window really contained heartbeats; otherwise this test would prove nothing.
    expect(heartbeatsDuringFinish).toBeGreaterThan(0);
  }, 20_000);
});

/** Asks the SDK to send queued batches now (it flushes on pagehide), then reads what the server got. */
async function sentTypes(session: object): Promise<string[]> {
  window.dispatchEvent(new Event('pagehide'));
  await new Promise((r) => setTimeout(r, 30));
  return testState(session).batches.flatMap((b) => b.events.map((e) => e.type));
}

function getMockConfirmed(session: object): Record<string, number> {
  // The mock keeps confirmed chunk counts per stream on the session record.
  return (session as { confirmedChunks: Record<string, number> }).confirmedChunks;
}
