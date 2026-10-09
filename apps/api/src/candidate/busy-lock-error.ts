// "The session row is busy" as the candidate paths see it (DL-37): Postgres lock_timeout (55P03),
// deadlock_detected (40P01), Prisma's write conflict (P2034) and its transaction timeout (P2028),
// read through `code`, `originalCode`, `meta.driverAdapterError.cause` and the `cause` chain (the
// shapes Prisma 7 with the pg adapter produces; database/error-scrub.ts reads the same places).
// Backend A's ProblemFilter turns these into 503 with Retry-After so the client retries; the code
// here only has to give back what it took BEFORE the failing statement and rethrow the error as it
// is. FU-BEB-117: when the session-job branch merges, replace this with session/busy-lock.ts.
import { SessionLockRetryError } from '../database/errors';

const BUSY = new Set(['55P03', '40P01', 'P2034', 'P2028']);

type Probe = {
  code?: unknown;
  originalCode?: unknown;
  meta?: { code?: unknown; driverAdapterError?: { cause?: unknown } };
  cause?: unknown;
};

const busy = (value: unknown): boolean => typeof value === 'string' && BUSY.has(value);

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
