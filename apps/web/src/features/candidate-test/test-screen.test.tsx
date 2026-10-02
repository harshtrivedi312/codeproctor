import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/server';
import { fakeRun } from '@/mocks/handlers';
import { mockSession } from '@/mocks/data';
import { FinishSectionDialog, FullscreenLockOverlay } from './overlays';
import { TestScreen } from './test-screen';

// Monaco needs a real browser; a textarea stands in for it in jsdom.
vi.mock('next/dynamic', () => ({
  default: () =>
    function EditorStub(props: {
      value: string;
      readOnly: boolean;
      onChange: (v: string) => void;
    }) {
      return (
        <textarea
          aria-label="Code editor"
          value={props.value}
          readOnly={props.readOnly}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestScreen />
    </QueryClientProvider>,
  );
}

describe('candidate test screen (mocked, FR-501 to FR-505)', () => {
  it('shows the demo banner, both timers seeded from the server, and the start gate', async () => {
    renderScreen();
    expect(await screen.findByText('Enter fullscreen to begin')).toBeInTheDocument();
    expect(screen.getByTestId('demo-banner')).toHaveTextContent('Demo — mocked data');
    await waitFor(() =>
      expect(screen.getByRole('timer', { name: 'Test time left', hidden: true })).toHaveTextContent(
        /5\d:\d\d/,
      ),
    );
    expect(
      screen.getByRole('timer', { name: 'Section time left', hidden: true }),
    ).toHaveTextContent(/2[45]:\d\d/);
  });

  it('runs sample tests after the gate, with fake results and a cooldown on the button', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByText(/0 of 3 sample tests passed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run again in \ds/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('locks the editor with an overlay on simulated fullscreen exit and unlocks on re-enter', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
    await user.click(screen.getByRole('button', { name: /simulate fullscreen exit/i }));
    expect(await screen.findByText(/time keeps running/i)).toBeInTheDocument();
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByTestId('warning-pill')).toHaveTextContent('Warnings: 1');
    await user.click(screen.getByRole('button', { name: /re-enter fullscreen/i }));
    await waitFor(() => expect(screen.queryByText(/time keeps running/i)).not.toBeInTheDocument());
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'false');
  });

  it('ADR 0002: finishing a section warns that it cannot be reopened', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
    await user.click(screen.getByRole('button', { name: 'Finish section' }));
    expect(await screen.findByText(/cannot be reopened/i)).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    expect(await screen.findByText(/finished and cannot be reopened/i)).toBeInTheDocument();
  });

  it('lists only the open section questions', async () => {
    renderScreen();
    await screen.findByText('Enter fullscreen to begin');
    const nav = screen.getByRole('navigation', { name: 'Questions in this section', hidden: true });
    expect(nav.querySelectorAll('button')).toHaveLength(mockSession.questions.length);
  });
});

describe('overlays', () => {
  it('lock overlay has no axe violations and says the time keeps running', async () => {
    render(<FullscreenLockOverlay warnings={2} onReenter={() => undefined} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Your time keeps running');
    expect(screen.getByTestId('warning-count')).toHaveTextContent('Warnings so far: 2');
    expect(await axe(document.body)).toHaveNoViolations();
  });
  it('finish dialog has no axe violations', async () => {
    render(
      <FinishSectionDialog
        open
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
        busy={false}
        sectionTitle="Coding"
      />,
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('fake run grading', () => {
  const tests = mockSession.questions[0]?.sampleTests ?? [];
  it('returns a compile error for empty code and a timeout for infinite loops', () => {
    expect(fakeRun('', tests).outcome).toBe('compile_error');
    expect(fakeRun('while True: pass', tests).outcome).toBe('time_limit_exceeded');
  });
  it('passes all samples when code sorts and handles touching ranges', () => {
    const r = fakeRun('ranges.sort(); if a <= b: merge', tests);
    expect(r.tests.every((t) => t.status === 'passed')).toBe(true);
  });
});
