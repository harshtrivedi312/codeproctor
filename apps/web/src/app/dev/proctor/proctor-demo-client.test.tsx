import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopDemo = vi.fn(() => Promise.resolve());
const mountProctorDemo = vi.fn((...args: [HTMLElement, unknown]) => ({ stop: stopDemo, args }));
const mountCalibrationPanel = vi.fn(() => ({ stop: vi.fn() }));
vi.mock('@codeproctor/proctor-sdk', () => ({ mountProctorDemo, mountCalibrationPanel }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}', { status: 503 }))),
  );
  sessionStorage.clear();
});

describe('ProctorDemoClient (FR-601..610 demo, TC-063)', () => {
  it('TC-063: mounts the SDK demo against the same-origin mock API and cleans up on unmount', async () => {
    const { ProctorDemoClient } = await import('./proctor-demo-client');
    const { unmount } = render(<ProctorDemoClient />);
    await waitFor(() => expect(mountProctorDemo).toHaveBeenCalledTimes(1));
    const opts = mountProctorDemo.mock.calls[0]?.[1] as Record<string, string>;
    expect(opts.apiBase).toBe('/dev/proctor/api');
    expect(opts.modelBaseUrl).toBe('/dev-proctor-models');
    expect(opts.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    unmount();
    expect(stopDemo).toHaveBeenCalled();
  });

  it('TC-063: keeps the session id across a reload of the tab so IndexedDB batches resume', async () => {
    const { ProctorDemoClient } = await import('./proctor-demo-client');
    const first = render(<ProctorDemoClient />);
    await waitFor(() => expect(mountProctorDemo).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<ProctorDemoClient />);
    await waitFor(() => expect(mountProctorDemo).toHaveBeenCalledTimes(2));
    const ids = mountProctorDemo.mock.calls.map((c) => (c[1] as { sessionId: string }).sessionId);
    expect(ids[0]).toBe(ids[1]);
  });
});
