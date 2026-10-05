import { IdbStore, STORES, padSeq } from '../core/idb';
import { SessionTouch, sweepStaleSessions } from '../core/sweep';
import {
  MAX_BUFFER_BYTES,
  MediaApiError,
  RECORDING_STREAMS,
  type ChunkRef,
  type MediaApi,
  type RecorderHealth,
  type RecordingStream,
} from './types';

interface StoredChunk {
  data: ArrayBuffer;
}

/** Key layout: `${sessionId}:${stream}:${segment}:${seq}:${bytes}:${contentType}`, all sortable. */
export function chunkKey(sessionId: string, c: ChunkRef): string {
  return `${sessionId}:${c.stream}:${padSeq(c.segment)}:${padSeq(c.seq)}:${c.bytes}:${encodeURIComponent(c.contentType)}`;
}

export function parseChunkKey(key: string): ChunkRef | null {
  const parts = key.split(':');
  if (parts.length < 6) return null;
  const [, stream, segment, seq, bytes, ct] = parts;
  if (!RECORDING_STREAMS.includes(stream as RecordingStream)) return null;
  const n = (v: string | undefined): number => Number(v);
  if ([segment, seq, bytes].some((v) => !Number.isInteger(n(v)))) return null;
  return {
    stream: stream as RecordingStream,
    segment: n(segment),
    seq: n(seq),
    bytes: n(bytes),
    contentType: decodeURIComponent(ct ?? ''),
  };
}

export interface UploadQueueOptions {
  sessionId: string;
  api: MediaApi;
  store: IdbStore;
  /** Upload one object; defaults to fetch PUT. Returns the HTTP status or throws on network error. */
  put?: (url: string, body: ArrayBuffer, headers: Record<string, string>) => Promise<number>;
  concurrency?: number;
  maxBufferBytes?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  jitter?: number;
  onHealth?: (h: RecorderHealth) => void;
  /** Called once when IndexedDB stops working and the queue falls back to memory. */
  onStorageDegraded?: (reason: 'OPEN_FAILED' | 'WRITE_FAILED') => void;
  /** Max bytes held in memory when IndexedDB is unusable (default 32 MiB). */
  maxMemoryBytes?: number;
  /** Other sessions' leftovers older than this are deleted on start (default 24 h). */
  staleAfterMs?: number;
}

const defaultPut = async (
  url: string,
  body: ArrayBuffer,
  headers: Record<string, string>,
): Promise<number> => (await fetch(url, { method: 'PUT', body, headers })).status;

