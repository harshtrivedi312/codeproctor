import { signHex } from './hmac';
import { IdbStore, STORES, padSeq } from './idb';
import { DEFAULT_STALE_AFTER_MS, SessionTouch, sweepStaleSessions } from './sweep';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
export type SendResult = 'OK' | 'RETRY' | 'REJECTED' | SendOutcome;

/** Why the server will accept nothing more from this session. */
export type EndReason = 'SESSION_NOT_ACTIVE' | 'TAKEN_OVER';

/**
 * The rich answer of a transport (ADR 0013 5.8). The plain strings above stay valid and mean the
 * same as `{ kind }` without details.
 * - RETRY: network, timeout, 408, 429, 5xx, 503 BUSY; `retryAfterMs` is the server's Retry-After.
 * - REJECTED: dropped for good and counted (400, 413, 415, 403, 409 SEQ_CONFLICT, SIGNATURE_INVALID);
 *   `code` is the problem code, never content.
 * - KEY_STALE: 409 KEY_EPOCH_STALE, the batch must be signed again with the new key.
 * - KEY_UNAVAILABLE: 409 KEY_ALREADY_ISSUED, this client cannot get the key.
 * - ENDED: 409 SESSION_NOT_ACTIVE or SESSION_TAKEN_OVER, nothing will ever be accepted again.
 * - AUTH: 401 (`code` TOKEN_EXPIRED or other).
 */
export type SendOutcome =
  | { kind: 'OK' }
  | { kind: 'RETRY'; retryAfterMs?: number }
  | { kind: 'REJECTED'; code?: string }
  | { kind: 'KEY_STALE' }
  | { kind: 'KEY_UNAVAILABLE' }
  | { kind: 'ENDED'; reason: EndReason }
  | { kind: 'AUTH'; code?: string };

function normalize(r: SendResult): SendOutcome {
  if (typeof r === 'string') return { kind: r };
  return r;
}

/** Longest wait a Retry-After can impose (the server cannot park a client for longer). */
const MAX_RETRY_AFTER_MS = 300_000;

export interface BatchTransport {
  sendBatch(batch: SignedBatch): Promise<SendResult>;
}

export interface BatchQueueOptions {
  sessionId: string;
  key: CryptoKey;
  transport: BatchTransport;
  store: IdbStore;
  flushIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 0..1 jitter share; tests set 0 for determinism. */
  jitter?: number;
  /** Other sessions' leftovers older than this are deleted on start (default 24 h). */
  staleAfterMs?: number;
  /** Called once when IndexedDB stops working and the queue continues in memory only. */
  onStorageDegraded?: (reason: 'OPEN_FAILED' | 'WRITE_FAILED') => void;
  /** Called when the server refused a batch for good (4xx): the batch is dropped. `code` is the problem code, never content. */
  onRejected?: (code?: string) => void;
  /**
   * 409 KEY_EPOCH_STALE on a batch that was signed with the queue's CURRENT key: ask for a newer
   * key (or null when there is none). The queue then signs every unsent batch AGAIN from its stored
   * body (same body, same seq) and retries at once. Without it, or when it returns null, the
   * batches are held and kept (never dropped). Receives that current key, so a provider shared by
   * several queues can hand out an already refreshed key instead of asking the server twice.
   * A batch that was signed with an OLDER key (or loaded from IndexedDB, key unknown) is simply
   * signed again with the current key first, without asking (ADR 0013 section 2: after an OTP
   * resume the new key is already here and the server issues it only once).
   */
  onKeyStale?: (staleKey: CryptoKey) => Promise<CryptoKey | null>;
  /** A hung key provider is given up after this long and treated as a transient failure (default 10 s). */
  keyProviderTimeoutMs?: number;
  /** The queue holds its batches because it has no usable key (once per episode). */
  onKeyUnavailable?: (why: 'STALE_NO_KEY' | 'ALREADY_ISSUED') => void;
  /** 409 SESSION_NOT_ACTIVE (batch route) or SESSION_TAKEN_OVER: called once, the queue has stopped and purged. */
  onEnded?: (reason: EndReason) => void;
  /**
   * After this many consecutive 401 answers (default 3) the queue STOPS: no more retries, the
   * batches stay persisted, and `onReauthRequired` is called once (ADR 0013 section 5.2: never retry
   * forever). Only resume() continues, after the app refreshed the token; online events and finish()
   * do not clear the hold.
   */
  authLostAfter?: number;
  onReauthRequired?: (reason: 'TOKEN_EXPIRED' | 'UNAUTHENTICATED') => void;
  /** Called when IndexedDB works again after a degraded period. */
  onStorageRecovered?: () => void;
  /** Called when the sequence counter could not be read and the queue seeded it high (holes, no collisions). */
  onSeqUntrusted?: () => void;
  /** While degraded, try IndexedDB again at most this often (default 30 s). */
  storageProbeMs?: number;
}

