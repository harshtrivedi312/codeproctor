import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { apiBaseUrl } from '@/lib/env';
import { describe, expect, it, vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { setSessionToken } from '@/features/candidate-flow/session-store';
import {
  recordRequests,
  renderWithQuery,
  server,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import type { IdentityDeps } from './capture';
import { IDENTITY_COPY, IdentityStep } from './identity-step';

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

async function signIn(token: string = MOCK_TOKENS.consented): Promise<void> {
  const r = await candidateApi.startSession(token, MOCK_OTP);
  if (!r.ok) throw new Error('mock sign-in failed');
  setSessionToken(r.data.sessionToken);
}

function fakeDeps(overrides: Partial<IdentityDeps> = {}): {
  deps: Partial<IdentityDeps>;
  stopped: ReturnType<typeof vi.fn>;
} {
  const stopped = vi.fn();
  const stream = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream;
  return {
    stopped,
    deps: {
      openCamera: () => Promise.resolve(stream),
      snapshot: () => Promise.resolve(new Blob(['jpeg-bytes'], { type: 'image/jpeg' })),
      fileToJpeg: () => Promise.resolve(new Blob(['jpeg-bytes'], { type: 'image/jpeg' })),
      upload: () => Promise.resolve(true),
      ...overrides,
    },
  };
}

/** Walks the happy path up to the "Send my photos" button. */
async function capturePhotos(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /turn on camera/i }));
  await user.click(await screen.findByRole('button', { name: /take photo of my id/i }));
  await user.click(await screen.findByRole('button', { name: /use this photo, next: selfie/i }));
  for (let i = 0; i < 3; i += 1) {
    await user.click(await screen.findByRole('button', { name: /done, (next prompt|last step)/i }));
  }
  await user.click(await screen.findByRole('button', { name: /take selfie/i }));
  await user.click(await screen.findByRole('button', { name: /use this selfie/i }));
}

