import { IdbStore, STORES, padSeq } from '../core/idb';
import { SessionTouch, sweepStaleSessions } from '../core/sweep';
import {
  MAX_BUFFER_BYTES,
  MediaApiError,
  RECORDING_STREAMS,
  contentTypeFor,
  type ChunkRef,
  type MediaApi,
  type PresignedPut,
  type RecorderHealth,
  type RecordingStream,
} from './types';

interface StoredChunk {
  data: ArrayBuffer;
}

/**
 * Key layout: `${sid}:${stream}:${segment}:${seq}:${bytes}:${contentType}:${startedAtMs}:${durationMs}:${f|n}`
 * (segment and seq zero padded so keys sort in recording order; `f` marks the first chunk of a
 * segment). Chunks stored by an earlier SDK version have only the first six parts: they get a
 * start time of "now minus 10 s", a 10 s duration, the bare content type, and are not first.
 */
export function chunkKey(sessionId: string, c: ChunkRef): string {
  return [
    sessionId,
    c.stream,
    padSeq(c.segment),
    padSeq(c.seq),
    c.bytes,
    encodeURIComponent(c.contentType),
    Math.round(c.startedAtMs ?? Date.now() - 10_000),
    Math.round(c.durationMs ?? 10_000),
    c.first ? 'f' : 'n',
  ].join(':');
}

export function parseChunkKey(key: string): ChunkRef | null {
  const parts = key.split(':');
  if (parts.length < 6) return null;
  const [, stream, segment, seq, bytes, , startedAt, duration, first] = parts;
  if (!RECORDING_STREAMS.includes(stream as RecordingStream)) return null;
  const n = (v: string | undefined): number => Number(v);
  if ([segment, seq, bytes].some((v) => !Number.isInteger(n(v)))) return null;
  const st = stream as RecordingStream;
  const modern =
    parts.length >= 9 && Number.isFinite(n(startedAt)) && Number.isInteger(n(duration));
  return {
    stream: st,
    segment: n(segment),
    seq: n(seq),
    bytes: n(bytes),
    contentType: contentTypeFor(st),
    startedAtMs: modern ? n(startedAt) : Date.now() - 10_000,
    durationMs: modern ? Math.min(60_000, Math.max(1, n(duration))) : 10_000,
    first: modern && first === 'f',
  };
}

export interface UploadQueueOptions {
  sessionId: string;
  api: MediaApi;
  store: IdbStore;
  /**
   * Upload one object; defaults to fetch PUT with a timeout. Returns the HTTP status or throws on
   * a network error. `headers` are exactly the ones the presign returned.
   */
  put?: (url: string, body: ArrayBuffer, headers: Record<string, string>) => Promise<number>;
  /** Per PUT timeout for the default `put` (default 30 s). */
  putTimeoutMs?: number;
  /**
   * Reachability probe used while the connection is down (for example the session heartbeat).
   * Without it, one chunk is let through as the probe. No presign is made while the probe fails.
   */
  probe?: () => Promise<boolean>;
  /** The server said the session is over (SESSION_NOT_ACTIVE): uploading stopped, chunks kept. */
  onEnded?: (info: { code?: string }) => void;
  /** A segment's first chunk was refused for good; it is kept and retried slowly. */
  onChunkBlocked?: (info: { code?: string; stream: RecordingStream; segment: number }) => void;
  /** A first chunk was admitted above the buffer cap because only protected chunks remain. */
  onCapExceeded?: () => void;
  /** A first chunk could not be admitted: the per-stream overflow allowance is used up. */
  onSegmentLost?: (info: { stream: RecordingStream; segment: number }) => void;
  /** The presign quota ran out (PRESIGN_QUOTA_EXCEEDED): the cap is per session, waiting may not help. */
  onQuota?: (info: { stream: RecordingStream }) => void;
  /**
   * Called when held chunks were dropped because the counters were refreshed (`releaseHeld`): they
   * carried identities that collide with chunks the server already has. Never carries content.
   */
  onStaleIdentityLoss?: (info: { stream: RecordingStream; chunks: number; bytes: number }) => void;
  /** Called when a chunk's identity collided with a confirmed one (never carries content). */
  onSeqConflict?: (info: { stream: RecordingStream; segment: number }) => void;
  /** Probe timeout (default 15 s): a probe that never answers counts as "still offline". */
  probeTimeoutMs?: number;
  concurrency?: number;
  maxBufferBytes?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitter?: number;
  onHealth?: (h: RecorderHealth) => void;
  /** Called once when IndexedDB stops working and the queue falls back to memory. */
  onStorageDegraded?: (reason: 'OPEN_FAILED' | 'WRITE_FAILED') => void;
  /** Called when IndexedDB writes work again after a degraded period. */
  onStorageRecovered?: () => void;
  /** While degraded, try IndexedDB again at most this often (default 30 s). */
  storageProbeMs?: number;
  /** Max bytes held in memory when IndexedDB is unusable (default 32 MiB). */
  maxMemoryBytes?: number;
  /** Other sessions' leftovers older than this are deleted on start (default 24 h). */
  staleAfterMs?: number;
}

