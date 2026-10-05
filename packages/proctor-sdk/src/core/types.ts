import type {
  ClientEventType,
  ClientProctorEvent,
  EventPayload,
  ProctorDetector,
} from '@codeproctor/shared';

/** Extra fields a detector may set on an event (the shared envelope fields). */
export interface EmitOptions {
  occurredAt?: Date;
  durationMs?: number;
  confidence?: number;
  evidenceKey?: string;
}

export type EmitFn = <T extends ClientEventType>(
  type: T,
  payload: EventPayload<T>,
  options?: EmitOptions,
) => void;

/**
 * Honest capability reporting: when a check cannot run in this browser (or the user denied it) the
 * SDK says so. It never reports a pass for a check it could not perform. The shape that the API
 * stores in `sessions.device_info.capabilities` is still open (ARC-03).
 */
export type CapabilityStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'DENIED' | 'UNVERIFIABLE';
export interface CapabilityFlag {
  id: string;
  status: CapabilityStatus;
  detail?: string;
}

/** Things a UI needs to react to (pause the editor, show the re-share prompt). */
export type LockReason = 'FULLSCREEN' | 'SCREEN_SHARE';
export interface LockState {
  reason: LockReason;
  locked: boolean;
}

export interface DetectorContext {
  emit: EmitFn;
  /** Element that scopes clipboard, drop and context-menu blocking. */
  root: HTMLElement;
  setCapability(flag: CapabilityFlag): void;
  setLock(state: LockState): void;
  /** Throws ConsentRequiredError until consent is recorded. Call before any device access. */
  assertConsent(): void;
  /** Wrap timers or heavy callbacks so their CPU time shows up in metrics. */
  measure<R>(label: string, fn: () => R): R;
  /** Detectors disabled by accommodations never start; this is the check used by the session. */
  isDisabled(detector: ProctorDetector): boolean;
}

/** A detector is a plug-in: the session calls start() once and stop() on teardown. */
export interface Detector {
  readonly id: string;
  /** Set when an accommodation can switch this detector off (FR-106); a disabled detector never starts. */
  readonly accommodationId?: ProctorDetector;
  start(ctx: DetectorContext): void | Promise<void>;
  /**
   * Called by the session when start() did not finish in time and the detector is abandoned.
   * Report what can no longer be trusted (DETECTOR_UNAVAILABLE, capability flags). stop() is
   * called right after; a late start() must then do nothing.
   */
  reportStartTimeout?(ctx: DetectorContext): void;
  stop(): void | Promise<void>;
}

export type TypedEvent = ClientProctorEvent;

export class ConsentRequiredError extends Error {
  constructor() {
    super('Consent must be recorded before the SDK touches the camera, microphone or screen.');
    this.name = 'ConsentRequiredError';
  }
}
