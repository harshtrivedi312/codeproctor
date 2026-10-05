/**
 * Periodic identity re-check (FR-606). The browser only sends a selfie frame; matching happens on
 * the server (ADR 0004: it never blocks or rejects the candidate; a mismatch is MEDIUM evidence
 * for a human). The API call is injected because its contract is still open (ARC-03).
 */
export interface IdentityRecheckResult {
  matched: boolean;
  /** Cosine similarity -1..1 as stored in the FACE_MISMATCH payload. */
  similarity?: number;
}
export type IdentityRechecker = (frame: Blob) => Promise<IdentityRecheckResult | null>;

export class IdentityScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly captureFrame: () => Promise<Blob | null>,
    private readonly recheck: IdentityRechecker,
    private readonly onMismatch: (r: IdentityRecheckResult) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  /** Public so the demo and tests can trigger one check. Never overlaps with itself. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const frame = await this.captureFrame();
      if (!frame) return;
      const r = await this.recheck(frame);
      if (r && !r.matched) this.onMismatch(r);
    } catch {
      // A failed re-check is not evidence of anything.
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
