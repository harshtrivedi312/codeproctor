// The org context: who is asking, and for which org. The extension in org-scope.extension.ts reads
// it on every query, so a query can only touch rows of that org (ADR 0006, TC-008).
//
// Why AsyncLocalStorage and not Nest's request scope. A request-scoped provider makes every
// provider that injects it request-scoped too, and Nest then builds a new instance of that whole
// chain on each request: slower (NFR-01), and not usable outside HTTP. This API also runs BullMQ
// jobs and Socket.IO events, which have no request object. AsyncLocalStorage keeps every provider
// a singleton, follows the async call chain of one request (or job, or socket event), and gives
// concurrent requests separate contexts. The context is "request-scoped" in the sense that
// matters: it lives for exactly one unit of work and cannot leak to the next.
//
// How the context is set:
// - Staff HTTP routes: OrgContextInterceptor reads `request.user` (BE-02's JwtAuthGuard sets an
//   AuthUser there) and calls runAsUser.
// - Candidate routes: CandidateSessionGuard (BE-07) calls runAsCandidate(orgId, sessionId) from the
//   verified token claims (ADR 0013 section 5.10, CS-4.1). Session jobs: SessionJobProcessor (BE-07)
//   calls detachForSessionJob and then runAsSessionJob(orgId, sessionId) from the job payload. Both
//   enter a scope bound to ONE session, and the entry sets the actor (CANDIDATE or SERVICE): it is
//   never a parameter, so it cannot be forged.
// - Jobs and sockets that span sessions: the code that resolves the org calls runInOrg.
// - Work that has no org yet or spans orgs: runSystem, with one of the named reasons below.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { UserRole } from '../generated/prisma/enums.js';
import { OrgContextMissingError, OrgScopeViolationError } from './errors';
import { GRANT_SITES } from './session-scope-map';
import type { GrantSite, GrantView } from './session-scope-map';

/**
 * Who is asking, inside the context. The interceptor builds it from BE-02's `AuthUser`
 * (`id` becomes `userId`). The orgId comes from the verified token, never from the request body, a
 * header or a query string.
 */
export interface AuthenticatedUser {
  readonly orgId: string;
  readonly userId: string;
  readonly role: UserRole;
}

/**
 * The only reasons to run without an org filter. A new reason is a reviewed change to this list
 * (architect), not a string a caller makes up.
 */
export const SYSTEM_SCOPE_REASONS = {
  AUTH_BOOTSTRAP:
    "Lookups before the caller's org is known. Staff side: login by email, refresh-token " +
    'rotation, set-password tokens. Candidate side: only the three routes before a session JWT ' +
    'exists (invitation-link resolve, OTP send, OTP verify; ADR 0013 section 5.10). A candidate ' +
    'JWT is never resolved to its session here: CandidateSessionGuard verifies it and enters ' +
    'runAsCandidate(oid, sid) from the claims, outside every system scope. Switch to runAsUser or ' +
    'runInOrg as soon as the org is known. It cannot enter a session scope.',
  BACKGROUND_JOB:
    'Scheduled cross-org discovery only: a scheduler that finds which orgs or sessions have work ' +
    'due. It is not for processing a job. It only enqueues: a job payload carries orgId and ' +
    'sessionId, stamped by the enqueuer from its own scope. A session job runs in ' +
    'SessionJobProcessor, which calls detachForSessionJob and then runAsSessionJob(orgId, ' +
    'sessionId); a cross-session job runs runInOrg(payload.orgId, ...). Either way the processor ' +
    'loads its target in scope and treats a miss as a poison job (ADR 0001 C-1, ADR 0006 8.4).',
  RETENTION_ERASURE:
    'Retention and erasure sweeps (FR-704, NFR-05): they select sessions of every org by date.',
  SCHEDULE_CAPACITY:
    'The cross-organisation read of scheduled_windows (ADR 0017 section 4.7, C-53): capacity ' +
    '(FR-306), the stale-ceiling rule and the monthly instance-hours. findMany, count, aggregate ' +
    'and groupBy of ScheduledWindow only, naming starts_at, ends_at, ceiling_at, status and kind ' +
    'only (schedule-capacity.ts); no other model, no write. Every write stays org-scoped.',
} as const;

