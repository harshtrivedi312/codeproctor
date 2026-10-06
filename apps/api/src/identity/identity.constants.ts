// Constants of the identity check (FR-403, ADR 0004 section 1, ADR 0013 5.6, ADR 0014 6.2, 6.5).

/** The initial ID image and selfie are at most 5 MiB, JPEG only (ADR 0013 5.6, ADR 0014 6.2). */
export const IDENTITY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IDENTITY_IMAGE_TYPE = 'image/jpeg';

export type IdentityPurpose = 'ID_IMAGE' | 'SELFIE';
export const IDENTITY_PURPOSES: readonly IdentityPurpose[] = ['ID_IMAGE', 'SELFIE'];

/** A candidate may retry once: attempt 1, then attempt 2 (ADR 0004 section 1). */
export const MAX_ATTEMPTS = 2;

/** Presigned PUT URL life for the identity images: the same 60 s as every upload (ADR 0013 5.5). */
export const NAME_TTL_SECONDS = 3 * 24 * 3600;

/** The wire name of an identity upload, session relative: `identity/{attempt}/{id|selfie}-{ULID}.jpg`. */
export const IDENTITY_NAME = /^identity\/([12])\/(id|selfie)-([0-9A-HJKMNP-TV-Z]{26})\.jpg$/;

export const IDENTITY_QUEUE = 'identity-jobs';
export const FACE_MATCH_JOB = 'face-match';
/** ADR 0014 6.5: two attempts, fixed 2 s. */
export const FACE_MATCH_ATTEMPTS = 2;
export const FACE_MATCH_BACKOFF_MS = 2_000;
/** A pending row older than this with no job is re-enqueued by the reconciler (design notes 3.6). */
export const PENDING_RECONCILE_AFTER_MS = 2 * 60_000;
export const RECONCILE_EVERY_MS = 60_000;
/** WORKER_BUSY re-delays are capped for face-match (ADR 0014 bounds only face-recheck). */
export const MAX_BUSY_REDELAYS = 20;

/** The presigned GET for the worker lives 60 s for face calls (ADR 0014 5.1). */
export const WORKER_GET_TTL_SECONDS = 60;
/** Client timeout of a match call (ADR 0014 6.2). */
export const MATCH_TIMEOUT_MS = 20_000;
