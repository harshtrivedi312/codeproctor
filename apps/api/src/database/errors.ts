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

/** Raw SQL outside OrgContextService.runRawSql. */
export class RawQueryNotAllowedError extends OrgScopeError {
  constructor(operation: string) {
    super(
      `${operation} is not allowed: raw SQL bypasses org scoping. ` +
        'Wrap a reviewed query in OrgContextService.runRawSql(reason, fn) and filter by org_id yourself.',
    );
  }
}