export type SystemScopeReason = keyof typeof SYSTEM_SCOPE_REASONS;

/** Who works inside a session scope (ADR 0013 CS-4.1). The entry function sets it. */
export type SessionActor = 'CANDIDATE' | 'SERVICE';

/** The one session an org scope is bound to, and the actor working on it. Frozen. */
export interface SessionBinding {
  readonly actor: SessionActor;
  readonly sessionId: string;
}

/**
 * What a CANDIDATE scope knows about the session it was entered for, besides the ids in the token:
 * the candidate, the invitation and the test (ADR 0013 CS-4.4, "Candidate facts"). They drive the
 * injected row filters on `candidates`, `invitations` and `tests`. Set once, by
 * CandidateSessionGuard only (candidate-facts.ts); immutable afterwards.
 */
export interface CandidateFacts {
  readonly candidateId: string;
  readonly invitationId: string;
  readonly testId: string;
}

export type OrgScope =
  | {
      readonly kind: 'org';
      readonly orgId: string;
      readonly user?: AuthenticatedUser;
      /** Present only in a session scope (runAsCandidate, runAsSessionJob). */
      readonly session?: SessionBinding;
    }
  | { readonly kind: 'system'; readonly reason: SystemScopeReason };

/**
 * What `withGrant` asks for (ADR 0013 CS-4.4, ADR 0006 section 8.5). `model` is the Prisma model name
 * (`Session`, not `sessions`), `columns` are Prisma field names (`hmacKeyEnc`), and `ids` are the primary
 * keys of the rows the grant reaches. All three are mandatory, and an empty `ids` throws. `ids` are never
 * request input: they are read in the same scope, or resolved within the session (CS-2).
 */
export interface GrantRequest {
  readonly model: string;
  readonly columns: readonly string[];
  readonly ids: readonly (string | bigint | number)[];
}

/**
 * An active or finished grant, as the extension sees it (frozen). `active` is true while the callback of
 * `withGrant` is running and false from the moment it settles: the extension refuses every query that runs
 * under an inactive grant, and AsyncLocalStorage keeps the store of async work that `fn` started and did
 * not await (a promise, `setTimeout`, an emitter or a stream callback) alive after `fn` settled, so this
 * flag is what ends the grant. It cannot be set from outside: it reads a module-private set.
 */
export interface Grant extends GrantView {
  /** The CS-4.4 grant site the columns belong to (for messages and the call-site test). */
  readonly site: string;
  readonly active: boolean;
}

/** What AsyncLocalStorage holds for one unit of work. */
export interface ScopeStore {
  readonly scope?: OrgScope;
  /** Set only inside runRawSql: the written reason raw SQL is allowed. */
  readonly rawSqlReason?: string;
  /** Set only inside withGrant: the one grant of this unit of work (grants do not nest). */
  readonly grant?: Grant;
}

