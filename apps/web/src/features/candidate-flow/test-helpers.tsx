import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import {
  MOCK_OTP,
  createCandidateHandlers,
  resetMockCandidateState,
} from '@/mocks/candidate/handlers';
import { router } from '@/test/nav-mock';
import { captureInvitationToken, clearCandidateCredentials } from './session-store';

/**
 * Shared test setup for the candidate flow. Call `setupCandidateServer()` at the top of a describe
 * block. The handlers are the PROVISIONAL mocks in src/mocks/candidate.
 */
export const server = setupServer(
  ...createCandidateHandlers(),
  http.get(`${apiBaseUrl}/v1/health`, () => HttpResponse.json({ status: 'ok' })),
);

export function setupCandidateServer(): void {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  beforeEach(() => {
    router.replace.mockReset();
    // Like Next's router: replacing the route rewrites the address bar and history entry.
    router.replace.mockImplementation((path: string) =>
      window.history.replaceState(null, '', path),
    );
    resetMockCandidateState();
    clearCandidateCredentials();
  });
  afterEach(() => {
    server.resetHandlers();
    clearCandidateCredentials();
    window.history.replaceState(null, '', '/');
  });
  afterAll(() => server.close());
}

export function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Requests seen by the mock server, as "METHOD pathname" plus the JSON body when there is one. */
export function recordRequests(): { method: string; url: string; body: unknown }[] {
  const seen: { method: string; url: string; body: unknown }[] = [];
  server.events.on('request:start', async ({ request }) => {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }
    seen.push({ method: request.method, url: request.url, body });
  });
  return seen;
}

/** Sends the code and enters the OTP, as a candidate would. */
export async function passOtp(user: ReturnType<typeof userEvent.setup>, code = MOCK_OTP) {
  const slow = { timeout: 15_000 };
  await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }, slow));
  const input = await screen.findByLabelText(/6-digit code/i, undefined, slow);
  await user.type(input, code);
  await user.click(screen.getByRole('button', { name: /check code/i }));
}

/** Fakes a scrollable box in jsdom, which has no layout. */
export function fakeScrollBox(el: HTMLElement, scrollHeight = 2000, clientHeight = 400): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
}

export async function expectHeadingFocused(name: RegExp): Promise<void> {
  // Query again on every try: the heading may be replaced while a step finishes loading.
  // 15 s: under a loaded CI runner a step (the consent text renders markdown) can take a while.
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name })).toHaveFocus(), {
    timeout: 15_000,
  });
}

/** No camera, microphone or screen request may happen: used for TC-030 and TC-096. */
export function spyOnMedia() {
  const getUserMedia = vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
  const getDisplayMedia = vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, getDisplayMedia, enumerateDevices: vi.fn(() => Promise.resolve([])) },
  });
  return { getUserMedia, getDisplayMedia };
}

/** Production shape: /t/<token> hands the token to memory and the stepper starts at /t/link. */
export function startAtStepper(token: string): void {
  captureInvitationToken(token);
  window.history.replaceState(null, '', '/t/link');
}

/** Stand-in for the monaco editor, which needs a real browser. Use inside vi.mock('next/dynamic'). */
export function editorStub() {
  return function EditorStub(props: {
    value: string;
    readOnly: boolean;
    ariaLabel: string;
    onChange: (v: string) => void;
    onBlocked: (kind: 'paste' | 'drop') => void;
  }) {
    return (
      <>
        <textarea
          aria-label={props.ariaLabel}
          value={props.value}
          readOnly={props.readOnly}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button type="button" onClick={() => props.onBlocked('paste')}>
          simulate paste
        </button>
      </>
    );
  };
}

/** Room scan deps with a fake camera and recorder. `stopped` counts stopped camera tracks. */
export function fakeRoomDeps(upload: 'ok' | 'exists' | 'failed' = 'ok') {
  const stopped = vi.fn();
  const started = vi.fn();
  const stream = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream;
  return {
    stopped,
    started,
    deps: {
      openCamera: () => Promise.resolve(stream),
      startRecording: () => {
        started();
        return {
          stop: () =>
            Promise.resolve({
              blob: new Blob(['webm-bytes'], { type: 'video/webm' }),
              durationMs: 15_000,
              startedAt: new Date('2026-10-05T10:00:00Z'),
            }),
        };
      },
      upload: () => Promise.resolve(upload),
    },
  };
}

/**
 * Browser storage written by this app must hold nothing. The proctor SDK keeps one counter per
 * session in localStorage (`codeproctor:eventseq:*`, the next event batch number: no token, key or
 * answer; FU-FEB-45), which is the only entry allowed.
 */
export function storedKeys(): string[] {
  const local = Object.keys(localStorage).filter((k) => !k.startsWith('codeproctor:eventseq:'));
  return [...local, ...Object.keys(sessionStorage)];
}
