// The ONE adapter between the session jobs and the per-session write lock of Database A
// (ADR 0013 section 5.7 `guardLive`, `database/session-locks`). Nothing else in the session jobs
// imports that module, so when it lands only this file changes (see "How this flips" below).
//
// The contract, exactly as Database A builds it:
//   guardLive(tx, sessionId): Promise<'LIVE' | 'ERASED'>
//     The FIRST statement of a session job's write transaction. It takes the session row lock. On
//     'ERASED' the caller writes nothing. Throws SessionNotFoundError (the job is dropped) or
//     SessionLockRetryError (BullMQ retries the job). 'ERASED' cannot be returned until the ERASED
//     status exists (#91).
//
// How this flips (hub ruling for #206). Database A's #208 adds `database/session-locks.ts`, imported
// ONLY by SessionStateService. Add `guardLive`, `lockAnySession` and `lockForAccommodation`
// methods to SessionStateService (call shapes (tx, sessionId), delegating to that module), bind
// `StateServiceSessionLockPort` (a one-line delegate per method, mapping the module's
// SessionNotFoundError and SessionLockRetryError onto the classes below) in place of
// `UnwiredSessionLockPort`, and delete the stub and FU-BEB-111. Do not copy #208's SQL or tests.
// Until then the module binds `UnwiredSessionLockPort`, which always throws, so a deployment can
// never run a session job without the fence (the dev flow cannot reach VERIFIED until the real lock
// lands). `StubSessionLockPort` exists for specs only. MERGE BLOCKER: FU-BEB-111.
import { Injectable } from '@nestjs/common';
import type { SessionStatus } from '../generated/prisma/enums.js';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';

/** The transaction client a session job's callback receives. */
export type SessionTx = Parameters<Parameters<OrgScopedPrismaClient['$transaction']>[0]>[0];

export type SessionLockState = 'LIVE' | 'ERASED';

/** The session does not exist in the job's org: drop the job, never retry. */
export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'SessionNotFoundError';
  }
}

/** The lock could not be taken now (timeout, a concurrent change): let BullMQ retry the job. */
export class SessionLockRetryError extends Error {
  constructor() {
    super('Session lock busy');
    this.name = 'SessionLockRetryError';
  }
}

/** The lock layer is not wired in this environment: the job gives up loudly and is not retried. */
export class SessionLockUnavailableError extends Error {
  constructor() {
    super('The session lock (database/session-locks) is not wired; session jobs refuse to run');
    this.name = 'SessionLockUnavailableError';
  }
}

/**
 * The three call shapes of the lock core (hub ruling for #206; the core is Database A's #208,
 * `database/session-locks.ts`, imported only by SessionStateService). Who may call which:
 *   guardLive           SessionJobProcessor.withLiveSession and the one staff method
 *                       SessionStateService.proctorResume, nothing else
 *   lockAnySession      SessionJobProcessor.withAnySession only (its own allowlist, ANY_SESSION_JOBS)
 *   lockForAccommodation  the ADR 0015 accommodation writers and the erasure, R-4 and R-10 jobs;
 *                       never guardLive. Not used by the session-job layer yet.
 */
export abstract class SessionLockPort {
  /** First data statement of the write transaction. Writes nothing when it answers 'ERASED'. */
  abstract guardLive(tx: SessionTx, sessionId: string): Promise<SessionLockState>;
  /** Locks in any status, ERASED included, and always lets the caller go on. */
  abstract lockAnySession(tx: SessionTx, sessionId: string): Promise<SessionLockState>;
  /** Locks in any status and returns it; throws AccommodationLockedError (409) when locked. */
  abstract lockForAccommodation(tx: SessionTx, sessionId: string): Promise<SessionStatus>;
}

/** The module default: always throws. Nothing runs a session job until the real port is bound. */
@Injectable()
export class UnwiredSessionLockPort extends SessionLockPort {
  guardLive(): Promise<SessionLockState> {
    return Promise.reject(new SessionLockUnavailableError());
  }
  lockAnySession(): Promise<SessionLockState> {
    return Promise.reject(new SessionLockUnavailableError());
  }
  lockForAccommodation(): Promise<SessionStatus> {
    return Promise.reject(new SessionLockUnavailableError());
  }
}

/**
 * For tests only: specs construct it directly or override the provider. It answers LIVE only when
 * BOTH NODE_ENV and APP_ENV are "test" (two layers, so one misset variable cannot enable it), and
 * throws everywhere else.
 */
@Injectable()
export class StubSessionLockPort extends SessionLockPort {
  /** Reads the row (no lock) in a test environment; throws everywhere else. */
  private async read(tx: SessionTx, sessionId: string): Promise<SessionStatus> {
    if (process.env.NODE_ENV !== 'test' || process.env.APP_ENV !== 'test') {
      throw new SessionLockUnavailableError();
    }
    const row = await tx.session.findUnique({ where: { id: sessionId }, select: { status: true } });
    if (row === null) throw new SessionNotFoundError();
    return row.status;
  }

  async guardLive(tx: SessionTx, sessionId: string): Promise<SessionLockState> {
    await this.read(tx, sessionId);
    return 'LIVE';
  }

  async lockAnySession(tx: SessionTx, sessionId: string): Promise<SessionLockState> {
    await this.read(tx, sessionId);
    return 'LIVE';
  }

  lockForAccommodation(tx: SessionTx, sessionId: string): Promise<SessionStatus> {
    return this.read(tx, sessionId);
  }
}
