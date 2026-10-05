import {
  MAX_EVENTS_PER_BATCH,
  clientProctorEventSchema,
  type ClientProctorEvent,
} from '@codeproctor/shared';
import { canonicalJson } from './canonical';
import { signHex } from './hmac';
import { IdbStore, STORES, padSeq } from './idb';
import { sweepStaleSessions } from './sweep';

/** What goes on the wire: `body` is the exact signed string, `signature` is hex HMAC-SHA256. */
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
}

export interface EventQueueStats {
  pendingEvents: number;
  unsentBatches: number;
  sentBatches: number;
  rejectedBatches: number;
  droppedInvalidEvents: number;
  nextSeq: number;
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
  private sent = 0;
  private rejected = 0;
  private invalid = 0;

  constructor(private readonly opts: EventQueueOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.maxBatchSize = Math.min(opts.maxBatchSize ?? MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_BATCH);
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.jitter = opts.jitter ?? 0.2;
  }

  private metaKey(): string {
    return `${this.opts.sessionId}:nextEventSeq`;
  }

  /** Load unsent batches from a previous page load and continue the sequence. */
  async start(): Promise<void> {
    const saved = await this.opts.store.entries<SignedBatch>(
      STORES.eventBatches,
      `${this.opts.sessionId}:`,
    );
    this.outbox = saved.map((e) => e.value).sort((a, b) => a.seq - b.seq);
    const stored = (await this.opts.store.get<number>(STORES.meta, this.metaKey())) ?? 0;
    const maxSaved = this.outbox.reduce((m, b) => Math.max(m, b.seq + 1), 0);
    this.nextSeq = Math.max(stored, maxSaved);
    await sweepStaleSessions(
      this.opts.store,
      this.opts.sessionId,
      Date.now(),
      this.opts.staleAfterMs,
    );
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
    this.chain = this.chain.then(() => this.cutAll()).then(() => this.drain());
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
      await this.opts.store.put(
        STORES.eventBatches,
        `${this.opts.sessionId}:${padSeq(seq)}`,
        batch,
      );
      await this.opts.store.put(STORES.meta, this.metaKey(), this.nextSeq);
      this.outbox.push(batch);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.started) return;
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
        await this.opts.store.delete(
          STORES.eventBatches,
          `${this.opts.sessionId}:${padSeq(head.seq)}`,
        );
        if (result === 'OK') this.sent++;
        else this.rejected++;
        this.attempt = 0;
      }
    } finally {
      this.draining = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
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
    };
  }

  /**
   * End of session (FR-702): flush, wait up to `drainTimeoutMs` for the outbox to empty, then delete
   * every stored batch and the sequence counter of this session from IndexedDB. Batches that did
   * not get through are returned as `lostBatches` (and are gone: signed batches must not linger on
   * the candidate's disk). Keystroke batches use the same store layout when that queue exists.
   */
  async finish(drainTimeoutMs = 15_000): Promise<{ lostBatches: number }> {
    await this.flush();
    const deadline = Date.now() + drainTimeoutMs;
    while (this.outbox.length > 0 && Date.now() < deadline) {
      this.retryNow();
      await new Promise((r) => setTimeout(r, 50));
    }
    const lostBatches = this.outbox.length;
    this.outbox = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.started = false;
    try {
      await this.opts.store.deletePrefix(STORES.eventBatches, `${this.opts.sessionId}:`);
      await this.opts.store.delete(STORES.meta, this.metaKey());
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
