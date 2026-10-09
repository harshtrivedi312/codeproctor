import type { RecordingStream } from '../recording/types';
import { importSessionKey } from './hmac';
import { timedFetch } from './http';
import { IdbStore } from './idb';
import { IdbKeyStore, isSigningKey, type KeyStore } from './key-store';
import { parseRetryAfter } from './transport';

/** Where each sequence continues (ADR 0013 section 2, "Sequence numbers across devices"). */
export interface ProctorCounters {
  eventSeqStart?: number;
  keystrokeSeqStart?: number;
  /** Feed this to `pipeline.seedCounters()`. */
  media?: Partial<Record<RecordingStream, { nextSeq: number; nextSegment: number }>>;
}

export interface ProctorKeyResult {
  key: CryptoKey;
  epoch: number;
  /** Null when the key came from IndexedDB (counters arrive only with a fresh key). */
  counters: ProctorCounters | null;
  source: 'NETWORK' | 'STORE';
  /** False when IndexedDB refused the key: it works now, but a reload needs an OTP resume. */
  persisted: boolean;
}

export type ProctorKeyErrorKind =
  | 'ALREADY_ISSUED' // 409 KEY_ALREADY_ISSUED: the candidate must pass the OTP again
  | 'NOT_ACTIVE' // 409 SESSION_NOT_ACTIVE
  | 'UNAUTHENTICATED' // 401 (TOKEN_EXPIRED, SESSION_TAKEN_OVER, ...)
  | 'UNAVAILABLE' // retries ran out (network, timeout, 429, 5xx) or an unexpected answer
  | 'BAD_RESPONSE'; // 200 with a body that is not a key

/** Carries the kind and the problem code only: never the key, the token or a response body. */
export class ProctorKeyError extends Error {
  constructor(
    readonly kind: ProctorKeyErrorKind,
    readonly code?: string,
  ) {
    super(`proctor-key failed: ${kind}`);
    this.name = 'ProctorKeyError';
  }
}

export interface ProctorKeyProviderOptions {
  /** API origin plus prefix, as for the transport. */
  baseUrl: string;
  sessionId: string;
  /** Test seam for `navigator.locks` (default: the browser's, when present). */
  locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
  /** IndexedDB refused the key: it works in memory, but every reload will cost an OTP resume. */
  onStorageUnavailable?: () => void;
  /**
   * The candidate token, read per request. The helper never stores, copies or logs it: it only
   * puts it in the Authorization header.
   */
  getToken: () => string;
  /** Default: IndexedDB (`<sessionId>:hmacKey` in the SDK database). */
  store?: KeyStore | IdbStore;
  fetchFn?: typeof fetch;
  path?: string;
  /** Per request, body read included (default 15 s). */
  timeoutMs?: number;
  /** Attempts for transient failures (network, timeout, 408, 429, 5xx), default 4. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The key cannot be had on this device: ALREADY_ISSUED means the app must run the OTP resume
   * (a new epoch); NOT_ACTIVE and UNAUTHENTICATED mean the session or token is gone.
   */
  onKeyUnavailable?: (why: 'ALREADY_ISSUED' | 'NOT_ACTIVE' | 'UNAUTHENTICATED') => void;
}

// Below 2^31 - 1: the next cut stores seq + 1, which must stay a valid (< 2^31) counter on reload.
const MAX_SEQ = 2 ** 31 - 2;
const isSeq = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_SEQ;

function parseCounters(raw: unknown): ProctorCounters | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const out: ProctorCounters = {};
  if (isSeq(c['eventSeqStart'])) out.eventSeqStart = c['eventSeqStart'];
  if (isSeq(c['keystrokeSeqStart'])) out.keystrokeSeqStart = c['keystrokeSeqStart'];
  const media = c['media'];
  if (typeof media === 'object' && media !== null) {
    const m: NonNullable<ProctorCounters['media']> = {};
    for (const stream of ['SCREEN', 'WEBCAM', 'AUDIO'] as const) {
      const v = (media as Record<string, unknown>)[stream];
      if (typeof v !== 'object' || v === null) continue;
      const { nextSeq, nextSegment } = v as Record<string, unknown>;
      if (isSeq(nextSeq) && isSeq(nextSegment)) m[stream] = { nextSeq, nextSegment };
    }
    out.media = m;
  }
  return out;
}

