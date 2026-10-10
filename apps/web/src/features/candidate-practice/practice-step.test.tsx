import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
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
import { PracticeStep } from './practice-step';

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

async function signIn(): Promise<void> {
  const r = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
  if (!r.ok) throw new Error('mock sign-in failed');
  setSessionToken(r.data.sessionToken);
}

describe('practice question (FR-406)', () => {
  it('FR-406: says it is untimed, not scored and not saved, and shows the question and editor', async () => {
    await signIn();
    renderWithQuery(<PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(
      await screen.findByRole('heading', { level: 2, name: /practice: add two numbers/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not timed, not scored and nothing here is saved/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Practice code editor')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });

  it('FR-406 TC-041: three quick clicks on Run send one practice run', async () => {
    await signIn();
    const seen = recordRequests();
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    const editor = await screen.findByLabelText('Practice code editor');
    await user.type(editor, 'print(1)');
    const button = screen.getByRole('button', { name: /^run$/i });
    await user.tripleClick(button);
    await screen.findByText(/sample tests passed/i);
    expect(seen.filter((r) => r.url.endsWith('/practice/run'))).toHaveLength(1);
  });

  it('FR-406: Run shows sample test results from the practice route only, and nothing is saved', async () => {
    await signIn();
    const seen = recordRequests();
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    const editor = await screen.findByLabelText('Practice code editor');
    await user.type(editor, 'print(int(input()) + int(input()))');
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByText(/1 of 1 sample tests passed/i)).toBeInTheDocument();
    // No draft, answer, submit, keystroke or event route is ever called for the practice.
    const paths = seen.map((r) => new URL(r.url).pathname);
    expect(paths.some((p) => /draft|answers|submit|keystrokes|events|finish/.test(p))).toBe(false);
    expect(paths.some((p) => p.endsWith('/practice/run'))).toBe(true);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('FR-406 DL-58: a local stub run says "Local stub, not real execution" and shows no pass or fail', async () => {
    await signIn();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/practice/run`, () =>
        HttpResponse.json({
          outcome: 'completed',
          tests: [],
          stdout: '',
          stderr: 'local stub, not real execution',
          stub: true,
          message: 'local stub, not real execution',
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.type(await screen.findByLabelText('Practice code editor'), 'print(1)');
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByTestId('run-stub-notice')).toHaveTextContent(
      /local stub, not real execution/i,
    );
    expect(screen.queryByText(/sample tests passed/i)).not.toBeInTheDocument();
  });

  it('FR-406: runs are spaced like the real test (one per 5 seconds)', async () => {
    await signIn();
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await screen.findByLabelText('Practice code editor');
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    await screen.findByText(/sample tests/i);
    expect(screen.getByRole('button', { name: /run again in \d+ s/i })).toBeDisabled();
  });

  it('FR-406: paste is switched off in the practice too, with a message', async () => {
    await signIn();
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await screen.findByLabelText('Practice code editor');
    await user.click(screen.getByRole('button', { name: /simulate paste/i }));
    expect(screen.getByTestId('practice-blocked')).toHaveTextContent(/pasting is switched off/i);
  });

  it('FR-406: the candidate can carry on whenever they like', async () => {
    await signIn();
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={onDone} onSessionEnded={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /i am ready: continue/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('FR-406: if the practice question cannot load, it can be skipped', async () => {
    await signIn();
    server.use(http.get(`${apiBaseUrl}/v1/candidate/session/practice`, () => HttpResponse.error()));
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={onDone} onSessionEnded={vi.fn()} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: /not available/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /skip the practice/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('FR-406: a run that fails on the network says what to do', async () => {
    await signIn();
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/practice/run`, () => HttpResponse.error()),
    );
    const user = userEvent.setup();
    renderWithQuery(<PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />);
    await screen.findByLabelText('Practice code editor');
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/check your internet connection/i);
  });

  it('NFR-06: no axe violations on the practice step, before and after a run', async () => {
    await signIn();
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <PracticeStep onDone={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    await screen.findByLabelText('Practice code editor');
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    await screen.findByText(/sample tests/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
