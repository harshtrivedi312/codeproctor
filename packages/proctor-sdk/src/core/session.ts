import type {
  ClientEventType,
  ClientProctorEvent,
  EventPayload,
  ProctorDetector,
} from '@codeproctor/shared';
import {
  ProviderTimeoutError,
  type BatchQueueStats,
  type EndReason,
  type SendResult,
  type SignedBatch,
} from './batch-queue';
import { EventQueue, type EventQueueStats, type EventTransport } from './event-queue';
import { KeystrokeQueue } from '../keystrokes/keystroke-queue';
import { KeystrokeRecorder, type UnrepresentableReason } from '../keystrokes/recorder';
import {
  FLAG_DETAIL_MAX,
  FlagReporter,
  cutDetail,
  sanitizeRecorder,
  type HeartbeatBody,
  type HealthSnapshot,
  type HeartbeatState,
  type TokenRenewal,
} from './health';
import { Heartbeat } from './heartbeat';
import type { HeartbeatResult } from './transport';
import { importSessionKey } from './hmac';
import { IdbStore, STORES } from './idb';
import { IdbKeyStore, isSigningKey, type KeyStore } from './key-store';
import type { ProctorCounters } from './proctor-key';
import { SessionTouch } from './sweep';
import { MetricsCollector, type Metrics } from './metrics';
import {
  ConsentRequiredError,
  type CapabilityFlag,
  type Detector,
  type DetectorContext,
  type EmitOptions,
  type LockState,
} from './types';

/** Flags only the SDK raises: an app reporting one of these is ignored (no forging, no clashes). */
const SDK_OWNED_FLAGS = new Set([
  'idb',
  'signing-key',
  'event-seq',
  'event-rejected',
  'keystroke-seq-reset',
  'keystroke-rejected',
  'keystroke-unrepresentable',
  'keystrokes',
  'batches-lost',
  'finish-lost',
  'finish-pending',
  'heartbeat-body-rejected',
]);

/**
 * Supplies a new signing key after the server answered 409 KEY_EPOCH_STALE (ADR 0013); without
 * one, stale batches are held and kept, never dropped. `ProctorKeyProvider` is the real one.
 */
export interface KeyProvider {
  /** Session this provider serves; start() refuses a provider of another session. */
  readonly sessionId?: string;
  /** Delete whatever the provider stored and refuse to store from requests still in flight. */
  forget?(): Promise<void>;
  /**
   * The new key as base64, as a CryptoKey, or as a `ProctorKeyProvider` result (key, epoch,
   * counters); null when none can be had.
   */
  getKey(): Promise<
    | string
    | CryptoKey
    | { key: CryptoKey; epoch?: number; counters?: ProctorCounters | null; persisted?: boolean }
    | null
  >;
}

export interface ProctorSessionConfig {
  sessionId: string;
  /**
   * Per-session HMAC key (base64) when the app has the raw value. Prefer `signingKey` (the
   * non-extractable result of `ProctorKeyProvider`). One of the two is required.
   * Held in memory only.
   * TODO(ARC-03): ADR 0010 leaves open how events sent before this key exists (system-check
   * events such as MULTI_MONITOR) are signed. Not invented here: the SDK cannot start without a key.
   */
  hmacKeyBase64?: string;
  /**
   * Key, epoch and counters from `ProctorKeyProvider` (ADR 0013 section 2). The counters seed the
   * event and keystroke sequences at max(local, server) BEFORE anything is cut; seed the media
   * pipeline with `counters.media` via `pipeline.seedCounters()`.
   */
  signingKey?: {
    key: CryptoKey;
    epoch?: number;
    counters?: ProctorCounters | null;
    /** `ProctorKeyProvider` result: false means IndexedDB refused the key (`idb` flag). */
    persisted?: boolean;
  };
  /** Where the key is stored; default IndexedDB. Share the helper's store so purges reach it. */
  keyStore?: KeyStore;
  /** Scope of clipboard, drop and context-menu blocking. */
  root: HTMLElement;
  /** Nothing touches camera, microphone or screen until this is set (D-17). */
  consent: { recordedAt: string } | null;
  transport: EventTransport & {
    heartbeat(body?: HeartbeatBody): Promise<HeartbeatResult>;
    /**
     * Sends one signed keystroke batch (POST /candidate/session/keystrokes). Without it the session
     * has no keystroke recorder (`session.keystrokes` is null) and says so with the `keystrokes`
     * capability flag.
     */
    sendKeystrokeBatch?(batch: SignedBatch): Promise<SendResult>;
  };
  /** Optional: how to get a new signing key after KEY_EPOCH_STALE (see KeyProvider). */
  keyProvider?: KeyProvider;
  /** A hung `keyProvider.getKey()` is given up after this long (default 10 s). */
  keyProviderTimeoutMs?: number;
  /** Consecutive 401 answers before sending stops and `onReauthRequired` is raised (default 3). */
  authLostAfter?: number;
  /**
   * ADR 0013 section 2: raised when a batch signed with the current key is refused as
   * KEY_EPOCH_STALE and no newer key is available (no `keyProvider`, or it returned null). The app
   * fetches the key (or runs the OTP resume) and hands it to `session.setKey()`.
   */
  onKeyStale?: () => void;
  /**
   * ADR 0013 section 5.2: raised on SESSION_TAKEN_OVER and after repeated 401 (TOKEN_EXPIRED).
   * Sending has stopped (taken over: the outbox is purged; 401: batches stay persisted until the
   * app refreshed the token and calls `session.resume()`).
   */
  onReauthRequired?: (reason: 'TOKEN_EXPIRED' | 'UNAUTHENTICATED' | 'SESSION_TAKEN_OVER') => void;
  /** Detectors the accommodations switched off (FR-106). They never start. */
  disabledDetectors?: readonly ProctorDetector[];
  detectors: readonly Detector[];
  store?: IdbStore;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /**
   * Health the app can see and the session cannot (ADR 0013 section 5.3 `getHealth()`): the
   * recorder block, for example `() => ({ recorder: pipeline.heartbeatHealth() })`. Counts only.
   */
  getHealth?: () => HealthSnapshot | null;
  /**
   * The server renewed the candidate token on a heartbeat. The SDK passes it through and never
   * stores or logs it; the app must use it for every later call.
   */
  onToken?: (t: TokenRenewal) => void;
  /** Server state of the latest acknowledged heartbeat (status, deadlines, pause reasons). */
  onHeartbeat?: (s: HeartbeatState) => void;
  backoffBaseMs?: number;
  /** A detector whose start() takes longer than this is abandoned (default 45 s). */
  detectorStartTimeoutMs?: number;
  /** After a start timeout, stop() of the abandoned detector is given this long (default 5 s). */
  detectorStopTimeoutMs?: number;
}