function makeDefaultPut(timeoutMs: number): NonNullable<UploadQueueOptions['put']> {
  return async (url, body, headers) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return (await fetch(url, { method: 'PUT', body, headers, signal: ctl.signal })).status;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Longest wait between tries for a first chunk the server refused for good. */
const BLOCKED_RETRY_MS = 5 * 60_000;
/** ADR 0013 5.5: an incoming first chunk may exceed the buffer cap by at most this much per stream. */
const OVERFLOW_PER_STREAM_BYTES = 16 * 1024 * 1024;
/** A cached presign is reused until this long before it expires. */
const PRESIGN_REUSE_MARGIN_MS = 5000;

/**
 * Chunk upload queue (FR-701, FR-702, TC-063, TC-070, NFR-08).
 *
 * Every chunk is written to IndexedDB first, then uploaded by at most `concurrency` (2) workers
 * that do presign, PUT, confirm. The server counts every presign request (a repeat for the same
 * chunk too; only a confirmed chunk answers `alreadyUploaded` without counting), so a chunk is
 * presigned lazily right before its PUT, the URL is reused for retries until 5 s before it
 * expires, and nothing is presigned while the connection is down. The editor thread only pays for the IndexedDB write; the network
 * work is async. Failures back off exponentially per chunk and the chunk stays in IndexedDB, so a
 * 60 s outage or a reload loses nothing. The buffer is capped at 200 MB: past the cap the oldest
 * chunks that are not uploading are dropped and counted in the health report (the review UI must
 * show a gap, never silently skip).
 */
const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);

export class UploadQueue {
  private readonly concurrency: number;
  private readonly cap: number;
  private readonly put: NonNullable<UploadQueueOptions['put']>;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;

  /** key -> chunk, for everything stored and not yet confirmed. */
  private readonly pending = new Map<string, ChunkRef>();
  private readonly inFlight = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly notBefore = new Map<string, number>();
  private wake: ReturnType<typeof setTimeout> | null = null;
  private lastOk: number | null = null;
  private failures = 0;
  private droppedChunks = 0;
  private droppedBytes = 0;
  private running = false;
  private readonly touch: SessionTouch;
  /** Chunks that could not be written to IndexedDB, uploaded from memory. */
  private readonly memory = new Map<string, ArrayBuffer>();
  private storageDegraded = false;
  private lastStorageProbe = -Infinity;
  private memBytes = 0;
  /** Presigned URLs, memory only (never persisted, never logged), reused for retries. */
  private readonly presigns = new Map<string, PresignedPut>();
  /** No connection: do not presign, probe instead. */
  private offline = false;
  private offlineAttempts = 0;
  private nextProbeAt = 0;
  private probing = false;
  /** Per stream: no presign before this time (PRESIGN_QUOTA_EXCEEDED). */
  private readonly streamHold = new Map<RecordingStream, number>();
  private ended = false;
  private capExceeded = false;
  /** First chunks the server refused for good (kept, retried slowly). */
  private readonly blocked = new Set<string>();
  /**
   * Keys this queue obtained a URL for, or restored from IndexedDB. `alreadyUploaded` is believed
   * only for these: for any other chunk it means our identity collides with a different confirmed
   * chunk (counters behind), and deleting it would lose media without a trace.
   */
  private readonly trusted = new Set<string>();
  /**
   * Streams held after an identity collision (the server confirmed ANOTHER chunk under a seq we
   * hold: our counters are behind). A held stream gets no presign, no drop and no guessed seq; its
   * chunks wait. The hold is persisted per stream (`<sid>:held:<STREAM>`, a segment number, no
   * media) BEFORE anything else happens, so a reload re-holds instead of trusting the chunks.
   */
  private readonly held = new Map<RecordingStream, { segment: number }>();
  private readonly seqConflictsBy: Record<RecordingStream, number> = {
    SCREEN: 0,
    WEBCAM: 0,
    AUDIO: 0,
  };
  private readonly staleLossesBy: Record<RecordingStream, number> = {
    SCREEN: 0,
    WEBCAM: 0,
    AUDIO: 0,
  };
  private purged = false;
  /** Bytes of first chunks admitted above the cap, per chunk (ADR 0013 5.5: at most 16 MiB per stream). */
  private readonly overflow = new Map<string, number>();

