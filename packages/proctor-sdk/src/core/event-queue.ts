import {
  MAX_EVENTS_PER_BATCH,
  clientProctorEventSchema,
  type ClientProctorEvent,
} from '@codeproctor/shared';
import { canonicalJson } from './canonical';
import { signHex } from './hmac';
import { IdbStore, STORES, padSeq } from './idb';
import { DEFAULT_STALE_AFTER_MS, SessionTouch, sweepStaleSessions } from './sweep';

/** What goes on the wire: `body` is the exact signed string, `signature` is hex HMAC-SHA256. */
const BACKUP_PREFIX = 'codeproctor:eventseq:';
const SEQ_SEED_FLOOR = 10_000_000;
const MAX_SEQ_SEED = 2_147_483_000; // below MAX_BATCH_SEQ (2^31 - 1) with room to grow

/** Accepts only a plausible stored counter: a non-negative safe integer below 2^31. */
function validSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 2 ** 31;
}

function parseBackup(raw: string): { seq: number; seenAt: number } | null {
  try {
    const j = JSON.parse(raw) as { seq?: unknown; seenAt?: unknown };
    return validSeq(j.seq) && typeof j.seenAt === 'number'
      ? { seq: j.seq, seenAt: j.seenAt }
      : null;
  } catch {
    return null;
  }
}

export interface SignedBatch {
  seq: number;
  body: string;
  signature: string;
}

/**
 * OK: acknowledged (also for an idempotent replay of the same seq).
 * RETRY: network or 5xx, keep the batch and back off.
 * REJECTED: the server refused it for good (4xx); drop it so one bad batch cannot block the rest.
 */
export type SendResult = 'OK' | 'RETRY' | 'REJECTED';

export interface EventTransport {
  sendBatch(batch: SignedBatch): Promise<SendResult>;
}

export interface EventQueueOptions {
  sessionId: string;
  key: CryptoKey;
  transport: EventTransport;
  store: IdbStore;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 0..1 jitter share; tests set 0 for determinism. */
  jitter?: number;
  /** Other sessions' leftovers older than this are deleted on start (default 24 h). */
  staleAfterMs?: number;
  /** Called once when IndexedDB stops working and the queue continues in memory only. */
  onStorageDegraded?: (reason: 'OPEN_FAILED' | 'WRITE_FAILED') => void;
  /** Called when IndexedDB works again after a degraded period. */
  onStorageRecovered?: () => void;
  /** Called when the sequence counter could not be read and the queue seeded it high (holes, no collisions). */
  onSeqUntrusted?: () => void;
  /** While degraded, try IndexedDB again at most this often (default 30 s). */
  storageProbeMs?: number;
}

export interface EventQueueStats {
  pendingEvents: number;
  unsentBatches: number;
  sentBatches: number;
  rejectedBatches: number;
  droppedInvalidEvents: number;
  nextSeq: number;
  /** IndexedDB is unusable; unsent batches live in memory only (lost on reload). */
  storageDegraded: boolean;
}

/**
 * Batches events every 5 s or 100 events (FR-601 area, ADR 0001 F4), signs each batch with the
 * session HMAC key and a monotonic `seq`, persists it in IndexedDB before the first send and
 * retries with exponential backoff (TC-063, NFR-08). After a reload the unsent batches are
 * loaded again and the sequence continues, so a 60 s outage loses nothing.
 */
export class EventQueue {
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitter: number;

  private pending: ClientProctorEvent[] = [];
  private outbox: SignedBatch[] = [];
  private nextSeq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private draining = false;
  private chain: Promise<void> = Promise.resolve();
  private started = false;
  private finished = false;
  private storageDegraded = false;
  private lastProbe = -Infinity;
  private readonly touch: SessionTouch;
  private sent = 0;
  private rejected = 0;
  private invalid = 0;

  constructor(private readonly opts: EventQueueOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.maxBatchSize = Math.min(opts.maxBatchSize ?? MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_BATCH);
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.jitter = opts.jitter ?? 0.2;
    this.touch = new SessionTouch(opts.store, opts.sessionId);
  }

  private metaKey(): string {
    return `${this.opts.sessionId}:nextEventSeq`;
  }

  /** Load unsent batches from a previous page load and continue the sequence. */
  private degrade(reason: 'OPEN_FAILED' | 'WRITE_FAILED'): void {
    if (this.storageDegraded) return;
    this.storageDegraded = true;
    this.lastProbe = Date.now();
    this.opts.onStorageDegraded?.(reason);
  }

