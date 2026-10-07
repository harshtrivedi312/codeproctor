// A busy session lock is never a 409 or a 500 (ADR 0013 section 5.7, 5.10 lock order): Postgres
// lock_timeout (55P03), deadlock_detected (40P01) and Prisma's write conflict (P2034), or the lock
// layer's own SessionLockRetryError, mean "try again": 503 with Retry-After for a request, a BullMQ
// retry for a job. One mapper, so every caller answers the same way.
import { HttpStatus } from '@nestjs/common';
import { CodedHttpException } from '../common/coded.exception';
import { SessionLockRetryError } from './session-lock.port';

/**
 * 55P03 lock_timeout, 40P01 deadlock_detected, P2034 Prisma write conflict or deadlock, and P2028
 * (an interactive transaction that ran out of its timeout: for a transaction that waits on the
 * `sessions` row that is the lock wait). P2028 also covers pool exhaustion and "transaction already
 * closed"; 503 with a retry is still the right answer for those.
 */
const BUSY_CODES = new Set(['55P03', '40P01', 'P2034', 'P2028']);

/** Seconds a client is told to wait. */
export const BUSY_LOCK_RETRY_AFTER_SECONDS = 2;

type Probe = {
  code?: unknown;
  originalCode?: unknown;
  meta?: { code?: unknown; driverAdapterError?: { cause?: unknown } };
  cause?: unknown;
};

const busy = (value: unknown): boolean => typeof value === 'string' && BUSY_CODES.has(value);

/**
 * Looks through `code`, `originalCode`, `meta` and the `cause` chain of a driver or Prisma error.
 * Under Prisma 7 with the pg adapter the SQLSTATE sits in `meta.driverAdapterError.cause`
 * (`originalCode` or `code`), or in `cause.originalCode` of a bare DriverAdapterError
 * (database/error-scrub.ts reads the same places).
 */
export function isBusyLockError(error: unknown): boolean {
  if (error instanceof SessionLockRetryError) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const e = current as Probe;
    if (busy(e.code) || busy(e.originalCode) || busy(e.meta?.code)) return true;
    const adapter = e.meta?.driverAdapterError?.cause;
    if (typeof adapter === 'object' && adapter !== null) {
      const c = adapter as Probe;
      if (busy(c.originalCode) || busy(c.code)) return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * 503 LOCK_BUSY with Retry-After when `error` is a busy lock, otherwise null (the caller rethrows
 * its own error). The candidate request paths (consent, test start, heartbeat: BE-07 #98) call this
 * around their transactions; see FU-BEB-117 for the files that must.
 */
export function busyLockToProblem(error: unknown): CodedHttpException | null {
  if (!isBusyLockError(error)) return null;
  return new CodedHttpException(
    HttpStatus.SERVICE_UNAVAILABLE,
    'The session is busy. Try again in a moment.',
    'LOCK_BUSY',
    { retryAfterSeconds: BUSY_LOCK_RETRY_AFTER_SECONDS },
  );
}
