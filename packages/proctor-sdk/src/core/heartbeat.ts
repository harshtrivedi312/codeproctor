/** Heartbeat every 10 s (FR-609). Failures are silent: the server logs DISCONNECTED itself. */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  lastOkAt: number | null = null;
  failures = 0;

  constructor(
    private readonly send: () => Promise<boolean>,
    private readonly intervalMs = 10_000,
    private readonly onChange?: (online: boolean) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
  }

  private async beat(): Promise<void> {
    let ok: boolean;
    try {
      ok = await this.send();
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