describe('identity step (FR-403, ADR 0004)', () => {
  it('FR-403: shows the framing guide, liveness prompts in order, then uploads names only and says "received"', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps } = fakeDeps();
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={onDone} onSessionEnded={vi.fn()} />,
    );

    await user.click(await screen.findByRole('button', { name: /turn on camera/i }));
    expect(await screen.findByText('Place your ID here')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /take photo of my id/i }));
    expect(await screen.findByAltText('Preview of your ID')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /use this photo, next: selfie/i }));

    const prompts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      prompts.push((await screen.findByTestId('liveness-prompt')).textContent ?? '');
      await user.click(screen.getByRole('button', { name: /done, (next prompt|last step)/i }));
    }
    expect(prompts[0]).toMatch(/blink/i);
    expect(prompts[1]).toMatch(/left/i);
    expect(prompts[2]).toMatch(/right/i);
    await user.click(await screen.findByRole('button', { name: /take selfie/i }));
    await user.click(await screen.findByRole('button', { name: /use this selfie/i }));
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));

    expect(await screen.findByTestId('identity-received')).toHaveTextContent(
      IDENTITY_COPY.received,
    );
    // The candidate sees "received", never a score, a match, or a pass or fail.
    expect(document.body.textContent).not.toMatch(
      /score|\bmatch(ed|es)?\b|similarity|confidence|failed|passed/i,
    );
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(onDone).toHaveBeenCalledTimes(1);

    const presigns = seen.filter((r) => r.url.endsWith('/identity/presign'));
    expect(presigns.map((r) => (r.body as { purpose: string }).purpose)).toEqual([
      'ID_IMAGE',
      'SELFIE',
    ]);
    expect(
      presigns.every((r) => (r.body as { contentType: string }).contentType === 'image/jpeg'),
    ).toBe(true);
    const submit = seen.find((r) => r.method === 'POST' && r.url.endsWith('/session/identity'));
    // Names issued by the presign (identity/<attempt>/<id|selfie>-<ULID>.jpg), never object keys or
    // URLs chosen by the browser; exactly these three fields (unknown fields are refused).
    const body = submit?.body as { idImageName: string; selfieName: string };
    expect(Object.keys(submit?.body as object).sort()).toEqual([
      'idImageName',
      'livenessConfirmed',
      'selfieName',
    ]);
    expect(body.idImageName).toMatch(/^identity\/1\/id-[0-9A-Z]{26}\.jpg$/);
    expect(body.selfieName).toMatch(/^identity\/1\/selfie-[0-9A-Z]{26}\.jpg$/);
    expect(submit?.body).toMatchObject({ livenessConfirmed: true });
    expect(JSON.stringify(submit?.body)).not.toContain('http');
    // The result is read from GET /session/identity until it leaves PENDING.
    expect(seen.some((r) => r.method === 'GET' && r.url.endsWith('/session/identity'))).toBe(true);
  });

  it('FR-403: the camera is stopped once the photos are sent', async () => {
    await signIn();
    const { deps, stopped } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    await screen.findByTestId('identity-received');
    expect(stopped).toHaveBeenCalled();
  });

  it('TC-033: a first attempt that could not be read asks for one retake with tips, and never shows a score', async () => {
    await signIn(MOCK_TOKENS.lowConfidence);
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    expect(await screen.findByTestId('identity-retry')).toHaveTextContent(
      /take both photos again/i,
    );
    expect(screen.getByText(/second try/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/score|similarity|%/i);

    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    // Second attempt: no further retry; the candidate continues (nothing auto-rejects).
    expect(await screen.findByTestId('identity-received')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('FR-403: an ID can be uploaded from a file instead of the camera, which keeps the step usable without a webcam for the ID', async () => {
    await signIn();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    const input = await screen.findByLabelText(/upload a photo of my id instead/i);
    await user.upload(input, new File(['x'], 'id.png', { type: 'image/png' }));
    expect(
      await screen.findByRole('button', { name: /use this photo, next: selfie/i }),
    ).toBeInTheDocument();
  });

  it('FR-403: a file that is not a picture is explained', async () => {
    await signIn();
    const { deps } = fakeDeps();
    const user = userEvent.setup({ applyAccept: false });
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    const input = await screen.findByLabelText(/upload a photo of my id instead/i);
    await user.upload(input, new File(['x'], 'id.txt', { type: 'text/plain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/that file is not a picture/i);
  });

  it('FR-403: a camera that will not start says how to fix it', async () => {
    await signIn();
    const { deps } = fakeDeps({
      openCamera: () => Promise.reject(new DOMException('x', 'NotAllowedError')),
    });
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: /turn on camera/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/allow the camera/i);
  });

  it('FR-403: an upload that fails keeps the photos and offers to send again', async () => {
    await signIn();
    let ok = false;
    const { deps } = fakeDeps({ upload: () => Promise.resolve(ok) });
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/upload did not finish/i);
    ok = true;
    await user.click(screen.getByRole('button', { name: /send my photos/i }));
    expect(await screen.findByTestId('identity-received')).toBeInTheDocument();
  });

  it('ADR 0015: a waived identity check shows the waived text and asks for no photos', async () => {
    await signIn(MOCK_TOKENS.waived);
    const seen = recordRequests();
    const { deps } = fakeDeps();
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={onDone} onSessionEnded={vi.fn()} />,
    );
    const waived = await screen.findByTestId('identity-waived');
    expect(waived).toHaveTextContent(IDENTITY_COPY.waived);
    expect(waived).toHaveTextContent(IDENTITY_COPY.waivedFaceOn);
    expect(screen.queryByRole('button', { name: /turn on camera/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(onDone).toHaveBeenCalled();
    expect(seen.some((r) => r.url.endsWith('/identity/presign'))).toBe(false);
  });

  it('ADR 0015: a waiver set after the page loaded (409 IDENTITY_CHECK_WAIVED) switches to the waived text', async () => {
    await signIn();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/identity/presign`, () =>
        HttpResponse.json({ code: 'IDENTITY_CHECK_WAIVED' }, { status: 409 }),
      ),
    );
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    // The waiver arrives after the page loaded: the next read of the projection shows it.
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/accommodations`, () =>
        HttpResponse.json({ identityCheckWaived: true, faceDetectorsOff: false }),
      ),
    );
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    const waived = await screen.findByTestId('identity-waived');
    await waitFor(() => expect(waived).toHaveTextContent(IDENTITY_COPY.waivedFaceOn));
  });

  it('FR-403: a double click on send uploads once', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    const send = await screen.findByRole('button', { name: /send my photos/i });
    await user.dblClick(send);
    await screen.findByTestId('identity-received');
    expect(
      seen.filter((r) => r.method === 'POST' && r.url.endsWith('/session/identity')),
    ).toHaveLength(1);
  });

  it('FR-403: the camera is stopped once the selfie is accepted', async () => {
    await signIn();
    const { deps, stopped } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    expect(stopped).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /send my photos/i })).toBeInTheDocument();
  });

  it('FR-403: an upload URL that is not https is refused (only the mock URL is allowed with mocks on)', async () => {
    await signIn();
    const { presignSchema } = await import('@/features/candidate-flow/wire');
    const base = {
      method: 'PUT',
      headers: {},
      name: 'identity/1/id-01.jpg',
      attempt: 1,
      expiresAt: 'x',
    };
    expect(presignSchema.safeParse({ ...base, url: 'https://s3.test/x' }).success).toBe(true);
    expect(presignSchema.safeParse({ ...base, url: 'ftp://s3.test/x' }).success).toBe(false);
    expect(presignSchema.safeParse({ ...base, url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('FR-403 D-61: after the submit the page says it is checking, reads the status until it leaves PENDING, then says "received"', async () => {
    await signIn();
    const seen = recordRequests();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    expect(await screen.findByTestId('identity-checking')).toBeInTheDocument();
    expect(await screen.findByTestId('identity-received')).toBeInTheDocument();
    const reads = seen.filter((r) => r.method === 'GET' && r.url.endsWith('/session/identity'));
    expect(reads.length).toBeGreaterThanOrEqual(2); // the first read on mount, then at least one poll
  });

  it('TC-033 D-05 NFR-05: MANUAL_REVIEW is shown as "received", never as a failure or a score', async () => {
    await signIn(MOCK_TOKENS.manualReview);
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    expect(await screen.findByTestId('identity-received')).toHaveTextContent(
      IDENTITY_COPY.received,
    );
    expect(document.body.textContent).not.toMatch(
      /score|similarity|confidence|\bfail(ed|ure)?\b|not match|mismatch/i,
    );
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('FR-403 D-61: UPLOAD_NOT_FOUND (the PUT had not landed) repeats the submit with the same names', async () => {
    await signIn();
    const submits: { idImageName: string; selfieName: string }[] = [];
    let first = true;
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/identity`, async ({ request }) => {
        submits.push((await request.clone().json()) as { idImageName: string; selfieName: string });
        if (first) {
          first = false;
          return HttpResponse.json({ code: 'UPLOAD_NOT_FOUND' }, { status: 409 });
        }
        return undefined;
      }),
    );
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    expect(await screen.findByTestId('identity-received')).toBeInTheDocument();
    expect(submits).toHaveLength(2);
    expect(submits[1]).toEqual(submits[0]);
  });

  it('FR-403 D-61: names the server cannot use (IDENTITY_NAME_INVALID) ask for both photos again', async () => {
    await signIn();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/identity`, () =>
        HttpResponse.json({ code: 'IDENTITY_NAME_INVALID' }, { status: 400 }),
      ),
    );
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/take both photos again/i);
    expect(await screen.findByRole('heading', { name: /photo of your id/i })).toBeInTheDocument();
  });

  it('FR-403 D-61: coming back while the check is PENDING shows "checking" and then the result, without asking for photos', async () => {
    await signIn();
    let reads = 0;
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/identity`, () => {
        reads += 1;
        return HttpResponse.json({
          attempt: 1,
          status: reads < 3 ? 'PENDING' : 'PASSED',
          canRetry: false,
        });
      }),
    );
    const { deps } = fakeDeps();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    expect(await screen.findByTestId('identity-checking')).toBeInTheDocument();
    expect(await screen.findByTestId('identity-received')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /turn on camera/i })).not.toBeInTheDocument();
  });

  it('FR-403 D-61: a status already WAIVED or checked on arrival skips the photos', async () => {
    await signIn();
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/identity`, () =>
        HttpResponse.json({ attempt: 1, status: 'MANUAL_REVIEW', canRetry: false }),
      ),
    );
    const { deps } = fakeDeps();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    expect(await screen.findByTestId('identity-received')).toBeInTheDocument();
  });

  it('FR-403: nothing is kept in browser storage', async () => {
    await signIn();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    await screen.findByTestId('identity-received');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('NFR-06: no axe violations on the capture, review, received and waived screens', async () => {
    await signIn();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await screen.findByRole('button', { name: /turn on camera/i });
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /turn on camera/i }));
    await screen.findByText('Place your ID here');
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /take photo of my id/i }));
    await user.click(await screen.findByRole('button', { name: /use this photo, next: selfie/i }));
    await screen.findByTestId('liveness-prompt');
    expect(await axe(container)).toHaveNoViolations();
    for (let i = 0; i < 3; i += 1) {
      await user.click(
        await screen.findByRole('button', { name: /done, (next prompt|last step)/i }),
      );
    }
    await user.click(await screen.findByRole('button', { name: /take selfie/i }));
    await user.click(await screen.findByRole('button', { name: /use this selfie/i }));
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /send my photos/i }));
    await screen.findByTestId('identity-received');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('NFR-06: no axe violations on the waived screen', async () => {
    await signIn(MOCK_TOKENS.waived);
    const { deps } = fakeDeps();
    const { container } = renderWithQuery(
      <IdentityStep pollMs={5} deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await screen.findByTestId('identity-waived');
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
