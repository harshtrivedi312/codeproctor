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
import type { IdentityDeps } from './capture';
import { IDENTITY_COPY, IdentityStep } from './identity-step';

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
    renderWithQuery(<IdentityStep deps={deps} onDone={onDone} onSessionEnded={vi.fn()} />);

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

    const presigns = seen.filter((r) => r.url.endsWith('/evidence/presign'));
    expect(presigns.map((r) => (r.body as { purpose: string }).purpose)).toEqual([
      'ID_IMAGE',
      'SELFIE',
    ]);
    const submit = seen.find((r) => r.url.endsWith('/identity'));
    // Names issued by the presign, never object keys or URLs chosen by the browser.
    expect(submit?.body).toMatchObject({
      idImageName: 'id_image-name-1',
      selfieName: 'selfie-name-2',
      liveness: { completed: true },
    });
    expect(JSON.stringify(submit?.body)).not.toContain('http');
  });

  it('FR-403: the camera is stopped once the photos are sent', async () => {
    await signIn();
    const { deps, stopped } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    await screen.findByTestId('identity-received');
    expect(stopped).toHaveBeenCalled();
  });

  it('TC-033: a first attempt that could not be read asks for one retake with tips, and never shows a score', async () => {
    await signIn(MOCK_TOKENS.lowConfidence);
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
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
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
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
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
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
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /turn on camera/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/allow the camera/i);
  });

  it('FR-403: an upload that fails keeps the photos and offers to send again', async () => {
    await signIn();
    let ok = false;
    const { deps } = fakeDeps({ upload: () => Promise.resolve(ok) });
    const user = userEvent.setup();
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
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
    renderWithQuery(<IdentityStep deps={deps} onDone={onDone} onSessionEnded={vi.fn()} />);
    const waived = await screen.findByTestId('identity-waived');
    expect(waived).toHaveTextContent(IDENTITY_COPY.waived);
    expect(waived).toHaveTextContent(IDENTITY_COPY.waivedFaceOn);
    expect(screen.queryByRole('button', { name: /turn on camera/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(onDone).toHaveBeenCalled();
    expect(seen.some((r) => r.url.endsWith('/evidence/presign'))).toBe(false);
  });

  it('ADR 0015: a waiver set after the page loaded (409 IDENTITY_CHECK_WAIVED) switches to the waived text', async () => {
    await signIn();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    const { server } = await import('@/features/candidate-flow/test-helpers');
    const { http, HttpResponse } = await import('msw');
    const { apiBaseUrl } = await import('@/lib/env');
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/evidence/presign`, () =>
        HttpResponse.json({ code: 'IDENTITY_CHECK_WAIVED' }, { status: 409 }),
      ),
    );
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await capturePhotos(user);
    await user.click(await screen.findByRole('button', { name: /send my photos/i }));
    expect(await screen.findByTestId('identity-waived')).toBeInTheDocument();
  });

  it('FR-403: nothing is kept in browser storage', async () => {
    await signIn();
    const { deps } = fakeDeps();
    const user = userEvent.setup();
    renderWithQuery(<IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
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
      <IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
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
      <IdentityStep deps={deps} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await screen.findByTestId('identity-waived');
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
