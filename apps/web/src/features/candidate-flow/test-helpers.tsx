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
import { clearCandidateCredentials } from './session-store';

/**
 * Shared test setup for the candidate flow. Call `useCandidateServer()` at the top of a describe
 * block. The handlers are the PROVISIONAL mocks in src/mocks/candidate.
 */
export const server = setupServer(
  ...createCandidateHandlers(),
  http.get(`${apiBaseUrl}/v1/health`, () => HttpResponse.json({ status: 'ok' })),
);

export function useCandidateServer(): void {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  beforeEach(() => {
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
    let body: unknown = null;
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
  await user.click(await screen.findByRole('button', { name: /email me a one-time code/i }));
  const input = await screen.findByLabelText(/6-digit code/i);
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
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name })).toHaveFocus());
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
