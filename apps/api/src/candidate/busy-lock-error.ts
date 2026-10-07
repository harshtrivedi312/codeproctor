// "The session row is busy" as the candidate paths see it (DL-37, DL-42): Postgres lock_timeout
// (55P03), deadlock_detected (40P01), serialization_failure (40001), Prisma's write conflict
// (P2034) and its transaction timeout (P2028), and a pool-wait timeout (FU-BE-197),
// read through `code`, `originalCode`, `meta.driverAdapterError.cause` and the `cause` chain (the
// shapes Prisma 7 with the pg adapter produces; database/error-scrub.ts reads the same places).
// Backend A's ProblemFilter turns these into 503 with Retry-After so the client retries; the code
// here only has to give back what it took BEFORE the failing statement and rethrow the error as it
// is. Since FU-BE-197 (DL-42) it is the same predicate as the filter's (a pool-wait timeout
// counts: the action did not take place).
// FU-BEB-117: when the session-job branch merges, make session/busy-lock.ts delegate to
// lockContentionCode too; replacing this file with it as it stands would drop 40001 and the pool
// timeout from the candidate undo paths (FU-BE-204).
import { lockContentionCode } from '../common/db-contention';

export function isBusyLockError(error: unknown): boolean {
  return lockContentionCode(error) !== undefined;
}
