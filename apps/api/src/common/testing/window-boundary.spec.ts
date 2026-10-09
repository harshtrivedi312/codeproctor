import { awaitSafeWindow } from './window-boundary';

describe('awaitSafeWindow (test helper for fixed-window rate limits)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('FR-103: returns at once when more than the safe margin is left in the window', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-09T17:30:00.000Z') });
    await expect(awaitSafeWindow(3600, 30_000)).resolves.toBeUndefined();
  });

  it('FR-103: waits past the boundary when under the safe margin is left', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-09T17:59:50.000Z') });
    let done = false;
    const p = awaitSafeWindow(3600, 30_000).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(9_000);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1_200);
    await p;
    expect(done).toBe(true);
    expect(Date.now() % 3_600_000).toBeLessThan(5_000); // now in the next window
  });
});
