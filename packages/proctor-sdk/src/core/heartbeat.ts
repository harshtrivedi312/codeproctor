import type { EndReason } from './batch-queue';
import type { HeartbeatResult } from './transport';

export interface HeartbeatHooks {
  /** After `authLostAfter` consecutive 401 answers (default 3) the beat stops; `resume()` continues. */
  onAuthLost?: (code: string) => void;
  authLostAfter?: number;
}

/** Heartbeat every 10 s (FR-609). Failures are silent: the server logs DISCONNECTED itself. */
export class Heartbeat {
  /** Set once the server said the session is over; the heartbeat then stops for good. */
  endedBy: EndReason | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private auth401 = 0;
  private authHold = false;
  private current: Promise<void> | null = null;
  lastOkAt: number | null = null;
  failures = 0;

  constructor(
    private readonly send: () => Promise<HeartbeatResult>,
    private readonly intervalMs = 10_000,
    private readonly onChange?: (online: boolean) => void,
    private readonly onEnded?: (reason: EndReason) => void,
    private readonly hooks: HeartbeatHooks = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.endedBy = null;
    this.authHold = false;
    this.auth401 = 0;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
  }

  /** True while the last beat was acknowledged and none failed since (and the heartbeat is live). */
  get online(): boolean {
    return (
      !this.stopped &&
      this.endedBy === null &&
      !this.authHold &&
      this.failures === 0 &&
      this.lastOkAt !== null
    );
  }

  /**
   * One beat right now (shared with a beat already in flight); true when the server answered. After
   * stop(), the end of the session or a 401 hold it sends nothing and answers false: a probe must
   * never beat with a token the server refused or after the session was purged.
   */
  async beatNow(): Promise<boolean> {
    if (this.stopped || this.endedBy !== null || this.authHold) return false;
    await this.beat();
    return this.online;
  }

  /** The app refreshed the token after repeated 401: beat again. */
  resume(): void {
    if (this.stopped || this.endedBy !== null) return;
    this.auth401 = 0;
    if (!this.authHold) return;
    this.authHold = false;
    if (!this.timer) this.timer = setInterval(() => void this.beat(), this.intervalMs);
    void this.beat();
  }

  private beat(): Promise<void> {
    this.current ??= this.beatOnce().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async beatOnce(): Promise<void> {
    let ok: boolean;
    try {
      const r = await this.withTimeout(this.send());
      if (this.stopped) return; // a late answer after stop(): nothing to report
      if (typeof r === 'object') {
        if ('ended' in r) {
          // SESSION_NOT_ACTIVE or taken over: stop beating and tell the session once.
          if (this.endedBy === null) {
            this.endedBy = r.ended;
            this.stop();
            this.safely(() => this.onEnded?.(r.ended));
          }
          return;
        }
        if ('busy' in r) {
          // 429: the server answered, so we are online; nothing was acknowledged.
          this.auth401 = 0;
          this.lastOkAt = Date.now();
          const wasOffline = this.failures > 0;
          this.failures = 0;
          if (wasOffline) this.safely(() => this.onChange?.(true));
          return;
        }
        if ('auth' in r) {
          // Reachable but refused: not "offline". After N in a row stop and let the app refresh.
          this.auth401++;
          if (this.auth401 >= (this.hooks.authLostAfter ?? 3) && !this.authHold) {
            this.authHold = true;
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
            this.safely(() => this.hooks.onAuthLost?.(r.auth));
          }
          return;
        }
        this.auth401 = 0;
        ok = true;
      } else {
        this.auth401 = 0;
        ok = r;
      }
    } catch {
      ok = false;
    }
    const wasOnline = this.failures === 0;
    if (ok) {
      this.lastOkAt = Date.now();
      this.failures = 0;
    } else {
      this.failures++;
    }
    const isOnline = this.failures === 0;
    if (wasOnline !== isOnline) this.safely(() => this.onChange?.(isOnline));
  }

  /** A transport that never settles must not block every later beat: no answer in time is a failure. */
  private withTimeout(p: Promise<HeartbeatResult>): Promise<HeartbeatResult> {
    const ms = Math.min(this.intervalMs * 0.8, 8000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HeartbeatResult>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    p.catch(() => undefined);
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // a faulty callback must not look like a lost connection
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
