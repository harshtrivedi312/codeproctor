import type { Detector, DetectorContext } from '../core/types';

/**
 * FR-602: tab switch (page hidden) and focus loss (window blurred but still visible) with
 * durations. A tab switch also fires blur; that case is reported once, as TAB_SWITCH.
 */
export class VisibilityMonitor implements Detector {
  readonly id = 'visibility';
  private ctx: DetectorContext | null = null;
  private hiddenAt: number | null = null;
  private blurAt: number | null = null;
  private touchedByHidden = false;

  constructor(
    private readonly doc: Document = document,
    private readonly win: Window = window,
    /** Blur shorter than this is ignored (alert dialogs, focus flicker). */
    private readonly minFocusLossMs = 0,
  ) {}

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.measure('visibility', () => {
      if (this.doc.hidden) {
        this.hiddenAt ??= Date.now();
        this.touchedByHidden = true;
      } else if (this.hiddenAt !== null) {
        const start = this.hiddenAt;
        this.hiddenAt = null;
        ctx.emit('TAB_SWITCH', {}, { occurredAt: new Date(start), durationMs: Date.now() - start });
        this.settle();
      }
    });
  };

  private readonly onBlur = (): void => {
    this.blurAt ??= Date.now();
  };

  private readonly onFocus = (): void => {
    const ctx = this.ctx;
    if (!ctx || this.blurAt === null) return;
    ctx.measure('visibility', () => {
      const start = this.blurAt as number;
      this.blurAt = null;
      const durationMs = Date.now() - start;
      if (!this.touchedByHidden && durationMs >= this.minFocusLossMs) {
        ctx.emit('FOCUS_LOST', {}, { occurredAt: new Date(start), durationMs });
      }
      this.settle();
    });
  };

  private settle(): void {
    if (this.blurAt === null && this.hiddenAt === null) this.touchedByHidden = false;
  }

  start(ctx: DetectorContext): void {
    this.ctx = ctx;
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.win.addEventListener('blur', this.onBlur);
    this.win.addEventListener('focus', this.onFocus);
    ctx.setCapability({ id: 'visibility', status: 'SUPPORTED' });
  }

  stop(): void {
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.win.removeEventListener('blur', this.onBlur);
    this.win.removeEventListener('focus', this.onFocus);
    this.ctx = null;
  }
}