export interface SessionEvents {
  event: ClientProctorEvent;
  lock: LockState;
  capability: CapabilityFlag;
  connection: { online: boolean };
  /** The server says the session is over (or taken over). Sending has stopped and unsent batches were purged. */
  ended: { reason: EndReason; lostBatches: number };
}
type Handler<K extends keyof SessionEvents> = (payload: SessionEvents[K]) => void;

/** Thrown by withTimeout when a detector's start() does not settle in time. */
class StartTimeoutError extends Error {}

/** Rejects with StartTimeoutError when `p` has not settled in `ms`. */
function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StartTimeoutError('detector start timed out')), ms);
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Entry point of the SDK. start() wires detectors (plug-ins) to the signed event queue and the
 * heartbeat; on() lets the UI react (pause the editor on a lock, show a capability notice).
 */
export class ProctorSession {
  private handlers: { [K in keyof SessionEvents]: Set<Handler<K>> } = {
    event: new Set(),
    lock: new Set(),
    capability: new Set(),
    connection: new Set(),
    ended: new Set(),
  };
  private currentKey: CryptoKey | null = null;
  /** Bumped by setKey(): a provider answer that started earlier must not overwrite it. */
  private keyGen = 0;
  /** The key was purged (finish, taken over, session over): nothing may store it again. */
  private keyPurged = false;
  /** Monotonic (never reset): a put that started before a purge deletes its row afterwards. */
  private purgeGen = 0;
  private keyStore: KeyStore | null = null;
  private touch: SessionTouch | null = null;
  private reauthSignalled = false;
  private takenOverSignalled = false;
  private keyRefresh: Promise<CryptoKey | null> | null = null;
  private endedFired = false;
  private queuesEnded = false;
  private stopping = false;
  /** handleEnded is running its purge: re-entrant calls (from queue onEnded) wait for the outer one. */
  private ending = false;
  private eventRejected = 0;
  private keystrokeRejected = 0;
  private queue: EventQueue | null = null;
  private keystrokeQueue: KeystrokeQueue | null = null;
  private keystrokeRecorder: KeystrokeRecorder | null = null;
  private store: IdbStore | null = null;
  private heartbeat: Heartbeat | null = null;
  private flags: FlagReporter | null = null;
  /** What each IndexedDB user reports; the single `idb` flag is their worst status (ADR 0013 section 2). */
  private readonly idbParts = new Map<string, CapabilityFlag>();
  private idbShown: string | null = null;
  /** Bumped by start() and at the end of shutdown(): an async call from an earlier run must not touch this one. */
  private startGen = 0;
  private bodyRejectedFlagged = false;
  private started: Detector[] = [];
  private metrics: MetricsCollector | null = null;
  private config: ProctorSessionConfig | null = null;
  private capabilities = new Map<string, CapabilityFlag>();
  private locks = new Map<string, boolean>();
  private readonly onPageHide = (): void => {
    void this.queue?.flush();
    void this.keystrokeQueue?.flush();
  };
  private readonly onOnline = (): void => {
    this.queue?.retryNow();
    this.keystrokeQueue?.retryNow();
  };

