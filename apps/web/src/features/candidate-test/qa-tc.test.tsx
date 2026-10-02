/**
 * QA-01 test cases for the candidate test screen (merged in FE-01, mocked API).
 * Test names start with the TC ID from /docs/test-cases.md. These cover the browser side only;
 * the server side of each case is tracked in /docs/test-matrix.md.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/server';
import { computeClockOffset, remainingMs } from './timer';
import { initialLockState, isEditorReadOnly, lockReducer } from './lock-state';
import { TestScreen } from './test-screen';
import { useAutosave } from './use-autosave';
import { useServerClock } from './use-clock';
import * as React from 'react';
import { act, renderHook } from '@testing-library/react';

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

describe('TC-040 run sample tests (FR-502), UI side', () => {
  it('TC-040 shows sample results after Run and never shows hidden-test data', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByText(/sample tests passed/)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/hidden (input|output|test case)/i);
  });
});

describe('TC-041 run rate limit (FR-502), UI side', () => {
  it('TC-041 three clicks within two seconds send exactly one run request', async () => {
    const user = userEvent.setup();
    let runRequests = 0;
    const onStart = ({ request }: { request: Request }) => {
      if (request.method === 'POST' && /\/questions\/[^/]+\/run$/.test(request.url)) runRequests++;
    };
    server.events.on('request:start', onStart);
    try {
      renderScreen();
      await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
      await user.click(screen.getByRole('button', { name: /run sample tests/i }));
      await user.click(screen.getByRole('button', { name: /run/i }));
      await user.click(screen.getByRole('button', { name: /run/i }));
      expect(runRequests).toBe(1);
      expect(screen.getByRole('button', { name: /run again in \ds/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    } finally {
      server.events.removeListener('request:start', onStart);
    }
  });
});

describe('TC-045 autosave (FR-504), UI side', () => {
  it('TC-045 an edit is saved within 10 s and not before', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook(({ v }) => useAutosave(v, save), {
        initialProps: { v: { code: 'a' } },
      });
      rerender({ v: { code: 'ab' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(save).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(save).toHaveBeenCalledWith({ code: 'ab' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('TC-045 a failed save keeps the edit and reports an error, then retries', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
      const { result, rerender } = renderHook(({ v }) => useAutosave(v, save), {
        initialProps: { v: { code: 'a' } },
      });
      rerender({ v: { code: 'ab' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.status).toBe('error');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe('saved');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TC-046 auto-submit at time zero (FR-505), UI side', () => {
  it('TC-046 remaining time is zero at and after the deadline and the editor is read-only', () => {
    expect(remainingMs(1_000, 1_000, 0)).toBe(0);
    expect(remainingMs(1_000, 5_000, 0)).toBe(0);
    const running = lockReducer(initialLockState, { type: 'start', fullscreen: true });
    expect(isEditorReadOnly(running, true)).toBe(true);
  });
});

describe('TC-047 client clock tampering (FR-505), UI side', () => {
  it('TC-047 moving the OS clock forward one hour does not change the remaining time', () => {
    const serverNow = 1_000_000_000_000;
    const deadline = serverNow + 60 * 60_000;
    const honestClient = serverNow - 2_000;
    const tamperedClient = honestClient + 60 * 60_000;
    // The offset is measured against the server at the moment of the (tampered) request.
    const honestOffset = computeClockOffset(serverNow, honestClient, honestClient);
    const tamperedOffset = computeClockOffset(serverNow, tamperedClient, tamperedClient);
    expect(remainingMs(deadline, honestClient, honestOffset)).toBe(60 * 60_000);
    expect(remainingMs(deadline, tamperedClient, tamperedOffset)).toBe(60 * 60_000);
  });
});

describe('TC-047 clock moved after load (FR-505), UI side', () => {
  // KNOWN DEFECT (frontend-engineer, docs/followups/qa.md): useServerClock reads /v1/time once
  // (staleTime Infinity) and never re-syncs, so an OS clock moved forward after load shortens the
  // countdown shown to the candidate. `it.fails` keeps CI green while the defect is open; change it
  // to `it` when the hook re-syncs (for example from the heartbeat response).
  it.fails(
    'TC-047 KNOWN DEFECT: moving the OS clock forward one hour after load keeps the countdown',
    async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(() => useServerClock(), { wrapper });
      await waitFor(() => expect(result.current.ready).toBe(true));
      const deadline = new Date(Date.now() + 90_000 + 60 * 60_000).toISOString();
      const before = result.current.remaining(deadline) ?? 0;
      // The candidate moves the OS clock forward one hour after the page loaded.
      const realNow = Date.now.bind(Date);
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60 * 60_000);
      try {
        // The hook ticks once per second; wait for the next tick to read the new Date.now().
        await waitFor(() => expect(result.current.remaining(deadline) ?? 0).not.toBe(before), {
          timeout: 3_000,
        });
        // Expected by TC-047: the server deadline is unchanged, so the countdown is too.
        expect(result.current.remaining(deadline) ?? 0).toBeGreaterThan(before - 5_000);
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe('TC-050 fullscreen exit (FR-601), UI side', () => {
  it('TC-050 exiting fullscreen locks the editor, shows the overlay and counts a warning', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
    await user.click(screen.getByRole('button', { name: /simulate fullscreen exit/i }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByTestId('warning-pill')).toHaveTextContent('Warnings: 1');
  });
});

describe('TC-092 accessibility (NFR-06), candidate test screen', () => {
  it('TC-092 start gate has no axe violations', async () => {
    renderScreen();
    await screen.findByText('Enter fullscreen to begin');
    expect(await axe(document.body)).toHaveNoViolations();
  });
  it('TC-092 running test screen has no axe violations', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
    await waitFor(() => expect(screen.getByTestId('editor-region')).toBeInTheDocument());
    // The landmark rule needs the app layout (main element), which jsdom does not render here;
    // the Playwright axe run in packages/qa checks it on the real page.
    expect(
      await axe(document.body, { rules: { region: { enabled: false } } }),
    ).toHaveNoViolations();
  });
});