  constructor(private readonly o: UploadQueueOptions) {
    this.concurrency = o.concurrency ?? 2;
    this.cap = o.maxBufferBytes ?? MAX_BUFFER_BYTES;
    this.put = o.put ?? makeDefaultPut(o.putTimeoutMs ?? 30_000);
    this.baseMs = o.backoffBaseMs ?? 1000;
    this.maxMs = o.backoffMaxMs ?? 30_000;
    this.jitter = o.jitter ?? 0.2;
    this.touch = new SessionTouch(o.store, o.sessionId);
  }

  private prefix(): string {
    return `${this.o.sessionId}:`;
  }

  private heldKey(stream: RecordingStream): string {
    return `${this.o.sessionId}:held:${stream}`;
  }

  /** Pick up chunks left by a previous page load and start uploading. */
  async start(): Promise<void> {
    try {
      // Holds first: chunks of a held stream are NOT trusted (the server may answer alreadyUploaded
      // for another chunk under their identity, and believing it would delete them unseen).
      for (const stream of RECORDING_STREAMS) {
        const h = await this.o.store.get<{ segment: number }>(STORES.meta, this.heldKey(stream));
        if (h && Number.isInteger(h.segment)) {
          this.held.set(stream, { segment: h.segment });
          this.seqConflictsBy[stream]++;
          this.o.onSeqConflict?.({ stream, segment: h.segment });
        }
      }
      for (const key of await this.o.store.keys(STORES.chunks, this.prefix())) {
        const ref = parseChunkKey(key);
        if (ref) {
          this.pending.set(key, ref);
          if (!this.held.has(ref.stream)) this.trusted.add(key); // restored: this identity was ours
        }
      }
      await sweepStaleSessions(this.o.store, this.o.sessionId, Date.now(), this.o.staleAfterMs);
    } catch {
      this.degrade('OPEN_FAILED');
    }
    this.running = true;
    this.report();
    this.pump();
  }

  /** Highest stored segment number for a stream, so a restart can use the next one. */
  maxSegment(stream: RecordingStream): number {
    let m = -1;
    for (const c of this.pending.values()) if (c.stream === stream) m = Math.max(m, c.segment);
    return m;
  }

  /** Highest stored seq for a stream, so counters never restart below a chunk still waiting. */
  maxSeq(stream: RecordingStream): number {
    let m = -1;
    for (const c of this.pending.values()) if (c.stream === stream) m = Math.max(m, c.seq);
    return m;
  }

  async add(chunk: ChunkRef, data: ArrayBuffer): Promise<void> {
    const key = chunkKey(this.o.sessionId, chunk);
    if (this.ended || this.purged) {
      // The session is over: nothing new is stored (privacy) and nothing can be sent.
      this.drop(chunk);
      this.report();
      return;
    }
    if (chunk.bytes > this.cap) {
      this.drop(chunk);
      return;
    }
    const room = await this.makeRoom(chunk);
    if (this.ended || this.purged) {
      // finish() purged (or the session ended) while we made room: write nothing.
      this.drop(chunk);
      this.report();
      return;
    }
    if (room === 'NO') {
      // Only protected first chunks are left and the cap is still exceeded: drop the incoming
      // chunk and say so; the buffer never grows past the cap silently.
      this.drop(chunk);
      this.report();
      return;
    }
    if (room === 'OVERFLOW') {
      this.overflow.set(key, chunk.bytes);
    }
    let stored = false;
    const now = Date.now();
    const probe =
      this.storageDegraded && now - this.lastStorageProbe >= (this.o.storageProbeMs ?? 30_000);
    if (!this.storageDegraded || probe) {
      if (probe) this.lastStorageProbe = now;
      try {
        await this.o.store.put<StoredChunk>(STORES.chunks, key, { data });
        stored = true;
        if (this.storageDegraded) {
          // A transient quota or open error is over: stop living in memory only.
          this.storageDegraded = false;
          this.o.onStorageRecovered?.();
        }
      } catch {
        this.degrade('WRITE_FAILED');
      }
    }
    if (!stored) {
      // IndexedDB failed (quota, private mode, closed): keep the chunk in memory so the upload can
      // still happen; past the memory cap it is a counted drop, never a silent one.
      if (this.memoryBytes() + chunk.bytes > (this.o.maxMemoryBytes ?? 32 * 1024 * 1024)) {
        this.drop(chunk);
        this.report();
        return;
      }
      this.memory.set(key, data);
      this.memBytes += data.byteLength;
    }
    this.pending.set(key, chunk);
    void this.touch.touch();
    this.report();
    this.pump();
  }

