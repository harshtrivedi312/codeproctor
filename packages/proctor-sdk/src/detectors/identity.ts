/**
 * Periodic identity re-check (FR-606, ADR 0013 section 5.6, owner decisions C-08 and C-34). The
 * browser only uploads ONE small JPEG every 2 minutes and tells the server its evidence name; the
 * server answers 202 with NO result and writes FACE_MISMATCH itself. So this scheduler never
 * emits or relays FACE_MISMATCH: it only keeps a status for the UI.
 *
 * Privacy (NFR-05): the frame lives in memory for the duration of one tick, is never written to
 * IndexedDB or storage, never logged, and no reference is kept after the upload or stop().
 */

/** What one upload attempt came to (no match result exists on the client). */
export type IdentityRecheckOutcome =
  | { kind: 'ACCEPTED' }
  /** The server will not take re-checks any more: stop quietly (nothing is emitted). */
  | {
      kind: 'STOP';
      reason:
        | 'IDENTITY_CHECK_WAIVED'
        | 'DETECTOR_DISABLED'
        | 'QUOTA_EXCEEDED'
        | 'SESSION_NOT_ACTIVE'
        | 'UNAUTHENTICATED';
    }
  /** Transient (network, 429, 503): try again later, never faster than `retryAfterMs`. */
  | { kind: 'RETRY'; retryAfterMs?: number }
  /** This frame is dropped (400, UPLOAD_NOT_FOUND); the next tick takes a new one. */
  | { kind: 'SKIP' };

export type IdentityRechecker = (frame: Blob, capturedAt: Date) => Promise<IdentityRecheckOutcome>;

export type IdentityStatusState =
  | 'IDLE'
  | 'RUNNING'
  | 'BACKOFF'
  | 'WAIVED'
  | 'DETECTOR_DISABLED'
  | 'QUOTA_EXCEEDED'
  | 'ENDED'
  | 'UNAUTHENTICATED'
  | 'STOPPED';

/** Counts and a state only: no frame, no score, no result. */
export interface IdentityStatus {
  state: IdentityStatusState;
  accepted: number;
  skipped: number;
  retries: number;
}

const MAX_BACKOFF_MS = 10 * 60_000;

export class IdentityScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private notBefore = 0;
  private failures = 0;
  private gen = 0;
  private status: IdentityStatus = { state: 'IDLE', accepted: 0, skipped: 0, retries: 0 };

  constructor(
    private readonly intervalMs: number,
    private readonly captureFrame: () => Promise<Blob | null>,
    private readonly recheck: IdentityRechecker,
    private readonly onStatus?: (s: IdentityStatus) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.status = { ...this.status, state: 'RUNNING' };
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  getStatus(): IdentityStatus {
    return { ...this.status };
  }

  private set(state: IdentityStatusState, patch: Partial<IdentityStatus> = {}): void {
    this.status = { ...this.status, ...patch, state };
    try {
      this.onStatus?.({ ...this.status });
    } catch {
      // a faulty UI callback must not stop the scheduler
    }
  }

  /** Public so the demo and tests can trigger one check. Never overlaps with itself. */
  async tick(): Promise<void> {
    if (this.running || this.isStopped()) return;
    if (this.now() < this.notBefore) return; // backing off (429, 503, network)
    this.running = true;
    const gen = this.gen;
    try {
      let frame: Blob | null = await this.captureFrame();
      if (!frame || gen !== this.gen) return;
      let outcome: IdentityRecheckOutcome;
      try {
        outcome = await this.recheck(frame, new Date(this.now()));
      } catch {
        outcome = { kind: 'RETRY' }; // a failed re-check is not evidence of anything
      } finally {
        frame = null; // no reference to the frame survives the upload
      }
      if (gen !== this.gen) return; // stopped meanwhile
      this.apply(outcome);
    } catch {
      // capture failed: nothing to report
    } finally {
      this.running = false;
    }
  }

  private isStopped(): boolean {
    const s = this.status.state;
    return s !== 'RUNNING' && s !== 'BACKOFF' && s !== 'IDLE';
  }

  private apply(o: IdentityRecheckOutcome): void {
    switch (o.kind) {
      case 'ACCEPTED':
        this.failures = 0;
        this.set('RUNNING', { accepted: this.status.accepted + 1 });
        return;
      case 'SKIP':
        this.set('RUNNING', { skipped: this.status.skipped + 1 });
        return;
      case 'RETRY': {
        this.failures++;
        const exp = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** (this.failures - 1));
        this.notBefore = this.now() + Math.max(exp, Math.min(o.retryAfterMs ?? 0, MAX_BACKOFF_MS));
        this.set('BACKOFF', { retries: this.status.retries + 1 });
        return;
      }
      case 'STOP': {
        const state: IdentityStatusState =
          o.reason === 'IDENTITY_CHECK_WAIVED'
            ? 'WAIVED'
            : o.reason === 'DETECTOR_DISABLED'
              ? 'DETECTOR_DISABLED'
              : o.reason === 'QUOTA_EXCEEDED'
                ? 'QUOTA_EXCEEDED'
                : o.reason === 'SESSION_NOT_ACTIVE'
                  ? 'ENDED'
                  : 'UNAUTHENTICATED';
        this.halt();
        this.set(state);
      }
    }
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.gen++; // an upload in flight is ignored
    this.halt();
    if (!this.isStopped()) this.status = { ...this.status, state: 'STOPPED' };
  }
}
