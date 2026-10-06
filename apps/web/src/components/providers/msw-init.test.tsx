/** Mock worker start guards (frontend step-1 follow-up 1, FU-FEB-03). Mock-only code, no TC ID. */
import { render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn<() => Promise<void>>();
const toastError = vi.fn();
const markReady = vi.fn();

vi.mock('@/mocks/browser', () => ({ worker: { start: (): Promise<void> => start() } }));
vi.mock('sonner', () => ({ toast: { error: (m: string): void => void toastError(m) } }));
vi.mock('@/lib/mock-ready', () => ({ markMockingReady: (): void => void markReady() }));

async function load() {
  vi.resetModules();
  return (await import('./msw-init')).MswInit;
}

describe('FR-505 MswInit starts the mock worker safely', () => {
  beforeEach(() => {
    start.mockReset();
    toastError.mockReset();
    markReady.mockReset();
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('FR-505 starts once under StrictMode and marks mocking ready', async () => {
    start.mockResolvedValue(undefined);
    const MswInit = await load();
    render(
      <React.StrictMode>
        <MswInit />
      </React.StrictMode>,
    );
    await vi.waitFor(() => expect(markReady).toHaveBeenCalled());
    expect(start).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('FR-505 a failed worker.start() shows a toast and still marks mocking ready', async () => {
    start.mockRejectedValue(new Error('no service worker'));
    const MswInit = await load();
    render(<MswInit />);
    await vi.waitFor(() => expect(markReady).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not start/i));
  });

  it('FR-505 does nothing when mocking is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', '');
    const MswInit = await load();
    render(<MswInit />);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
  });
});
