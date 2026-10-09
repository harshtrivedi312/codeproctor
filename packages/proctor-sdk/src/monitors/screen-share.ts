import type { Detector, DetectorContext } from '../core/types';

export type ScreenShareOutcome =
  | { ok: true; stream: MediaStream; surface: string | null }
  | { ok: false; reason: 'WRONG_SURFACE' | 'DENIED' | 'UNSUPPORTED' };

type DisplayMedia = Pick<MediaDevices, 'getDisplayMedia'>;

/**
 * Asks for the whole-screen share WITHOUT a started session (the pre-start system check runs
 * before a key exists, so no monitor has a context yet). Call it on a user gesture. Consent is
 * checked first through `assertConsent` (it throws when consent is not recorded). A wrong surface
 * is stopped here; a share the browser does not describe comes back with `surface: null`. Pass
 * `surfaceOf(outcome)` to `runSystemCheck`, and after the session started hand the outcome to
 * `ScreenShareMonitor.adopt(outcome)` so the candidate is not asked a second time.
 */
export async function requestScreenShare(
  assertConsent: () => void,
  media: DisplayMedia | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.mediaDevices,
): Promise<ScreenShareOutcome> {
  assertConsent();
  if (typeof media?.getDisplayMedia !== 'function') return { ok: false, reason: 'UNSUPPORTED' };
  let stream: MediaStream;
  try {
    stream = await media.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 5, max: 10 } },
      audio: false,
    });
  } catch {
    return { ok: false, reason: 'DENIED' };
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    // A share without a video track is no share: never "unverified".
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, reason: 'DENIED' };
  }
  const surface = track.getSettings()?.displaySurface ?? null;
  if (surface !== null && surface !== 'monitor') {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, reason: 'WRONG_SURFACE' };
  }
  return { ok: true, stream, surface };
}

/**
 * The app owns a pre-start share until `ScreenShareMonitor.adopt()` takes it over. If the system
 * check is blocked or fails, or the candidate leaves before the start, release it here.
 */
export function releaseScreenShare(outcome: ScreenShareOutcome): void {
  if (outcome.ok) outcome.stream.getTracks().forEach((t) => t.stop());
}

/**
 * Maps the outcome of `request()` to the system-check `devices.screenShare` value, never a fake
 * pass: a verified whole-screen share is MONITOR, a share whose surface the browser does not
 * report is UNVERIFIABLE, a wrong surface is OTHER. A refused or unsupported request has no
 * surface at all (null): the app handles it (the share is missing, not "other").
 */
export function surfaceOf(
  outcome: ScreenShareOutcome,
): 'MONITOR' | 'OTHER' | 'UNVERIFIABLE' | null {
  if (outcome.ok) {
    if (outcome.surface === null) return 'UNVERIFIABLE';
    return outcome.surface === 'monitor' ? 'MONITOR' : 'OTHER';
  }
  return outcome.reason === 'WRONG_SURFACE' ? 'OTHER' : null;
}

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
    const got = await requestScreenShare(() => ctx.assertConsent(), this.media);
    if (this.ctx !== ctx) {
      // stop() ran while the picker was open: nothing may keep this stream or unlock the test.
      releaseScreenShare(got);
      return { ok: false, reason: 'UNSUPPORTED' };
    }
    if (!got.ok) {
      if (got.reason === 'DENIED') ctx.setCapability({ id: 'screen-share', status: 'DENIED' });
      if (got.reason === 'WRONG_SURFACE')
        ctx.emit('SCREEN_SHARE_STOPPED', { reason: 'WRONG_SURFACE' });
      return got;
    }
    return this.accept(ctx, got.stream, got.surface);
  }

  /**
   * Takes over a share the app obtained BEFORE the session started (pre-start system check, see
   * `requestScreenShare`) so the candidate is not asked twice. Only a successful outcome is
   * adopted; anything else is returned unchanged and nothing happens.
   */
  adopt(outcome: ScreenShareOutcome): ScreenShareOutcome {
    const ctx = this.ctx;
    if (!outcome.ok) return outcome;
    if (!ctx) {
      outcome.stream.getTracks().forEach((t) => t.stop()); // not started: nothing may keep a device
      return { ok: false, reason: 'UNSUPPORTED' };
    }
    try {
      ctx.assertConsent();
    } catch (err) {
      releaseScreenShare(outcome); // no consent: keep no device
      throw err;
    }
    return this.accept(ctx, outcome.stream, outcome.surface);
  }

  private accept(
    ctx: DetectorContext,
    stream: MediaStream,
    surface: string | null,
  ): ScreenShareOutcome {
    const track = stream.getVideoTracks()[0];
    // A share that already ended (the candidate pressed "Stop sharing" between the check and the
    // start) or has no video is not a share: keep the lock and ask again.
    if (!track || stream.getVideoTracks().some((t) => t.readyState === 'ended')) {
      stream.getTracks().forEach((t) => t.stop());
      ctx.setCapability({ id: 'screen-share', status: 'DENIED' });
      return { ok: false, reason: 'DENIED' };
    }
    if (surface !== null && surface !== 'monitor') {
      stream.getTracks().forEach((t) => t.stop());
      ctx.emit('SCREEN_SHARE_STOPPED', { reason: 'WRONG_SURFACE' });
      return { ok: false, reason: 'WRONG_SURFACE' };
    }
    if (this.stream && this.stream !== stream) {
      // A different live share is replaced: the old one must not keep capturing.
      const old = this.stream;
      this.stream = null; // clear first so its ended handler stays quiet
      old.getTracks().forEach((t) => t.stop());
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
