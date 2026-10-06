// Errors raised by the org-scoping layer. They are plain Errors, not HttpExceptions: each one
// means the calling code is wrong (no org context, a cross-org payload, an unreviewed raw query),
// so it must surface as a 500 and be logged, never be turned into a client-facing 4xx.
// A request for another org's row is a different case: the scoped query simply finds nothing, and
// the service answers 404 (ADR 0006 section 2, TC-008).

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

// The three outcomes of the session write locks (session-locks.ts: guardLive and lockForAccommodation,
// ADR 0013 section 5.7, ADR 0015 section 6). Unlike the scoping errors above they are not a bug in
// the calling code: each is an expected outcome that the caller maps. They are plain Errors and not
// OrgScopeErrors, so a handler for scoping bugs does not catch them. Their messages carry no value,
// never the session id.

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
}

/**
 * guardLive lost its compare-and-set three times in a row: the status kept changing between the
 * read and the lock. The job fails and its own retry (BullMQ) runs it again.
 */
export class SessionLockRetryError extends Error {
  constructor() {
    super('The session lock could not be taken: the status kept changing. Retry the job.');
    this.name = new.target.name;
  }
}

/**
 * lockForAccommodation lost its compare-and-set three times in a row. The accommodation routes
 * answer 409 ACCOMMODATION_LOCKED (ADR 0015 section 6); the retention jobs retry through BullMQ.
 */
export class AccommodationLockedError extends Error {
  constructor() {
    super('The accommodation lock could not be taken: the session status kept changing.');
    this.name = new.target.name;
  }
}