/**
 * Chunk upload queue (FR-701, FR-702, TC-063, NFR-08).
 *
 * Every chunk is written to IndexedDB first, then uploaded by at most `concurrency` (2) workers
 * that do presign, PUT, confirm. The editor thread only pays for the IndexedDB write; the network
 * work is async. Failures back off exponentially per chunk and the chunk stays in IndexedDB, so a
 * 60 s outage or a reload loses nothing. The buffer is capped at 200 MB: past the cap the oldest
 * chunks that are not uploading are dropped and counted in the health report (the review UI must
 * show a gap, never silently skip).
 */
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

  constructor(private readonly o: UploadQueueOptions) {
    this.concurrency = o.concurrency ?? 2;
    this.cap = o.maxBufferBytes ?? MAX_BUFFER_BYTES;
    this.put = o.put ?? defaultPut;
    this.baseMs = o.backoffBaseMs ?? 1000;
    this.maxMs = o.backoffMaxMs ?? 30_000;
    this.jitter = o.jitter ?? 0.2;
    this.touch = new SessionTouch(o.store, o.sessionId);
  }

  private prefix(): string {
    return `${this.o.sessionId}:`;
  }

  /** Pick up chunks left by a previous page load and start uploading. */
  async start(): Promise<void> {
    try {
      for (const key of await this.o.store.keys(STORES.chunks, this.prefix())) {
        const ref = parseChunkKey(key);
        if (ref) this.pending.set(key, ref);
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

  async add(chunk: ChunkRef, data: ArrayBuffer): Promise<void> {
    const key = chunkKey(this.o.sessionId, chunk);
    if (chunk.bytes > this.cap) {
      this.drop(chunk);
      return;
    }
    await this.makeRoom(chunk.bytes);
    let stored = false;
    if (!this.storageDegraded) {
      try {
        await this.o.store.put<StoredChunk>(STORES.chunks, key, { data });
        stored = true;
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
    }
    this.pending.set(key, chunk);
    void this.touch.touch();
    this.report();
    this.pump();
  }

  private degrade(reason: 'OPEN_FAILED' | 'WRITE_FAILED'): void {
    if (this.storageDegraded) return;
    this.storageDegraded = true;
    this.o.onStorageDegraded?.(reason);
  }

  private memoryBytes(): number {
    let b = 0;
    for (const d of this.memory.values()) b += d.byteLength;
    return b;
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

  private async makeRoom(incoming: number): Promise<void> {
    while (this.bytesPending() + incoming > this.cap) {
      // Oldest first: keys sort by stream, segment, seq; pick the smallest not in flight.
      const victim = [...this.pending.keys()].sort().find((k) => !this.inFlight.has(k));
      if (!victim) return;
      const ref = this.pending.get(victim);
      this.pending.delete(victim);
      this.memory.delete(victim);
      await this.o.store.delete(STORES.chunks, victim).catch(() => undefined);
      if (ref) this.drop(ref);
    }
  }

  private pump(): void {
    if (!this.running) return;
    const now = Date.now();
    let nextWake: number | null = null;
    for (const key of [...this.pending.keys()].sort()) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.inFlight.has(key)) continue;
      const at = this.notBefore.get(key) ?? 0;
      if (at > now) {
        nextWake = nextWake === null ? at : Math.min(nextWake, at);
        continue;
      }
      this.inFlight.add(key);
      // Detached on purpose: uploads never block the caller.
      setTimeout(() => void this.upload(key), 0);
    }
    if (nextWake !== null && !this.wake) {
      this.wake = setTimeout(
        () => {
          this.wake = null;
          this.pump();
        },
        Math.max(0, nextWake - now),
      );
    }
    this.report();
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
      // Fresh presign every attempt: URLs live 60 s, a retry after an outage needs a new one.
      const { url, headers } = await this.o.api.presign(ref);
      const status = await this.put(url, stored.data, {
        'Content-Type': ref.contentType,
        ...headers,
      });
      if (status < 200 || status >= 300) {
        // 4xx on the object store (expired URL, clock skew) is retried with a new presign.
        throw new MediaApiError('RETRY', `PUT failed with ${status}`);
      }
      await this.o.api.confirm(ref);
      this.memory.delete(key);
      await this.o.store.delete(STORES.chunks, key).catch(() => undefined);
      this.pending.delete(key);
      this.attempts.delete(key);
      this.notBefore.delete(key);
      this.lastOk = Date.now();
      void this.touch.touch();
      this.failures = 0;
    } catch (err) {
      if (err instanceof MediaApiError && err.kind === 'FATAL') {
        // The server will never take this chunk (session over, chunk not allowed).
        await this.o.store.delete(STORES.chunks, key).catch(() => undefined);
        if (ref) this.drop(ref);
        this.pending.delete(key);
      } else {
        const n = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, n);
        const exp = Math.min(this.maxMs, this.baseMs * 2 ** (n - 1));
        this.notBefore.set(key, Date.now() + exp * (1 - this.jitter * Math.random()));
        this.failures++;
      }
    } finally {
      this.inFlight.delete(key);
      this.pump();
    }
  }

  /** Retry everything now, for the browser `online` event. */
  retryNow(): void {
    this.notBefore.clear();
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
    this.attempts.clear();
    this.notBefore.clear();
    await this.o.store.deletePrefix(STORES.chunks, this.prefix()).catch(() => 0);
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