  private degrade(reason: 'OPEN_FAILED' | 'WRITE_FAILED'): void {
    if (this.storageDegraded) return;
    this.storageDegraded = true;
    this.lastStorageProbe = Date.now();
    this.o.onStorageDegraded?.(reason);
  }

  private dropMemory(key: string): void {
    const d = this.memory.get(key);
    if (d) this.memBytes -= d.byteLength;
    this.memory.delete(key);
  }

  private memoryBytes(): number {
    return this.memBytes;
  }

  private bytesPending(): number {
    let b = 0;
    for (const c of this.pending.values()) b += c.bytes;
    return b;
  }

  private drop(c: ChunkRef): void {
    this.droppedChunks++;
    this.droppedBytes += c.bytes;
  }

  /** Bytes of first chunks above the cap that are still pending for a stream. */
  private overflowOf(stream: RecordingStream): number {
    let n = 0;
    for (const [k, b] of this.overflow) if (this.pending.get(k)?.stream === stream) n += b;
    return n;
  }

  /**
   * Make room for `incoming` by dropping the OLDEST chunks that are not uploading. A segment's
   * first chunk is never a victim (without it the whole segment is unplayable). When only
   * protected or uploading chunks remain: an incoming first chunk is admitted above the cap
   * ('OVERFLOW') while that stream's overflow stays within 16 MiB (ADR 0013 5.5), beyond that it
   * is lost and reported ('NO'); an ordinary incoming chunk is 'NO'.
   */
  private async makeRoom(incoming: ChunkRef): Promise<'OK' | 'OVERFLOW' | 'NO'> {
    while (this.bytesPending() + incoming.bytes > this.cap) {
      // Oldest first: keys sort by stream, segment, seq.
      const victim = [...this.pending.keys()]
        .sort()
        .find((k) => !this.inFlight.has(k) && !this.pending.get(k)?.first);
      if (!victim) {
        if (incoming.first) {
          if (this.overflowOf(incoming.stream) + incoming.bytes > OVERFLOW_PER_STREAM_BYTES) {
            this.o.onSegmentLost?.({ stream: incoming.stream, segment: incoming.segment });
            return 'NO';
          }
          if (!this.capExceeded) {
            this.capExceeded = true;
            this.o.onCapExceeded?.();
          }
          return 'OVERFLOW';
        }
        return 'NO';
      }
      const ref = this.pending.get(victim);
      this.pending.delete(victim);
      this.overflow.delete(victim);
      this.presigns.delete(victim);
      this.trusted.delete(victim);
      this.dropMemory(victim);
      await this.o.store.delete(STORES.chunks, victim).catch(() => undefined);
      if (ref) this.drop(ref);
    }
    return 'OK';
  }