  /**
   * Backup of the sequence counter outside IndexedDB: `{ seq, seenAt }` in localStorage under
   * `codeproctor:eventseq:<sessionId>` (a pseudonymous id and an integer, no candidate data). This
   * localStorage use is an exception to confirm with the hub. Entries of other sessions older than
   * `staleAfterMs` are removed on start.
   */
  private backupKey(): string {
    return `${BACKUP_PREFIX}${this.opts.sessionId}`;
  }
  private readBackup(): number {
    try {
      const raw = globalThis.localStorage?.getItem(this.backupKey());
      return raw ? (parseBackup(raw)?.seq ?? 0) : 0;
    } catch {
      return 0;
    }
  }
  private writeBackup(): void {
    try {
      globalThis.localStorage?.setItem(
        this.backupKey(),
        JSON.stringify({ seq: this.nextSeq, seenAt: Date.now() }),
      );
    } catch {
      // storage disabled
    }
  }
  private sweepBackups(): void {
    try {
      const ls = globalThis.localStorage;
      if (!ls) return;
      const maxAge = this.opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
      for (let i = ls.length - 1; i >= 0; i--) {
        const key = ls.key(i);
        if (!key?.startsWith(BACKUP_PREFIX) || key === this.backupKey()) continue;
        const parsed = parseBackup(ls.getItem(key) ?? '');
        // Unparseable or old entries go; a pre-existing plain integer gets no age, so it goes too.
        if (!parsed || Date.now() - parsed.seenAt > maxAge) ls.removeItem(key);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Fail closed when the sequence counter cannot be trusted (IndexedDB unreadable and no backup).
   * A seed far above any plausible earlier value (10 000 000 plus seconds since 2026-01-01, always
   * below the schema limit, and high even on a device clock set before 2026) leaves holes in the
   * sequence instead of reusing a seq; every reused seq is rejected by the server (ADR 0013: that
   * batch is dropped and counted as rejected). Two reuse paths stay unflagged until ADR 0013
   * counters exist: every counter write failed in the previous page load while IndexedDB reads
   * work on reload (the sequence restarts at 0), and resuming on a new device always restarts at 0
   * (FR-106, D-21; fixed by `proctor-key` `counters.eventSeqStart`, max(local, server)).
   */
  private seqSeed(): number {
    const secs = Math.max(0, Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000));
    return Math.min(MAX_SEQ_SEED, SEQ_SEED_FLOOR + secs);
  }

  async start(): Promise<void> {
    let maxSaved = 0;
    let stored: number | null = null;
    let readFailed = false;
    try {
      const saved = await this.opts.store.entries<SignedBatch>(
        STORES.eventBatches,
        `${this.opts.sessionId}:`,
      );
      this.outbox = saved.map((e) => e.value).sort((a, b) => a.seq - b.seq);
      maxSaved = this.outbox.reduce((m, b) => Math.max(m, b.seq + 1), 0);
    } catch {
      readFailed = true;
      this.degrade('OPEN_FAILED');
    }
    try {
      stored = (await this.opts.store.get<number>(STORES.meta, this.metaKey())) ?? 0;
    } catch {
      readFailed = true; // the saved batches (if any) still count, see maxSaved
    }
    if (stored !== null && !validSeq(stored)) {
      stored = null; // a corrupt counter is no counter
      readFailed = true;
    }
    const backup = this.readBackup();
    this.sweepBackups();
    this.nextSeq = Math.max(maxSaved, stored ?? 0, backup);
    if (readFailed && backup === 0 && stored === null) {
      // The counter is unknowable: seed above anything plausible and say so.
      this.nextSeq = Math.max(this.nextSeq, this.seqSeed());
      this.opts.onSeqUntrusted?.();
    }
    try {
      await sweepStaleSessions(
        this.opts.store,
        this.opts.sessionId,
        Date.now(),
        this.opts.staleAfterMs,
      );
    } catch {
      // ignore
    }
    this.started = true;
    if (this.outbox.length > 0) void this.drain();
  }

  enqueue(event: unknown): boolean {
    const parsed = clientProctorEventSchema.safeParse(event);
    if (!parsed.success) {
      this.invalid++;
      return false;
    }
    this.pending.push(parsed.data);
    if (this.pending.length >= this.maxBatchSize) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), this.flushIntervalMs);
    }
    return true;
  }

  /** Cut pending events into signed batches, persist them and try to send everything. */
  flush(): Promise<void> {
    // A failure in one flush must never leave the chain rejected: every later flush would be dead.
    this.chain = this.chain
      .then(() => this.cutAll())
      .then(() => this.drain())
      .catch(() => undefined);
    return this.chain;
  }

  private async cutAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.pending.length > 0) {
      const events = this.pending.splice(0, this.maxBatchSize);
      const seq = this.nextSeq++;
      const body = canonicalJson({ seq, events });
      const signature = await signHex(this.opts.key, body);
      const batch: SignedBatch = { seq, body, signature };
      // Persist before sending: if the tab dies mid-request the batch is replayed (idempotent seq).
      const now = Date.now();
      const probe =
        this.storageDegraded && now - this.lastProbe >= (this.opts.storageProbeMs ?? 30_000);
      if (!this.storageDegraded || probe) {
        if (probe) this.lastProbe = now;
        try {
          await this.opts.store.put(
            STORES.eventBatches,
            `${this.opts.sessionId}:${padSeq(seq)}`,
            batch,
          );
          if (this.storageDegraded) {
            this.storageDegraded = false;
            this.opts.onStorageRecovered?.();
          }
        } catch {
          this.degrade('WRITE_FAILED'); // keep going: the batch is still sent from memory
        }
      }
      // The counter is written on EVERY cut, also while degraded (best effort, in IndexedDB and in
      // a localStorage backup), so a reload never restarts below an acknowledged seq.
      await this.opts.store.put(STORES.meta, this.metaKey(), this.nextSeq).catch(() => undefined);
      this.writeBackup();
      this.outbox.push(batch);
      void this.touch.touch();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.started || this.finished) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0) {
        const head = this.outbox[0];
        if (!head) break;
        let result: SendResult;
        try {
          result = await this.opts.transport.sendBatch(head);
        } catch {
          result = 'RETRY';
        }
        if (result === 'RETRY') {
          this.scheduleRetry();
          return;
        }
        this.outbox.shift();
        await this.opts.store
          .delete(STORES.eventBatches, `${this.opts.sessionId}:${padSeq(head.seq)}`)
          .catch(() => undefined);
        if (result === 'OK') this.sent++;
        else this.rejected++;
        this.attempt = 0;
      }
    } finally {
      this.draining = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.finished) return;
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    this.attempt++;
    const delay = exp * (1 - this.jitter * Math.random());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, delay);
  }

  /** Retry now (for example on the browser `online` event). */
  retryNow(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempt = 0;
    void this.drain();
  }

  stats(): EventQueueStats {
    return {
      pendingEvents: this.pending.length,
      unsentBatches: this.outbox.length,
      sentBatches: this.sent,
      rejectedBatches: this.rejected,
      droppedInvalidEvents: this.invalid,
      nextSeq: this.nextSeq,
      storageDegraded: this.storageDegraded,
    };
  }

  /**
   * End of session (FR-702): flush, wait up to `drainTimeoutMs` for the outbox to empty, then delete
   * every stored batch of this session from IndexedDB. Batches that did not get through are
   * returned as `lostBatches` (and are gone: signed batches must not linger on the candidate's
   * disk). The `nextEventSeq` counter is KEPT: it is a small integer, not candidate data, and a
   * new queue for the same session after a reload must continue at the next seq; restarting at 0
   * would make the server acknowledge and discard new batches that reuse an old seq. The stale
   * sweep removes the counter later. Keystroke batches use the same store layout when that queue exists.
   */
  async finish(drainTimeoutMs = 15_000): Promise<{ lostBatches: number }> {
    await this.flush();
    const deadline = Date.now() + drainTimeoutMs;
    let lastKick = -Infinity;
    while (this.outbox.length > 0 && Date.now() < deadline) {
      // Normal backoff applies; only nudge a waiting retry at most once a second, so a 5xx or 429
      // outage costs a handful of requests, not hundreds.
      if (Date.now() - lastKick >= 1000) {
        lastKick = Date.now();
        this.retryNow();
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // A send that is still in flight at the deadline may yet be acknowledged: give it a moment so
    // it is not counted as lost.
    const settleBy = Date.now() + 1500;
    while (this.draining && Date.now() < settleBy) await new Promise((r) => setTimeout(r, 25));
    this.finished = true;
    const lostBatches = this.outbox.length;
    this.outbox = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.started = false;
    try {
      await this.opts.store.deletePrefix(STORES.eventBatches, `${this.opts.sessionId}:`);
    } catch {
      // best effort
    }
    return { lostBatches };
  }

  /** Final flush, then stop timers. Unsent batches stay in IndexedDB for the next page load. */
  async stop(): Promise<void> {
    await this.flush();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.started = false;
  }
}
