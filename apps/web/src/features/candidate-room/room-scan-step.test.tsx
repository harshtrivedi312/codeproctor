import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { setSessionToken } from '@/features/candidate-flow/session-store';
import {
  fakeRoomDeps,
  recordRequests,
  renderWithQuery,
  server,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { ROTATE_STEPS, STATIONARY_STEPS } from './room-capture';
import { RoomScanStep } from './room-scan-step';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));

setupCandidateServer();

async function signIn(): Promise<void> {
  const r = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
  if (!r.ok) throw new Error('mock sign-in failed');
  setSessionToken(r.data.sessionToken);
}

type User = ReturnType<typeof userEvent.setup>;

async function recordRotation(user: User) {
  await user.click(screen.getByRole('button', { name: /start the room scan/i }));
  for (let i = 0; i < ROTATE_STEPS.length - 1; i += 1) {
    expect(await screen.findByTestId('room-step')).toHaveTextContent(ROTATE_STEPS[i] ?? '');
    await user.click(screen.getByRole('button', { name: /done, next/i }));
  }
  await user.click(await screen.findByRole('button', { name: /done, stop recording/i }));
}

describe('room scan step (FR-404, TC-035)', () => {
  it('FR-404: guides a full rotation and then the desk, candidate-paced, and uploads one ROOM_SCAN clip', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps } = fakeRoomDeps();
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={onDone} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(onDone).toHaveBeenCalledTimes(1);

    const presign = seen.find((r) => r.url.endsWith('/media/presign'));
    expect(presign?.body).toMatchObject({
      stream: 'ROOM_SCAN',
      segment: 0,
      seq: 0,
      contentType: 'video/webm',
      durationMs: 15_000,
      startedAt: '2026-10-05T10:00:00.000Z',
    });
    // The bare content type, with no codecs parameter (ADR 0013 section 5.5).
    expect(JSON.stringify(presign?.body)).not.toContain('codecs');
    expect(seen.find((r) => r.url.endsWith('/media/confirm'))?.body).toEqual({
      stream: 'ROOM_SCAN',
      segment: 0,
      seq: 0,
    });
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('TC-035: there is no way past the room scan without sending a recording', async () => {
    await signIn();
    const { deps } = fakeRoomDeps();
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={onDone} onSessionEnded={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^continue$|skip/i })).not.toBeInTheDocument();
    await recordRotation(user);
    expect(screen.queryByRole('button', { name: /^continue$|skip/i })).not.toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('FR-404: a candidate who cannot rotate gets a still-view path, with the same upload', async () => {
    await signIn();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /i cannot rotate my camera/i }));
    expect(await screen.findByTestId('room-step')).toHaveTextContent(STATIONARY_STEPS[0]);
    await user.click(screen.getByRole('button', { name: /done, next/i }));
    expect(screen.getByTestId('room-step')).toHaveTextContent(STATIONARY_STEPS[1]);
    await user.click(screen.getByRole('button', { name: /done, stop recording/i }));
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
  });

  it('FR-404: nothing is timed for the candidate: steps only move when they press the button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await signIn();
      const { deps } = fakeRoomDeps();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: /start the room scan/i }));
      expect(await screen.findByTestId('room-step')).toHaveTextContent(ROTATE_STEPS[0]);
      vi.advanceTimersByTime(40_000);
      expect(screen.getByTestId('room-step')).toHaveTextContent(ROTATE_STEPS[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FR-404: a camera that will not start says how to fix it and records nothing', async () => {
    await signIn();
    const started = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep
        deps={{
          openCamera: () => Promise.reject(new DOMException('x', 'NotAllowedError')),
          startRecording: () => {
            started();
            return { stop: () => Promise.reject(new Error('never')) };
          },
        }}
        onDone={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /start the room scan/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/allow the camera/i);
    expect(started).not.toHaveBeenCalled();
  });

  it('FR-404: a failed upload keeps the recording and offers to send it again', async () => {
    await signIn();
    let outcome: 'ok' | 'failed' = 'failed';
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep
        deps={{ ...deps, upload: () => Promise.resolve(outcome) }}
        onDone={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/upload did not finish/i);
    outcome = 'ok';
    await user.click(screen.getByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
  });

  it('FR-404: a 412 on the PUT (already stored) and alreadyUploaded both go straight to confirm', async () => {
    await signIn();
    const { deps } = fakeRoomDeps('exists');
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
  });

  it('FR-404: confirm 409 UPLOAD_NOT_FOUND asks for a new URL and uploads again', async () => {
    await signIn();
    let confirms = 0;
    const seen = recordRequests();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/confirm`, () => {
        confirms += 1;
        return confirms === 1
          ? HttpResponse.json({ code: 'UPLOAD_NOT_FOUND' }, { status: 409 })
          : HttpResponse.json({ uploaded: true, sizeBytes: 5 });
      }),
    );
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    expect(seen.filter((r) => r.url.endsWith('/media/presign'))).toHaveLength(2);
  });

  it('FR-404: a double click on send uploads once', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.dblClick(await screen.findByRole('button', { name: /send this recording/i }));
    await screen.findByTestId('room-done');
    expect(seen.filter((r) => r.url.endsWith('/media/confirm'))).toHaveLength(1);
  });

  it('FR-404: recording again starts a new segment', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /record again/i }));
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    await screen.findByTestId('room-done');
    expect(seen.find((r) => r.url.endsWith('/media/presign'))?.body).toMatchObject({ segment: 1 });
  });

  it('FR-404: the camera is stopped once recording ends', async () => {
    await signIn();
    const { deps, stopped } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await waitFor(() => expect(stopped).toHaveBeenCalled());
  });

  it('FR-404: the camera is stopped when the step closes mid-recording', async () => {
    await signIn();
    const { deps, stopped } = fakeRoomDeps();
    const user = userEvent.setup();
    const view = renderWithQuery(
      <RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: /start the room scan/i }));
    await screen.findByTestId('room-step');
    view.unmount();
    expect(stopped).toHaveBeenCalled();
  });

  it('FR-404: an ended session says so', async () => {
    setSessionToken('unknown-session');
    const onSessionEnded = vi.fn();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={onSessionEnded} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });

  it('NFR-06: no axe violations on the intro, recording, review and done screens', async () => {
    await signIn();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /start the room scan/i }));
    await screen.findByTestId('room-step');
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /stop now/i }));
    await screen.findByRole('button', { name: /send this recording/i });
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /send this recording/i }));
    await screen.findByTestId('room-done');
    expect(await axe(container)).toHaveNoViolations();
  });
});