/** What the extension needs from the context. OrgContextService implements it. */
export interface ScopeSource {
  current(): ScopeStore | undefined;
  /** The candidate facts of the current CANDIDATE scope, or undefined while they are not set. */
  candidateFacts(): CandidateFacts | undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * What the run methods return. A Prisma query is a lazy thenable (a PrismaPromise); the service
 * starts it inside the scope and hands back a native Promise, so the type says Promise, not
 * PrismaPromise. Anything that is not a thenable is returned as it is.
 */
export type Scoped<T> = T extends PromiseLike<infer U> ? Promise<U> : T;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_RAW_REASON_LENGTH = 10;

/**
 * One storage for the whole process (FU-DB-83). The scope belongs to the unit of work, not to a
 * provider instance, so a service that is provided twice (a test module, a second Nest context)
 * shares it with the instance the extension was built with.
 */
const storage = new AsyncLocalStorage<ScopeStore>();

/**
 * The candidate facts of each CANDIDATE scope, keyed by the scope's own (frozen) session binding.
 * Module-private: the only writer is the setter below, so the facts cannot be changed from outside,
 * and a nested runInOrg of the same org (which keeps the binding) sees the same facts.
 */
const factsOfBinding = new WeakMap<SessionBinding, CandidateFacts>();

/**
 * The setter of the candidate facts is NOT a method of OrgContextService (a method, even one keyed by
 * a symbol, is reachable by reflection: `Object.getOwnPropertySymbols(OrgContextService.prototype)`).
 * It is a closure that exists once, in this module, and is handed out once, to candidate-facts.ts
 * (ADR 0013 CS-4.4: "one private setter in org-context.ts, which only CandidateSessionGuard may call,
 * once per scope"). A second claim throws, so a module that imports this file and asks first makes
 * candidate-facts.ts fail to load, loudly, instead of silently sharing the capability. A deep import of
 * `claimCandidateFactsSetter` is still a path: FU-DB-67 pins its importers (FU-DB-189).
 */
let factsSetterClaimed = false;

/**
 * candidate-facts.ts ONLY. Returns the one setter of the candidate facts, once per process. Not
 * exported from index.ts.
 */
export function claimCandidateFactsSetter(): (facts: CandidateFacts) => void {
  if (factsSetterClaimed) {
    throw new OrgScopeViolationError(
      'The candidate-facts setter was already claimed: only candidate-facts.ts may claim it.',
    );
  }
  factsSetterClaimed = true;
  return (facts) => {
    const scope = storage.getStore()?.scope;
    if (scope === undefined) throw new OrgContextMissingError('Setting the candidate facts');
    const session = scope.kind === 'org' ? scope.session : undefined;
    if (session?.actor !== 'CANDIDATE') {
      throw new OrgScopeViolationError(
        'The candidate facts can be set only inside a CANDIDATE scope (runAsCandidate).',
      );
    }
    if (factsOfBinding.has(session)) {
      throw new OrgScopeViolationError(
        'The candidate facts are already set for this scope, and are immutable.',
      );
    }
    const ids = [facts?.candidateId, facts?.invitationId, facts?.testId];
    if (!ids.every((id): id is string => typeof id === 'string' && GUID.test(id))) {
      throw new OrgScopeViolationError('The candidate facts need ids in uuid form.');
    }
    const [candidateId, invitationId, testId] = ids as [string, string, string];
    factsOfBinding.set(
      session,
      Object.freeze({
        candidateId: candidateId.toLowerCase(),
        invitationId: invitationId.toLowerCase(),
        testId: testId.toLowerCase(),
      }),
    );
  };
}

/**
 * The grants that are still running. Module-private on purpose: `Grant.active` reads it, and only
 * `withGrant` removes a grant from it, so nothing that holds a grant (through `current()`) can switch one
 * on again.
 */
const liveGrants = new WeakSet<object>();

/** The ids of a grant, normalised to what the filter compares: lower-case uuids, or bigint. */
function grantIds(site: GrantSite, ids: unknown): (string | bigint)[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new OrgScopeViolationError(
      `withGrant (${site.name}) needs ids, a non-empty list: ids are mandatory and an empty list throws ` +
        '(ADR 0013 CS-4.4).',
    );
  }
  const out = new Set<string | bigint>();
  for (const id of ids as unknown[]) {
    if (site.idKind === 'bigint') {
      const big =
        typeof id === 'bigint'
          ? id
          : typeof id === 'number' && Number.isSafeInteger(id)
            ? BigInt(id)
            : undefined;
      if (big === undefined || big <= 0n) {
        throw new OrgScopeViolationError(
          `withGrant (${site.name}) needs ids that are positive integers (a bigint primary key).`,
        );
      }
      out.add(big);
    } else {
      if (typeof id !== 'string' || !GUID.test(id)) {
        throw new OrgScopeViolationError(`withGrant (${site.name}) needs ids in uuid form.`);
      }
      out.add(id.toLowerCase());
    }
  }
  return [...out];
}

