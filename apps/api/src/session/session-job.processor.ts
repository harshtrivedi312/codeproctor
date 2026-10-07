// SessionJobProcessor: the base class of every job that writes one session (ADR 0013 section 5.7
// "Structural, not a list", CS-4.1, CS-4.7). It is the ONLY place a session job opens a write
// transaction or enters the SERVICE scope: a static scan (session-job-writers.spec.ts) fails for
// any other file that calls runAsSessionJob or detachForSessionJob.
//
//   withLiveSession(sid, orgId, fn)   detach from any inherited scope, enter runAsSessionJob, open
//                                     ONE $transaction, call guardLive FIRST, and run `fn` only when
//                                     the session is LIVE. ERASED writes nothing.
//   withAnySession(job, sid, orgId, fn)  the same lock, but `fn` also runs on an ERASED session. Only
//                                     for the jobs of ADR 0013 section 5.7 that must (ANY_SESSION_JOBS).
//
// Errors. SessionNotFoundError drops the job (outcome DROPPED, logged with ids only, no retry).
// SessionLockRetryError is rethrown so BullMQ retries. Any other error rolls back and propagates.
// The transaction stays short: no external call (Judge0, the worker, HTTP) inside `fn`.
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { isBusyLockError } from './busy-lock';
import { OrgContextService } from '../database/org-context';
import type { OrgScope } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import {
  SessionLockPort,
  SessionLockRetryError,
  SessionLockUnavailableError,
  SessionNotFoundError,
} from './session-lock.port';
import type { SessionTx } from './session-lock.port';

/**
 * The jobs allowed to run on an ERASED session (ADR 0013 section 5.7: ingest close and key
 * destruction, both sweep passes, evidence-expire, the erasure re-run, and the consent PDF job,
 * because the consent record is kept, C-17). Adding a name is a reviewed change.
 */
export const ANY_SESSION_JOBS = [
  'ingest-close',
  'sweep-1',
  'sweep-2',
  'evidence-expire',
  'erasure-rerun',
  'consent-pdf',
] as const;
export type AnySessionJob = (typeof ANY_SESSION_JOBS)[number];

/**
 * Which file may call withAnySession, and for which jobs. Empty until a caller exists (the
 * erasure jobs, BE-09 and later): adding an entry is a reviewed change, and session-job-writers.spec.ts
 * fails for a caller that is not listed here.
 */
export const ANY_SESSION_CALLERS: Readonly<Record<string, readonly AnySessionJob[]>> = {};

export type LiveResult<T> =
  | { readonly outcome: 'LIVE'; readonly value: T }
  | { readonly outcome: 'ERASED' }
  /** The session was not found in the job's org: the job is dropped, not retried. */
  | { readonly outcome: 'DROPPED' };

export type AnyResult<T> =
  { readonly outcome: 'LIVE' | 'ERASED'; readonly value: T } | { readonly outcome: 'DROPPED' };

/** A write transaction of a session job is cut off after this long (statement and lock waits). */
const TRANSACTION_TIMEOUT_MS = 10_000;

export { isBusyLockError };

export abstract class SessionJobProcessor {
  protected abstract readonly logger: Logger;

  /** The ERASED-tolerant jobs this class may run; a subclass lists its own (see ANY_SESSION_CALLERS). */
  protected readonly anySessionJobs: readonly AnySessionJob[] = [];

  // Private on purpose: a subclass reaches the database only through the transaction `fn` gets.
  protected constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly locks: SessionLockPort,
  ) {}

  /** The scope the caller is in right now (for an enqueue that must match the caller's session). */
  protected currentScope(): OrgScope | undefined {
    return this.orgContext.current()?.scope;
  }

  /** `fn` runs only when guardLive says LIVE. */
  protected async withLiveSession<T>(
    sessionId: string,
    orgId: string,
    fn: (tx: SessionTx) => Promise<T>,
  ): Promise<LiveResult<T>> {
    const result = await this.run(sessionId, orgId, async (tx) => {
      const state = await this.locks.guardLive(tx, sessionId);
      if (state === 'ERASED') return { outcome: 'ERASED' } as const;
      return { outcome: 'LIVE', value: await fn(tx) } as const;
    });
    return result;
  }

  /** The ERASED-tolerant entry. `job` must be one of ANY_SESSION_JOBS. */
  protected async withAnySession<T>(
    job: AnySessionJob,
    sessionId: string,
    orgId: string,
    fn: (tx: SessionTx) => Promise<T>,
  ): Promise<AnyResult<T>> {
    if (
      !(ANY_SESSION_JOBS as readonly string[]).includes(job) ||
      !this.anySessionJobs.includes(job)
    ) {
      throw new Error(`Job "${String(job)}" may not use withAnySession (ADR 0013 section 5.7)`);
    }
    return this.run(sessionId, orgId, async (tx) => {
      // lockAnySession locks in any status, ERASED included, and `fn` runs either way; the outcome
      // only tells the caller what the row was (ADR 0013 section 5.7).
      const state = await this.locks.lockAnySession(tx, sessionId);
      return { outcome: state, value: await fn(tx) } as const;
    });
  }

  private async run<R>(
    sessionId: string,
    orgId: string,
    inTransaction: (tx: SessionTx) => Promise<R>,
  ): Promise<R | { readonly outcome: 'DROPPED' }> {
    try {
      // Detach first: a BullMQ worker callback must prove it inherited no scope. Then the SERVICE
      // scope of this one session (the org filter and the session filter), and one transaction.
      return await this.orgContext.detachForSessionJob(() =>
        this.orgContext.runAsSessionJob(orgId, sessionId, () =>
          this.prisma.client.$transaction(inTransaction, { timeout: TRANSACTION_TIMEOUT_MS }),
        ),
      );
    } catch (e) {
      if (e instanceof SessionNotFoundError) {
        // Ids only: never a payload, a code or a key.
        this.logger.warn(`Session job dropped: session ${sessionId} not found in org ${orgId}`);
        return { outcome: 'DROPPED' };
      }
      // Postgres lock_timeout (55P03) and deadlock (40P01), or Prisma's own transaction conflict
      // (P2034): the lock was busy, so the job retries. Never swallowed, never a 500 to a candidate.
      if (isBusyLockError(e)) throw new SessionLockRetryError();
      // The lock layer is not wired: retrying cannot help, so the job fails for good (the message
      // is the class name only).
      if (e instanceof SessionLockUnavailableError) throw new UnrecoverableError(e.name);
      // SessionLockRetryError and every other error: the transaction rolled back and the error
      // propagates, so BullMQ retries the job (attempts and backoff are the job's options).
      throw e;
    }
  }
}
