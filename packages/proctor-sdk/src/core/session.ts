import type {
  ClientEventType,
  ClientProctorEvent,
  EventPayload,
  ProctorDetector,
} from '@codeproctor/shared';
import { EventQueue, type EventQueueStats, type EventTransport } from './event-queue';
import { Heartbeat } from './heartbeat';
import { importSessionKey } from './hmac';
import { IdbStore } from './idb';
import { MetricsCollector, type Metrics } from './metrics';
import {
  ConsentRequiredError,
  type CapabilityFlag,
  type Detector,
  type DetectorContext,
  type EmitOptions,
  type LockState,
} from './types';

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
  transport: EventTransport & { heartbeat(): Promise<boolean> };
  /** Detectors the accommodations switched off (FR-106). They never start. */
  disabledDetectors?: readonly ProctorDetector[];
  detectors: readonly Detector[];
  store?: IdbStore;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
  backoffBaseMs?: number;
}

export interface SessionEvents {
  event: ClientProctorEvent;
  lock: LockState;
  capability: CapabilityFlag;
  connection: { online: boolean };
}
type Handler<K extends keyof SessionEvents> = (payload: SessionEvents[K]) => void;

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
  };
  private queue: EventQueue | null = null;
  private heartbeat: Heartbeat | null = null;
  private started: Detector[] = [];
  private metrics: MetricsCollector | null = null;
  private config: ProctorSessionConfig | null = null;
  private capabilities = new Map<string, CapabilityFlag>();
  private locks = new Map<string, boolean>();
  private readonly onPageHide = (): void => void this.queue?.flush();
  private readonly onOnline = (): void => this.queue?.retryNow();

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
    const queue = (this.queue = new EventQueue({
      sessionId: config.sessionId,
      key,
      transport: config.transport,
      store: config.store ?? new IdbStore(),
      ...(config.flushIntervalMs === undefined ? {} : { flushIntervalMs: config.flushIntervalMs }),
      ...(config.backoffBaseMs === undefined ? {} : { backoffBaseMs: config.backoffBaseMs }),
    }));
    await queue.start();

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
    );
    this.heartbeat.start();
    globalThis.addEventListener?.('pagehide', this.onPageHide);
    globalThis.addEventListener?.('online', this.onOnline);

    for (const d of config.detectors) {
      if (d.accommodationId && disabled.has(d.accommodationId)) continue;
      this.started.push(d);
      try {
        await d.start(ctx);
      } catch {
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

  async stop(): Promise<void> {
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
    await this.queue?.stop();
    this.metrics?.stop();
    this.queue = null;
    this.config = null;
  }
}
