import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_CONFIG, IDENTITY_FRAME_WIDTH_PX, IDENTITY_RECHECK_INTERVAL_MS } from './config';
import { scaledSize } from './evidence';
import { IdentityScheduler } from './identity';

/** Owner decision C-08: one 640 px JPEG every 2 minutes for the identity re-check (FR-606). */
afterEach(() => vi.useRealTimers());

describe('identity re-check constants (FR-606, C-08)', () => {
  it('FR-606 C-08: the named constants are 640 px and 120 000 ms and are the defaults', () => {
    expect(IDENTITY_FRAME_WIDTH_PX).toBe(640);
    expect(IDENTITY_RECHECK_INTERVAL_MS).toBe(120_000);
    expect(DEFAULT_AI_CONFIG.snapshotMaxWidth).toBe(IDENTITY_FRAME_WIDTH_PX);
    expect(DEFAULT_AI_CONFIG.identityIntervalMs).toBe(IDENTITY_RECHECK_INTERVAL_MS);
  });

  it('FR-606 C-08: a 1280x720 or 640x360 webcam frame is captured exactly 640 px wide', () => {
    expect(scaledSize(1280, 720, IDENTITY_FRAME_WIDTH_PX)).toEqual({ width: 640, height: 360 });
    expect(scaledSize(1920, 1080, IDENTITY_FRAME_WIDTH_PX)).toEqual({ width: 640, height: 360 });
    expect(scaledSize(640, 360, IDENTITY_FRAME_WIDTH_PX)).toEqual({ width: 640, height: 360 });
  });

  it('FR-606 C-08 (documented gap): the capture never scales up, so a narrower webcam gives a narrower frame', () => {
    expect(scaledSize(320, 180, IDENTITY_FRAME_WIDTH_PX)).toEqual({ width: 320, height: 180 });
  });

  it('FR-606 C-08: the scheduler runs one re-check per 120 s, not more', async () => {
    vi.useFakeTimers();
    const recheck = vi.fn(() => Promise.resolve({ matched: true }));
    const s = new IdentityScheduler(
      DEFAULT_AI_CONFIG.identityIntervalMs,
      () => Promise.resolve(new Blob(['frame'])),
      recheck,
      () => undefined,
    );
    s.start();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(recheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000 * 2);
    expect(recheck).toHaveBeenCalledTimes(3);
    s.stop();
  });
});
