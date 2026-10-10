import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  AUTO_STOP_MS,
  VIDEO_BITS_PER_SECOND,
  advanceRoomSeq,
  currentRoomSeq,
  resetRoomSeq,
  ROTATE_STEPS,
  STATIONARY_STEPS,
} from './room-capture';
import { RoomScanStep } from './room-scan-step';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));

setupCandidateServer();
beforeEach(() => resetRoomSeq());

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

  it('FR-404: a 412 after our own earlier PUT (response lost) is accepted and confirmed', async () => {
    await signIn();
    const outcomes: ('failed' | 'exists')[] = ['failed', 'exists'];
    const upload = vi.fn(() => Promise.resolve(outcomes.shift() ?? 'exists'));
    const seen = recordRequests();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep deps={{ ...deps, upload }} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    const seqs = seen
      .filter((r) => r.url.endsWith('/media/presign'))
      .map((r) => (r.body as { seq: number }).seq);
    expect(seqs).toEqual([0, 0]); // same number: it was our own first PUT that landed
  });

  it('FR-404: a 412 on the first PUT of a number (a stored object that is not ours) moves on to a new number', async () => {
    await signIn();
    const outcomes: ('exists' | 'ok')[] = ['exists', 'ok'];
    const upload = vi.fn(() => Promise.resolve(outcomes.shift() ?? 'ok'));
    const seen = recordRequests();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep deps={{ ...deps, upload }} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(2);
    const confirms = seen.filter((r) => r.url.endsWith('/media/confirm'));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.body).toMatchObject({ seq: 1 });
  });

  it('FR-404: when every number is taken the candidate is told to press Send again', async () => {
    await signIn();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/presign`, () =>
        HttpResponse.json({ alreadyUploaded: true }),
      ),
    );
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /press "send this recording" again/i,
    );
  });

  it('FR-404: the step closing while the camera prompt is open switches the camera off', async () => {
    await signIn();
    const stop = vi.fn();
    let resolveCamera: (s: MediaStream) => void = () => undefined;
    const startRecording = vi.fn();
    const user = userEvent.setup();
    const view = renderWithQuery(
      <RoomScanStep
        deps={{
          openCamera: () =>
            new Promise<MediaStream>((resolve) => {
              resolveCamera = resolve;
            }),
          startRecording,
        }}
        onDone={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /start the room scan/i }));
    view.unmount();
    resolveCamera({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(startRecording).not.toHaveBeenCalled();
  });

  it('FR-404: closing the step during a send does not keep sending or move the counter', async () => {
    await signIn();
    const seen = recordRequests();
    let release: () => void = () => undefined;
    const upload = vi.fn(
      () =>
        new Promise<'ok'>((resolve) => {
          release = () => resolve('ok');
        }),
    );
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    const view = renderWithQuery(
      <RoomScanStep deps={{ ...deps, upload }} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    view.unmount();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((r) => r.url.endsWith('/media/confirm'))).toBe(false);
    expect(currentRoomSeq()).toBe(0);
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

  it('FR-404 TC-035: confirm 503 with Retry-After is retried in place after the wait, without uploading the clip again', async () => {
    await signIn();
    let confirms = 0;
    const seen = recordRequests();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/confirm`, () => {
        confirms += 1;
        return confirms <= 2
          ? HttpResponse.json(
              { code: 'SERVICE_UNAVAILABLE' },
              { status: 503, headers: { 'Retry-After': '4' } },
            )
          : HttpResponse.json({ uploaded: true, sizeBytes: 5 });
      }),
    );
    const { deps } = fakeRoomDeps();
    const sleep = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep deps={{ ...deps, sleep }} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    expect(confirms).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 4000);
    expect(seen.filter((r) => r.url.endsWith('/media/presign'))).toHaveLength(1);
  });

  it('FR-404 TC-035 D-61: confirm that keeps answering 503 stops after the retries, offers Try again, and never uploads a second clip', async () => {
    await signIn();
    let confirms = 0;
    let failing = true;
    const seen = recordRequests();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/confirm`, () => {
        confirms += 1;
        return failing
          ? HttpResponse.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 })
          : HttpResponse.json({ uploaded: true, sizeBytes: 5 });
      }),
    );
    const { deps } = fakeRoomDeps();
    const sleep = vi.fn(() => Promise.resolve());
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep deps={{ ...deps, sleep }} onDone={onDone} onSessionEnded={vi.fn()} />,
    );
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/service is busy/i);
    // 1 confirm plus 3 retries, each retry after the 2 s fallback wait.
    expect(confirms).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2000);
    // The stored clip keeps its number and cannot be replaced by a new recording.
    expect(currentRoomSeq()).toBe(0);
    expect(screen.queryByRole('button', { name: /record again/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-done')).not.toBeInTheDocument();
    // Try again confirms the SAME chunk: no presign, no upload.
    failing = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    expect(seen.filter((r) => r.url.endsWith('/media/presign'))).toHaveLength(1);
    expect(confirms).toBe(5);
    expect(currentRoomSeq()).toBe(1);
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

  it('FR-404: recording again before sending presigns only the clip that is sent', async () => {
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
    const presigns = seen.filter((r) => r.url.endsWith('/media/presign'));
    expect(presigns).toHaveLength(1);
    expect(presigns[0]?.body).toMatchObject({ segment: 0, seq: 0 });
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

  it('FR-404: after a failed send, Record again and Send uses a new seq and succeeds (no SEQ_CONFLICT forever)', async () => {
    await signIn();
    const seen = recordRequests();
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
    await user.click(screen.getByRole('button', { name: /record again/i }));
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    const seqs = seen
      .filter((r) => r.url.endsWith('/media/presign'))
      .map((r) => (r.body as { seq: number; segment: number }).seq);
    // The failed send retried the same chunk (seq 0); the re-recorded clip got a new seq.
    expect(seqs[0]).toBe(0);
    expect(seqs.at(-1)).toBeGreaterThan(0);
    const last = seen.filter((r) => r.url.endsWith('/media/presign')).at(-1)?.body as {
      seq: number;
      segment: number;
    };
    expect(last.segment).toBe(last.seq);
  });

  it('FR-404: a second clip after the step reopens (resume) does not reuse the first clip seq', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    const first = renderWithQuery(
      <RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    await screen.findByTestId('room-done');
    first.unmount();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    await screen.findByTestId('room-done');
    const seqs = seen
      .filter((r) => r.url.endsWith('/media/presign'))
      .map((r) => (r.body as { seq: number }).seq);
    expect(seqs).toEqual([0, 1]);
  });

  it('FR-404: after a page reload the counter restarts, and alreadyUploaded for a clip this page did not send is not "received"', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps: base } = fakeRoomDeps();
    const upload = vi.fn(() => Promise.resolve('ok' as const));
    const deps = { ...base, upload };
    const user = userEvent.setup();
    // An earlier page load stored and confirmed seq 0.
    const prior = await candidateApi.presignMedia({
      stream: 'ROOM_SCAN',
      segment: 0,
      seq: 0,
      bytes: 10,
      contentType: 'video/webm',
      startedAt: '2026-10-05T09:00:00.000Z',
      durationMs: 1000,
    });
    expect(prior.ok).toBe(true);
    await candidateApi.confirmMedia({ stream: 'ROOM_SCAN', segment: 0, seq: 0 });
    resetRoomSeq();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    // The clip really was uploaded, under a seq the server did not already hold.
    const presigns = seen.filter((r) => r.url.endsWith('/media/presign'));
    expect(presigns.map((r) => (r.body as { seq: number }).seq).slice(-2)).toEqual([0, 1]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('FR-404: SEQ_CONFLICT moves on to the next seq and presigns again', async () => {
    await signIn();
    const seen = recordRequests();
    let first = true;
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/presign`, async ({ request }) => {
        const body = (await request.json()) as { seq: number };
        if (first) {
          first = false;
          return HttpResponse.json({ code: 'SEQ_CONFLICT' }, { status: 409 });
        }
        return HttpResponse.json({
          url: `${apiBaseUrl}/mock-upload/x-${body.seq}`,
          method: 'PUT',
          headers: { 'Content-Type': 'video/webm' },
          expiresAt: '2026-10-05T10:00:00.000Z',
        });
      }),
    );
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/confirm`, () =>
        HttpResponse.json({ uploaded: true, sizeBytes: 5 }),
      ),
    );
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByTestId('room-done')).toBeInTheDocument();
    const seqs = seen
      .filter((r) => r.url.endsWith('/media/presign'))
      .map((r) => (r.body as { seq: number }).seq);
    expect(seqs).toEqual([0, 1]);
    expect(advanceRoomSeq()).toBeGreaterThan(1);
  });

  it('FR-404: presign 429 and SESSION_NOT_ACTIVE give their own messages', async () => {
    await signIn();
    const user = userEvent.setup();
    const { deps } = fakeRoomDeps();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/presign`, () =>
        HttpResponse.json(
          { code: 'RATE_LIMITED' },
          { status: 429, headers: { 'Retry-After': '17' } },
        ),
      ),
    );
    renderWithQuery(<RoomScanStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await recordRotation(user);
    await user.click(await screen.findByRole('button', { name: /send this recording/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wait 17 seconds/i);
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/media/presign`, () =>
        HttpResponse.json({ code: 'SESSION_NOT_ACTIVE' }, { status: 409 }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /send this recording/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no longer active/i));
  });

  it('FR-404: the recorder is limited to about 1.2 Mbps and stops a second before the wire limit', () => {
    expect(VIDEO_BITS_PER_SECOND).toBeLessThanOrEqual(1_500_000);
    // 60 s at that rate is well under the 16 MiB chunk limit.
    expect((VIDEO_BITS_PER_SECOND / 8) * 60).toBeLessThan(16 * 1024 * 1024);
    expect(AUTO_STOP_MS).toBe(59_000);
  });

  it('FR-404: a recorder that cannot start stops the camera and explains', async () => {
    await signIn();
    const stopped = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep
        deps={{
          openCamera: () =>
            Promise.resolve({ getTracks: () => [{ stop: stopped }] } as unknown as MediaStream),
          startRecording: () => {
            throw new Error('NotSupportedError');
          },
        }}
        onDone={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /start the room scan/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not start the recording/i);
    expect(stopped).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /start the room scan/i })).toBeEnabled();
  });

  it('FR-404: pressing start twice quickly opens one camera', async () => {
    await signIn();
    const open = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) =>
          setTimeout(
            () => resolve({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
            30,
          ),
        ),
    );
    const { deps } = fakeRoomDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <RoomScanStep
        deps={{ ...deps, openCamera: open }}
        onDone={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );
    await user.dblClick(screen.getByRole('button', { name: /start the room scan/i }));
    await screen.findByTestId('room-step');
    expect(open).toHaveBeenCalledTimes(1);
  });
});
