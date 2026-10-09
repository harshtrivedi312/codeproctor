// Which scopes may take a per-session write lock (session-locks.ts). One ALLOWLIST OF ACTORS PER LOCK, built to the
// merged ADR 0006 section 8.5 (#211, #213), which is the source of truth and the narrower, fail-closed reading
// (FU-DB-240). Everything not named throws at run time, before any statement, with a value-free
// OrgScopeViolationError:
//
//   guardLive             SERVICE (`runAsSessionJob`, through SessionJobProcessor.withLiveSession) and STAFF
//                         (`runAsUser`: the proctor-resume method `SessionStateService.proctorResume` only).
//   lockAnySession        SERVICE only (`runAsSessionJob`, through SessionJobProcessor.withAnySession). STAFF is
//                         refused.
//   lockForAccommodation  STAFF (`runAsUser`: the accommodations PATCH, redact-note and the video-check PUT) and the
//                         plain org JOB scope (`runInOrg(orgId)`: an org scope with no user, no session and not
//                         system; the scope that holds the ADR 0004 per-candidate advisory lock, which is refused in
//                         any session scope). The one site there is RetentionRepository.casAccommodations (erasure,
//                         R-4, R-10), one session at a time. SERVICE is refused: R-4 has no SERVICE caller and none
//                         may be added.
//
// Refused for all three: a CANDIDATE scope, with or without a grant (a candidate path never takes a session lock:
// `SessionStateService.transition()`'s own compare-and-set UPDATE is the first `sessions` lock of a candidate
// transaction, ADR 0013 CS-4.4a); system scope (no org filter: the lock could take a session of any org); no scope at
// all (the extension would throw on the first query; refused here first, so a client that is not org-scoped can never
// lock); any scope kind or session actor that does not exist today (a future kind is refused until it is added here,
// in a reviewed change).
//
// Why a plain org scope is safe for lockForAccommodation (the hub's conditions): the target session id comes from the
// job's own query, and the read and the write run under the org filter of the scope, so another org's session reads
// no row and throws SessionNotFoundError, never a lock on another org's row; the same-value updateMany and the
// any-status semantics are unchanged; and FU-DB-67 pins its call sites (call-sites.spec.ts: the STAFF accommodation
// routes through SessionStateService and the retention repository).
//
// A pure function over a scope value, so it is tested with synthetic scopes (an unknown kind, an unknown actor) that
// no public entry can build. NFR-04.
import { deepFreeze } from './deep-freeze';
import type { OrgScope } from './org-context';

/** The scopes one lock passes in. A scope that is not listed is refused. */
export interface LockScopePolicy {
  /** A session scope entered by `runAsSessionJob`. */
  readonly service: boolean;
  /** An org scope with a signed-in user, entered by `runAsUser`. */
  readonly staff: boolean;
  /** A plain org job scope: `runInOrg`, no user, no session, not system. */
  readonly plainOrg: boolean;
}

/**
 * The three policies, by lock name (the merged ADR 0006 section 8.5). The tests check them against a literal
 * matrix. FROZEN, deeply, when the module loads (`as const` is compile-time only): code that holds a reference
 * could otherwise write `LOCK_SCOPE_POLICY.lockAnySession.staff = true` and widen the run-time allowlist for the
 * rest of the process (the same rule as the CS-4 scope tables, deep-freeze.ts).
 */
export const LOCK_SCOPE_POLICY = deepFreeze({
  guardLive: { service: true, staff: true, plainOrg: false },
  lockAnySession: { service: true, staff: false, plainOrg: false },
  lockForAccommodation: { service: false, staff: true, plainOrg: true },
} as const satisfies Record<string, LockScopePolicy>);

/** The scopes of `policy`, in words, for a refusal message. */
function allowedText(policy: LockScopePolicy): string {
  const names = [
    policy.service ? 'a SERVICE scope (runAsSessionJob)' : undefined,
    policy.staff ? 'a STAFF scope (runAsUser)' : undefined,
    policy.plainOrg ? 'a plain org job scope (runInOrg)' : undefined,
  ].filter((name): name is string => name !== undefined);
  return names.length === 0 ? 'no scope' : names.join(' or ');
}

/**
 * Why `scope` may not take this lock, or undefined when it may. The messages name no value: no session id, no org id,
 * no user id.
 */
export function lockScopeRefusal(
  scope: OrgScope | undefined,
  policy: LockScopePolicy,
): string | undefined {
  const allowed = allowedText(policy);
  if (scope === undefined) {
    return `This session lock needs ${allowed}, and there is no scope at all.`;
  }
  // Read as plain data: a kind that does not exist today must land in the refusal, not throw.
  const kind: unknown = (scope as { readonly kind?: unknown }).kind;
  if (kind === 'system') {
    return (
      'This session lock is refused in system scope: it has no org filter, so the lock could take a ' +
      `session of any org. Enter ${allowed}.`
    );
  }
  if (kind !== 'org') {
    return `This session lock is refused in this kind of scope: only ${allowed} may take it.`;
  }
  const orgScope = scope as Extract<OrgScope, { kind: 'org' }>;
  const session: unknown = orgScope.session;
  const user: unknown = orgScope.user;
  // Fail closed on shape: a session or a user that is present but is not an object (null, a string, a
  // boolean) is neither a session scope nor STAFF nor a plain org scope: refused for every lock.
  const present = (value: unknown): boolean => value !== undefined;
  const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
  if ((present(session) && !isObject(session)) || (present(user) && !isObject(user))) {
    return 'This session lock is refused for a scope of an unexpected shape: only a well-formed scope may take it.';
  }
  if (isObject(session)) {
    const actor: unknown = (session as { readonly actor?: unknown }).actor;
    if (actor === 'SERVICE') {
      return policy.service
        ? undefined
        : `This session lock is refused in a SERVICE scope: only ${allowed} may take it.`;
    }
    if (actor === 'CANDIDATE') {
      return (
        'The session locks are refused in a CANDIDATE scope, with or without a grant: a candidate path ' +
        'never takes them, SessionStateService.transition() compare-and-sets the status itself.'
      );
    }
    return `This session lock is refused for this actor of a session scope: only ${allowed} may take it.`;
  }
  if (isObject(user)) {
    return policy.staff
      ? undefined
      : `This session lock is refused in a STAFF scope: only ${allowed} may take it.`;
  }
  return policy.plainOrg
    ? undefined
    : `This session lock is refused in a plain org scope with no actor (runInOrg): only ${allowed} may take it.`;
}
