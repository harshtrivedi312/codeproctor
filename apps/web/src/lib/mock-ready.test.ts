import { afterEach, describe, expect, it, vi } from 'vitest';

describe('FR-505 mockingReady has a timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('FR-505 resolves after the timeout when the mock worker never reports ready', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', 'enabled');
    vi.useFakeTimers();
    vi.resetModules();
    const { mockingReady, MOCK_READY_TIMEOUT_MS } = await import('./mock-ready');
    let done = false;
    void mockingReady.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(MOCK_READY_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it('FR-505 resolves at once when mocking is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKING', '');
    vi.resetModules();
    const { mockingReady } = await import('./mock-ready');
    await expect(mockingReady).resolves.toBeUndefined();
  });
});