  private backoffMs(attempt: number): number {
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, attempt - 1));
    return exp * (1 - this.jitter * Math.random());
  }

  private schedule(at: number): void {
    if (this.wake) return;
    this.wake = setTimeout(
      () => {
        this.wake = null;
        this.pump();
      },
      Math.max(0, at - Date.now()),
    );
  }

  private pump(): void {
    if (!this.running || this.ended) return;
    const now = Date.now();
    let nextWake: number | null = null;
    const wakeAt = (t: number): void => {
      nextWake = nextWake === null ? t : Math.min(nextWake, t);
    };
    // Connection down: no presigns. Probe when due; without a probe let ONE chunk through.
    let probeSlot = false;
    if (this.offline) {
      if (now < this.nextProbeAt) {
        wakeAt(this.nextProbeAt);
        if (nextWake !== null) this.schedule(nextWake);
        this.report();
        return;
      }
      if (this.o.probe) {
        void this.runProbe();
        this.report();
        return;
      }
      probeSlot = this.inFlight.size === 0;
      if (!probeSlot) {
        this.report();
        return;
      }
    }
    for (const key of [...this.pending.keys()].sort()) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.inFlight.has(key)) continue;
      const ref = this.pending.get(key);
      if (ref && this.held.has(ref.stream)) continue; // identity collision: waits for releaseHeld
      const at = Math.max(
        this.notBefore.get(key) ?? 0,
        ref ? (this.streamHold.get(ref.stream) ?? 0) : 0,
      );
      if (at > now) {
        wakeAt(at);
        continue;
      }
      this.inFlight.add(key);
      // Detached on purpose: uploads never block the caller.
      setTimeout(() => void this.upload(key), 0);
      if (probeSlot) break;
    }
    if (nextWake !== null) this.schedule(nextWake);
    this.report();
  }

  private async runProbe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    let ok: boolean;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((res) => {
        timer = setTimeout(() => res(false), this.o.probeTimeoutMs ?? 15_000);
      });
      try {
        ok = (await Promise.race([this.o.probe?.() ?? Promise.resolve(false), timeout])) === true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      ok = false;
    }
    this.probing = false;
    if (ok) {
      this.offline = false;
      this.offlineAttempts = 0;
    } else {
      this.offlineAttempts++;
      this.nextProbeAt = Date.now() + this.backoffMs(this.offlineAttempts);
    }
    this.pump();
  }

  private async upload(key: string): Promise<void> {
    const ref = this.pending.get(key);
    try {
      if (!ref) return;
      const mem = this.memory.get(key);
      const stored: StoredChunk | undefined = mem
        ? { data: mem }
        : await this.o.store.get<StoredChunk>(STORES.chunks, key).catch(() => undefined);
      if (!stored) {
        this.pending.delete(key);
        return;
      }
      let put = this.presigns.get(key);
      if (put && (put.expiresAtMs ?? 0) - PRESIGN_REUSE_MARGIN_MS <= Date.now()) {
        this.presigns.delete(key);
        put = undefined;
      }
      let alreadyUploaded = false;
      if (!put) {
        // Lazy: one chunk, right before its PUT. Every presign request counts against the quota.
        const r = await this.o.api.presign(ref);
        if (r.alreadyUploaded === true) {
          if (!this.trusted.has(key)) {
            // Never got a URL for this identity and did not restore it: the server confirmed
            // ANOTHER chunk under it. Believing it would delete this one unseen.
            throw new MediaApiError('SEQ_COLLISION', 'identity already confirmed', {
              code: 'SEQ_CONFLICT',
            });
          }
          alreadyUploaded = true;
        } else {
          put = { ...r, expiresAtMs: r.expiresAtMs ?? Date.now() + 30_000 };
          this.presigns.set(key, put);
          this.trusted.add(key);
        }
      }
      if (put && !alreadyUploaded) {
        let status: number;
        try {
          status = await this.put(put.url, stored.data, {
            'Content-Type': contentTypeFor(ref.stream),
            ...put.headers, // exactly what the presign returned wins (it signs Content-Type)
          });
        } catch {
          throw new MediaApiError('NETWORK', 'network');
        }
        if (status === 0) {
          // Some PUT helpers answer 0 for a network error: offline, not a refused URL.
          throw new MediaApiError('NETWORK', 'network');
        }
        if (status === 412) {
          // If-None-Match: the object is already stored (a retry after a lost answer): confirm it.
        } else if (status < 200 || status >= 300) {
          const transient = status === 408 || status === 429 || status >= 500;
          if (!transient) this.presigns.delete(key); // expired or refused URL: presign again
          throw new MediaApiError(
            transient ? 'RETRY' : 'REPRESIGN',
            `PUT failed with ${String(status)}`,
          );
        }
        await this.o.api.confirm(ref);
      }
      this.presigns.delete(key);
      this.blocked.delete(key);
      this.trusted.delete(key);
      this.overflow.delete(key);
      this.dropMemory(key);
      await this.o.store.delete(STORES.chunks, key).catch(() => undefined);
      this.pending.delete(key);
      this.attempts.delete(key);
      this.notBefore.delete(key);
      this.lastOk = Date.now();
      void this.touch.touch();
      this.failures = 0;
      this.offline = false;
      this.offlineAttempts = 0;
    } catch (err) {
      await this.onFailure(key, ref, err);
    } finally {
      this.inFlight.delete(key);
      this.pump();
    }
  }

  private async onFailure(key: string, ref: ChunkRef | undefined, err: unknown): Promise<void> {
    const e = err instanceof MediaApiError ? err : new MediaApiError('RETRY', 'unexpected');
    const n = (this.attempts.get(key) ?? 0) + 1;
    const backoff = (min = 0): number => Date.now() + Math.max(min, this.backoffMs(n));
    switch (e.kind) {
      case 'NETWORK':
        this.attempts.set(key, n);
        this.failures++;
        this.offline = true;
        this.offlineAttempts++;
        this.nextProbeAt = Date.now() + this.backoffMs(this.offlineAttempts);
        return;
      case 'RETRY':
        this.attempts.set(key, n);
        this.failures++;
        this.notBefore.set(key, backoff(e.retryAfterMs ?? 0));
        return;
      case 'REPRESIGN':
        this.presigns.delete(key);
        this.attempts.set(key, n);
        this.failures++;
        this.notBefore.set(key, backoff());
        return;
      case 'REUPLOAD':
        this.attempts.set(key, n);
        this.failures++;
        this.notBefore.set(key, backoff());
        return;
      case 'SEQ_COLLISION':
        if (ref) await this.onCollision(ref);
        return;
      case 'QUOTA': {
        // Never drop for a quota: wait for it, for the whole stream (every presign counts). The
        // server cap is per session, so waiting may never help: say so.
        const until = Date.now() + Math.max(1000, e.retryAfterMs ?? 30_000);
        if (ref) {
          const first = !this.streamHold.has(ref.stream);
          this.streamHold.set(ref.stream, until);
          if (first) this.o.onQuota?.({ stream: ref.stream });
        }
        this.notBefore.set(key, until);
        return;
      }
      case 'ENDED':
        // The session is over: stop uploading, keep the chunks, tell the app (transport hardening
        // purges or drains as it decides).
        if (!this.ended) {
          this.ended = true;
          this.o.onEnded?.(e.code ? { code: e.code } : {});
        }
        return;
      case 'FATAL':
        if (ref?.first) {
          // A segment's first chunk is never dropped: keep it, retry slowly, flag it.
          if (!this.blocked.has(key)) {
            this.blocked.add(key);
            this.o.onChunkBlocked?.({
              ...(e.code ? { code: e.code } : {}),
              stream: ref.stream,
              segment: ref.segment,
            });
          }
          this.attempts.set(key, n);
          this.notBefore.set(key, Date.now() + BLOCKED_RETRY_MS);
          return;
        }
        this.presigns.delete(key);
        this.trusted.delete(key);
        this.overflow.delete(key);
        this.dropMemory(key);
        await this.o.store.delete(STORES.chunks, key).catch(() => undefined);
        if (ref) this.drop(ref);
        this.pending.delete(key);
        return;
    }
  }

  /**
   * The server confirmed ANOTHER chunk under an identity we hold (alreadyUploaded for a chunk we
   * never presigned, or 409 SEQ_CONFLICT). HOLD the stream: no presign, no drop, no guessed seq.
   * The hold is persisted first, then flagged once per episode. The live recorder keeps recording
   * into the held segment (bounded by the buffer cap). Only `releaseHeld` ends a hold.
   */
  private async onCollision(ref: ChunkRef): Promise<void> {
    if (this.held.has(ref.stream)) return; // already held: one flag per episode
    this.held.set(ref.stream, { segment: ref.segment });
    this.seqConflictsBy[ref.stream]++;
    if (!this.purged) {
      await this.o.store
        .put(STORES.meta, this.heldKey(ref.stream), { segment: ref.segment })
        .catch(() => undefined);
    }
    this.o.onSeqConflict?.({ stream: ref.stream, segment: ref.segment });
  }

  /**
   * The counters were refreshed from the server (the app calls `seedCounters` after a new epoch):
   * end the holds. The held chunks carry identities that collide with chunks the server already
   * has, so they are dropped and COUNTED as stale-identity losses (never silent); uploads that are
   * running right now are left to finish. Returns the streams that were released.
   */
  async releaseHeld(): Promise<RecordingStream[]> {
    const released: RecordingStream[] = [];
    if (this.purged) return released; // finish() already dropped and counted everything
    for (const stream of [...this.held.keys()]) {
      let chunks = 0;
      let bytes = 0;
      for (const [key, ref] of [...this.pending.entries()]) {
        // A purge that ran while we awaited has already counted these chunks: never twice.
        if (this.purged || !this.pending.has(key)) continue;
        if (ref.stream !== stream || this.inFlight.has(key)) continue;
        this.pending.delete(key);
        this.presigns.delete(key);
        this.trusted.delete(key);
        this.overflow.delete(key);
        this.blocked.delete(key);
        this.dropMemory(key);
        this.attempts.delete(key);
        this.notBefore.delete(key);
        await this.o.store.delete(STORES.chunks, key).catch(() => undefined);
        this.drop(ref);
        this.staleLossesBy[stream]++;
        chunks++;
        bytes += ref.bytes;
      }
      this.held.delete(stream);
      await this.o.store.delete(STORES.meta, this.heldKey(stream)).catch(() => undefined);
      if (chunks > 0) this.o.onStaleIdentityLoss?.({ stream, chunks, bytes });
      released.push(stream);
    }
    this.pump();
    return released;
  }

  /** Retry everything now, for the browser `online` event. */
  retryNow(): void {
    this.notBefore.clear();
    // streamHold is kept on purpose: a quota hold is not a connection problem, and the browser
    // `online` event must not cause presigns that are certain to be refused.
    this.offline = false; // the browser says it is online again: try, do not wait for a probe
    this.offlineAttempts = 0;
    this.pump();
  }

  health(): RecorderHealth {
    const byStream: Record<RecordingStream, number> = { SCREEN: 0, WEBCAM: 0, AUDIO: 0 };
    let bytes = 0;
    for (const c of this.pending.values()) {
      bytes += c.bytes;
      byStream[c.stream] += c.bytes;
    }
    return {
      bytesPending: bytes,
      chunksPending: this.pending.size,
      inFlight: this.inFlight.size,
      lastSuccessfulUploadAt: this.lastOk,
      consecutiveFailures: this.failures,
      droppedChunks: this.droppedChunks,
      droppedBytes: this.droppedBytes,
      degraded: this.failures > 0 || this.storageDegraded,
      storageDegraded: this.storageDegraded,
      memoryBytes: this.memoryBytes(),
      bytesPendingByStream: byStream,
      ended: this.ended,
      offline: this.offline,
      quotaWait: [...this.streamHold.values()].some((t) => t > Date.now()),
      blockedChunks: this.blocked.size,
      capExceeded: this.capExceeded,
      seqConflicts: sum(this.seqConflictsBy),
      seqConflictsByStream: { ...this.seqConflictsBy },
      staleIdentityLosses: sum(this.staleLossesBy),
      staleIdentityLossesByStream: { ...this.staleLossesBy },
      heldStreams: [...this.held.keys()],
    };
  }

  private report(): void {
    this.o.onHealth?.(this.health());
    if (this.pending.size === 0) {
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private readonly idleWaiters: (() => void)[] = [];

  /** Resolves true when everything is uploaded, false when `timeoutMs` ran out first. */
  waitUntilIdle(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.idleWaiters.indexOf(done);
        if (i >= 0) this.idleWaiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(done);
    });
  }

  /**
   * Delete everything still buffered for this session (end of session: recorded media must not
   * stay on the candidate's disk, FR-702). Leftovers count as dropped. Returns the dropped bytes.
   */
  async purge(): Promise<number> {
    let bytes = 0;
    for (const c of this.pending.values()) {
      this.drop(c);
      bytes += c.bytes;
    }
    this.pending.clear();
    this.memory.clear();
    this.memBytes = 0;
    this.attempts.clear();
    this.notBefore.clear();
    this.purged = true;
    this.presigns.clear();
    this.blocked.clear();
    this.trusted.clear();
    this.overflow.clear();
    this.held.clear();
    await this.o.store.deletePrefix(STORES.chunks, this.prefix()).catch(() => 0);
    for (const stream of RECORDING_STREAMS) {
      await this.o.store.delete(STORES.meta, this.heldKey(stream)).catch(() => undefined);
    }
    this.report();
    return bytes;
  }

  /** Stop scheduling. Chunks stay in IndexedDB and resume on the next page load. */
  stop(): void {
    this.running = false;
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
  }
}