/** The one grant site of the model that names every requested column, or a throw. */
function grantSiteOf(request: unknown): { site: GrantSite; columns: readonly string[] } {
  if (typeof request !== 'object' || request === null) {
    throw new OrgScopeViolationError('withGrant needs { model, columns, ids }.');
  }
  const { model, columns: given } = request as Partial<GrantRequest>;
  if (typeof model !== 'string' || !GRANT_SITES.some((site) => site.model === model)) {
    throw new OrgScopeViolationError(
      'withGrant: this model has no grant site in ADR 0013 CS-4.4 (the explicit-only and grant-only ' +
        'models only).',
    );
  }
  // Copied first, once, and frozen: what is validated below is the very list the grant carries, so the
  // caller's array (or a Proxy that answers differently on each read) cannot change between the check and
  // the grant (review of #185, N1).
  const columns: readonly unknown[] | undefined = Array.isArray(given)
    ? Object.freeze(Array.from(given as readonly unknown[]))
    : undefined;
  if (
    columns === undefined ||
    columns.length === 0 ||
    !columns.every((column): column is string => typeof column === 'string') ||
    new Set(columns).size !== columns.length
  ) {
    throw new OrgScopeViolationError(
      `withGrant (${model}) needs columns: a non-empty list of distinct column names.`,
    );
  }
  const names = columns;
  // A grant names the columns of ONE site, so it cannot join the columns of two services.
  const site = GRANT_SITES.find(
    (candidate) =>
      candidate.model === model && names.every((column) => candidate.columns.includes(column)),
  );
  if (site === undefined) {
    throw new OrgScopeViolationError(
      `withGrant (${model}): these columns are not those of one grant site of ADR 0013 CS-4.4. A grant ` +
        'unlocks a subset of ONE site columns, never a column outside the sites or columns of two sites.',
    );
  }
  return { site, columns: names };
}

function isEmptyStore(store: ScopeStore | undefined): boolean {
  return store === undefined || Object.values(store).every((value) => value === undefined);
}

@Injectable()
export class OrgContextService implements ScopeSource {
  /** The scope of the current unit of work. A frozen object: it cannot be changed from outside. */
  current(): ScopeStore | undefined {
    return storage.getStore();
  }

  /** Run `fn` as a signed-in staff member. The interceptor calls this for staff routes. */
  runAsUser<T>(user: AuthenticatedUser, fn: () => T): Scoped<T> {
    // A frozen copy: the caller's object may change later, and the context must not.
    const frozen: AuthenticatedUser = Object.freeze({
      orgId: typeof user.orgId === 'string' ? user.orgId.toLowerCase() : user.orgId,
      userId: user.userId,
      role: user.role,
    });
    return this.#enter({ kind: 'org', orgId: frozen.orgId, user: frozen }, fn);
  }

  /**
   * Run `fn` for one org without a staff user: cross-session jobs and narrowing from system scope.
   * Inside a session scope (runAsCandidate, runAsSessionJob) of the same org it changes nothing:
   * the session and the actor stay (ADR 0013 CS-4.1, nesting).
   */
  runInOrg<T>(orgId: string, fn: () => T): Scoped<T> {
    return this.#enter({ kind: 'org', orgId }, fn);
  }

  /**
   * Run `fn` as a candidate, bound to ONE session (ADR 0013 CS-4.1; actor CANDIDATE). Called by
   * CandidateSessionGuard only, from the verified token claims (`oid`, `sid`). Allowed from no scope
   * only: inside any scope, system scope included, and inside a candidate scope of the same session,
   * it throws. Every query inside is filtered by the org and by the session (CS-4.2), is limited to
   * the CANDIDATE model allowlist (CS-4.3), and may not use relations (CS-4.5). Raw SQL is refused.
   * Entering sends no SQL. Both ids are lower-cased on entry.
   *
   * Column safety is the CS-4.4 allowlist (ADR 0013 CS-4 PR 2): a read names only readable columns, a
   * call that returns rows and names no `select` gets an `omit` of everything that is not in the default
   * select, the explicit-only columns need a grant (`withGrant`), and a write carries only the columns of
   * the model's write list plus the ones a grant unlocks (candidate-interim.ts, session-scope-map.ts).
   * Until the guard calls the candidate-facts setter, every query in this scope throws.
   */
  runAsCandidate<T>(orgId: string, sessionId: string, fn: () => T): Scoped<T> {
    return this.#enterSession('CANDIDATE', 'runAsCandidate', orgId, sessionId, fn);
  }

