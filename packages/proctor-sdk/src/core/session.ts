import type {
  ClientEventType,
  ClientProctorEvent,
  EventPayload,
  ProctorDetector,
} from '@codeproctor/shared';
import type { BatchQueueStats, EndReason } from './batch-queue';
import { EventQueue, type EventQueueStats, type EventTransport } from './event-queue';
import type { SendResult, SignedBatch } from './batch-queue';
import { KeystrokeQueue } from '../keystrokes/keystroke-queue';
import { KeystrokeRecorder, type UnrepresentableReason } from '../keystrokes/recorder';
import { Heartbeat } from './heartbeat';
import { importSessionKey } from './hmac';
import { IdbStore, STORES } from './idb';
import { MetricsCollector, type Metrics } from './metrics';
import {
  ConsentRequiredError,
  type CapabilityFlag,
  type Detector,
  type DetectorContext,
  type EmitOptions,
  type LockState,
} from './types';

/**
 * Supplies a new signing key after the server answered 409 KEY_EPOCH_STALE (ADR 0013). The real
 * provider (proctor-key route) comes with a later change; without one, stale batches are held and
 * kept, never dropped. Returns the key as base64, or null when none can be had.
 */
export interface KeyProvider {
  getKey(): Promise<string | null>;
}

export interface ProctorSessionConfig {
  sessionId: string;
  /**
   * Per-session HMAC key issued by the API at IN_PROGRESS, base64. Held in memory only.
   * TODO(ARC-03): ADR 0010 leaves open how events sent before this key exists (system-check
   * events such as MULTI_MONITOR) are signed. Not invented here: the SDK cannot start without a key.
   */
  hmacKeyBase64: string;
  /** Scope of clipboard, drop and context-menu blocking. */
  root: HTMLElement;
  /** Nothing touches camera, microphone or screen until this is set (D-17). */
  consent: { recordedAt: string } | null;
  transport: EventTransport & {
    heartbeat(): Promise<boolean | { ended: EndReason }>;
    /**
     * Sends one signed keystroke batch (POST /candidate/session/keystrokes). Without it the session
     * has no keystroke recorder (`session.keystrokes` is null) and says so with the `keystrokes`
     * capability flag.
     */
    sendKeystrokeBatch?(batch: SignedBatch): Promise<SendResult>;
  };
  /** Optional: how to get a new signing key after KEY_EPOCH_STALE (see KeyProvider). */
  keyProvider?: KeyProvider;
  /** Consecutive 401 answers before the `auth-lost` event (default 3). */
  authLostAfter?: number;
  /** Detectors the accommodations switched off (FR-106). They never start. */
  disabledDetectors?: readonly ProctorDetector[];
  detectors: readonly Detector[];
  store?: IdbStore;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
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
  ended: { reason: EndReason };
  /** Repeated 401 answers while live: the app must refresh the candidate token (retries continue slowly). */
  'auth-lost': { stream: 'event' | 'keystroke' };
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
    'auth-lost': new Set(),
  };
  private currentKey: CryptoKey | null = null;
  private keyRefresh: Promise<CryptoKey | null> | null = null;
  private endedReason: EndReason | null = null;
  private eventRejected = 0;
  private keystrokeRejected = 0;
  private queue: EventQueue | null = null;
  private keystrokeQueue: KeystrokeQueue | null = null;
  private keystrokeRecorder: KeystrokeRecorder | null = null;
  private store: IdbStore | null = null;
  private heartbeat: Heartbeat | null = null;
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
    const metrics = (this.metrics = new MetricsCollector());
    const key = await importSessionKey(config.hmacKeyBase64);
    this.currentKey = key;
    // Hooks both queues share: key rotation, end of session, lost authentication.
    const shared = (stream: 'event' | 'keystroke') => ({
      ...(config.keyProvider ? { onKeyStale: (stale: CryptoKey) => this.refreshKey(stale) } : {}),
      ...(config.authLostAfter === undefined ? {} : { authLostAfter: config.authLostAfter }),
      onKeyUnavailable: (why: 'STALE_NO_KEY' | 'ALREADY_ISSUED') =>
        this.fire('capability', {
          id: 'signing-key',
          status: 'UNVERIFIABLE',
          detail:
            why === 'ALREADY_ISSUED'
              ? 'The signing key could not be obtained again: batches are held, not dropped.'
              : 'The signing key was rotated and no new key is available: batches are held, not dropped.',
        }),
      onEnded: (reason: EndReason) => this.handleEnded(reason),
      onAuthLost: () => this.fire('auth-lost', { stream }),
    });
    const store = (this.store = config.store ?? new IdbStore()); // shared by the event and keystroke queues
    const queue = (this.queue = new EventQueue({
      sessionId: config.sessionId,
      key,
      transport: config.transport,
      store,
      ...shared('event'),
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
      onStorageRecovered: () =>
        this.fire('capability', { id: 'event-storage', status: 'SUPPORTED' }),
      onStorageDegraded: (reason) =>
        this.fire('capability', {
          id: 'event-storage',
          status: 'UNVERIFIABLE',
          detail:
            reason === 'OPEN_FAILED'
              ? 'IndexedDB unavailable: event batches are kept in memory only (a reload loses unsent batches).'
              : 'IndexedDB writes are failing: event batches are kept in memory only.',
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
        ...shared('keystroke'),
        ...(config.backoffBaseMs === undefined ? {} : { backoffBaseMs: config.backoffBaseMs }),
        onSeqUntrusted: () =>
          this.fire('capability', {
            id: 'keystroke-seq',
            status: 'UNVERIFIABLE',
            detail: 'The keystroke batch counter could not be read; sequence numbers jump ahead.',
          }),
        onStorageDegraded: () =>
          this.fire('capability', {
            id: 'keystroke-storage',
            status: 'UNVERIFIABLE',
            detail: 'IndexedDB problem: keystroke batches are kept in memory only.',
          }),
        onStorageRecovered: () =>
          this.fire('capability', { id: 'keystroke-storage', status: 'SUPPORTED' }),
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
      () => config.transport.heartbeat(),
      config.heartbeatIntervalMs ?? 10_000,
      (online) => this.fire('connection', { online }),
      (reason) => this.handleEnded(reason),
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
   * One key refresh at a time, shared by both queues: a queue whose batches were signed with a key
   * that has already been replaced gets the current key without asking the provider again (the
   * server issues a key only once per epoch).
   */
  private refreshKey(stale: CryptoKey): Promise<CryptoKey | null> {
    const provider = this.config?.keyProvider;
    if (!provider) return Promise.resolve(null);
    if (this.currentKey && this.currentKey !== stale) return Promise.resolve(this.currentKey);
    this.keyRefresh ??= (async () => {
      try {
        const b64 = await provider.getKey();
        if (!b64) return null;
        this.currentKey = await importSessionKey(b64);
        return this.currentKey;
      } finally {
        this.keyRefresh = null;
      }
    })();
    return this.keyRefresh;
  }

  /** The server said the session is over: stop everything that sends, tell the UI once. */
  private handleEnded(reason: EndReason): void {
    if (this.endedReason) return;
    this.endedReason = reason;
    this.heartbeat?.stop();
    this.keystrokeRecorder?.close();
    void this.queue?.end(reason);
    void this.keystrokeQueue?.end(reason);
    this.fire('ended', { reason });
  }

  async stop(): Promise<void> {
    await this.shutdown(null);
  }

  private async shutdown(purgeDrainMs: number | null): Promise<{ lostBatches: number }> {
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    globalThis.removeEventListener?.('online', this.onOnline);
    this.heartbeat?.stop();
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
      const results = await Promise.all([
        this.queue?.finish(purgeDrainMs),
        this.keystrokeQueue?.finish(purgeDrainMs),
      ]);
      lostBatches = results.reduce((n, r) => n + (r?.lostBatches ?? 0), 0);
      // Editor code text left by an earlier page load must go too, even if this load created no
      // keystroke queue (for example the transport cannot send keystroke batches).
      if (sessionId && this.store) {
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
    this.endedReason = null;
    this.currentKey = null;
    this.keyRefresh = null;
    this.eventRejected = 0;
    this.keystrokeRejected = 0;
    this.queue = null;
    this.keystrokeQueue = null;
    this.keystrokeRecorder = null;
    this.store = null;
    this.config = null;
    return { lostBatches };
  }
}
