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
    "Lookups before the caller's org is known: staff login by email, refresh-token rotation, " +
    'set-password tokens, resolving a candidate token to its session. Switch to runAsUser or ' +
    'runInOrg as soon as the org is known.',
  BACKGROUND_JOB:
    'Scheduled cross-org discovery only: a scheduler that finds which orgs or sessions have work ' +
    'due. It is not for processing a job. A job payload carries orgId and sessionId, stamped by ' +
    'the enqueuer from its own scope; the processor runs runInOrg(payload.orgId, ...), loads the ' +
    'session inside it, and treats a miss as a poison job (ADR 0001 C-1).',
  RETENTION_ERASURE:
    'Retention and erasure sweeps (FR-704, NFR-05): they select sessions of every org by date.',
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

/** What AsyncLocalStorage holds for one unit of work. */
export interface ScopeStore {
  readonly scope?: OrgScope;
  /** Set only inside runRawSql: the written reason raw SQL is allowed. */
  readonly rawSqlReason?: string;
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
 * The key of the private candidate-facts setter on OrgContextService (ADR 0013 CS-4.4: "one private
 * setter in org-context.ts, which only CandidateSessionGuard may call, once per scope"). A symbol,
 * so the method is not part of the service's public surface, and a symbol that is not registered
 * (`Symbol()`, not `Symbol.for()`), so it cannot be rebuilt from its name. Only candidate-facts.ts
 * imports it. It is not exported from index.ts. FU-DB-67 pins the importers.
 */
export const SET_CANDIDATE_FACTS: unique symbol = Symbol('OrgContextService.setCandidateFacts');

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
      orgId: user.orgId,
      userId: user.userId,
      role: user.role,
    });
    return this.enter({ kind: 'org', orgId: user.orgId, user: frozen }, fn);
  }

  /**
   * Run `fn` for one org without a staff user: cross-session jobs and narrowing from system scope.
   * Inside a session scope (runAsCandidate, runAsSessionJob) of the same org it changes nothing:
   * the session and the actor stay (ADR 0013 CS-4.1, nesting).
   */
  runInOrg<T>(orgId: string, fn: () => T): Scoped<T> {
    return this.enter({ kind: 'org', orgId }, fn);
  }

  /**
   * Run `fn` as a candidate, bound to ONE session (ADR 0013 CS-4.1; actor CANDIDATE). Called by
   * CandidateSessionGuard only, from the verified token claims (`oid`, `sid`). Allowed from no scope
   * only: inside any scope, system scope included, and inside a candidate scope of the same session,
   * it throws. Every query inside is filtered by the org and by the session (CS-4.2), is limited to
   * the CANDIDATE model allowlist (CS-4.3), and may not use relations (CS-4.5). Raw SQL is refused.
   * Entering sends no SQL.
   */
  runAsCandidate<T>(orgId: string, sessionId: string, fn: () => T): Scoped<T> {
    return this.enterSession('CANDIDATE', 'runAsCandidate', orgId, sessionId, fn);
  }

  /**
   * Run `fn` as a session job, bound to ONE session (ADR 0013 CS-4.1; actor SERVICE). Called by
   * SessionJobProcessor only, from the job payload, after detachForSessionJob. Allowed from no scope
   * only: any scope, every system scope (BACKGROUND_JOB included), refuses it. Every query inside is
   * filtered by the org and by the session on session-path models (CS-4.2); there is no allowlist
   * and no column limit. Raw SQL is refused. Entering sends no SQL.
   */
  runAsSessionJob<T>(orgId: string, sessionId: string, fn: () => T): Scoped<T> {
    return this.enterSession('SERVICE', 'runAsSessionJob', orgId, sessionId, fn);
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
    return this.runWith({}, fn);
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
    return this.enter({ kind: 'system', reason }, fn);
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
    return this.runWith({ ...current, rawSqlReason: reason }, fn);
  }

  /**
   * The candidate facts of the current CANDIDATE scope, or undefined while they are not set (and in
   * every other scope). Read-only: the setter is private (candidate-facts.ts).
   */
  candidateFacts(): CandidateFacts | undefined {
    const scope = storage.getStore()?.scope;
    const session = scope?.kind === 'org' ? scope.session : undefined;
    return session === undefined ? undefined : factsOfBinding.get(session);
  }

  /**
   * The private candidate-facts setter (ADR 0013 CS-4.4). Do not call it: use setCandidateFacts in
   * candidate-facts.ts, and only from CandidateSessionGuard. It refuses outside a CANDIDATE scope
   * and a second call in the same scope, and the values are frozen.
   * @internal
   */
  [SET_CANDIDATE_FACTS](facts: CandidateFacts): void {
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
    for (const id of [facts.candidateId, facts.invitationId, facts.testId]) {
      if (typeof id !== 'string' || !GUID.test(id)) {
        throw new OrgScopeViolationError('The candidate facts need ids in uuid form.');
      }
    }
    factsOfBinding.set(
      session,
      Object.freeze({
        candidateId: facts.candidateId,
        invitationId: facts.invitationId,
        testId: facts.testId,
      }),
    );
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

  private enter<T>(scope: OrgScope, fn: () => T): Scoped<T> {
    const current = storage.getStore();
    if (scope.kind === 'org') {
      if (!GUID.test(scope.orgId)) {
        throw new OrgScopeViolationError('The org context needs an org id in uuid form.');
      }
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
      if (scope.kind === 'org' && scope.user === undefined) return this.runWith(current, fn);
      throw new OrgScopeViolationError(
        `Inside a ${bound.actor} session scope; runAsUser would drop or change the session or ` +
          'the actor. Only runInOrg of the same org is allowed.',
      );
    }
    return this.runWith({ ...current, scope: Object.freeze(scope) }, fn);
  }

  /**
   * Enter a scope bound to one session. Allowed from no scope only, so no scope, hatch or grant of
   * the caller can carry into it, and a plain org scope never narrows into a session scope.
   */
  private enterSession<T>(
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
    const session: SessionBinding = Object.freeze({ actor, sessionId });
    return this.runWith({ scope: Object.freeze({ kind: 'org', orgId, session }) }, fn);
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
  private runWith<T>(store: ScopeStore, fn: () => T): Scoped<T> {
    // Frozen: current() returns this object to any caller, and it must not be a live one to mutate.
    return storage.run(Object.freeze(store), () => {
      const result = fn();
      return (isThenable(result) ? Promise.resolve(result) : result) as Scoped<T>;
    });
  }
}