  /**
   * Run `fn` as a session job, bound to ONE session (ADR 0013 CS-4.1; actor SERVICE). Called by
   * SessionJobProcessor only, from the job payload, after detachForSessionJob. Allowed from no scope
   * only: any scope, every system scope (BACKGROUND_JOB included), refuses it. Every query inside is
   * filtered by the org and by the session on session-path models (CS-4.2); there is no allowlist
   * and no column limit. Raw SQL is refused. Entering sends no SQL. Both ids are lower-cased on entry.
   */
  runAsSessionJob<T>(orgId: string, sessionId: string, fn: () => T): Scoped<T> {
    return this.#enterSession('SERVICE', 'runAsSessionJob', orgId, sessionId, fn);
  }

  /**
   * SessionJobProcessor ONLY (ADR 0013 CS-4.1, ADR 0006 section 8.5). Asserts that the store is
   * empty, then runs `fn` in a fresh empty store. It throws if anything is present: any scope
   * (STAFF, plain org, SERVICE, CANDIDATE or system, BACKGROUND_JOB included), an open runRawSql
   * hatch, or a grant. A BullMQ worker is built at module init, outside any scope, and each session
   * job runs in its own worker callback; this is where the processor proves it did not inherit one,
   * and the only function that could ever be used to leave a scope. A candidate scope therefore
   * cannot leave itself. The call-site test (FU-DB-67) pins the one caller.
   */
  detachForSessionJob<T>(fn: () => T): Scoped<T> {
    if (!isEmptyStore(storage.getStore())) {
      throw new OrgScopeViolationError(
        'detachForSessionJob needs an empty context: it was called inside a scope, an open ' +
          'runRawSql, or a grant. Only SessionJobProcessor calls it, from a BullMQ worker callback.',
      );
    }
    return this.#runWith({}, fn);
  }

  /**
   * Run `fn` under a grant (ADR 0013 CS-4.4, ADR 0006 section 8.5): it unlocks exactly `columns` on exactly
   * `model`, for rows whose id is in `ids`, and nothing else. Private to the services of the eleven CS-4.4
   * grant sites; FU-DB-67 pins the call sites (FU-DB-189). All three fields are mandatory, and an empty
   * `ids` throws. `ids` are never request input.
   *
   * What the extension does with it, in a CANDIDATE scope:
   *   - `columns` are readable (an explicit-only column), or writable (a column of a write that CS-4.4 opens
   *     only under a grant: `sessions.status`, `pauseReasons`, `submittedAt`, `deviceInfo`), on that model
   *     only. A model that is readable only under a grant (`consent_texts`, `test_questions`) is readable
   *     through them. The one candidate create of `consents` needs its grant, and its `sessionId` must be
   *     one of the ids.
   *   - `id IN ids` is ANDed into every query on that model (a create grant has no where, so the ids
   *     constrain the checked session key instead). The model allowlist, the row filters, the session filter
   *     and the org filter are never widened: a grant of candidate A cannot reach candidate B's row.
   * It needs an org scope (none, or a system scope, throws), does not nest (a second grant inside the first
   * throws, also inside a callback that outlived it), and ends when `fn` settles: the `active` flag is
   * cleared in a `finally`, and any query under the inactive grant throws, so a promise or a timer that
   * `fn` started and did not await cannot use it later. In another actor's scope (staff, plain org,
   * SERVICE) there is no column limit, so the grant is validated and carries no filter.
   */
  withGrant<T>(request: GrantRequest, fn: () => T): Scoped<T> {
    const current = storage.getStore();
    const scope = current?.scope;
    if (current === undefined || scope === undefined) throw new OrgContextMissingError('withGrant');
    if (scope.kind !== 'org') {
      throw new OrgScopeViolationError(
        'withGrant needs an org scope: a grant exists only inside a scope that has an org.',
      );
    }
    if (current.grant !== undefined) {
      throw new OrgScopeViolationError(
        'A grant is already set for this unit of work (it may have ended): grants do not nest.',
      );
    }
    const { site, columns } = grantSiteOf(request);
    const ids = grantIds(site, (request as { ids?: unknown }).ids);
    const grant: Grant = Object.freeze({
      model: site.model,
      site: site.name,
      mode: site.mode,
      columns,
      ids: Object.freeze(ids),
      get active(): boolean {
        return liveGrants.has(grant);
      },
    });
    liveGrants.add(grant);
    let result: Scoped<T>;
    try {
      result = this.#runWith({ ...current, grant }, fn);
    } catch (error) {
      liveGrants.delete(grant);
      throw error;
    }
    if (isThenable(result)) {
      return Promise.resolve(result).finally(() => {
        liveGrants.delete(grant);
      }) as Scoped<T>;
    }
    liveGrants.delete(grant);
    return result;
  }

