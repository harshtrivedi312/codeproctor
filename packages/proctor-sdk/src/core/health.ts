import type { CapabilityFlag } from './types';

/** ADR 0013 section 5.3: capability flags are `^[a-z][a-z0-9-]{1,47}$` with a detail of at most 128. */
export const FLAG_ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
export const FLAG_DETAIL_MAX = 128;
/** The route accepts at most this many flags per beat. */
export const MAX_HEARTBEAT_FLAGS = 32;
/** A changed flag is sent on the first beat after the change; the full set again every 5 minutes. */
export const FLAG_RESEND_MS = 5 * 60_000;

export interface HeartbeatStreamHealth {
  stream: string;
  segment: number;
  lastSeq: number;
  bufferedChunks: number;
  bufferedBytes: number;
  droppedChunks: number;
  droppedBytes: number;
}

export interface HeartbeatRecorderHealth {
  streams: HeartbeatStreamHealth[];
  /** Counts only: chunks whose identity collided, held chunks dropped on a counter refresh, streams on hold. */
  seqConflicts?: number;
  staleIdentityLosses?: number;
  heldStreams?: number;
}

export interface HeartbeatQueueHealth {
  pendingEventBatches: number;
  pendingKeystrokeBatches: number;
  rejectedBatches: number;
}

/** Optional body of `POST /candidate/session/heartbeat` (ADR 0013 section 5.3). */
export interface HeartbeatBody {
  capabilities?: CapabilityFlag[];
  recorder?: HeartbeatRecorderHealth;
  queue?: HeartbeatQueueHealth;
}

/** What the app plugs in through `ProctorSessionConfig.getHealth`. Counts only, never content. */
export interface HealthSnapshot {
  recorder?: HeartbeatRecorderHealth | null;
}

/** The server's answer to a beat (ADR 0013 section 5.3). */
export interface HeartbeatState {
  status: 'IN_PROGRESS' | 'PAUSED';
  serverTime?: string;
  deadlineAt?: string;
  sectionDeadlineAt?: string | null;
  pauseReasons?: string[];
}

/** A renewed candidate token: passed to the app through `onToken`, never stored or logged. */
export interface TokenRenewal {
  sessionToken: string;
  sessionTokenExpiresAt: string;
}

function conforming(f: CapabilityFlag): CapabilityFlag | null {
  if (!FLAG_ID_RE.test(f.id)) return null; // never send an id the route would refuse
  if (f.detail === undefined) return { id: f.id, status: f.status };
  return { id: f.id, status: f.status, detail: f.detail.slice(0, FLAG_DETAIL_MAX) };
}

/**
 * Keeps the latest flag per id and decides what the next beat carries: flags that changed since the
 * last acknowledged beat, or everything every 5 minutes (so a restarted server view heals). A flag
 * is only marked as sent once a beat was acknowledged.
 */
export class FlagReporter {
  private readonly flags = new Map<string, CapabilityFlag>();
  private readonly dirty = new Set<string>();
  /** Flags still owed in the current full resend (a full set can need several beats). */
  private readonly fullPending = new Set<string>();
  private lastFullAt = -Infinity;

  record(f: CapabilityFlag): void {
    this.flags.set(f.id, f);
    this.dirty.add(f.id);
  }

  all(): CapabilityFlag[] {
    return [...this.flags.values()];
  }

  /**
   * The flags for the next beat (at most 32; not-SUPPORTED first) and a `commit()` to call when
   * the beat was acknowledged.
   */
  take(nowMs: number = Date.now()): { flags: CapabilityFlag[]; commit(): void } {
    if (this.fullPending.size === 0 && nowMs - this.lastFullAt >= FLAG_RESEND_MS) {
      for (const id of this.flags.keys()) this.fullPending.add(id);
      if (this.fullPending.size === 0) this.lastFullAt = nowMs;
    }
    const ids = new Set([...this.dirty, ...this.fullPending]);
    const candidates = [...ids]
      .map((id) => this.flags.get(id))
      .filter((f): f is CapabilityFlag => f !== undefined)
      .sort((a, b) => Number(a.status === 'SUPPORTED') - Number(b.status === 'SUPPORTED'));
    const sent: CapabilityFlag[] = [];
    const sentRaw: CapabilityFlag[] = [];
    for (const f of candidates) {
      if (sentRaw.length >= MAX_HEARTBEAT_FLAGS) break;
      const c = conforming(f);
      if (c) sent.push(c);
      sentRaw.push(f);
    }
    return {
      flags: sent,
      commit: () => {
        const wasFull = this.fullPending.size > 0;
        for (const f of sentRaw) {
          // A flag that changed again while the beat was in flight stays dirty.
          if (this.flags.get(f.id) === f) this.dirty.delete(f.id);
          this.fullPending.delete(f.id);
        }
        if (wasFull && this.fullPending.size === 0) this.lastFullAt = nowMs;
      },
    };
  }
}
