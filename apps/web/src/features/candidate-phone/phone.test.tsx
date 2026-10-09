import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { apiBaseUrl } from '@/lib/env';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { setSessionToken } from '@/features/candidate-flow/session-store';
import {
  recordRequests,
  renderWithQuery,
  server,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { PhoneCamera } from './phone-camera';
import { PhoneHandoff } from './phone-handoff';
import {
  capturePhoneToken,
  clearPhoneToken,
  getPhoneToken,
  phoneLinkUrl,
  readPhoneTokenFromHash,
} from './phone-store';
import { PhoneStep } from './phone-step';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

setupCandidateServer();
beforeEach(() => {
  replace.mockReset();
  clearPhoneToken();
});

async function signIn(token: string): Promise<void> {
  const r = await candidateApi.startSession(token, MOCK_OTP);
  if (!r.ok) throw new Error('mock sign-in failed');
  setSessionToken(r.data.sessionToken);
}

describe('phone step on the computer (FR-405)', () => {
  it('FR-405: a test that needs no side camera moves on by itself', async () => {
    await signIn(MOCK_TOKENS.consented);
    const onDone = vi.fn();
    const known = vi.fn();
    renderWithQuery(<PhoneStep onDone={onDone} onRequiredKnown={known} onSessionEnded={vi.fn()} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(known).toHaveBeenCalledWith(false);
  });

  it('FR-405: when the server has no side-camera route (404) the step moves on and asks for nothing', async () => {
    // A STRICT session: without the 404 override the step would show the QR screen.
    await signIn(MOCK_TOKENS.strict);
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/side-camera`, () =>
        HttpResponse.json({ code: 'NOT_FOUND' }, { status: 404 }),
      ),
    );
    const onDone = vi.fn();
    const known = vi.fn();
    renderWithQuery(<PhoneStep onDone={onDone} onRequiredKnown={known} onSessionEnded={vi.fn()} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(known).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phone-paired')).not.toBeInTheDocument();
  });

  it('FR-405: a server error (500) or a network error still shows the retry, not a silent skip', async () => {
    await signIn(MOCK_TOKENS.consented);
    for (const answer of [
      () => HttpResponse.json({ code: 'INTERNAL' }, { status: 500 }),
      () => HttpResponse.error(),
    ]) {
      server.use(http.get(`${apiBaseUrl}/v1/candidate/session/side-camera`, answer));
      const onDone = vi.fn();
      const view = renderWithQuery(<PhoneStep onDone={onDone} onSessionEnded={vi.fn()} />);
      expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(onDone).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('FR-405: a 401 on the status call still ends the session', async () => {
    await signIn(MOCK_TOKENS.consented);
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/side-camera`, () =>
        HttpResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
      ),
    );
    const onDone = vi.fn();
    const ended = vi.fn();
    renderWithQuery(<PhoneStep onDone={onDone} onSessionEnded={ended} />);
    await waitFor(() => expect(ended).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('FR-405: a STRICT test shows a QR code and a text link on request, and waits', async () => {
    await signIn(MOCK_TOKENS.strict);
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PhoneStep pollMs={40} onDone={onDone} onSessionEnded={vi.fn()} />);
    expect(await screen.findByAltText(/qr code to scan with your phone/i)).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/png/),
    );
    expect(screen.getByTestId('phone-waiting')).toBeInTheDocument();
    expect(screen.queryByLabelText(/link for your phone/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /i cannot scan: show the link/i }));
    const link = screen.getByLabelText<HTMLInputElement>(/link for your phone/i);
    // The token is in the fragment, so no server ever receives it as a path or query.
    expect(link.value).toMatch(/\/t\/phone\/enter#[A-Za-z0-9_-]{20,}$/);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument();
  });

  it('FR-405: when the phone pairs, the step shows "connected" and lets the candidate continue', async () => {
    await signIn(MOCK_TOKENS.strict);
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PhoneStep pollMs={40} onDone={onDone} onSessionEnded={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /i cannot scan/i }));
    const link = screen.getByLabelText<HTMLInputElement>(/link for your phone/i).value;
    // The phone presents the token from the fragment.
    const token = link.split('#')[1] ?? '';
    const paired = await candidateApi.pairSideCamera(token);
    expect(paired.ok).toBe(true);
    expect(await screen.findByTestId('phone-paired')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('FR-405: the link is single use: a second pairing is refused, "New QR code" gives another', async () => {
    await signIn(MOCK_TOKENS.strict);
    const user = userEvent.setup();
    renderWithQuery(<PhoneStep pollMs={5000} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /i cannot scan/i }));
    const first = screen.getByLabelText<HTMLInputElement>(/link for your phone/i).value;
    await user.click(screen.getByRole('button', { name: /new qr code/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/link for your phone/i)).not.toBeInTheDocument(),
    );
    await user.click(await screen.findByRole('button', { name: /i cannot scan/i }));
    const second = screen.getByLabelText<HTMLInputElement>(/link for your phone/i).value;
    expect(second).not.toBe(first);
    const token = second.split('#')[1] ?? '';
    expect((await candidateApi.pairSideCamera(token)).ok).toBe(true);
    const again = await candidateApi.pairSideCamera(token);
    expect(again.ok).toBe(false);
  });

  it('FR-405: the link token never goes in a URL or a request path from the computer', async () => {
    await signIn(MOCK_TOKENS.strict);
    const seen = recordRequests();
    const user = userEvent.setup();
    renderWithQuery(<PhoneStep pollMs={5000} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /i cannot scan/i }));
    const token =
      screen.getByLabelText<HTMLInputElement>(/link for your phone/i).value.split('#')[1] ?? '';
    expect(token.length).toBeGreaterThan(20);
    for (const r of seen) expect(r.url).not.toContain(token);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('NFR-06: no axe violations on the QR screen and the connected screen', async () => {
    await signIn(MOCK_TOKENS.strict);
    const { container } = renderWithQuery(
      <PhoneStep pollMs={40} onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await screen.findByAltText(/qr code/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('phone page (FR-405)', () => {
  const stream = (stop = vi.fn()) => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream;

  it('FR-405: pairs with the link token from memory, previews, and forgets the token', async () => {
    await signIn(MOCK_TOKENS.strict);
    const link = await candidateApi.createSideCameraLink();
    if (!link.ok) throw new Error('link failed');
    capturePhoneToken(link.data.linkToken);
    const stop = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PhoneCamera deps={{ openCamera: () => Promise.resolve(stream(stop)) }} />);
    await user.click(screen.getByRole('button', { name: /turn on the camera and connect/i }));
    expect(await screen.findByTestId('phone-connected')).toBeInTheDocument();
    expect(getPhoneToken()).toBeNull();
    expect(screen.getByLabelText(/live preview of your phone camera/i)).toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('FR-405: without a link token the page says to scan the QR code again, and asks for no camera', () => {
    const openCamera = vi.fn();
    renderWithQuery(<PhoneCamera deps={{ openCamera }} />);
    expect(
      screen.getByRole('heading', { level: 1, name: /needs the qr code from your computer/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(openCamera).not.toHaveBeenCalled();
  });

  it('FR-405: an expired or used link explains how to get a new code and stops the camera', async () => {
    capturePhoneToken('mock-phone-link-token-not-issued-00');
    const stop = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PhoneCamera deps={{ openCamera: () => Promise.resolve(stream(stop)) }} />);
    await user.click(screen.getByRole('button', { name: /turn on the camera and connect/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/i);
    expect(stop).toHaveBeenCalled();
  });

  it('FR-405: a camera that will not start says how to fix it', async () => {
    capturePhoneToken('mock-phone-link-token-aaaaaaaaaaaa');
    const user = userEvent.setup();
    renderWithQuery(
      <PhoneCamera
        deps={{ openCamera: () => Promise.reject(new DOMException('x', 'NotAllowedError')) }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /turn on the camera and connect/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/allow the camera for this page/i);
  });

  it('NFR-06: no axe violations on the phone page', async () => {
    capturePhoneToken('mock-phone-link-token-aaaaaaaaaaaa');
    const { container } = renderWithQuery(<PhoneCamera />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('phone link hand-off (FR-405, ADR 0003)', () => {
  it('FR-405: reads #<token> into memory and calls router.replace with /t/phone', async () => {
    window.history.replaceState(null, '', '/t/phone/enter#mock-phone-link-token-aaaaaaaaaaaa');
    render(<PhoneHandoff />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/t/phone'));
    expect(getPhoneToken()).toBe('mock-phone-link-token-aaaaaaaaaaaa');
  });

  it('FR-405: an odd fragment stores nothing, and the link URL keeps the token in the fragment', () => {
    window.history.replaceState(null, '', '/t/phone/enter#nope');
    expect(readPhoneTokenFromHash()).toBeNull();
    expect(phoneLinkUrl('https://x.test', 'abc')).toBe('https://x.test/t/phone/enter#abc');
  });
});

describe('phone fixes from review (FR-405)', () => {
  it('FR-405: pressing connect twice quickly opens one camera', async () => {
    capturePhoneToken('mock-phone-link-token-aaaaaaaaaaaa');
    const open = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) =>
          setTimeout(
            () => resolve({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
            30,
          ),
        ),
    );
    const user = userEvent.setup();
    renderWithQuery(<PhoneCamera deps={{ openCamera: open }} />);
    await user.dblClick(screen.getByRole('button', { name: /turn on the camera and connect/i }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });

  it('FR-405: an expired link clears the link token from memory', async () => {
    capturePhoneToken('mock-phone-link-token-not-issued-00');
    const user = userEvent.setup();
    renderWithQuery(
      <PhoneCamera
        deps={{
          openCamera: () =>
            Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /turn on the camera and connect/i }));
    await screen.findByRole('alert');
    expect(getPhoneToken()).toBeNull();
  });

  it('FR-405: leaving the phone page forgets the link token', async () => {
    capturePhoneToken('mock-phone-link-token-aaaaaaaaaaaa');
    const view = renderWithQuery(<PhoneCamera />);
    view.unmount();
    await waitFor(() => expect(getPhoneToken()).toBeNull());
  });

  it('FR-405: an ended session while asking for a QR code ends the step', async () => {
    await signIn(MOCK_TOKENS.strict);
    setSessionToken('unknown-session');
    const onSessionEnded = vi.fn();
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/side-camera`, () =>
        HttpResponse.json({ required: true, connected: false }),
      ),
    );
    renderWithQuery(<PhoneStep pollMs={5000} onDone={vi.fn()} onSessionEnded={onSessionEnded} />);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });

  it('FR-405: both sides say the phone video is not recorded yet', async () => {
    await signIn(MOCK_TOKENS.strict);
    renderWithQuery(<PhoneStep pollMs={5000} onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(await screen.findByTestId('phone-waiting')).toHaveTextContent(/not recorded yet/i);
  });

  it('FR-405: a malformed link token from the API is rejected at the boundary', async () => {
    const { sideCameraLinkSchema } = await import('@/features/candidate-flow/wire');
    expect(
      sideCameraLinkSchema.safeParse({ linkToken: 'a'.repeat(30), expiresAt: 'x' }).success,
    ).toBe(true);
    expect(
      sideCameraLinkSchema.safeParse({ linkToken: 'has spaces and / slash 123456', expiresAt: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('phone page, closing while waiting (FR-405)', () => {
  it('FR-405: closing the page while the camera prompt is open switches the camera off', async () => {
    capturePhoneToken('mock-phone-link-token-aaaaaaaaaaaa');
    const stop = vi.fn();
    let resolveCamera: (s: MediaStream) => void = () => undefined;
    const user = userEvent.setup();
    const view = renderWithQuery(
      <PhoneCamera
        deps={{
          openCamera: () =>
            new Promise<MediaStream>((resolve) => {
              resolveCamera = resolve;
            }),
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /turn on the camera and connect/i }));
    view.unmount();
    resolveCamera({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it('FR-405: a spent link switches to the "needs the QR code" view with the reason, and no button', async () => {
    capturePhoneToken('mock-phone-link-token-not-issued-00');
    const user = userEvent.setup();
    renderWithQuery(
      <PhoneCamera
        deps={{
          openCamera: () =>
            Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /turn on the camera and connect/i }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /needs the qr code/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/expired or was already used/i);
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
  });

  it('FR-405: a new valid link replaces an old one', () => {
    capturePhoneToken('mock-phone-link-token-aaaaaaaaaaaa');
    capturePhoneToken('mock-phone-link-token-bbbbbbbbbbbb');
    expect(getPhoneToken()).toBe('mock-phone-link-token-bbbbbbbbbbbb');
    capturePhoneToken('bad token');
    expect(getPhoneToken()).toBe('mock-phone-link-token-bbbbbbbbbbbb');
  });
});