  /**
   * Run `fn` with no org filter, for one of the named reasons. Everything inside is unscoped, so
   * keep `fn` as small as possible and move to runInOrg once the org is known. Raw SQL is still
   * refused here: it has its own hatch, runRawSql. It cannot be called from inside an org scope
   * (a staff request, a candidate request, a job already narrowed to one org): work that has an
   * org never widens to all orgs.
   */
  runSystem<T>(reason: SystemScopeReason, fn: () => T): Scoped<T> {
    if (!Object.hasOwn(SYSTEM_SCOPE_REASONS, reason)) {
      throw new OrgScopeViolationError(
        'runSystem needs one of the reasons in SYSTEM_SCOPE_REASONS.',
      );
    }
    return this.#enter({ kind: 'system', reason }, fn);
  }

  /**
   * Allow raw SQL ($queryRaw, $executeRaw and their Unsafe forms) inside `fn`. Raw SQL cannot be
   * filtered by the extension, so the SQL itself must filter by org_id. The reason is free text,
   * for the reviewer: say what the query does and why the model API cannot. It needs an active
   * scope (org or system) and throws without one. The scope that is active stays in force for
   * model queries inside `fn`.
   *
   * The hatch stays open for the whole of `fn`, including any runAsUser, runInOrg or runSystem
   * started inside it (a nested scope keeps the outer hatch). So wrap only the single raw
   * statement, never a block that also does model work.
   */
  runRawSql<T>(reason: string, fn: () => T): Scoped<T> {
    if (reason.trim().length < MIN_RAW_REASON_LENGTH) {
      throw new OrgScopeViolationError(
        'runRawSql needs a written reason (at least 10 characters).',
      );
    }
    const current = storage.getStore();
    // The hatch is not a scope. With no org or system scope the model queries inside would throw
    // anyway, and a raw query alone would run with nobody accountable for the org.
    if (current?.scope === undefined) throw new OrgContextMissingError('runRawSql');
    return this.#runWith({ ...current, rawSqlReason: reason }, fn);
  }

  /**
   * The candidate facts of the current CANDIDATE scope, or undefined while they are not set (and in
   * every other scope). Read-only: the setter is a closure that only candidate-facts.ts holds.
   */
  candidateFacts(): CandidateFacts | undefined {
    const scope = storage.getStore()?.scope;
    const session = scope?.kind === 'org' ? scope.session : undefined;
    return session === undefined ? undefined : factsOfBinding.get(session);
  }

  /** The org of the current unit of work. Throws outside an org scope, including in system scope. */
  requireOrgId(): string {
    const scope = storage.getStore()?.scope;
    if (scope?.kind !== 'org') throw new OrgContextMissingError('This call');
    return scope.orgId;
  }

  /** The signed-in staff member. Throws when the work has no user (candidate route, job). */
  requireUser(): AuthenticatedUser {
    const scope = storage.getStore()?.scope;
    if (scope?.kind !== 'org' || scope.user === undefined) {
      throw new OrgContextMissingError('This call (it needs a signed-in staff user)');
    }
    return scope.user;
  }