function problemCode(text: string): string {
  try {
    const j = JSON.parse(text) as { code?: unknown } | null;
    return typeof j?.code === 'string' ? j.code.slice(0, 64) : '';
  } catch {
    return '';
  }
}

/**
 * Gets the batch signing key from `POST /candidate/session/proctor-key` (ADR 0013 sections 2, 4),
 * keeps it as a NON-EXTRACTABLE CryptoKey in IndexedDB with its epoch, and reloads it after a
 * page reload without a network call. The server issues the key once per epoch, so the helper
 * never asks twice for the same epoch: `ensureKey()` returns the stored key first, concurrent
 * fetches share one request, and 409 KEY_ALREADY_ISSUED is final (the app runs the OTP resume).
 *
 * A request that timed out may still have been served: the next call then answers
 * KEY_ALREADY_ISSUED and the OTP resume is the way out (this is the ADR's fail-closed design).
 * Nothing here is ever logged; errors carry a kind and a problem code only.
 */
export class ProctorKeyProvider {
  private readonly store: KeyStore;
  private inflight: Promise<ProctorKeyResult> | null = null;
  /** Bumped by forget(): a request that started earlier must not store its key afterwards. */
  private gen = 0;
  readonly sessionId: string;

  constructor(private readonly o: ProctorKeyProviderOptions) {
    this.sessionId = o.sessionId;
    this.store =
      o.store === undefined
        ? new IdbKeyStore(new IdbStore())
        : o.store instanceof IdbStore
          ? new IdbKeyStore(o.store)
          : o.store;
  }

  /**
   * The stored key, or null. With `expectedEpoch` (the epoch of the current token, which only the
   * app knows) a key of another epoch is not returned.
   */
  async loadStoredKey(expectedEpoch?: number): Promise<ProctorKeyResult | null> {
    let stored: Awaited<ReturnType<KeyStore['get']>>;
    try {
      stored = await this.store.get(this.o.sessionId);
    } catch {
      throw new ProctorKeyError('UNAVAILABLE'); // a faulty store: no detail, never the key
    }
    if (!stored) return null;
    if (expectedEpoch !== undefined && stored.epoch !== expectedEpoch) return null;
    return {
      key: stored.key,
      epoch: stored.epoch,
      counters: null,
      source: 'STORE',
      persisted: true,
    };
  }

  /** Stored key if present, otherwise one request to the server. */
  async ensureKey(expectedEpoch?: number): Promise<ProctorKeyResult> {
    return (await this.loadStoredKey(expectedEpoch)) ?? this.fetchKey();
  }

