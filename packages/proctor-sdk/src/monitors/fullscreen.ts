import type { Detector, DetectorContext } from '../core/types';

/** FR-601: fullscreen required; leaving it locks the editor and logs FULLSCREEN_EXIT. */
export class FullscreenMonitor implements Detector {
  readonly id = 'fullscreen';
  private ctx: DetectorContext | null = null;
  private exitedAt: number | null = null;
  private readonly onChange = (): void => this.handle();

  constructor(private readonly doc: Document = document) {}

  start(ctx: DetectorContext): void {
    this.ctx = ctx;
    if (!this.doc.fullscreenEnabled) {
      ctx.setCapability({
        id: 'fullscreen',
        status: 'UNSUPPORTED',
        detail: 'Fullscreen API unavailable (for example iOS Safari).',
      });
      return;
    }
    ctx.setCapability({ id: 'fullscreen', status: 'SUPPORTED' });
    this.doc.addEventListener('fullscreenchange', this.onChange);
    ctx.setLock({ reason: 'FULLSCREEN', locked: !this.doc.fullscreenElement });
  }

  /** Must be called from a user gesture (browser rule). */
  async enter(el: HTMLElement = this.doc.documentElement): Promise<boolean> {
    try {
      await el.requestFullscreen();
      return true;
    } catch {
      return false;
    }
  }

  private handle(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.measure('fullscreen', () => {
      if (!this.doc.fullscreenElement) {
        this.exitedAt = Date.now();
        ctx.emit('FULLSCREEN_EXIT', {});
        ctx.setLock({ reason: 'FULLSCREEN', locked: true });
      } else {
        const durationMs = this.exitedAt === null ? undefined : Date.now() - this.exitedAt;
        this.exitedAt = null;
        ctx.emit('FULLSCREEN_RESTORED', {}, durationMs === undefined ? {} : { durationMs });
        ctx.setLock({ reason: 'FULLSCREEN', locked: false });
      }
    });
  }

  stop(): void {
    this.doc.removeEventListener('fullscreenchange', this.onChange);
    this.ctx = null;
  }
}