  #enter<T>(requested: OrgScope, fn: () => T): Scoped<T> {
    const current = storage.getStore();
    let scope = requested;
    if (requested.kind === 'org') {
      if (typeof requested.orgId !== 'string' || !GUID.test(requested.orgId)) {
        throw new OrgScopeViolationError('The org context needs an org id in uuid form.');
      }
      // Lower-cased on entry, so `A` and `a` are one org in every comparison below and in the filters.
      scope = { ...requested, orgId: requested.orgId.toLowerCase() };
      // An org scope cannot be swapped for another org's inside the same unit of work. Narrowing
      // from system scope to one org is the intended use.
      if (current?.scope?.kind === 'org' && current.scope.orgId !== scope.orgId) {
        throw new OrgScopeViolationError("Already inside another org's scope; refusing to switch.");
      }
    }
    if (scope.kind === 'system' && current?.scope?.kind === 'org') {
      throw new OrgScopeViolationError(
        'Already inside an org scope; system scope would widen it to every org.',
      );
    }
    // A session scope only narrows (ADR 0013 CS-4.1, ADR 0006 section 8.4). The one thing that is
    // allowed inside it is runInOrg of the same org (the org switch is refused above), and it keeps
    // the session binding and the actor, so the scope object stays as it is. runAsUser would drop
    // or change the actor; runSystem is refused above.
    const bound = current?.scope?.kind === 'org' ? current.scope.session : undefined;
    if (current !== undefined && bound !== undefined) {
      if (scope.kind === 'org' && scope.user === undefined) return this.#runWith(current, fn);
      throw new OrgScopeViolationError(
        `Inside a ${bound.actor} session scope; runAsUser would drop or change the session or ` +
          'the actor. Only runInOrg of the same org is allowed.',
      );
    }
    return this.#runWith({ ...current, scope: Object.freeze(scope) }, fn);
  }

  /**
   * Enter a scope bound to one session. Allowed from no scope only, so no scope, hatch or grant of
   * the caller can carry into it, and a plain org scope never narrows into a session scope.
   */
  #enterSession<T>(
    actor: SessionActor,
    entry: string,
    orgId: string,
    sessionId: string,
    fn: () => T,
  ): Scoped<T> {
    if (typeof orgId !== 'string' || !GUID.test(orgId)) {
      throw new OrgScopeViolationError(`${entry} needs an org id in uuid form.`);
    }
    if (typeof sessionId !== 'string' || !GUID.test(sessionId)) {
      throw new OrgScopeViolationError(`${entry} needs a session id in uuid form.`);
    }
    if (!isEmptyStore(storage.getStore())) {
      throw new OrgScopeViolationError(
        `${entry} is allowed from no scope only: it was called inside a scope (a staff or org ` +
          'scope, a system scope, a session scope, or an open runRawSql). A session job detaches ' +
          'first (detachForSessionJob).',
      );
    }
    // Lower-cased on entry: every comparison of ids in the scope is then a plain string comparison.
    const session: SessionBinding = Object.freeze({ actor, sessionId: sessionId.toLowerCase() });
    return this.#runWith(
      { scope: Object.freeze({ kind: 'org', orgId: orgId.toLowerCase(), session }) },
      fn,
    );
  }

  /**
   * Prisma queries are lazy: `client.session.findMany()` sends nothing until something calls its
   * `.then()`. A callback like `() => client.session.findMany()` returns that unstarted query, and
   * the caller would start it after the context is gone. So a thenable result is started here,
   * inside the context, and a native Promise is returned.
   *
   * Only a result that is itself a thenable is handled. A query wrapped in an object or an array
   * (`() => ({ rows: client.x.findMany() })`) is not started here: it runs when it is finally
   * awaited, in whatever scope is active then, or with none (fail closed). Await queries inside
   * the callback.
   */
  #runWith<T>(store: ScopeStore, fn: () => T): Scoped<T> {
    // Frozen: current() returns this object to any caller, and it must not be a live one to mutate.
    return storage.run(Object.freeze(store), () => {
      const result = fn();
      return (isThenable(result) ? Promise.resolve(result) : result) as Scoped<T>;
    });
  }
}