  /** Always asks the server (after an OTP resume the epoch is new). Concurrent calls share one request. */
  fetchKey(): Promise<ProctorKeyResult> {
    this.inflight ??= this.lockedFetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Check-then-fetch inside the Web Lock `cp-key:<sessionId>` (ADR 0013 section 2): two tabs must
   * not both POST (the second would get KEY_ALREADY_ISSUED, run an OTP resume and kill the first
   * tab's epoch). Inside the lock a key that another tab stored while we waited is used instead
   * of going to the network.
   */
  private async lockedFetch(): Promise<ProctorKeyResult> {
    const before = (await this.safeGet())?.epoch;
    const run = async (): Promise<ProctorKeyResult> => {
      const now = await this.safeGet();
      if (now && (before === undefined || now.epoch > before)) {
        return { key: now.key, epoch: now.epoch, counters: null, source: 'STORE', persisted: true };
      }
      return this.run();
    };
    const locks =
      this.o.locks ??
      (typeof navigator !== 'undefined'
        ? (navigator as { locks?: ProctorKeyProviderOptions['locks'] }).locks
        : undefined);
    return locks ? locks.request(`cp-key:${this.o.sessionId}`, run) : run();
  }

  private async safeGet(): Promise<{ key: CryptoKey; epoch: number } | null> {
    try {
      return await this.store.get(this.o.sessionId);
    } catch {
      return null;
    }
  }

  /**
   * Pull-style adapter for `ProctorSessionConfig.keyProvider`: the key after KEY_EPOCH_STALE, or
   * null when this device cannot get one (the hook has already told the app).
   */
  async getKey(): Promise<ProctorKeyResult | null> {
    try {
      return await this.fetchKey();
    } catch (err) {
      if (err instanceof ProctorKeyError && err.kind !== 'UNAVAILABLE') return null;
      throw err; // transient: the queue retries
    }
  }

  /** Remove the stored key (finish and purge do this too). */
  async forget(): Promise<void> {
    this.gen++; // a request in flight will not store its key
    await this.store.delete(this.o.sessionId);
  }

  private async run(): Promise<ProctorKeyResult> {
    const f = this.o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const gen = this.gen;
    const attempts = Math.max(1, this.o.maxAttempts ?? 4);
    const base = this.o.backoffBaseMs ?? 1000;
    const max = this.o.backoffMaxMs ?? 15_000;
    for (let attempt = 0; ; attempt++) {
      let retryAfterMs: number | undefined;
      let token: string;
      try {
        token = this.o.getToken();
      } catch {
        this.fail('UNAUTHENTICATED'); // no token: final, nothing to retry
      }
      try {
        const a = await timedFetch(
          f,
          `${this.o.baseUrl}${this.o.path ?? '/candidate/session/proctor-key'}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          },
          this.o.timeoutMs ?? 15_000,
        );
        if (a.ok) return await this.accept(a.text, gen);
        const code = problemCode(a.text);
        if (code === 'KEY_ALREADY_ISSUED') this.fail('ALREADY_ISSUED', code);
        if (code === 'SESSION_NOT_ACTIVE') this.fail('NOT_ACTIVE', code);
        if (a.status === 401) this.fail('UNAUTHENTICATED', code || undefined);
        if (a.status === 408 || a.status === 429 || a.status >= 500) {
          retryAfterMs = parseRetryAfter(a.retryAfter);
        } else {
          throw new ProctorKeyError('UNAVAILABLE', code || undefined); // other 4xx: will not succeed
        }
      } catch (err) {
        if (err instanceof ProctorKeyError) throw err;
        // network error or timeout: transient
      }
      if (attempt + 1 >= attempts) throw new ProctorKeyError('UNAVAILABLE');
      const exp = Math.min(max, base * 2 ** attempt);
      await sleep(Math.max(exp, Math.min(retryAfterMs ?? 0, 300_000)));
    }
  }

  private fail(kind: 'ALREADY_ISSUED' | 'NOT_ACTIVE' | 'UNAUTHENTICATED', code?: string): never {
    try {
      this.o.onKeyUnavailable?.(kind);
    } catch {
      // a faulty app callback must not hide the error
    }
    throw new ProctorKeyError(kind, code);
  }

  private async accept(text: string, gen: number): Promise<ProctorKeyResult> {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProctorKeyError('BAD_RESPONSE');
    }
    const keyB64 = j['key'];
    const epoch = j['keyEpoch'];
    if (
      j['alg'] !== 'HMAC-SHA256' ||
      typeof keyB64 !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=?$/.test(keyB64) || // 32 bytes of base64
      typeof epoch !== 'number' ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0
    ) {
      throw new ProctorKeyError('BAD_RESPONSE');
    }
    const key = await importSessionKey(keyB64); // non-extractable
    if (!isSigningKey(key)) throw new ProctorKeyError('BAD_RESPONSE');
    let persisted = true;
    if (gen !== this.gen) {
      persisted = false; // forgotten (finish or purge) while the request was in flight: do not store
    } else {
      try {
        await this.store.put(this.o.sessionId, { key, epoch });
        if (gen !== this.gen) {
          await this.store.delete(this.o.sessionId); // forgotten while the put was running
          persisted = false;
        }
      } catch {
        persisted = false; // IndexedDB unusable: the key works in memory, a reload needs an OTP resume
        try {
          this.o.onStorageUnavailable?.();
        } catch {
          // ignore
        }
      }
    }
    return { key, epoch, counters: parseCounters(j['counters']), source: 'NETWORK', persisted };
  }
}
