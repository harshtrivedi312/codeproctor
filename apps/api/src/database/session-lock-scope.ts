// Which scopes may take a per-session write lock (session-locks.ts). An ALLOWLIST of actors, the hub's rulings
// (#211 and the follow-up on the review of #208). The three locks pass in
//   - SERVICE: a session scope entered by `runAsSessionJob` (the session jobs: SessionJobProcessor);
//   - STAFF:   an org scope with a signed-in user, entered by `runAsUser` (the proctor-resume route, the
//              accommodation routes);
// and `lockForAccommodation`, ONLY it, also passes in
//   - a plain org JOB scope: `runInOrg(orgId)`, an org scope with no user, no session and not system. Database B's
//     retention jobs (erasure, R-4, R-10) run per session there (ADR 0015 section 6(b), ADR 0006 section 8.5).
// Everything else is refused at run time, before any statement, with a value-free OrgScopeViolationError:
//   - a CANDIDATE scope, with or without a grant, for every lock (a candidate path never takes a session lock:
//     `SessionStateService.transition()`'s own compare-and-set UPDATE is the first `sessions` lock of a
//     candidate transaction, ADR 0013 CS-4.4a);
//   - system scope, for every lock (no org filter: the lock could take a session of any org);
//   - a plain org scope with no actor (`runInOrg`: for example the candidate guard's pre-read scope), for
//     guardLive and lockAnySession;
//   - no scope at all (the extension would throw on the first query; refused here first, so a client that is
//     not org-scoped can never lock);
//   - any scope kind or session actor that does not exist today (a future kind is refused until it is
//     added here, in a reviewed change).
//
// Why a plain org scope is safe for lockForAccommodation (the hub's conditions): the target session id comes
// from the job's own query, and the read and the write run under the org filter of the scope, so another
// org's session reads no row and throws SessionNotFoundError, never a lock on another org's row; the
// same-value updateMany and the any-status semantics are unchanged; and FU-DB-67 pins its call sites
// (call-sites.spec.ts: the retention repository and the accommodation writers, through SessionStateService).
//
// A pure function over a scope value, so it is tested with synthetic scopes (an unknown kind, an unknown
// actor) that no public entry can build. NFR-04.
import type { OrgScope } from './org-context';

/**
 * Why `scope` may not take a session lock, or undefined when it may (SERVICE or STAFF, and a plain org job scope
 * when `allowPlainOrg`, which only lockForAccommodation passes). The messages name no value: no session id, no
 * org id, no user id.
 */
export function lockScopeRefusal(
  scope: OrgScope | undefined,
  allowPlainOrg = false,
): string | undefined {
  if (scope === undefined) {
    return (
      'The session locks need a SERVICE (runAsSessionJob) or STAFF (runAsUser) scope, and there is no ' +
      'scope at all.'
    );
  }
  // Read as plain data: a kind that does not exist today must land in the last branch, not throw.
  const kind: unknown = (scope as { readonly kind?: unknown }).kind;
  if (kind === 'system') {
    return (
      'The session locks are refused in system scope: it has no org filter, so the lock could take a ' +
      'session of any org. Enter a SERVICE (runAsSessionJob) or STAFF (runAsUser) scope.'
    );
  }
  if (kind !== 'org') {
    return (
      'The session locks are refused in this kind of scope: only a SERVICE (runAsSessionJob) or STAFF ' +
      '(runAsUser) scope may take them.'
    );
  }
  const orgScope = scope as Extract<OrgScope, { kind: 'org' }>;
  const session: unknown = orgScope.session;
  if (session !== undefined) {
    const actor: unknown = (session as { readonly actor?: unknown }).actor;
    if (actor === 'SERVICE') return undefined;
    if (actor === 'CANDIDATE') {
      return (
        'The session locks are refused in a CANDIDATE scope, with or without a grant: a candidate path ' +
        'never takes them, SessionStateService.transition() compare-and-sets the status itself.'
      );
    }
    return (
      'The session locks are refused for this actor of a session scope: only SERVICE (runAsSessionJob) ' +
      'may take them.'
    );
  }
  if (orgScope.user !== undefined) return undefined; // STAFF
  if (allowPlainOrg) return undefined; // a plain org job scope: lockForAccommodation only
  return (
    'The session locks are refused in a plain org scope with no actor (runInOrg): only a SERVICE ' +
    '(runAsSessionJob) or STAFF (runAsUser) scope may take them.'
  );
}
