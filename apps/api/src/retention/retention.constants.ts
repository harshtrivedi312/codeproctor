// Retention and erasure constants (FR-704, NFR-05; ADR 0004 section 9).

/**
 * The per-tier completion markers (ADR 0004 9.2). Only RetentionService writes them: a marker is
 * written after the tier's deletion is verified, and `audit_logs` is append-only, so a wrong marker
 * can never be withdrawn. `retention-markers.spec.ts` fails on any other writer.
 */
export const RETENTION_MARKER_ACTIONS = {
  FACE: 'RETENTION_FACE_DONE',
  MEDIA: 'RETENTION_MEDIA_DONE',
  RESULTS: 'RETENTION_RESULTS_DONE',
} as const;

/**
 * Reserved to the email worker and the erasure service (ADR 0004 9.2, 9.5): they gate destructive
 * steps, so an unrelated audit row must never be able to suppress or trigger them.
 */
export const ERASURE_RESERVED_ACTIONS = {
  EMAIL_SENT: 'ERASURE_EMAIL_SENT',
  EMAIL_FAILED: 'ERASURE_EMAIL_FAILED',
  COMPLETED: 'ERASURE_COMPLETED',
} as const;

export type RetentionTier = keyof typeof RETENTION_MARKER_ACTIONS;

/** Audit rows about a session carry this entity type; `entity_id` is the session id as text. */
export const SESSION_ENTITY_TYPE = 'session';
/** The audit row a marker is (ADR 0004 9.2 partial index). */
export const MARKER_ENTITY_TYPE = SESSION_ENTITY_TYPE;

/** The two-int advisory lock namespace R-10 and erasure both take, one candidate per transaction (ADR 0004 9.4). */
export const CANDIDATE_ERASURE_LOCK = 'codeproctor/candidate-erasure';

/** Face images are never kept more than this long from the face clock (C-27, C-35). */
export const FACE_CAP_DAYS = 90;
/** Results are kept this many years after the anchor (C-26). */
export const RESULTS_YEARS = 1;
/** Signed consent records are kept this many years from signing (C-04, C-17). A system constant. */
export const CONSENT_YEARS = 3;
/** Erasure completes within this many days of the request, or of the end of a hold (C-06). */
export const ERASURE_DEADLINE_DAYS = 30;
/** The candidate row is anonymised on this day of the deadline whatever else is pending (9.5 step 9). */
export const ERASURE_ANONYMISE_DAY = 28;
/** A person is alerted to tell the candidate on this day if no notice exists (9.5 step 9). */
export const ERASURE_ALERT_DAY = 25;
/** A tier that failed this many days in a row raises an alert (9.2). */
export const TIER_FAILURE_ALERT_DAYS = 3;
/** DeleteObjects takes at most this many keys per call (S3 and R2). */
export const DELETE_BATCH_SIZE = 1000;

/** Object key layout (ADR 0013 5.7). Keys hold only UUIDs and fixed words. */
export const sessionPrefix = (orgId: string, sessionId: string): string =>
  `orgs/${orgId}/sessions/${sessionId}/`;
export const consentPrefix = (orgId: string, sessionId: string): string =>
  `orgs/${orgId}/consents/${sessionId}/`;
/** The face tier's prefixes under the session prefix (identity images, sealed re-check frames). */
export const FACE_SUBPREFIXES = ['identity/', 'evidence/sealed/'] as const;
/** The report objects: kept by the media tier, deleted by the results tier (C-26). */
export const REPORTS_SUBPREFIX = 'reports/';
