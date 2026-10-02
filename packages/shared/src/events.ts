import { z } from 'zod';

/**
 * Proctoring event contract (FR-601..FR-610, FR-801, FR-802; ADR 0005, ADR 0010).
 *
 * Trust rule (ADR 0001 TB-1): everything a candidate browser sends is untrusted, including detector
 * output and timestamps. Severity is never part of a client event: the server assigns it from the
 * type. Unknown keys are stripped (zod default), so a client-sent `severity` is ignored, not stored.
 * Canonical JSON, the HMAC signature and how it is transported are defined by ARC-03; the schemas
 * here are the signed content only.
 */

// ---------- Enums (must match prisma/schema.prisma and docs/database.md) ----------

/** Postgres `event_type`, in DDL order. */
export const EVENT_TYPES = [
  'FULLSCREEN_EXIT',
  'TAB_SWITCH',
  'FOCUS_LOST',
  'PASTE_ATTEMPT',
  'COPY_ATTEMPT',
  'RIGHT_CLICK',
  'DEVTOOLS_OPEN',
  'SCREEN_SHARE_STOPPED',
  'MULTI_MONITOR',
  'VIRTUAL_CAMERA',
  'NO_FACE',
  'MULTIPLE_FACES',
  'FACE_MISMATCH',
  'GAZE_AWAY',
  'PHONE_DETECTED',
  'BOOK_DETECTED',
  'SPEECH_DETECTED',
  'MULTIPLE_VOICES',
  'DISCONNECTED',
  'RECONNECTED',
  'PASTE_BURST',
  'TYPING_ANOMALY',
  'CODE_SIMILARITY',
  'AI_LIKENESS',
  'PROCTOR_PAUSE',
  'PROCTOR_MESSAGE',
  'SIDE_CAMERA_DISCONNECTED',
  'SIDE_CAMERA_RECONNECTED',
  'DROP_ATTEMPT',
  'CUT_ATTEMPT',
  'SHORTCUT_BLOCKED',
  'EXTENSION_INTERFERENCE',
  'FULLSCREEN_RESTORED',
  'SCREEN_SHARE_RESUMED',
  'PROCTOR_RESUME',
  'IDLE_THEN_COMPLETE',
  'DETECTOR_UNAVAILABLE',
  'IDENTITY_MANUAL_REVIEW',
  'RESUME_OTP_FAILED',
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

/** Postgres `severity` (FR-801). */
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

/** Postgres `event_source`. */
export const EVENT_SOURCES = ['CLIENT', 'SERVER'] as const;
export const eventSourceSchema = z.enum(EVENT_SOURCES);
export type EventSource = z.infer<typeof eventSourceSchema>;

/** Postgres `risk_band` (FR-804). */
export const RISK_BANDS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const riskBandSchema = z.enum(RISK_BANDS);
export type RiskBand = z.infer<typeof riskBandSchema>;

/** Postgres `identity_review_reason` (ADR 0004). */
export const IDENTITY_REVIEW_REASONS = [
  'BELOW_THRESHOLD',
  'NO_FACE',
  'MULTIPLE_FACES',
  'LIVENESS_NOT_CONFIRMED',
  'MATCH_ERROR',
] as const;
export const identityReviewReasonSchema = z.enum(IDENTITY_REVIEW_REASONS);
export type IdentityReviewReason = z.infer<typeof identityReviewReasonSchema>;

// ---------- Sources (ADR 0010 §1) ----------

/**
 * Types the browser may send in a signed batch. Every other type is written only by the API or the
 * worker; a client batch containing one is rejected by the schema. SPEECH_DETECTED, MULTIPLE_VOICES
 * and SIDE_CAMERA_DISCONNECTED are also written by the server (audio re-check, side-camera watchdog).
 */
export const CLIENT_EVENT_TYPES = [
  'FULLSCREEN_EXIT',
  'TAB_SWITCH',
  'FOCUS_LOST',
  'PASTE_ATTEMPT',
  'COPY_ATTEMPT',
  'RIGHT_CLICK',
  'DEVTOOLS_OPEN',
  'SCREEN_SHARE_STOPPED',
  'MULTI_MONITOR',
  'VIRTUAL_CAMERA',
  'NO_FACE',
  'MULTIPLE_FACES',
  'FACE_MISMATCH',
  'GAZE_AWAY',
  'PHONE_DETECTED',
  'BOOK_DETECTED',
  'SPEECH_DETECTED',
  'MULTIPLE_VOICES',
  'SIDE_CAMERA_DISCONNECTED',
  'SIDE_CAMERA_RECONNECTED',
  'DROP_ATTEMPT',
  'CUT_ATTEMPT',
  'SHORTCUT_BLOCKED',
  'EXTENSION_INTERFERENCE',
  'FULLSCREEN_RESTORED',
  'SCREEN_SHARE_RESUMED',
  'DETECTOR_UNAVAILABLE',
] as const satisfies readonly EventType[];
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** Types the API or worker write (source SERVER). Includes the three dual-source client types. */
export const SERVER_EVENT_TYPES = [
  'SPEECH_DETECTED',
  'MULTIPLE_VOICES',
  'SIDE_CAMERA_DISCONNECTED',
  'DISCONNECTED',
  'RECONNECTED',
  'PASTE_BURST',
  'TYPING_ANOMALY',
  'CODE_SIMILARITY',
  'AI_LIKENESS',
  'PROCTOR_PAUSE',
  'PROCTOR_MESSAGE',
  'PROCTOR_RESUME',
  'IDLE_THEN_COMPLETE',
  'IDENTITY_MANUAL_REVIEW',
  'RESUME_OTP_FAILED',
] as const satisfies readonly EventType[];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

export function isClientEventType(type: EventType): type is ClientEventType {
  return (CLIENT_EVENT_TYPES as readonly EventType[]).includes(type);
}

export function isServerEventType(type: EventType): type is ServerEventType {
  return (SERVER_EVENT_TYPES as readonly EventType[]).includes(type);
}

// ---------- Defaults (ADR 0005 §2; org overrides in organizations.settings.risk, ADR 0007 §6) ----------

/** Severity the server assigns from the type. Client-sent severity is ignored (ADR 0001 TB-1). */
export const DEFAULT_EVENT_SEVERITY: Readonly<Record<EventType, Severity>> = {
  FULLSCREEN_EXIT: 'MEDIUM',
  TAB_SWITCH: 'MEDIUM',
  FOCUS_LOST: 'MEDIUM',
  PASTE_ATTEMPT: 'LOW',
  COPY_ATTEMPT: 'LOW',
  RIGHT_CLICK: 'LOW',
  DEVTOOLS_OPEN: 'MEDIUM',
  SCREEN_SHARE_STOPPED: 'HIGH',
  MULTI_MONITOR: 'HIGH',
  VIRTUAL_CAMERA: 'HIGH',
  NO_FACE: 'MEDIUM',
  MULTIPLE_FACES: 'HIGH',
  FACE_MISMATCH: 'MEDIUM',
  GAZE_AWAY: 'MEDIUM',
  PHONE_DETECTED: 'HIGH',
  BOOK_DETECTED: 'MEDIUM',
  SPEECH_DETECTED: 'MEDIUM',
  MULTIPLE_VOICES: 'HIGH',
  DISCONNECTED: 'LOW',
  RECONNECTED: 'LOW',
  PASTE_BURST: 'HIGH',
  TYPING_ANOMALY: 'MEDIUM',
  CODE_SIMILARITY: 'HIGH',
  AI_LIKENESS: 'MEDIUM',
  PROCTOR_PAUSE: 'LOW',
  PROCTOR_MESSAGE: 'LOW',
  SIDE_CAMERA_DISCONNECTED: 'HIGH',
  SIDE_CAMERA_RECONNECTED: 'LOW',
  DROP_ATTEMPT: 'LOW',
  CUT_ATTEMPT: 'LOW',
  SHORTCUT_BLOCKED: 'LOW',
  EXTENSION_INTERFERENCE: 'MEDIUM',
  FULLSCREEN_RESTORED: 'LOW',
  SCREEN_SHARE_RESUMED: 'LOW',
  PROCTOR_RESUME: 'LOW',
  IDLE_THEN_COMPLETE: 'MEDIUM',
  DETECTOR_UNAVAILABLE: 'MEDIUM',
  IDENTITY_MANUAL_REVIEW: 'HIGH',
  RESUME_OTP_FAILED: 'MEDIUM',
};

/** Types with default risk weight 0: informational, resume events, identity review, OTP typo. */
export const ZERO_WEIGHT_EVENT_TYPES = [
  'DISCONNECTED',
  'RECONNECTED',
  'PROCTOR_PAUSE',
  'PROCTOR_MESSAGE',
  'PROCTOR_RESUME',
  'SIDE_CAMERA_RECONNECTED',
  'FULLSCREEN_RESTORED',
  'SCREEN_SHARE_RESUMED',
  'IDENTITY_MANUAL_REVIEW',
  'RESUME_OTP_FAILED',
] as const satisfies readonly EventType[];

/** Default per-type risk weight: 1.0, or 0 for ZERO_WEIGHT_EVENT_TYPES. */
export const DEFAULT_EVENT_WEIGHT: Readonly<Record<EventType, number>> = Object.fromEntries(
  EVENT_TYPES.map((t) => [
    t,
    (ZERO_WEIGHT_EVENT_TYPES as readonly EventType[]).includes(t) ? 0 : 1,
  ]),
) as Record<EventType, number>;

/** Default points per severity (ADR 0005 §2). */
export const DEFAULT_SEVERITY_POINTS: Readonly<Record<Severity, number>> = {
  LOW: 2,
  MEDIUM: 8,
  HIGH: 20,
};

/** Default number of events of one type that count towards the score (ADR 0005 §2). */
export const DEFAULT_EVENT_CAP_PER_TYPE = 3;

/** Lowest score of each band (FR-804: 0-29 LOW, 30-59 MEDIUM, 60-100 HIGH). */
export const RISK_BAND_MIN_SCORE: Readonly<Record<RiskBand, number>> = {
  LOW: 0,
  MEDIUM: 30,
  HIGH: 60,
};

/** FR-804 band for a 0-100 risk score. Scores outside 0-100 are clamped. */
export function riskBandForScore(score: number): RiskBand {
  const s = Math.min(100, Math.max(0, score));
  if (s >= RISK_BAND_MIN_SCORE.HIGH) return 'HIGH';
  if (s >= RISK_BAND_MIN_SCORE.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/** Types pushed to /live whatever their severity (ADR 0005 §1, D-21). */
export const FORCED_LIVE_EVENT_TYPES = [
  'RESUME_OTP_FAILED',
] as const satisfies readonly EventType[];

/** HIGH events and forced types go to Redis `live:{orgId}` and then /live (ADR 0001 F4). */
export function shouldPushToLive(type: EventType, severity: Severity): boolean {
  return severity === 'HIGH' || (FORCED_LIVE_EVENT_TYPES as readonly EventType[]).includes(type);
}

// ---------- Bounds ----------

/** Max events in one signed batch (backend.md Step 10; DB `event_count` is smallint). */
export const MAX_EVENTS_PER_BATCH = 100;
/** Batch sequence numbers fit Postgres `int`. */
export const MAX_BATCH_SEQ = 2_147_483_647;
/** Upper bound on any single event duration (24 h). */
export const MAX_EVENT_DURATION_MS = 86_400_000;
/** Upper bound on an evidence object key. Layout and ownership checks: ARC-03. */
export const MAX_EVIDENCE_KEY_LENGTH = 512;
/** Upper bound on short free-text labels in payloads (device label, signal name). */
export const MAX_EVENT_LABEL_LENGTH = 128;
/** Upper bound on a proctor message (FR-903). */
export const MAX_PROCTOR_MESSAGE_LENGTH = 500;
/** Suggested JSON body limit for POST /candidate/session/events. */
export const MAX_EVENT_BATCH_BODY_BYTES = 256 * 1024;

// ---------- Shared field schemas ----------

/** Batch sequence: per session, per stream (events and keystrokes count separately). */
export const batchSeqSchema = z.int().min(0).max(MAX_BATCH_SEQ);

/** Client clock, ISO 8601 UTC with `Z`. Untrusted: the server clamps it to the session window. */
export const clientTimestampSchema = z.iso.datetime();

const durationMsSchema = z.int().min(0).max(MAX_EVENT_DURATION_MS);
const confidenceSchema = z.number().min(0).max(1);
const labelSchema = z.string().trim().min(1).max(MAX_EVENT_LABEL_LENGTH);
const evidenceKeySchema = z
  .string()
  .min(1)
  .max(MAX_EVIDENCE_KEY_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/, 'Invalid evidence key.')
  .refine((k) => !k.includes('..') && !k.includes('//'), 'Invalid evidence key.');

/** In-browser detectors that can report DETECTOR_UNAVAILABLE (v0; BE-06 reuses for accommodations). */
export const PROCTOR_DETECTORS = [
  'FACE',
  'GAZE',
  'OBJECT',
  'VOICE',
  'MULTI_MONITOR',
  'DEVTOOLS',
  'VIRTUAL_CAMERA',
  'EXTENSION',
  'SIDE_CAMERA',
] as const;
export const proctorDetectorSchema = z.enum(PROCTOR_DETECTORS);
export type ProctorDetector = z.infer<typeof proctorDetectorSchema>;

// ---------- Payloads (v0; never clipboard content, keys typed, OTPs or media keys) ----------

const emptyPayload = z.object({});
/** Size of a blocked clipboard or drop action in characters; the content itself is never sent. */
const clipboardPayload = z.object({ length: z.int().min(0).max(10_000_000).optional() });
const codeQuestionRef = { sessionQuestionId: z.uuid() };

export const EVENT_PAYLOAD_SCHEMAS = {
  FULLSCREEN_EXIT: emptyPayload,
  TAB_SWITCH: emptyPayload,
  FOCUS_LOST: emptyPayload,
  PASTE_ATTEMPT: clipboardPayload,
  COPY_ATTEMPT: clipboardPayload,
  RIGHT_CLICK: emptyPayload,
  DEVTOOLS_OPEN: z.object({ heuristic: z.enum(['WINDOW_SIZE', 'DEBUGGER_TIMING', 'OTHER']) }),
  SCREEN_SHARE_STOPPED: z.object({
    reason: z.enum(['TRACK_ENDED', 'WRONG_SURFACE', 'PERMISSION_REVOKED']),
  }),
  MULTI_MONITOR: z.object({
    screenCount: z.int().min(2).max(16).optional(),
    api: z.enum(['WINDOW_MANAGEMENT', 'SCREEN_IS_EXTENDED']),
  }),
  VIRTUAL_CAMERA: z.object({ deviceLabel: labelSchema }),
  NO_FACE: emptyPayload,
  MULTIPLE_FACES: z.object({ faceCount: z.int().min(2).max(32) }),
  FACE_MISMATCH: z.object({ similarity: z.number().min(-1).max(1).optional() }),
  GAZE_AWAY: emptyPayload,
  PHONE_DETECTED: emptyPayload,
  BOOK_DETECTED: emptyPayload,
  SPEECH_DETECTED: emptyPayload,
  MULTIPLE_VOICES: emptyPayload,
  DISCONNECTED: z.object({ lastHeartbeatAt: z.iso.datetime() }),
  RECONNECTED: emptyPayload,
  PASTE_BURST: z.object({
    ...codeQuestionRef,
    insertedChars: z.int().min(1),
    windowMs: z.int().min(0),
  }),
  TYPING_ANOMALY: z.object({ ...codeQuestionRef, metric: labelSchema }),
  CODE_SIMILARITY: z.object({
    ...codeQuestionRef,
    similarity: z.number().min(0).max(1),
    matchedSessionId: z.uuid().optional(),
    aiReferenceSolutionId: z.uuid().optional(),
  }),
  AI_LIKENESS: z.object({
    ...codeQuestionRef,
    similarity: z.number().min(0).max(1),
    aiReferenceSolutionId: z.uuid(),
  }),
  PROCTOR_PAUSE: z.object({ proctorUserId: z.uuid() }),
  PROCTOR_MESSAGE: z.object({
    proctorUserId: z.uuid(),
    message: z.string().trim().min(1).max(MAX_PROCTOR_MESSAGE_LENGTH),
  }),
  SIDE_CAMERA_DISCONNECTED: emptyPayload,
  SIDE_CAMERA_RECONNECTED: emptyPayload,
  DROP_ATTEMPT: clipboardPayload,
  CUT_ATTEMPT: clipboardPayload,
  SHORTCUT_BLOCKED: z.object({
    shortcut: z
      .string()
      .max(32)
      .regex(/^[A-Za-z0-9+]+$/, 'Shortcut must look like Ctrl+Shift+I.'),
  }),
  EXTENSION_INTERFERENCE: z.object({ signal: labelSchema }),
  FULLSCREEN_RESTORED: emptyPayload,
  SCREEN_SHARE_RESUMED: emptyPayload,
  PROCTOR_RESUME: z.object({ proctorUserId: z.uuid() }),
  IDLE_THEN_COMPLETE: z.object({
    ...codeQuestionRef,
    idleMs: z.int().min(0),
    insertedChars: z.int().min(1),
  }),
  DETECTOR_UNAVAILABLE: z.object({
    detector: proctorDetectorSchema,
    reason: z.enum(['MODEL_LOAD_FAILED', 'PERMISSION_DENIED', 'UNSUPPORTED', 'RUNTIME_ERROR']),
  }),
  IDENTITY_MANUAL_REVIEW: z.object({
    identityCheckId: z.uuid(),
    reason: identityReviewReasonSchema,
  }),
  // Never the OTP or any part of it.
  RESUME_OTP_FAILED: emptyPayload,
} as const satisfies Record<EventType, z.ZodType>;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

/** Validate a payload for a known type (for SERVER writers and the worker hand-off). */
export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EVENT_PAYLOAD_SCHEMAS[type].parse(payload) as EventPayload<T>;
}

// ---------- Client event envelope and batch ----------

const clientEventFields = {
  /** When it happened on the client clock (FR-801 timestamp). */
  occurredAt: clientTimestampSchema,
  /** FR-602, FR-606, FR-801: duration where the event spans time (focus lost, no face). */
  durationMs: durationMsSchema.optional(),
  /** Detector confidence 0-1; stored as numeric(5,4). */
  confidence: confidenceSchema.optional(),
  /** Evidence object key (for example a webcam JPEG); the server checks it belongs to the session. */
  evidenceKey: evidenceKeySchema.optional(),
};

function clientEvent<T extends ClientEventType>(type: T) {
  return z.object({
    type: z.literal(type),
    ...clientEventFields,
    payload: EVENT_PAYLOAD_SCHEMAS[type],
  });
}

/** One event as the browser sends it. Discriminated on `type`; server-only types are rejected. */
export const clientProctorEventSchema = z.discriminatedUnion('type', [
  clientEvent('FULLSCREEN_EXIT'),
  clientEvent('TAB_SWITCH'),
  clientEvent('FOCUS_LOST'),
  clientEvent('PASTE_ATTEMPT'),
  clientEvent('COPY_ATTEMPT'),
  clientEvent('RIGHT_CLICK'),
  clientEvent('DEVTOOLS_OPEN'),
  clientEvent('SCREEN_SHARE_STOPPED'),
  clientEvent('MULTI_MONITOR'),
  clientEvent('VIRTUAL_CAMERA'),
  clientEvent('NO_FACE'),
  clientEvent('MULTIPLE_FACES'),
  clientEvent('FACE_MISMATCH'),
  clientEvent('GAZE_AWAY'),
  clientEvent('PHONE_DETECTED'),
  clientEvent('BOOK_DETECTED'),
  clientEvent('SPEECH_DETECTED'),
  clientEvent('MULTIPLE_VOICES'),
  clientEvent('SIDE_CAMERA_DISCONNECTED'),
  clientEvent('SIDE_CAMERA_RECONNECTED'),
  clientEvent('DROP_ATTEMPT'),
  clientEvent('CUT_ATTEMPT'),
  clientEvent('SHORTCUT_BLOCKED'),
  clientEvent('EXTENSION_INTERFERENCE'),
  clientEvent('FULLSCREEN_RESTORED'),
  clientEvent('SCREEN_SHARE_RESUMED'),
  clientEvent('DETECTOR_UNAVAILABLE'),
]);
export type ClientProctorEvent = z.infer<typeof clientProctorEventSchema>;

/**
 * Signed content of POST /candidate/session/events (backend.md Step 10, ADR 0005 §3).
 * The session comes from the candidate token, never from the body. `seq` is unique per session:
 * same seq + same signature is an idempotent retry; same seq + different signature is rejected
 * (TC-065); out-of-order seq after an outage is accepted (TC-063, NFR-08).
 */
export const proctorEventBatchSchema = z.object({
  seq: batchSeqSchema,
  events: z.array(clientProctorEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type ProctorEventBatch = z.infer<typeof proctorEventBatchSchema>;
