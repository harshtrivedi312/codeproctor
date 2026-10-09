// Errors raised by the org-scoping layer. They are plain Errors, not HttpExceptions: each one
// means the calling code is wrong (no org context, a cross-org payload, an unreviewed raw query),
// so it must surface as a 500 and be logged, never be turned into a client-facing 4xx.
// A request for another org's row is a different case: the scoped query simply finds nothing, and
// the service answers 404 (ADR 0006 section 2, TC-008).

import { deepFreeze } from './deep-freeze';

/** Base class, so callers and tests can catch every scoping failure at once. */
export class OrgScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Something that needs an org context ran without one. */
export class OrgContextMissingError extends OrgScopeError {
  constructor(what: string) {
    super(
      `${what} needs an org context, and none is set. Run it inside OrgContextService.runAsUser, ` +
        'runInOrg or runSystem (see apps/api/src/database/README.md).',
    );
  }
}

/** A payload or call that would read or write another org's data, or that the scope cannot check. */
export class OrgScopeViolationError extends OrgScopeError {}

/**
 * Raw SQL outside OrgContextService.runRawSql, or in a session scope (ADR 0006 section 8.5, ADR 0013
 * CS-4.2), where it is refused even inside runRawSql.
 */
export class RawQueryNotAllowedError extends OrgScopeError {
  constructor(operation: string, inSessionScope = false) {
    super(
      inSessionScope
        ? `${operation} is not allowed: raw SQL is refused in a session scope (a candidate or ` +
            'session-job scope), even inside runRawSql. Use the model API (ADR 0006 section 8.5).'
        : `${operation} is not allowed: raw SQL bypasses org scoping. ` +
            'Wrap a reviewed query in OrgContextService.runRawSql(reason, fn) and filter by org_id yourself.',
    );
  }
}

// The three outcomes of the session write locks (session-locks.ts: guardLive, lockForAccommodation and
// lockAnySession, ADR 0013 section 5.7, ADR 0015 section 6). Unlike the scoping errors above they are not a bug in
// the calling code: each is an expected outcome that the caller maps. They are plain Errors and not
// OrgScopeErrors, so a handler for scoping bugs does not catch them. Their messages carry no value,
// never the session id.
//
// Each has a STABLE DISCRIMINATOR for the code that maps it: the exported class (`instanceof`) and a read-only `code`
// (a getter on the prototype, so it is not an own property, it cannot be reassigned, and it never shows in a
// serialised error). The global ProblemFilter (docs/api-contract.md section 8, Backend A) matches database SQLSTATEs;
// these three have none, so without a discriminator a route would answer 500.
//
//   SessionNotFoundError      `SESSION_NOT_FOUND`    404 on the accommodations PATCH (ADR 0015 section 6); a session
//                                                    job drops the job (a poison job, ADR 0006 section 8.4).
//   SessionLockRetryError     `SESSION_LOCK_RETRY`   503 `BUSY` with `Retry-After` via ProblemFilter on a route
//                                                    (the proctor-resume: ADR 0013 5.7), never 500; a BullMQ retry
//                                                    through `busy-lock.ts` (SessionJobProcessor, Backend B).
//   AccommodationLockedError  `ACCOMMODATION_LOCKED` 409, a state conflict (ADR 0015 section 6); the retention site
//                                                    retries through BullMQ.

/**
 * The `code` of each lock error. A caller switches on the code or on `instanceof`. FROZEN (`as const` is compile-time
 * only): a write anywhere would otherwise change the code every error of that class carries, for the whole process.
 */
export const SESSION_LOCK_ERROR_CODES = deepFreeze({
  notFound: 'SESSION_NOT_FOUND',
  retry: 'SESSION_LOCK_RETRY',
  accommodationLocked: 'ACCOMMODATION_LOCKED',
} as const);

export type SessionLockErrorCode =
  (typeof SESSION_LOCK_ERROR_CODES)[keyof typeof SESSION_LOCK_ERROR_CODES];

/**
 * The session is not visible in this scope: another org's session, an unknown id, or an id that is
 * not the session of a session scope. A session job drops the job (ADR 0006 section 8.4); the
 * accommodation routes answer 404 (ADR 0015 section 6).
 */
export class SessionNotFoundError extends Error {
  constructor() {
    super('The session was not found in this scope.');
    this.name = new.target.name;
  }

  get code(): typeof SESSION_LOCK_ERROR_CODES.notFound {
    return SESSION_LOCK_ERROR_CODES.notFound;
  }
}

/**
 * guardLive or lockAnySession lost its compare-and-set three times in a row: the status kept changing
 * between the read and the lock. It carries no SQLSTATE, so ProblemFilter does not match it by itself: a route maps it
 * to 503 `BUSY` with `Retry-After` (Backend A), a job to a BullMQ retry (`busy-lock.ts`, Backend B). Never a 500.
 */
export class SessionLockRetryError extends Error {
  constructor() {
    super('The session lock could not be taken: the status kept changing. Retry the job.');
    this.name = new.target.name;
  }

  get code(): typeof SESSION_LOCK_ERROR_CODES.retry {
    return SESSION_LOCK_ERROR_CODES.retry;
  }
}

/**
 * lockForAccommodation lost its compare-and-set three times in a row. The accommodation routes
 * answer 409 ACCOMMODATION_LOCKED, a state conflict (ADR 0015 section 6); the retention site retries through BullMQ.
 */
export class AccommodationLockedError extends Error {
  constructor() {
    super('The accommodation lock could not be taken: the session status kept changing.');
    this.name = new.target.name;
  }

  get code(): typeof SESSION_LOCK_ERROR_CODES.accommodationLocked {
    return SESSION_LOCK_ERROR_CODES.accommodationLocked;
  }
}

// The `code` getters live on the prototypes, so the prototypes are frozen: a write, a defineProperty or a delete on one of
// them throws, and no code can change what every error of a class reports. (An instance can still get an own property of
// its own through Object.defineProperty, which changes that one object only.)
Object.freeze(SessionNotFoundError.prototype);
Object.freeze(SessionLockRetryError.prototype);
Object.freeze(AccommodationLockedError.prototype);
