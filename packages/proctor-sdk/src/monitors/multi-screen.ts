import type { Detector, DetectorContext } from '../core/types';

interface ScreenDetailsLike {
  screens: readonly unknown[];
}
export interface ScreenLike {
  isExtended?: boolean;
}
export interface WindowLike {
  getScreenDetails?: () => Promise<ScreenDetailsLike>;
  screen: ScreenLike;
}

export type MultiScreenResult =
  | { kind: 'SINGLE' }
  | { kind: 'MULTI'; api: 'WINDOW_MANAGEMENT' | 'SCREEN_IS_EXTENDED'; screenCount?: number }
  | { kind: 'UNSUPPORTED' }
  | { kind: 'DENIED' };

/**
 * FR-605: window.getScreenDetails() where available (counts screens; needs the window-management
 * permission), otherwise screen.isExtended (a boolean, no prompt). If the API is there but the user
 * denied it we fall back to isExtended; with neither, the result is UNSUPPORTED, never SINGLE.
 */
export async function checkMultiScreen(win: WindowLike): Promise<MultiScreenResult> {
  let denied = false;
  if (typeof win.getScreenDetails === 'function') {
    try {
      const details = await win.getScreenDetails();
      const count = details.screens.length;
      return count > 1
        ? { kind: 'MULTI', api: 'WINDOW_MANAGEMENT', screenCount: Math.min(count, 16) }
        : { kind: 'SINGLE' };
    } catch {
      denied = true;
    }
  }
  if (typeof win.screen.isExtended === 'boolean') {
    return win.screen.isExtended
      ? { kind: 'MULTI', api: 'SCREEN_IS_EXTENDED' }
      : { kind: 'SINGLE' };
  }
  return denied ? { kind: 'DENIED' } : { kind: 'UNSUPPORTED' };
}

export class MultiScreenMonitor implements Detector {
  readonly id = 'multi-screen';
  readonly accommodationId = 'MULTI_MONITOR' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private multi = false;
  private stopped = false;

  constructor(
    private readonly win: WindowLike = window as unknown as WindowLike,
    private readonly pollMs = 5000,
  ) {}

  async start(ctx: DetectorContext): Promise<void> {
    this.stopped = false;
    const apply = (r: MultiScreenResult): void =>
      ctx.measure('multi-screen', () => {
        if (r.kind === 'MULTI') {
          if (!this.multi) {
            ctx.emit(
              'MULTI_MONITOR',
              r.screenCount === undefined
                ? { api: r.api }
                : { api: r.api, screenCount: r.screenCount },
            );
          }
          this.multi = true;
        } else {
          this.multi = false;
        }
      });
    const first = await checkMultiScreen(this.win);
    if (this.stopped) return;
    if (first.kind === 'UNSUPPORTED' || first.kind === 'DENIED') {
      const denied = first.kind === 'DENIED';
      ctx.setCapability({
        id: 'multi-screen',
        status: denied ? 'DENIED' : 'UNSUPPORTED',
        detail: 'Cannot tell how many screens are connected.',
      });
      ctx.emit('DETECTOR_UNAVAILABLE', {
        detector: 'MULTI_MONITOR',
        reason: denied ? 'PERMISSION_DENIED' : 'UNSUPPORTED',
      });
      return;
    }
    ctx.setCapability({ id: 'multi-screen', status: 'SUPPORTED' });
    apply(first);
    this.timer = setInterval(() => {
      void checkMultiScreen(this.win).then((r) => {
        if (!this.stopped) apply(r);
      });
    }, this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
