import type { Detector, DetectorContext } from '../core/types';

export type ScreenShareOutcome =
  | { ok: true; stream: MediaStream; surface: string | null }
  | { ok: false; reason: 'WRONG_SURFACE' | 'DENIED' | 'UNSUPPORTED' };

type DisplayMedia = Pick<MediaDevices, 'getDisplayMedia'>;

/**
 * FR-604: the whole screen must be shared (displaySurface === 'monitor') and the share must
 * stay alive. A window or tab share is stopped right away (WRONG_SURFACE); an ended track logs
 * SCREEN_SHARE_STOPPED and locks the test until request() succeeds again (SCREEN_SHARE_RESUMED).
 * Browsers that do not report displaySurface (Firefox, Safari) get an UNVERIFIABLE capability
 * flag instead of a pass.
 *
 * getDisplayMedia needs a user gesture, so request() is called by the UI, never by start().
 */
export class ScreenShareMonitor implements Detector {
  readonly id = 'screen-share';
  private ctx: DetectorContext | null = null;
  private stream: MediaStream | null = null;
  private everShared = false;
  private lost = false;

  constructor(
    private readonly media: DisplayMedia | undefined = typeof navigator === 'undefined'
      ? undefined
      : navigator.mediaDevices,
  ) {}

  start(ctx: DetectorContext): void {
    this.ctx = ctx;
    const supported = typeof this.media?.getDisplayMedia === 'function';
    ctx.setCapability({
      id: 'screen-share',
      status: supported ? 'SUPPORTED' : 'UNSUPPORTED',
    });
    ctx.setLock({ reason: 'SCREEN_SHARE', locked: true });
  }

  get currentStream(): MediaStream | null {
    return this.stream;
  }

  async request(): Promise<ScreenShareOutcome> {
    const ctx = this.ctx;
    if (!ctx) return { ok: false, reason: 'UNSUPPORTED' };
    ctx.assertConsent();
    if (typeof this.media?.getDisplayMedia !== 'function') {
      return { ok: false, reason: 'UNSUPPORTED' };
    }
    let stream: MediaStream;
    try {
      stream = await this.media.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
    } catch {
      ctx.setCapability({ id: 'screen-share', status: 'DENIED' });
      return { ok: false, reason: 'DENIED' };
    }
    const track = stream.getVideoTracks()[0];
    const surface =
      (track?.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface ??
      null;
    if (surface !== null && surface !== 'monitor') {
      stream.getTracks().forEach((t) => t.stop());
      ctx.emit('SCREEN_SHARE_STOPPED', { reason: 'WRONG_SURFACE' });
      return { ok: false, reason: 'WRONG_SURFACE' };
    }
    if (surface === null) {
      ctx.setCapability({
        id: 'screen-share-surface',
        status: 'UNVERIFIABLE',
        detail: 'This browser does not report which surface was shared.',
      });
    }
    this.stream = stream;
    track?.addEventListener('ended', () => this.onEnded(stream), { once: true });
    if (this.lost) ctx.emit('SCREEN_SHARE_RESUMED', {});
    this.everShared = true;
    this.lost = false;
    ctx.setLock({ reason: 'SCREEN_SHARE', locked: false });
    return { ok: true, stream, surface };
  }

  private onEnded(stream: MediaStream): void {
    const ctx = this.ctx;
    if (!ctx || stream !== this.stream) return; // we stopped it ourselves
    this.stream = null;
    this.lost = true;
    ctx.measure('screen-share', () => {
      ctx.emit('SCREEN_SHARE_STOPPED', { reason: 'TRACK_ENDED' });
      ctx.setLock({ reason: 'SCREEN_SHARE', locked: true });
    });
  }

  get hasShared(): boolean {
    return this.everShared;
  }

  stop(): void {
    const s = this.stream;
    this.stream = null; // clear first so the ended handler stays quiet
    s?.getTracks().forEach((t) => t.stop());
    this.ctx = null;
  }
}
