/**
 * Run and Finish error handling on the candidate test screen (FR-502, FR-503, FR-504, ADR 0002,
 * TC-040, TC-041, TC-045). Mocked API, with per-test handler overrides.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import * as React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { server } from '@/mocks/server';
import { mockSession } from '@/mocks/data';
import { TestScreen } from './test-screen';
import { useAutosave } from './use-autosave';
import { useServerClock } from './use-clock';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = 'enabled';
});

// Mock mode is on for this file (for the demo controls), but there is no browser worker in jsdom.
vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));

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

async function startDemo() {
  const user = userEvent.setup();
  renderScreen();
  await user.click(await screen.findByRole('button', { name: /continue without fullscreen/i }));
  return user;
}

describe('FR-502 run error handling', () => {
  it('FR-502 a network error on Run shows a fix-it message and the button works again', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/questions/:questionId/run`, () => HttpResponse.error()),
    );
    const user = await startDemo();
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByText(/run could not finish/i)).toBeInTheDocument();
    expect(screen.queryByText('Running…')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /run again in|run sample tests/i }),
    ).toBeInTheDocument();
  });

  it('TC-041 FR-502 a 429 on Run says to wait 5 seconds', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/questions/:questionId/run`, () =>
        HttpResponse.json({ retryAfterSeconds: 4 }, { status: 429 }),
      ),
    );
    const user = await startDemo();
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByText(/once every 5 seconds/i)).toBeInTheDocument();
    expect(screen.queryByText('Running…')).not.toBeInTheDocument();
  });

  it('FR-502 a 500 on Run is not treated as a result', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/questions/:questionId/run`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );
    const user = await startDemo();
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    expect(await screen.findByText(/run could not finish/i)).toBeInTheDocument();
    expect(screen.queryByText(/sample tests passed/i)).not.toBeInTheDocument();
  });

  it('FR-502 a run result stays with the question that was run, even if the candidate switches mid-run', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/questions/:questionId/run`, async () => {
        await gate;
        return HttpResponse.json({
          outcome: 'completed' as const,
          tests: [],
          stdout: '',
          stderr: '',
        });
      }),
    );
    const user = await startDemo();
    await user.click(screen.getByRole('button', { name: /run sample tests/i }));
    await user.click(screen.getByRole('button', { name: /question 2/i }));
    release();
    await act(async () => {
      await delay(50);
    });
    const output = screen.getByRole('region', { name: 'Output' });
    expect(within(output).getByText(/press run to try your code/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /question 1/i }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Output' })).queryByText(/press run to try/i),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('FR-301 ADR 0002 finish section error handling', () => {
  async function openFinishDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Finish section' }));
    return screen.findByRole('dialog');
  }

  it('FR-301 ADR 0002 a failed finish (500) is not marked finished and can be retried', async () => {
    let calls = 0;
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/sections/:sectionId/finish`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: 'boom' }, { status: 500 })
          : HttpResponse.json({ finishedAt: new Date().toISOString(), nextSectionId: null });
      }),
    );
    const user = await startDemo();
    const dialog = await openFinishDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /not finished|nothing changed/i,
    );
    expect(screen.queryByText(/finished and cannot be reopened/i)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/finished and cannot be reopened/i)).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('FR-301 ADR 0002 a network error on finish keeps the section open and retryable', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/sections/:sectionId/finish`, () =>
        HttpResponse.error(),
      ),
    );
    const user = await startDemo();
    const dialog = await openFinishDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /could not reach the server/i,
    );
    expect(screen.queryByText(/finished and cannot be reopened/i)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('FR-301 ADR 0002 a 409 SESSION_PAUSED is not shown as finished', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/sections/:sectionId/finish`, () =>
        HttpResponse.json({ code: 'SESSION_PAUSED' }, { status: 409 }),
      ),
    );
    const user = await startDemo();
    const dialog = await openFinishDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/paused|nothing changed/i);
    expect(screen.queryByText(/finished and cannot be reopened/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'false');
  });

  it('FR-301 ADR 0002 a failed re-read keeps the test on screen with the editor and drafts', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/sections/:sectionId/finish`, () =>
        HttpResponse.error(),
      ),
    );
    const user = await startDemo();
    await user.type(screen.getByLabelText('Code editor'), 'KEEPME');
    const dialog = await openFinishDialog(user);
    server.use(http.get(`${apiBaseUrl}/v1/candidate/session`, () => HttpResponse.error()));
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not confirm/i);
    expect(screen.queryByText(/we could not load your test/i)).not.toBeInTheDocument();
    expect(screen.getByText(/backend engineer screening/i)).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Code editor').value).toContain('KEEPME');
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'false');
  });

  it('FR-301 ADR 0002 a confirmed finish shows the banner first and opens the next section only on Continue', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/sections/:sectionId/finish`, () =>
        HttpResponse.error(),
      ),
    );
    const user = await startDemo();
    const dialog = await openFinishDialog(user);
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session`, () =>
        HttpResponse.json({
          ...mockSession,
          section: { ...mockSession.section, id: 'sec-2', title: 'Next part', position: 2 },
        }),
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    expect(
      await screen.findByText(/Coding section is finished and cannot be reopened/i),
    ).toBeInTheDocument();
    // Still the finished section, read-only; the next section is not open yet.
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
    await user.click(screen.getByRole('button', { name: /continue to the next section/i }));
    expect(await screen.findByText(/Section 2 of 2: Next part/i)).toBeInTheDocument();
    expect(screen.queryByText(/finished and cannot be reopened/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'false');
  });

  it('FR-301 the error is cleared when the dialog is opened again', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/sections/:sectionId/finish`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );
    const user = await startDemo();
    const dialog = await openFinishDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: /keep working/i }));
    const again = await openFinishDialog(user);
    expect(within(again).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('FR-301 ADR 0002 FR-504 finish does not go ahead when the latest answers could not be saved', async () => {
    let finishCalls = 0;
    server.use(
      http.put(`${apiBaseUrl}/v1/candidate/questions/:questionId/draft`, () =>
        HttpResponse.json({ message: 'down' }, { status: 503 }),
      ),
      http.post(`${apiBaseUrl}/v1/candidate/sections/:sectionId/finish`, () => {
        finishCalls += 1;
        return HttpResponse.json({ finishedAt: new Date().toISOString(), nextSectionId: null });
      }),
    );
    const user = await startDemo();
    await user.type(screen.getByLabelText('Code editor'), 'x');
    const dialog = await openFinishDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Finish section' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not save/i);
    expect(finishCalls).toBe(0);
  });
});

describe('FR-504 autosave flush', () => {
  it('FR-504 flush waits for an in-flight save and saves again when the value changed meanwhile', async () => {
    const releases: Array<() => void> = [];
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 60_000), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    let first: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = result.current.flush();
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // The candidate types more while the first save is in flight, then presses Run.
    rerender({ v: 3 });
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      second = result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    act(() => {
      releases[0]?.();
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(3);
    await act(async () => {
      releases[1]?.();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });
    expect(result.current.status).toBe('saved');
  });

  it('FR-504 flush resolves false when the save fails', async () => {
    const save = vi.fn().mockRejectedValue(new Error('offline'));
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 60_000), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    let ok = true;
    await act(async () => {
      ok = await result.current.flush();
    });
    expect(ok).toBe(false);
    expect(result.current.status).toBe('error');
  });
});

describe('TC-047 server clock re-sync (FR-505)', () => {
  function clockWrapper() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, wrapper };
  }

  it('TC-047 a server time seen in a response corrects the countdown offset', async () => {
    const { wrapper } = clockWrapper();
    // The server's reading is chosen by the test; the assertions do not depend on the mock offset.
    const serverAtLoad = Date.now() + 30_000;
    server.use(
      http.get(`${apiBaseUrl}/v1/time`, () =>
        HttpResponse.json({ serverNow: new Date(serverAtLoad).toISOString() }),
      ),
    );
    const { result } = renderHook(() => useServerClock(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const deadline = new Date(serverAtLoad + 10 * 60_000).toISOString();
    const before = result.current.remaining(deadline) ?? 0;
    expect(before).toBeGreaterThan(9 * 60_000);
    // A save response says the server is two minutes ahead of what we assumed.
    const t = performance.now();
    act(() => {
      result.current.syncFromServer(new Date(serverAtLoad + 120_000).toISOString(), t, t);
    });
    await waitFor(() =>
      expect(before - (result.current.remaining(deadline) ?? 0)).toBeGreaterThan(110_000),
    );
    expect(before - (result.current.remaining(deadline) ?? 0)).toBeLessThan(130_000);
  });

  it('TC-047 a periodic /v1/time re-fetch re-syncs the offset', async () => {
    const { client, wrapper } = clockWrapper();
    const { result } = renderHook(() => useServerClock(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
    const before = result.current.remaining(deadline) ?? 0;
    server.use(
      http.get(`${apiBaseUrl}/v1/time`, () =>
        HttpResponse.json({ serverNow: new Date(Date.now() + 5 * 60_000).toISOString() }),
      ),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: ['server-time'] });
    });
    await waitFor(() =>
      expect(before - (result.current.remaining(deadline) ?? 0)).toBeGreaterThan(200_000),
    );
  });

  it('TC-047 FR-505 when /v1/time cannot be read the editor is paused with a fix-it message', async () => {
    server.use(http.get(`${apiBaseUrl}/v1/time`, () => HttpResponse.error()));
    await startDemo();
    expect(await screen.findByText(/cannot check the time with the server/i)).toBeInTheDocument();
    expect(screen.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
  });

  it('TC-047 an OS clock jump triggers an immediate /v1/time re-fetch', async () => {
    const { wrapper } = clockWrapper();
    let calls = 0;
    server.use(
      http.get(`${apiBaseUrl}/v1/time`, () => {
        calls += 1;
        return HttpResponse.json({ serverNow: new Date().toISOString() });
      }),
    );
    const { result } = renderHook(() => useServerClock(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const afterLoad = calls;
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60 * 60_000);
    try {
      await waitFor(() => expect(calls).toBeGreaterThan(afterLoad), { timeout: 3_000 });
    } finally {
      spy.mockRestore();
    }
  });
});
