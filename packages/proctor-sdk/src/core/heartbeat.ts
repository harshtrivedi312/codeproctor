import type { EndReason } from './batch-queue';

/** Heartbeat every 10 s (FR-609). Failures are silent: the server logs DISCONNECTED itself. */
export class Heartbeat {
  /** Set once the server said the session is over; the heartbeat then stops for good. */
  endedBy: EndReason | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  lastOkAt: number | null = null;
  failures = 0;

  constructor(
    private readonly send: () => Promise<boolean | { ended: EndReason }>,
    private readonly intervalMs = 10_000,
    private readonly onChange?: (online: boolean) => void,
    private readonly onEnded?: (reason: EndReason) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.endedBy = null;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
  }

  private async beat(): Promise<void> {
    let ok: boolean;
    try {
      const r = await this.send();
      if (typeof r === 'object') {
        // SESSION_NOT_ACTIVE or taken over: stop beating and tell the session once.
        if (this.endedBy === null && !this.stopped) {
          this.endedBy = r.ended;
          this.stop();
          try {
            this.onEnded?.(r.ended);
          } catch {
            // a faulty callback must not look like a lost connection
          }
        }
        return;
      }
      ok = r;
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
    if (wasOnline !== isOnline) this.onChange?.(isOnline);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