  /**
   * Editor change recorder for replay (FR-608, TC-062), or null before start() or when the
   * transport cannot send keystroke batches. Flushed by stop() and purged by finish() like events.
   */
  get keystrokes(): KeystrokeRecorder | null {
    return this.keystrokeRecorder;
  }

  getKeystrokeStats(): BatchQueueStats | null {
    return this.keystrokeQueue?.stats() ?? null;
  }

  on<K extends keyof SessionEvents>(name: K, handler: Handler<K>): () => void {
    this.handlers[name].add(handler);
    return () => this.handlers[name].delete(handler);
  }

  private fire<K extends keyof SessionEvents>(name: K, payload: SessionEvents[K]): void {
    if (name === 'capability') this.flags?.record(payload as CapabilityFlag);
    for (const h of this.handlers[name]) {
      try {
        h(payload);
      } catch {
        // A faulty UI handler must never break proctoring.
      }
    }
  }

  async start(config: ProctorSessionConfig): Promise<void> {
    if (!config.consent?.recordedAt) throw new ConsentRequiredError();
    if (this.config) throw new Error('ProctorSession already started.');
    this.config = config;
    this.startGen++;
    const metrics = (this.metrics = new MetricsCollector());
    this.flags = new FlagReporter();
    const key =
      config.signingKey?.key ??
      (config.hmacKeyBase64 ? await importSessionKey(config.hmacKeyBase64) : null);
    if (!key) throw new Error('ProctorSession needs a signing key (signingKey or hmacKeyBase64).');
    if (!isSigningKey(key)) {
      throw new Error('The signing key must be a non-extractable HMAC-SHA-256 key (ADR 0013).');
    }
    const providerSession = config.keyProvider?.sessionId;
    if (providerSession !== undefined && providerSession !== config.sessionId) {
      throw new Error('keyProvider belongs to another session.');
    }
    this.currentKey = key;
    const counters = config.signingKey?.counters ?? null;
    // Hooks both queues share: key rotation, end of session, lost authentication.
    const shared = () => ({
      ...(config.keyProvider ? { onKeyStale: (stale: CryptoKey) => this.refreshKey(stale) } : {}),
      ...(config.authLostAfter === undefined ? {} : { authLostAfter: config.authLostAfter }),
      ...(config.keyProviderTimeoutMs === undefined
        ? {}
        : { keyProviderTimeoutMs: config.keyProviderTimeoutMs }),
      onKeyRestored: () => {
        // SUPPORTED only when neither queue is still held for a key.
        if (this.queue?.stats().keyBlocked || this.keystrokeQueue?.stats().keyBlocked) return;
        this.fire('capability', { id: 'signing-key', status: 'SUPPORTED' });
      },
      onKeyUnavailable: (why: 'STALE_NO_KEY' | 'ALREADY_ISSUED') => {
        if (why === 'STALE_NO_KEY') {
          try {
            config.onKeyStale?.();
          } catch {
            // ignore
          }
        }
        this.fire('capability', {
          id: 'signing-key',
          status: 'UNVERIFIABLE',
          detail:
            why === 'ALREADY_ISSUED'
              ? 'The signing key could not be obtained again: batches are held, not dropped.'
              : 'The signing key was rotated and no new key is available: batches are held, not dropped.',
        });
      },
      onEnded: (reason: EndReason) => this.handleEnded(reason, 'batch'),
      onReauthRequired: (reason: 'TOKEN_EXPIRED' | 'UNAUTHENTICATED') => {
        if (this.reauthSignalled) return; // once per episode, not once per queue
        this.reauthSignalled = true;
        try {
          config.onReauthRequired?.(reason);
        } catch {
          // a faulty app callback must not stall the queue
        }
      },
    });
    const store = (this.store = config.store ?? new IdbStore()); // shared by the event and keystroke queues
    this.keyStore = config.keyStore ?? new IdbKeyStore(store);
    this.touch = new SessionTouch(store, config.sessionId);
    if (config.signingKey?.persisted === false) {
      this.fireIdbUnsupported(); // the helper already failed to store it: do not try (and flag) again
    } else if (config.signingKey?.epoch !== undefined) {
      await this.persistKey(key, config.signingKey.epoch);
    }
    const queue = (this.queue = new EventQueue({
      sessionId: config.sessionId,
      key,
      transport: config.transport,
      store,
      ...shared(),
      ...(counters?.eventSeqStart === undefined ? {} : { initialSeq: counters.eventSeqStart }),
      onRejected: () => {
        this.eventRejected++;
        this.fire('capability', {
          id: 'event-rejected',
          status: 'UNVERIFIABLE',
          detail: `${this.eventRejected} event batches were refused by the server.`,
        });
      },
      ...(config.flushIntervalMs === undefined ? {} : { flushIntervalMs: config.flushIntervalMs }),
      ...(config.backoffBaseMs === undefined ? {} : { backoffBaseMs: config.backoffBaseMs }),
      onSeqUntrusted: () =>
        this.fire('capability', {
          id: 'event-seq',
          status: 'UNVERIFIABLE',
          detail:
            'The batch counter could not be read; sequence numbers jump ahead (holes, no collisions).',
        }),
      onStorageRecovered: () => this.setIdb('event', null),
      onStorageDegraded: (reason) =>
        this.setIdb('event', {
          status: reason === 'OPEN_FAILED' ? 'UNSUPPORTED' : 'UNVERIFIABLE',
          detail:
            reason === 'OPEN_FAILED'
              ? 'event batches: IndexedDB unavailable'
              : 'event batches: writes failing',
        }),
    }));
    await queue.start();
    const send = config.transport.sendKeystrokeBatch?.bind(config.transport);
    if (send) {
      const ks = (this.keystrokeQueue = new KeystrokeQueue({
        sessionId: config.sessionId,
        key,
        transport: { sendBatch: send },
        store,
        ...shared(),
        ...(counters?.keystrokeSeqStart === undefined
          ? {}
          : { initialSeq: counters.keystrokeSeqStart }),
        ...(config.backoffBaseMs === undefined ? {} : { backoffBaseMs: config.backoffBaseMs }),
        onSeqUntrusted: () =>
          this.fire('capability', {
            id: 'keystroke-seq-reset',
            status: 'UNVERIFIABLE',
            detail: 'The keystroke batch counter could not be read; sequence numbers jump ahead.',
          }),
        onStorageDegraded: () =>
          this.setIdb('keystroke', {
            status: 'UNVERIFIABLE',
            detail: 'keystroke batches: IndexedDB problem',
          }),
        onStorageRecovered: () => this.setIdb('keystroke', null),
        onRejected: () => {
          // The server refused a keystroke batch for good: say so (a count, no content).
          this.keystrokeRejected++;
          this.fire('capability', {
            id: 'keystroke-rejected',
            status: 'UNVERIFIABLE',
            detail: `${this.keystrokeRejected} batches of editor changes were refused by the server; replay of this period is incomplete.`,
          });
        },
      }));
      await ks.start();
      this.keystrokeRecorder = new KeystrokeRecorder(
        ks,
        Date.now,
        (reason: UnrepresentableReason) =>
          // Reasons only, never editor text.
          this.fire('capability', {
            id: 'keystroke-unrepresentable',
            status: 'UNVERIFIABLE',
            detail: `An editor change could not be recorded (${reason}); replay of this question may diverge.`,
          }),
      );
      this.fire('capability', { id: 'keystrokes', status: 'SUPPORTED' });
    } else {
      this.fire('capability', {
        id: 'keystrokes',
        status: 'UNSUPPORTED',
        detail: 'The transport cannot send keystroke batches; editor changes are not recorded.',
      });
    }

    const disabled = new Set(config.disabledDetectors ?? []);
    const ctx: DetectorContext = {
      emit: <T extends ClientEventType>(type: T, payload: EventPayload<T>, o: EmitOptions = {}) =>
        this.emit(type, payload, o),
      root: config.root,
      setCapability: (f) => {
        this.capabilities.set(f.id, f);
        this.fire('capability', f);
      },
      setLock: (s) => {
        if (this.locks.get(s.reason) === s.locked) return;
        this.locks.set(s.reason, s.locked);
        this.fire('lock', s);
      },
      assertConsent: () => {
        if (!this.config?.consent?.recordedAt) throw new ConsentRequiredError();
      },
      measure: metrics.measure,
      isDisabled: (d) => disabled.has(d),
    };

    // Heartbeat and page listeners first: a slow or hanging detector must not delay them (FR-609).
    this.heartbeat = new Heartbeat(
      async () => {
        // A live session keeps its retention mark fresh (and so its stored key) through a long
        // outage: another tab's stale sweep must never remove it.
        void this.touch?.touch();
        const { body, commit } = this.beatBody();
        const r = await config.transport.heartbeat(body);
        if (r === true || (typeof r === 'object' && 'ok' in r)) commit(); // acknowledged
        return r;
      },
      config.heartbeatIntervalMs ?? 10_000,
      (online) => this.fire('connection', { online }),
      (reason) => this.handleEnded(reason, 'heartbeat'),
      {
        ...(config.authLostAfter === undefined ? {} : { authLostAfter: config.authLostAfter }),
        onResync: () => this.flags?.forceFull(),
        onOk: (r) => {
          if (r.bodyRejected && !this.bodyRejectedFlagged) {
            // The server refused the health body (400 or 413): counts only, raised once.
            this.bodyRejectedFlagged = true;
            this.fire('capability', {
              id: 'heartbeat-body-rejected',
              status: 'UNVERIFIABLE',
              detail: 'The server refused the heartbeat health body; beats go out without it.',
            });
          }
          if (r.renewal) config.onToken?.(r.renewal);
          if (r.state) config.onHeartbeat?.(r.state);
        },
        onAuthLost: (code) => {
          if (this.reauthSignalled) return; // once per episode, not once per route
          this.reauthSignalled = true;
          config.onReauthRequired?.(code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
        },
      },
    );
    this.heartbeat.start();
    globalThis.addEventListener?.('pagehide', this.onPageHide);
    globalThis.addEventListener?.('online', this.onOnline);

    for (const d of config.detectors) {
      if (d.accommodationId && disabled.has(d.accommodationId)) continue;
      this.started.push(d);
      // A per-detector context that goes silent if the detector is abandoned, so a late start()
      // cannot emit events or flags after DETECTOR_UNAVAILABLE was reported.
      let abandoned = false;
      const dctx: DetectorContext = {
        ...ctx,
        emit: (type, payload, o) => {
          if (!abandoned) ctx.emit(type, payload, o);
        },
        setCapability: (f) => {
          if (!abandoned) ctx.setCapability(f);
        },
        setLock: (l) => {
          if (!abandoned) ctx.setLock(l);
        },
      };
      try {
        await withTimeout(d.start(dctx), config.detectorStartTimeoutMs ?? 45_000);
      } catch (err) {
        if (err instanceof StartTimeoutError) {
          abandoned = true;
          // Abandon cleanly: report, stop best-effort and forget it, so no half-started detector
          // keeps timers or streams alive.
          try {
            if (d.reportStartTimeout) d.reportStartTimeout(ctx);
            else ctx.setCapability({ id: d.id, status: 'UNVERIFIABLE', detail: 'start timed out' });
          } catch {
            // ignore
          }
          try {
            await withTimeout(d.stop(), config.detectorStopTimeoutMs ?? 5000);
          } catch {
            // best effort (a stop() that hangs must not block the session start)
          }
          this.started = this.started.filter((x) => x !== d);
        }
        // One broken detector must not stop the others; say so instead of passing silently.
        if (d.accommodationId) {
          this.emit('DETECTOR_UNAVAILABLE', {
            detector: d.accommodationId,
            reason: 'RUNTIME_ERROR',
          });
        }
      }
    }
  }

  private emit<T extends ClientEventType>(
    type: T,
    payload: EventPayload<T>,
    o: EmitOptions = {},
  ): void {
    const event = {
      type,
      occurredAt: (o.occurredAt ?? new Date()).toISOString(),
      payload,
      ...(o.durationMs === undefined ? {} : { durationMs: Math.round(o.durationMs) }),
      ...(o.confidence === undefined ? {} : { confidence: o.confidence }),
      ...(o.evidenceKey === undefined ? {} : { evidenceKey: o.evidenceKey }),
    };
    if (this.queue?.enqueue(event)) this.fire('event', event as ClientProctorEvent);
  }

  /** Flags for everything that could not be checked in this browser. */
  getCapabilities(): CapabilityFlag[] {
    return [...this.capabilities.values()];
  }

  getMetrics(): Metrics | null {
    return this.metrics?.snapshot() ?? null;
  }

  getQueueStats(): EventQueueStats | null {
    return this.queue?.stats() ?? null;
  }

  /**
   * Stop and purge: flushes the event queue (bounded), then deletes this session's batches from
   * IndexedDB (FR-702). The `nextEventSeq` counter is kept so a reload continues the sequence.
   * Call at the end of a test; stop() keeps unsent batches for a reload.
   */
  async finish(drainTimeoutMs = 15_000): Promise<{ lostBatches: number }> {
    return this.shutdown(drainTimeoutMs);
  }

  /**
   * One key refresh at a time, shared by both queues: a queue whose current key has already been
   * replaced gets the newest key without asking the provider again (the server issues a key only
   * once per epoch).
   */
  private refreshKey(stale: CryptoKey): Promise<CryptoKey | null> {
    const provider = this.config?.keyProvider;
    if (!provider) return Promise.resolve(null);
    if (this.currentKey && this.currentKey !== stale) return Promise.resolve(this.currentKey);
    const gen = this.keyGen;
    const ms = this.config?.keyProviderTimeoutMs ?? 10_000;
    if (this.keyRefresh) return this.keyRefresh;
    let run: Promise<CryptoKey | null> | null = null;
    run = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // `.then` so a synchronous throw of getKey() becomes a rejection after the promise is stored.
        const got = await Promise.race([
          Promise.resolve().then(() => provider.getKey()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ProviderTimeoutError()), ms);
          }),
        ]);
        if (gen !== this.keyGen) return this.currentKey; // setKey() won the race
        if (!got) return null;
        const adopted = await this.adoptKey(got);
        if (gen !== this.keyGen) return this.currentKey;
        if (!isSigningKey(adopted.key)) return null; // never sign with, or keep, an extractable key
        this.currentKey = adopted.key;
        if (adopted.persisted === false) this.fireIdbUnsupported();
        if (adopted.epoch !== undefined) await this.persistKey(adopted.key, adopted.epoch);
        await this.seedCounters(adopted.counters);
        return adopted.key;
      } finally {
        clearTimeout(timer);
        if (this.keyRefresh === run) this.keyRefresh = null; // never clear a newer session's refresh
      }
    })();
    this.keyRefresh = run;
    return this.keyRefresh;
  }

  /** String (base64), CryptoKey, or a `ProctorKeyProvider` result, as a non-extractable key. */
  private async adoptKey(
    got:
      | string
      | CryptoKey
      | { key: CryptoKey; epoch?: number; counters?: ProctorCounters | null; persisted?: boolean },
  ): Promise<{
    key: CryptoKey;
    epoch?: number;
    counters?: ProctorCounters | null;
    persisted?: boolean;
  }> {
    if (typeof got === 'string') return { key: await importSessionKey(got) };
    // A provider result is a plain object with `key`; a bare CryptoKey has no such property.
    if ('key' in got) return got;
    return { key: got };
  }

  /** Stores the key with its epoch (ADR 0013 section 2); a failure only costs the reload. */
  private async persistKey(key: CryptoKey, epoch: number): Promise<void> {
    const sid = this.config?.sessionId;
    const ks = this.keyStore;
    if (!sid || !ks || this.keyPurged) return;
    const gen = this.purgeGen;
    try {
      await ks.put(sid, { key, epoch });
      // The session was purged while the put ran (also across a stop() and a new start()): take
      // the row out again.
      if (this.keyPurged || gen !== this.purgeGen) await ks.delete(sid).catch(() => undefined);
      else this.setIdb('key', null); // stored: a failure reported earlier is over
    } catch {
      this.fireIdbUnsupported();
    }
  }

  private fireIdbUnsupported(): void {
    this.setIdb('key', {
      status: 'UNSUPPORTED',
      detail: 'signing key cannot be kept: every reload needs a new sign-in',
    });
  }

  /**
   * One `idb` flag (ADR 0013 section 2) from several users of IndexedDB: UNSUPPORTED if any part
   * cannot use it at all, UNVERIFIABLE if it only fails to write, SUPPORTED when all recovered.
   * Parts: event, keystroke, key, recording. Details are reasons only.
   */
  private setIdb(
    part: string,
    f: { status: CapabilityFlag['status']; detail: string } | null,
  ): void {
    if (f) this.idbParts.set(part, { id: 'idb', status: f.status, detail: f.detail });
    else this.idbParts.delete(part);
    const flags = [...this.idbParts.values()];
    const status: CapabilityFlag['status'] =
      flags.length === 0
        ? 'SUPPORTED'
        : flags.some((x) => x.status === 'UNSUPPORTED')
          ? 'UNSUPPORTED'
          : 'UNVERIFIABLE';
    const detail = flags.map((x) => x.detail).join('; ');
    const shown = `${status}:${detail}`;
    if (this.idbShown === null && status === 'SUPPORTED') return; // never degraded: nothing to say
    if (shown === this.idbShown) return;
    this.idbShown = shown;
    this.fire('capability', {
      id: 'idb',
      status,
      ...(detail ? { detail: cutDetail(detail, FLAG_DETAIL_MAX) } : {}),
    });
  }

  /**
   * The app reports a flag the session cannot see (for example the recording pipeline's
   * `onCapability`). It is shown to listeners and sent with the next heartbeat. The pipeline's
   * `recording-storage` flag is folded into the single `idb` flag.
   */
  reportCapability(flag: CapabilityFlag): void {
    if (SDK_OWNED_FLAGS.has(flag.id)) return; // the SDK raises these itself; an app must not forge them
    if (flag.id === 'recording-storage') {
      this.setIdb(
        'recording',
        flag.status === 'SUPPORTED'
          ? null
          : { status: flag.status, detail: 'recording chunks: IndexedDB problem' },
      );
      return;
    }
    this.capabilities.set(flag.id, flag);
    this.fire('capability', flag);
  }

  /**
   * Reachability probe for the recording pipeline (`probe` option): true when the heartbeat is
   * getting through. A fresh acknowledged beat answers at once, otherwise one beat is sent now.
   */
  async probe(): Promise<boolean> {
    const hb = this.heartbeat;
    if (!hb) return false;
    const fresh =
      hb.online &&
      hb.lastOkAt !== null &&
      Date.now() - hb.lastOkAt < (this.config?.heartbeatIntervalMs ?? 10_000) * 1.5;
    return fresh ? true : hb.beatNow();
  }

  /** The body of the next beat: changed flags (or all, every 5 minutes), recorder and queue health. */
  private beatBody(): { body: HeartbeatBody; commit: () => void } {
    const body: HeartbeatBody = {};
    const take = this.flags?.take();
    if (take && take.flags.length > 0) body.capabilities = take.flags;
    try {
      // Only the known numeric fields are copied: counts only, whatever the app returns.
      const rec = sanitizeRecorder(this.config?.getHealth?.()?.recorder);
      if (rec) body.recorder = rec;
    } catch {
      // a faulty provider must not stop the beat
    }
    const ev = this.queue?.stats();
    const ks = this.keystrokeQueue?.stats();
    body.queue = {
      pendingEventBatches: (ev?.unsentBatches ?? 0) + ((ev?.pendingItems ?? 0) ? 1 : 0),
      pendingKeystrokeBatches: (ks?.unsentBatches ?? 0) + ((ks?.pendingItems ?? 0) ? 1 : 0),
      rejectedBatches: (ev?.rejectedBatches ?? 0) + (ks?.rejectedBatches ?? 0),
    };
    return { body, commit: () => take?.commit() };
  }

  /**
   * The key must not outlive the data it signed: delete it from the session's store and from the
   * provider's (which also refuses to store from requests still in flight). `keyPurged` is set
   * first, so nothing stores it again.
   */
  private async purgeKey(): Promise<void> {
    this.keyPurged = true;
    this.purgeGen++;
    const sid = this.config?.sessionId;
    const ks = this.keyStore;
    const provider = this.config?.keyProvider;
    if (sid && ks) await ks.delete(sid).catch(() => undefined);
    await provider?.forget?.().catch(() => undefined);
  }

  /** Server counters from `proctor-key`: each sequence continues at max(local, server). */
  private async seedCounters(c: ProctorCounters | null | undefined): Promise<void> {
    if (!c) return;
    await Promise.all([
      c.eventSeqStart === undefined ? undefined : this.queue?.seedSeq(c.eventSeqStart),
      c.keystrokeSeqStart === undefined
        ? undefined
        : this.keystrokeQueue?.seedSeq(c.keystrokeSeqStart),
    ]);
  }

  /**
   * ADR 0013 section 2 `setKey`: the app hands over a new signing key (base64 or the CryptoKey of
   * `ProctorKeyProvider`) with its epoch and the server counters. The key is stored non-extractable
   * with the epoch, both queues sign their unsent batches again from the stored bodies (same
   * bodies, same seqs), the 401 hold is lifted and sending resumes. Counters raise the event and
   * keystroke sequences to max(local, server); seed the media pipeline with `counters.media`.
   * After the session was purged (finish, taken over, session over) this does nothing: restart
   * with `stop()` and a new `start()`.
   */
  async setKey(
    hmacKey: string | CryptoKey,
    epoch?: number,
    counters?: ProctorCounters | null,
  ): Promise<void> {
    if (!this.config || this.keyPurged) return; // a purged session never takes a key again
    const run = this.startGen; // a setKey that hangs across stop() and start() must not re-key the new run
    const stale = (): boolean => run !== this.startGen || !this.config || this.keyPurged;
    const key = typeof hmacKey === 'string' ? await importSessionKey(hmacKey) : hmacKey;
    if (!isSigningKey(key)) {
      throw new Error('The signing key must be a non-extractable HMAC-SHA-256 key (ADR 0013).');
    }
    if (stale()) return;
    this.currentKey = key;
    this.keyGen++;
    this.reauthSignalled = false; // a fresh key comes with a fresh token (OTP resume)
    this.heartbeat?.resume();
    if (epoch !== undefined) await this.persistKey(key, epoch);
    if (stale()) return;
    await this.seedCounters(counters); // before anything is cut with the new key
    if (stale()) return;
    await Promise.all([this.queue?.setKey(key), this.keystrokeQueue?.setKey(key)]);
  }

  /** Epoch of the key stored for this session, or null (ADR 0013 `loadStoredKey`). Never returns the key. */
  static async loadStoredKey(
    sessionId: string,
    store: IdbStore = new IdbStore(),
  ): Promise<{ epoch: number } | null> {
    try {
      const stored = await new IdbKeyStore(store).get(sessionId);
      return stored ? { epoch: stored.epoch } : null;
    } catch {
      return null; // unreadable store: the app asks the server
    }
  }

  /** The app refreshed the candidate token after `onReauthRequired`: send again. */
  resume(): void {
    this.reauthSignalled = false;
    this.heartbeat?.resume();
    this.queue?.resume();
    this.keystrokeQueue?.resume();
  }

  /**
   * The server said the session is over. `source` matters (ADR 0013 section 2, ingest close): the
   * heartbeat refuses as soon as the session is no longer IN_PROGRESS or PAUSED, but the batch
   * routes keep accepting during the post-submit grace. So a heartbeat SESSION_NOT_ACTIVE only
   * stops the heartbeat and tells the UI; the queues keep draining. A batch-route
   * SESSION_NOT_ACTIVE (after the grace) and SESSION_TAKEN_OVER from either source stop and purge.
   */
  private handleEnded(reason: EndReason, source: 'heartbeat' | 'batch'): void {
    if (!this.config || this.stopping || this.ending) return; // after stop() the kept outbox belongs to the next load
    const purge = source === 'batch' || reason === 'TAKEN_OVER';
    if (purge && !this.queuesEnded) {
      this.queuesEnded = true;
      this.ending = true;
      this.keystrokeRecorder?.close();
      // Both end() calls set their loss counters synchronously; `ended` fires after both.
      void this.queue?.end(reason);
      void this.keystrokeQueue?.end(reason);
      this.ending = false;
      // The session is over (or taken over): the key must not outlive the data. keyGen is bumped
      // so a refresh still in flight cannot adopt or store anything.
      this.keyGen++;
      void this.purgeKey();
      const lost =
        (this.queue?.stats().lostBatches ?? 0) + (this.keystrokeQueue?.stats().lostBatches ?? 0);
      if (lost > 0) {
        // Loss must not be silent even if the app never calls finish().
        this.fire('capability', {
          id: 'batches-lost',
          status: 'UNVERIFIABLE',
          detail: `${lost} batches (events and editor changes) were discarded when the session ended.`,
        });
      }
      if (reason === 'TAKEN_OVER' && !this.takenOverSignalled) {
        this.takenOverSignalled = true;
        try {
          this.config.onReauthRequired?.('SESSION_TAKEN_OVER');
        } catch {
          // ignore
        }
      }
    }
    if (!this.endedFired) {
      this.endedFired = true;
      this.heartbeat?.stop();
      this.heartbeat = null; // the probe must not beat with a refused token
      const lostBatches =
        (this.queue?.stats().lostBatches ?? 0) + (this.keystrokeQueue?.stats().lostBatches ?? 0);
      this.fire('ended', { reason, lostBatches });
    }
  }

  async stop(): Promise<void> {
    await this.shutdown(null);
  }

  private async shutdown(purgeDrainMs: number | null): Promise<{ lostBatches: number }> {
    // stop(): whatever is kept for the next page load must not be purged by a late answer.
    this.stopping = purgeDrainMs === null;
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    globalThis.removeEventListener?.('online', this.onOnline);
    this.heartbeat?.stop();
    this.heartbeat = null; // probe() after stop or finish sends nothing
    for (const d of this.started.reverse()) {
      try {
        await d.stop();
      } catch {
        // keep tearing down
      }
    }
    this.started = [];
    // The app may keep its reference to the recorder: nothing recorded from here on may be kept.
    this.keystrokeRecorder?.close();
    const sessionId = this.config?.sessionId;
    let lostBatches = 0;
    if (purgeDrainMs === null) {
      await this.queue?.stop();
      await this.keystrokeQueue?.stop();
    } else {
      // cut batches and events not yet cut both still have to go out
      const countUnsent = (st: BatchQueueStats | undefined): number =>
        (st?.unsentBatches ?? 0) + (st?.pendingItems ?? 0);
      const unsent = countUnsent(this.queue?.stats()) + countUnsent(this.keystrokeQueue?.stats());
      if (unsent > 0) {
        // Tell the UI before data is discarded so the candidate can stay online.
        this.fire('capability', {
          id: 'finish-pending',
          status: 'UNVERIFIABLE',
          detail: `${unsent} batches (events and editor changes) are still being sent: stay online.`,
        });
      }
      // From here on nothing stores the key again; the drain below may still re-sign in memory.
      this.keyPurged = true;
      const results = await Promise.all([
        this.queue?.finish(purgeDrainMs),
        this.keystrokeQueue?.finish(purgeDrainMs),
      ]);
      lostBatches = results.reduce((n, r) => n + (r?.lostBatches ?? 0), 0);
      // Editor code text left by an earlier page load must go too, even if this load created no
      // keystroke queue (for example the transport cannot send keystroke batches).
      if (sessionId && this.store) {
        await this.purgeKey(); // the key goes with the data it signed, after the queues closed
        try {
          await this.store.deletePrefix(STORES.eventBatches, `${sessionId}:ks:`);
        } catch {
          // best effort
        }
      }
      if (lostBatches > 0) {
        this.fire('capability', {
          id: 'finish-lost',
          status: 'UNVERIFIABLE',
          detail: `${lostBatches} batches (events and editor changes) could not be sent.`,
        });
      }
    }
    this.metrics?.stop();
    this.startGen++;
    this.bodyRejectedFlagged = false;
    this.flags = null;
    this.idbParts.clear();
    this.idbShown = null;
    this.endedFired = false;
    this.queuesEnded = false;
    this.stopping = false;
    this.reauthSignalled = false;
    this.takenOverSignalled = false;
    this.keyGen++; // a provider call still pending must not touch the next session
    this.keyPurged = false;
    this.currentKey = null;
    this.keyRefresh = null;
    this.eventRejected = 0;
    this.keystrokeRejected = 0;
    this.queue = null;
    this.keystrokeQueue = null;
    this.keystrokeRecorder = null;
    this.store = null;
    this.keyStore = null;
    this.touch = null;
    this.config = null;
    return { lostBatches };
  }
}
