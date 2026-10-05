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
    "Queue and worker jobs that find work across orgs before narrowing to the job's own org " +
    '(ADR 0001 C-1).',
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

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_RAW_REASON_LENGTH = 10;

@Injectable()
export class OrgContextService implements ScopeSource {
  private readonly storage = new AsyncLocalStorage<ScopeStore>();

  current(): ScopeStore | undefined {
    return this.storage.getStore();
  }

  /** Run `fn` as a signed-in staff member. The interceptor calls this for staff routes. */
  runAsUser<T>(user: AuthenticatedUser, fn: () => T): T {
    return this.enter({ kind: 'org', orgId: user.orgId, user }, fn);
  }

  /** Run `fn` for one org without a staff user: candidate routes (the token's session) and jobs. */
  runInOrg<T>(orgId: string, fn: () => T): T {
    return this.enter({ kind: 'org', orgId }, fn);
  }

  /**
   * Run `fn` with no org filter, for one of the named reasons. Everything inside is unscoped, so
   * keep `fn` as small as possible and move to runInOrg once the org is known. Raw SQL is still
   * refused here: it has its own hatch, runRawSql. It cannot be called from inside an org scope
   * (a staff request, a candidate request, a job already narrowed to one org): work that has an
   * org never widens to all orgs.
   */
  runSystem<T>(reason: SystemScopeReason, fn: () => T): T {
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
   * for the reviewer: say what the query does and why the model API cannot. The org scope that is
   * active stays in force for model queries inside `fn`.
   */
  runRawSql<T>(reason: string, fn: () => T): T {
    if (reason.trim().length < MIN_RAW_REASON_LENGTH) {
      throw new OrgScopeViolationError(
        'runRawSql needs a written reason (at least 10 characters).',
      );
    }
    const current = this.storage.getStore();
    return this.runWith({ ...current, rawSqlReason: reason }, fn);
  }

  /** The org of the current unit of work. Throws outside an org scope, including in system scope. */
  requireOrgId(): string {
    const scope = this.storage.getStore()?.scope;
    if (scope?.kind !== 'org') throw new OrgContextMissingError('This call');
    return scope.orgId;
  }

  /** The signed-in staff member. Throws when the work has no user (candidate route, job). */
  requireUser(): AuthenticatedUser {
    const scope = this.storage.getStore()?.scope;
    if (scope?.kind !== 'org' || scope.user === undefined) {
      throw new OrgContextMissingError('This call (it needs a signed-in staff user)');
    }
    return scope.user;
  }

  private enter<T>(scope: OrgScope, fn: () => T): T {
    const current = this.storage.getStore();
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
    return this.runWith({ ...current, scope }, fn);
  }

  /**
   * Prisma queries are lazy: `client.session.findMany()` sends nothing until something calls its
   * `.then()`. A callback like `() => client.session.findMany()` returns that unstarted query, and
   * the caller would start it after the context is gone. So a thenable result is started here,
   * inside the context. (A native Promise is returned for a Prisma query, which is what every
   * caller awaits.)
   */
  private runWith<T>(store: ScopeStore, fn: () => T): T {
    return this.storage.run(store, () => {
      const result = fn();
      return isThenable(result) ? (Promise.resolve(result) as T) : result;
    });
  }
}
