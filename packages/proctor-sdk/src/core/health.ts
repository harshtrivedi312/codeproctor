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

/** At most `max` code points (never splits a surrogate pair). */
export function cutDetail(s: string, max: number = FLAG_DETAIL_MAX): string {
  const cp = Array.from(s);
  return cp.length <= max ? s : cp.slice(0, max).join('');
}

function conforming(f: CapabilityFlag): CapabilityFlag | null {
  if (!FLAG_ID_RE.test(f.id)) return null; // never send an id the route would refuse
  if (f.detail === undefined) return { id: f.id, status: f.status };
  return { id: f.id, status: f.status, detail: cutDetail(f.detail) };
}

/** Worst first: UNSUPPORTED and DENIED, then UNVERIFIABLE, then SUPPORTED. */
const rank = (s: CapabilityFlag['status']): number =>
  s === 'UNSUPPORTED' || s === 'DENIED' ? 0 : s === 'UNVERIFIABLE' ? 1 : 2;

const STREAMS = new Set(['SCREEN', 'WEBCAM', 'AUDIO', 'ROOM_SCAN']);
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/**
 * Copies only the known numeric fields of the app's recorder health ("counts only"): the stream
 * name is limited to the known streams, everything else is dropped.
 */
export function sanitizeRecorder(r: unknown): HeartbeatRecorderHealth | undefined {
  if (typeof r !== 'object' || r === null) return undefined;
  const src = r as Record<string, unknown>;
  const streams: HeartbeatStreamHealth[] = [];
  if (Array.isArray(src['streams'])) {
    for (const raw of src['streams'].slice(0, 8) as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      const stream = s['stream'];
      const nums = [
        count(s['segment']),
        count(s['lastSeq']),
        count(s['bufferedChunks']),
        count(s['bufferedBytes']),
        count(s['droppedChunks']),
        count(s['droppedBytes']),
      ];
      if (typeof stream !== 'string' || !STREAMS.has(stream) || nums.some((n) => n === undefined)) {
        continue;
      }
      const [segment, lastSeq, bufferedChunks, bufferedBytes, droppedChunks, droppedBytes] =
        nums as number[];
      streams.push({
        stream,
        segment: segment as number,
        lastSeq: lastSeq as number,
        bufferedChunks: bufferedChunks as number,
        bufferedBytes: bufferedBytes as number,
        droppedChunks: droppedChunks as number,
        droppedBytes: droppedBytes as number,
      });
    }
  }
  const out: HeartbeatRecorderHealth = { streams };
  const sc = count(src['seqConflicts']);
  const si = count(src['staleIdentityLosses']);
  const hs = count(src['heldStreams']);
  if (sc !== undefined) out.seqConflicts = sc;
  if (si !== undefined) out.staleIdentityLosses = si;
  if (hs !== undefined) out.heldStreams = hs;
  return out;
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

  /** The server asked for the full set again (ADR 0013 `resyncCapabilities`). */
  forceFull(): void {
    this.lastFullAt = -Infinity;
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
    // Invalid ids are filtered BEFORE the cap so they cannot crowd out valid flags.
    const sent: CapabilityFlag[] = [];
    const sentRaw: CapabilityFlag[] = [];
    const candidates = [...ids]
      .map((id) => this.flags.get(id))
      .filter((f): f is CapabilityFlag => {
        if (f === undefined) return false;
        if (FLAG_ID_RE.test(f.id)) return true;
        sentRaw.push(f); // cleared on commit, never sent
        return false;
      })
      .sort((a, b) => rank(a.status) - rank(b.status));
    for (const f of candidates) {
      if (sent.length >= MAX_HEARTBEAT_FLAGS) break;
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
