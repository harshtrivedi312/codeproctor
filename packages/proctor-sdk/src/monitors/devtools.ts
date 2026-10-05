import type { Detector, DetectorContext } from '../core/types';

/**
 * FR-610 devtools heuristic: a docked devtools panel makes the outer window much larger than the
 * viewport. Undocked devtools and some zoom levels are not detected, and a large browser toolbar
 * can false-positive, so this logs MEDIUM evidence for review, never a verdict. The
 * debugger-timing trick is deliberately not used: it freezes the page for the candidate.
 */
export function devtoolsLikelyOpen(
  w: Pick<Window, 'outerWidth' | 'innerWidth' | 'outerHeight' | 'innerHeight'>,
  threshold = 160,
): boolean {
  return w.outerWidth - w.innerWidth > threshold || w.outerHeight - w.innerHeight > threshold;
}

export class DevtoolsMonitor implements Detector {
  readonly id = 'devtools';
  readonly accommodationId = 'DEVTOOLS' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private open = false;

  constructor(
    private readonly win: Window = window,
    private readonly pollMs = 1000,
    private readonly threshold = 160,
  ) {}

  start(ctx: DetectorContext): void {
    ctx.setCapability({
      id: 'devtools',
      status: 'SUPPORTED',
      detail: 'Window-size heuristic only; undocked devtools are not detected.',
    });
    this.timer = setInterval(
      () =>
        ctx.measure('devtools', () => {
          const now = devtoolsLikelyOpen(this.win, this.threshold);
          if (now && !this.open) ctx.emit('DEVTOOLS_OPEN', { heuristic: 'WINDOW_SIZE' });
          this.open = now;
        }),
      this.pollMs,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