export interface BatchQueueStats {
  pendingItems: number;
  unsentBatches: number;
  sentBatches: number;
  rejectedBatches: number;
  droppedInvalidItems: number;
  nextSeq: number;
  /** Set once the server said the session is over; nothing is sent or kept after that. */
  ended: EndReason | null;
  /** Batches that were lost because the session ended or the token expired after finish(). */
  lostBatches: number;
  /** IndexedDB is unusable; unsent batches live in memory only (lost on reload). */
  storageDegraded: boolean;
}

/**
 * What differs between the event stream and the keystroke stream (ADR 0013: separate sequences,
 * same key, signing, transport guarantees). Everything else lives in BatchQueue.
 */
export interface BatchQueueSpec<TItem> {
  /** Infix after `<sessionId>:` in IndexedDB batch keys: '' for events, 'ks:' for keystrokes. */
  keyInfix: string;
  /** Meta key suffix of the sequence counter, e.g. `nextEventSeq`. */
  metaName: string;
  /** localStorage prefix of the sequence backup, e.g. `codeproctor:eventseq:`. */
  backupPrefix: string;
  /** Validate one incoming item; null drops it (counted in `droppedInvalidItems`). */
  accept(item: unknown): TItem | null;
  /**
   * Take items from the FRONT of `pending` for batch `seq`. Returns the exact body to sign and how
   * many items it consumed (at least 1).
   */
  cut(pending: readonly TItem[], seq: number): { body: string; consumed: number };
  /** Cut right away once this many items are pending. */
  flushAt: number;
  /**
   * Optional: when true the newest pending item replaces `last` instead of being added (for
   * example consecutive cursor moves). Only pending, uncut items are ever replaced.
   */
  coalesce?: (last: TItem, next: TItem) => boolean;
}

/**
 * Signed, sequenced, persisted batch queue (FR-601 area, FR-608, ADR 0001 F4). Signs each batch with the
 * session HMAC key and a monotonic `seq`, persists it in IndexedDB before the first send and
 * retries with exponential backoff (TC-063, NFR-08). After a reload the unsent batches are
 * loaded again and the sequence continues, so a 60 s outage loses nothing.
 */
export class BatchQueue<TItem> {
  private readonly flushIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitter: number;

  private pending: TItem[] = [];
  private outbox: SignedBatch[] = [];
  private nextSeq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private draining = false;
  private chain: Promise<void> = Promise.resolve();
  private started = false;
  private finished = false;
  /** Set by finish(): nothing is accepted, cut or persisted any more (privacy, FR-702). */
  private closed = false;
  private lostAtClose = 0;
  private storageDegraded = false;
  private lastProbe = -Infinity;
  private readonly touch: SessionTouch;
  private sent = 0;
  private rejected = 0;
  private invalid = 0;
  private readonly keyRe: RegExp;
  private key: CryptoKey;
  private ended: EndReason | null = null;
  private lostAtEnd = 0;
  /** finish() has begun: the post-finish grace rules apply to a 401 TOKEN_EXPIRED. */
  private finishing = false;
  private tokenExpiredAtFinish = false;
  /** No usable key: retrying cannot help until the app provides one. */
  private keyBlocked = false;
  private keyStaleRounds = 0;
  private providerTimeouts = 0;
  private auth401 = 0;
  /** 3 consecutive 401: stopped until resume(). */
  private authHold = false;
  /** Retry-After: nothing is sent before this time, whoever asks (flush, online, finish nudges). */
  private notBefore = 0;
  /** The key each unsent batch was signed with (memory only; a batch loaded from IndexedDB is unknown). */
  private readonly signedWith = new WeakMap<SignedBatch, CryptoKey>();

