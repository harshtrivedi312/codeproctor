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
// - Candidate routes, jobs, sockets: the code that resolves the org (the token's session, the job's
//   session) calls runInOrg.
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

export type OrgScope =
  | { readonly kind: 'org'; readonly orgId: string; readonly user?: AuthenticatedUser }
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

  /** Run `fn` for one org without a staff user: candidate routes (the token's session) and jobs. */
  runInOrg<T>(orgId: string, fn: () => T): Scoped<T> {
    return this.enter({ kind: 'org', orgId }, fn);
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
    return this.runWith({ ...current, scope: Object.freeze(scope) }, fn);
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
