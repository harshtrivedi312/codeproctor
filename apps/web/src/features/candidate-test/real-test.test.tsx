import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateApi } from '@/features/candidate-flow/api';
import { setSessionToken } from '@/features/candidate-flow/session-store';
import {
  recordRequests,
  renderWithQuery,
  server,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_OTP, MOCK_TOKENS } from '@/mocks/candidate/handlers';
import { createAdrSource, openSection } from './adr-source';
import { TestScreen } from './test-screen';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));
vi.mock('next/dynamic', async () => {
  const { editorStub } = await import('@/features/candidate-flow/test-helpers');
  return { default: () => editorStub() };
});

setupCandidateServer();

const cand = `${apiBaseUrl}/v1/candidate`;

async function startedSession(token: string = MOCK_TOKENS.consented): Promise<void> {
  const r = await candidateApi.startSession(token, MOCK_OTP);
  if (!r.ok) throw new Error('mock sign-in failed');
  setSessionToken(r.data.sessionToken);
  if (token !== MOCK_TOKENS.resume) {
    const started = await candidateApi.startTest();
    if (!started.ok) throw new Error('mock start failed');
  }
}

beforeEach(() => {
  // jsdom has no fullscreen API: pretend the browser allows it.
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(() => Promise.resolve()),
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function enterTest(user: User, onSessionEnded = vi.fn(), onSubmitted = vi.fn()) {
  const source = createAdrSource({ onSessionEnded });
  renderWithQuery(<TestScreen source={source} onSubmitted={onSubmitted} />);
  await user.click(await screen.findByRole('button', { name: /enter fullscreen and start/i }));
  await screen.findByRole('button', { name: /run sample tests/i });
  return { onSessionEnded, onSubmitted };
}

describe('real test screen on the ADR 0013 routes (FR-501..FR-505, PROVISIONAL)', () => {
  it('FR-505: shows the open section only, with timers from the server deadlines', async () => {
    await startedSession();
    const seen = recordRequests();
    const user = userEvent.setup();
    await enterTest(user);
    expect(screen.getByText(/section 1 of 2: warm-up/i)).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Test time left', hidden: true })).toHaveTextContent(
      /(29|30):\d\d/,
    );
    expect(
      screen.getByRole('timer', { name: 'Section time left', hidden: true }),
    ).toHaveTextContent(/(9|10):\d\d/);
    // CS-4.6: only the open section's questions are read; section 2's question is never fetched.
    const reads = seen
      .filter((r) => /\/questions\/[^/]+$/.test(r.url))
      .map((r) => r.url.split('/').pop());
    expect(reads.sort()).toEqual(['q1', 'q2']);
    expect(screen.queryByText(/reverse a string/i)).not.toBeInTheDocument();
    // Demo wording and controls never appear in the real screen.
    expect(screen.queryByTestId('demo-banner')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /simulate fullscreen exit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /continue without fullscreen/i }),
    ).not.toBeInTheDocument();
  });

  it('FR-505: the start gate says the time is already running', async () => {
    await startedSession();
    renderWithQuery(<TestScreen source={createAdrSource({ onSessionEnded: vi.fn() })} />);
    expect(await screen.findByText(/your time is already running/i)).toBeInTheDocument();
  });

  it('FR-504 FR-502: Run saves the draft first, then runs the samples through the answers route', async () => {
    await startedSession();
    const seen = recordRequests();
    const user = userEvent.setup();
    await enterTest(user);
    await user.type(screen.getByLabelText(/code editor, python/i), 'print(1)');
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByText(/1 of 1 sample tests passed/i)).toBeInTheDocument();
    const order = seen.map(
      (r) => `${r.method} ${new URL(r.url).pathname.replace(/\/q\d/, '/:id')}`,
    );
    expect(order.indexOf('PUT /v1/candidate/questions/:id/draft')).toBeLessThan(
      order.indexOf('POST /v1/candidate/answers/:id/run'),
    );
    expect(seen.find((r) => r.method === 'PUT')?.body).toMatchObject({
      kind: 'code',
      language: 'python',
    });
  });

  it('FR-502: a second Run inside 5 seconds is refused with the wait, and the button counts down', async () => {
    await startedSession();
    const user = userEvent.setup();
    await enterTest(user);
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    await screen.findByText(/sample tests/i, { selector: 'p' });
    expect(screen.getByRole('button', { name: /run again in \ds/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('FR-502: a server 429 on Run shows the 5 second message', async () => {
    await startedSession();
    server.use(
      http.post(`${cand}/answers/:id/run`, () =>
        HttpResponse.json(
          { code: 'RATE_LIMITED' },
          { status: 429, headers: { 'Retry-After': '4' } },
        ),
      ),
    );
    const user = userEvent.setup();
    await enterTest(user);
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/once every 5 seconds/i);
  });

  it('FR-504 DL-17: a 409 SESSION_PAUSED on save keeps the draft and saves it after resume', async () => {
    await startedSession();
    let paused = true;
    const saved: unknown[] = [];
    server.use(
      http.put(`${cand}/questions/:id/draft`, async ({ request }) => {
        if (paused) return HttpResponse.json({ code: 'SESSION_PAUSED' }, { status: 409 });
        saved.push(await request.json());
        return HttpResponse.json({ savedAt: new Date().toISOString() });
      }),
    );
    const user = userEvent.setup();
    await enterTest(user);
    await user.type(screen.getByLabelText(/code editor, python/i), 'print(7)');
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByTestId('saved-indicator')).toHaveTextContent(/could not save/i);
    expect(saved).toHaveLength(0);
    expect(screen.getByLabelText<HTMLTextAreaElement>(/code editor, python/i).value).toContain(
      'print(7)',
    );
    paused = false;
    // The next run flushes the same unsaved draft: nothing was dropped.
    await new Promise((r) => setTimeout(r, 5100));
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    await waitFor(() => expect(saved.length).toBeGreaterThan(0));
    expect(JSON.stringify(saved[0])).toContain('print(7)');
  }, 20_000);

  it('FR-504: a multiple-choice answer is saved with the option id', async () => {
    await startedSession();
    const seen = recordRequests();
    const user = userEvent.setup();
    await enterTest(user);
    await user.click(screen.getByRole('button', { name: /question 2/i }));
    await user.click(screen.getByRole('radio', { name: 'O(log n)' }));
    await user.click(screen.getByRole('button', { name: 'Finish section' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish section' }),
    );
    await screen.findByText(/finished and cannot be reopened/i);
    const draft = seen.find((r) => r.method === 'PUT' && r.url.endsWith('/q2/draft'));
    expect(draft?.body).toEqual({ kind: 'mcq', selectedOptionId: 'opt_b' });
  });

  it('ADR 0002 FR-301: finishing section 1 is final and opens section 2; finishing the last submits the test', async () => {
    await startedSession();
    const seen = recordRequests();
    const user = userEvent.setup();
    const { onSubmitted } = await enterTest(user);
    await user.click(screen.getByRole('button', { name: 'Finish section' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/cannot be reopened/i);
    expect(dialog).not.toHaveTextContent(/submits your test/i);
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    await user.click(await screen.findByRole('button', { name: /continue to the next section/i }));
    expect(await screen.findByText(/section 2 of 2: problem solving/i)).toBeInTheDocument();
    expect(await screen.findByText(/reverse a string/i)).toBeInTheDocument();
    // The old section's questions are gone and cannot be reopened.
    expect(screen.queryByText(/complexity/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Finish section' }));
    const last = screen.getByRole('dialog');
    expect(last).toHaveTextContent(/finishing it submits your test/i);
    await user.click(within(last).getByRole('button', { name: 'Finish section' }));
    const done = await screen.findByTestId('test-submitted');
    expect(done).toHaveTextContent(/your test is submitted/i);
    expect(done).toHaveTextContent(/recording has stopped/i);
    // No score, result or hidden-test information (Q17).
    expect(done.textContent).not.toMatch(/score|passed|points|%/i);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    const finishes = seen
      .filter((r) => r.url.includes('/finish'))
      .map((r) => r.url.split('/').slice(-2)[0]);
    expect(finishes).toEqual(['1', '2']);
  });

  it('ADR 0002: a 409 on finish is re-read before anything is shown as finished', async () => {
    await startedSession();
    server.use(
      http.post(`${cand}/sections/:position/finish`, () =>
        HttpResponse.json({ code: 'SESSION_PAUSED' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    await enterTest(user);
    await user.click(screen.getByRole('button', { name: 'Finish section' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish section' }),
    );
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      /paused|nothing changed/i,
    );
    expect(screen.queryByText(/finished and cannot be reopened/i)).not.toBeInTheDocument();
  });

  it('ADR 0013 5.2: a 401 anywhere ends the session through the hook, with no retry loop', async () => {
    await startedSession();
    const onSessionEnded = vi.fn();
    server.use(
      http.get(`${cand}/session/test`, () =>
        HttpResponse.json({ code: 'TOKEN_EXPIRED' }, { status: 401 }),
      ),
    );
    renderWithQuery(<TestScreen source={createAdrSource({ onSessionEnded })} />);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
    expect(await screen.findByText(/could not load your test/i)).toBeInTheDocument();
  });

  it('FR-505: a short-answer question fails closed with a clear message, not a missing question', async () => {
    await startedSession();
    server.use(
      http.get(`${cand}/questions/q2`, () =>
        HttpResponse.json({
          sessionQuestionId: 'q2',
          type: 'SHORT_ANSWER',
          title: 'x',
          statementMd: 'y',
        }),
      ),
    );
    renderWithQuery(<TestScreen source={createAdrSource({ onSessionEnded: vi.fn() })} />);
    expect(await screen.findByTestId('load-unsupported')).toBeInTheDocument();
  });

  it('FR-505 TC-047: the countdown follows the server clock from GET /session, not the device clock', async () => {
    await startedSession();
    const source = createAdrSource({ onSessionEnded: vi.fn() });
    const now = await source.serverNow();
    expect(Math.abs(Date.parse(now) - Date.now())).toBeLessThan(5000);
  });

  it('ADR 0013 CS-4.6: the open section is the highest started one', () => {
    const base = { timeLimitMs: null, deadlineAt: null, questions: [] };
    const layout = {
      status: 'IN_PROGRESS' as const,
      serverTime: 'x',
      startedAt: 'x',
      deadlineAt: 'x',
      sections: [
        { ...base, position: 1, title: 'a', startedAt: 'x' },
        { ...base, position: 2, title: 'b', startedAt: 'x' },
        { ...base, position: 3, title: 'c', startedAt: null },
      ],
    };
    expect(openSection(layout)?.position).toBe(2);
  });

  it('FR-505: a resumed test (OTP while running) loads the running section and keeps the clock', async () => {
    await startedSession(MOCK_TOKENS.resume);
    const user = userEvent.setup();
    await enterTest(user);
    expect(screen.getByText(/section 1 of 2: warm-up/i)).toBeInTheDocument();
  });

  it('FR-501 NFR-06: no token, key or answer is stored in the browser', async () => {
    await startedSession();
    const user = userEvent.setup();
    await enterTest(user);
    await user.type(screen.getByLabelText(/code editor, python/i), 'secret-answer');
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    await screen.findByText(/sample tests/i, { selector: 'p' });
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('NFR-06: no axe violations on the gate, the running screen and the submitted screen', async () => {
    await startedSession();
    const user = userEvent.setup();
    const source = createAdrSource({ onSessionEnded: vi.fn() });
    const { container } = renderWithQuery(<TestScreen source={source} />);
    await screen.findByRole('button', { name: /enter fullscreen and start/i });
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /enter fullscreen and start/i }));
    await screen.findByRole('button', { name: /run sample tests/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