  constructor(
    private readonly opts: BatchQueueOptions,
    private readonly spec: BatchQueueSpec<TItem>,
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.jitter = opts.jitter ?? 0.2;
    this.key = opts.key;
    this.touch = new SessionTouch(opts.store, opts.sessionId);
    this.keyRe = new RegExp(`^${escapeRe(opts.sessionId)}:${escapeRe(spec.keyInfix)}\\d{10}$`);
  }

  private batchKey(seq: number): string {
    return `${this.opts.sessionId}:${this.spec.keyInfix}${padSeq(seq)}`;
  }

  /** Keys of THIS stream only (the event and keystroke queues share one store and session prefix). */
  private async ownKeys(): Promise<string[]> {
    const all = await this.opts.store.keys(STORES.eventBatches, `${this.opts.sessionId}:`);
    return all.filter((k) => this.keyRe.test(k));
  }

  private metaKey(): string {
    return `${this.opts.sessionId}:${this.spec.metaName}`;
  }

  private degrade(reason: 'OPEN_FAILED' | 'WRITE_FAILED'): void {
    if (this.storageDegraded) return;
    this.storageDegraded = true;
    this.lastProbe = Date.now();
    this.opts.onStorageDegraded?.(reason);
  }

  /**
   * Backup of the sequence counter outside IndexedDB: `{ seq, seenAt }` in localStorage under
   * `<backupPrefix><sessionId>` (`codeproctor:eventseq:` for events, `codeproctor:keystrokeseq:` for
   * keystrokes; a pseudonymous id and an integer, no candidate data). This
   * localStorage use is an exception to confirm with the hub. Entries of other sessions older than
   * `staleAfterMs` are removed on start.
   */
  private backupKey(): string {
    return `${this.spec.backupPrefix}${this.opts.sessionId}`;
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
        if (!key?.startsWith(this.spec.backupPrefix) || key === this.backupKey()) continue;
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

  /** Load unsent batches from a previous page load and continue the sequence. */
  async start(): Promise<void> {
    let maxSaved = 0;
    let stored: number | null = null;
    let readFailed = false;
    try {
      const saved = (
        await this.opts.store.entries<SignedBatch>(STORES.eventBatches, `${this.opts.sessionId}:`)
      ).filter((e) => this.keyRe.test(e.key));
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

  enqueue(item: unknown): boolean {
    if (this.closed) return false; // after finish() or the end of the session nothing is kept, not even in memory
    const parsed = this.spec.accept(item);
    if (parsed === null) {
      this.invalid++;
      return false;
    }
    const last = this.pending[this.pending.length - 1];
    if (last !== undefined && this.spec.coalesce?.(last, parsed)) {
      this.pending[this.pending.length - 1] = parsed;
    } else {
      this.pending.push(parsed);
    }
    if (this.pending.length >= this.spec.flushAt) {
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
    while (this.pending.length > 0 && !this.closed) {
      const seq = this.nextSeq++;
      const { body, consumed } = this.spec.cut(this.pending, seq);
      this.pending.splice(0, Math.max(1, consumed));
      let usedKey = this.key;
      let signature = await signHex(usedKey, body);
      if (this.closed) {
        // finish() closed the queue while this batch was being signed: nothing may be persisted.
        this.lostAtClose++;
        break;
      }
      let batch: SignedBatch = { seq, body, signature };
      this.signedWith.set(batch, usedKey);
      // Persist before sending: if the tab dies mid-request the batch is replayed (idempotent seq).
      const now = Date.now();
      const probe =
        this.storageDegraded && now - this.lastProbe >= (this.opts.storageProbeMs ?? 30_000);
      if (!this.storageDegraded || probe) {
        if (probe) this.lastProbe = now;
        try {
          await this.opts.store.put(STORES.eventBatches, this.batchKey(seq), batch);
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
      // The key may have been replaced while this batch was being signed or stored (setKey or a
      // refresh after KEY_EPOCH_STALE): sign again with the current one before it joins the outbox.
      // No await sits between the last check and the push.
      while (usedKey !== this.key && !this.closed) {
        const newer = this.key;
        try {
          signature = await signHex(newer, body);
        } catch {
          // Keep the batch: it joins the outbox with its old signature and key, and the head check
          // signs it again on the next KEY_EPOCH_STALE.
          break;
        }
        usedKey = newer;
        batch = { seq, body, signature };
        this.signedWith.set(batch, usedKey);
        if (!this.storageDegraded) {
          await this.opts.store
            .put(STORES.eventBatches, this.batchKey(seq), batch)
            .catch(() => undefined);
        }
      }
      if (this.closed) {
        this.lostAtClose++;
        break;
      }
      this.outbox.push(batch);
      void this.touch.touch();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.started || this.finished || this.ended) return;
    if (this.authHold) return; // stopped after repeated 401 until resume()
    const wait = this.notBefore - Date.now();
    if (wait > 0) {
      // Retry-After is binding for every caller (flush, online, finish nudges).
      if (!this.retryTimer && this.outbox.length > 0) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.drain();
        }, wait);
      }
      return;
    }
    this.draining = true;
    try {
      while (this.outbox.length > 0 && !this.ended) {
        const head = this.outbox[0];
        if (!head) break;
        let out: SendOutcome;
        try {
          out = normalize(await this.opts.transport.sendBatch(head));
        } catch {
          out = { kind: 'RETRY' };
        }
        if (this.ended || this.finished) return; // the session ended or finish() cleared everything meanwhile
        if (out.kind !== 'AUTH') this.auth401 = 0;
        switch (out.kind) {
          case 'RETRY':
            if (out.retryAfterMs !== undefined) {
              this.notBefore = Date.now() + Math.min(MAX_RETRY_AFTER_MS, out.retryAfterMs);
            }
            this.scheduleRetry(out.retryAfterMs);
            return;
          case 'AUTH': {
            if (this.finishing && out.code === 'TOKEN_EXPIRED') {
              // Post-finish grace: the token's lifetime is at least twice the ingestion grace
              // (invariant TTL/2 >= grace), so an expiry here means the tail cannot be delivered.
              // Do not retry; finish() counts the rest as lost.
              this.tokenExpiredAtFinish = true;
              return;
            }
            this.auth401++;
            if (this.auth401 >= (this.opts.authLostAfter ?? 3)) {
              // Stop: no timer, batches stay persisted. The app refreshes the token and calls resume().
              this.authHold = true;
              if (this.retryTimer) clearTimeout(this.retryTimer);
              this.retryTimer = null;
              const reason = out.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED';
              this.safely(() => this.opts.onReauthRequired?.(reason));
              return;
            }
            this.scheduleRetry(); // getToken is read per request: a refreshed token may already be there
            return;
          }
          case 'ENDED':
            // After stop() the batches are kept for the next page load, which will see the answer itself.
            if (!this.started && !this.finishing) return;
            await this.endSession(out.reason);
            return;
          case 'KEY_STALE': {
            if (await this.handleKeyStale(head)) continue; // re-signed: try the head again at once
            return;
          }
          case 'KEY_UNAVAILABLE':
            this.holdForKey('ALREADY_ISSUED');
            return;
          case 'OK':
          case 'REJECTED': {
            this.outbox.shift();
            await this.opts.store
              .delete(STORES.eventBatches, this.batchKey(head.seq))
              .catch(() => undefined);
            this.keyBlocked = false;
            this.keyStaleRounds = 0;
            if (out.kind === 'OK') this.sent++;
            else {
              this.rejected++;
              const code = out.code;
              this.safely(() => this.opts.onRejected?.(code));
            }
            this.attempt = 0;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // a faulty callback must not stall the queue
    }
  }

  private holdForKey(why: 'STALE_NO_KEY' | 'ALREADY_ISSUED'): void {
    if (!this.keyBlocked) this.safely(() => this.opts.onKeyUnavailable?.(why));
    this.keyBlocked = true;
    this.scheduleRetry();
  }

  /** Sign every unsent batch that was not signed with the current key again (same body, same seq). */
  private async resignOutbox(): Promise<boolean> {
    for (let pass = 0; pass < 3; pass++) {
      const k = this.key;
      for (const b of [...this.outbox]) {
        if (this.ended || this.signedWith.get(b) === k) continue;
        let signature: string;
        try {
          signature = await signHex(k, b.body);
        } catch {
          return false; // the rest is re-signed on the next KEY_EPOCH_STALE (the head check catches it)
        }
        if (this.ended || this.finished) return false;
        const again: SignedBatch = { seq: b.seq, body: b.body, signature };
        this.signedWith.set(again, k);
        const at = this.outbox.indexOf(b);
        if (at < 0) continue; // acknowledged while signing: it must not come back (memory or disk)
        this.outbox[at] = again;
        if (!this.storageDegraded) {
          await this.opts.store
            .put(STORES.eventBatches, this.batchKey(again.seq), again)
            .catch(() => undefined);
        }
      }
      if (this.key === k) return true;
    }
    return true;
  }

  /**
   * KEY_EPOCH_STALE. If the head batch was not signed with the current key (loaded from IndexedDB,
   * or signed before a key change) it just needs signing again with the key we already have: no
   * provider call, because the server issues a key only once per epoch (KEY_ALREADY_ISSUED).
   * Only when a batch signed with the CURRENT key is itself stale is a newer key requested.
   * Nothing is ever dropped here. Returns true when the head should be retried right away.
   */
  private async handleKeyStale(sent: SignedBatch): Promise<boolean> {
    // Decide from the batch that was actually SENT: setKey() may have replaced outbox[0] meanwhile.
    if (this.signedWith.get(sent) !== this.key) {
      const ok = await this.resignOutbox();
      if (!ok) this.scheduleRetry();
      return ok && !this.ended && !this.finished;
    }
    const provider = this.opts.onKeyStale;
    // A provider that hands out a stale key again would loop: stop after a few rounds and hold.
    if (!provider || this.keyStaleRounds >= 3) {
      this.holdForKey('STALE_NO_KEY');
      return false;
    }
    const askedWith = this.key;
    let fresh: CryptoKey | null = null;
    let failed: 'TIMEOUT' | 'ERROR' | null = null;
    try {
      fresh = await this.withTimeout(provider(askedWith), this.opts.keyProviderTimeoutMs ?? 10_000);
    } catch (err) {
      failed = err instanceof Error && err.message === 'timeout' ? 'TIMEOUT' : 'ERROR';
    }
    if (this.ended || this.finished) return false;
    if (this.key !== askedWith) {
      // setKey() delivered a key while we waited: ignore this answer (null, error or another key)
      // and sign again with what the app set. No hold, no flag.
      const ok = await this.resignOutbox();
      if (!ok) this.scheduleRetry();
      return ok && !this.ended && !this.finished;
    }
    if (failed) {
      // Transient (network, hung provider); three timeouts in a row count as "no key".
      this.providerTimeouts = failed === 'TIMEOUT' ? this.providerTimeouts + 1 : 0;
      if (this.providerTimeouts >= 3) {
        this.providerTimeouts = 0;
        this.holdForKey('STALE_NO_KEY');
        return false;
      }
      this.scheduleRetry();
      return false;
    }
    this.providerTimeouts = 0;
    if (!fresh) {
      this.holdForKey('STALE_NO_KEY');
      return false;
    }
    this.keyStaleRounds++;
    this.setKeyInternal(fresh);
    const ok = await this.resignOutbox();
    if (!ok) this.scheduleRetry();
    return ok && !this.ended && !this.finished;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private setKeyInternal(k: CryptoKey): void {
    this.key = k; // batches cut from now on use it too
    this.keyBlocked = false;
  }

  /**
   * The app (or a provider) hands over a new signing key (ADR 0013 section 2 `setKey`): every
   * unsent batch is signed again from its stored body and sending resumes.
   */
  async setKey(k: CryptoKey): Promise<void> {
    if (this.ended || this.closed) return;
    this.keyStaleRounds = 0;
    this.providerTimeouts = 0;
    // A new key means the OTP resume happened and the app holds a fresh token: lift the 401 hold.
    this.auth401 = 0;
    this.authHold = false;
    this.setKeyInternal(k);
    await this.resignOutbox();
    this.retryNow();
  }

  /** After the app refreshed the candidate token: clear the 401 hold and send again. */
  resume(): void {
    this.auth401 = 0;
    this.authHold = false;
    this.retryNow();
  }

  /** The session is over for good (or taken over): stop sending and purge everything (FR-702). */
  private async endSession(reason: EndReason): Promise<void> {
    if (this.ended) return;
    this.ended = reason;
    this.closed = true;
    this.lostAtEnd = this.outbox.length + this.pending.length;
    this.outbox = [];
    this.pending = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.safely(() => this.opts.onEnded?.(reason));
    try {
      for (const k of await this.ownKeys()) await this.opts.store.delete(STORES.eventBatches, k);
    } catch {
      // best effort
    }
  }

  /** Called by the session when the OTHER stream (or the heartbeat) learned that the session ended. */
  end(reason: EndReason): Promise<void> {
    // A queue that stop() already closed keeps its outbox for the next page load.
    if (!this.started && !this.finishing) return Promise.resolve();
    return this.endSession(reason);
  }

  private scheduleRetry(minDelayMs = 0): void {
    if (this.retryTimer || this.finished || this.ended) return;
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    this.attempt++;
    const delay = Math.max(
      exp * (1 - this.jitter * Math.random()),
      Math.min(MAX_RETRY_AFTER_MS, minDelayMs),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, delay);
  }

  /**
   * Retry now (for example on the browser `online` event). Does not override Retry-After (the send
   * waits for it) and does not clear the 401 hold (only resume() does).
   */
  retryNow(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempt = 0;
    void this.drain();
  }

  stats(): BatchQueueStats {
    return {
      pendingItems: this.pending.length,
      unsentBatches: this.outbox.length,
      sentBatches: this.sent,
      rejectedBatches: this.rejected,
      droppedInvalidItems: this.invalid,
      nextSeq: this.nextSeq,
      ended: this.ended,
      lostBatches: this.lostAtEnd,
      storageDegraded: this.storageDegraded,
    };
  }

  /**
   * End of session (FR-702): flush, wait up to `drainTimeoutMs` for the outbox to empty, then delete
   * every stored batch of this session from IndexedDB. Batches that did not get through are
   * returned as `lostBatches` (and are gone: signed batches must not linger on the candidate's
   * disk). The sequence counter is KEPT: it is a small integer, not candidate data, and a
   * new queue for the same session after a reload must continue at the next seq; restarting at 0
   * would make the server acknowledge and discard new batches that reuse an old seq. The stale
   * sweep removes the counter later.
   */
  async finish(drainTimeoutMs = 15_000): Promise<{ lostBatches: number }> {
    this.finishing = true;
    await this.flush();
    const deadline = Date.now() + drainTimeoutMs;
    let lastKick = -Infinity;
    while (
      (this.outbox.length > 0 || this.pending.length > 0) &&
      Date.now() < deadline &&
      !this.ended && // the session is over: nothing more can be sent
      !this.tokenExpiredAtFinish && // post-finish 401 TOKEN_EXPIRED: the tail is lost, no retry
      !this.authHold && // repeated 401: waiting cannot help until the app resumes
      !this.keyBlocked // no usable key: waiting cannot help
    ) {
      // Normal backoff applies; only nudge a waiting retry at most once a second, so a 5xx or 429
      // outage costs a handful of requests, not hundreds.
      if (this.pending.length > 0) await this.flush(); // items recorded while we wait
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
    // Close: nothing is accepted, cut or persisted from here on, so editor text recorded after the
    // end of the test (the app may keep its reference) can never reach IndexedDB (FR-702).
    this.closed = true;
    this.finished = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.chain; // a cut that was mid-signing sees `closed` and persists nothing
    const lostBatches =
      this.outbox.length + this.pending.length + this.lostAtClose + this.lostAtEnd;
    this.outbox = [];
    this.pending = [];
    this.started = false;
    try {
      // Only this stream's batches: the other queue of the session shares the store prefix.
      for (const k of await this.ownKeys()) await this.opts.store.delete(STORES.eventBatches, k);
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
