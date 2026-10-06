// The per-session write locks (ADR 0013 section 5.7, ADR 0006 section 8.5, ADR 0015 section 6): the LOCK
// CORE. `SessionStateService.guardLive`, `.lockForAccommodation` and the job entry `withAnySession` are thin
// wrappers over the three functions here, which Backend B builds (BE-07; the hub's ruling in ADR PR #205).
//
//   guardLive(tx, sessionId)              SERVICE writers and the staff proctor-resume. Takes the row
//                                         lock of the session and says whether it is still LIVE or has
//                                         been ERASED (the erasure fence, ADR 0004 section 9). When it
//                                         says ERASED the caller writes nothing. Retry error:
//                                         SessionLockRetryError.
//   lockForAccommodation(tx, sessionId)   The accommodation writers (the PATCH, redact-note, the
//                                         video-check PUT, and the reductions of erasure, R-10 and
//                                         R-4). The same lock in ANY status, ERASED included, and it
//                                         returns the status it read under the lock. Retry error:
//                                         AccommodationLockedError (409 ACCOMMODATION_LOCKED).
//   lockAnySession(tx, sessionId)         The erasure-compatible JOBS (ingest close and key
//                                         destruction, the sweeps, evidence-expire, the erasure re-run,
//                                         the consent-PDF job): the same lock in ANY status, ERASED
//                                         included, no ERASED stop. Only SessionJobProcessor's
//                                         `withAnySession` uses it, through SessionStateService. Retry
//                                         error: SessionLockRetryError (a job: its own retry runs it).
//
// Both go through the model API, so there is no raw SQL and no FU-DB-67 raw call site: a read of
// `status`, then `sessions.updateMany` that writes the status to the value just read. Writing the same
// value still takes the row lock (Postgres writes a new tuple), and because no key column changes the
// lock is FOR NO KEY UPDATE: it excludes other `UPDATE sessions` and the fence, and it does NOT block
// the FOR KEY SHARE that a child-table insert (proctor_events, media_chunks, identity_checks) takes,
// so ingest is never stalled. `status: <read>` is in the `where`, so the same-value write can never
// revert a status change that committed in between; if one did, 0 rows change and the lock is retried
// from the read, at most three times. A plain status read is not enough: under READ COMMITTED a
// fence that commits just after the read would not be seen.
//
// WHO MAY CALL THEM. This module is NOT exported from index.ts, on purpose. The import guard
// (import-guard.spec.ts, rule `database/session-locks`, FU-DB-67) allows exactly one importer outside
// `database/`: the SessionStateService file, which Backend B adds in its PR and which exposes the wrappers.
// Not SessionJobProcessor and not the retention jobs: they go through SessionStateService. The call-site
// test (call-sites.spec.ts, CALL_SITES) pins the three names the same way. That entry is the review point.
// Candidate scopes never call these: they use `SessionStateService.transition()` (ADR 0013 CS-4.4a). In a
// CANDIDATE scope all three fail closed, because the write allowlist of a candidate refuses
// `sessions.status`, unless an active SessionStateService grant unlocks it (see the README).
//
// SCOPES. All three work in a SERVICE session scope (`runAsSessionJob`, after `detachForSessionJob`), a
// STAFF scope (`runAsUser`) and a plain org scope (`runInOrg`): the extension adds the org filter (and
// in a session scope the session filter) to the read and the write, so another org's session is simply
// not found. Call them as the FIRST statement of an interactive transaction, at READ COMMITTED (a
// higher isolation level turns the compare-and-set into serialization errors), and keep the
// transaction short: the lock is held until it commits.
//
// ERASED. `session_status` gains `ERASED` only with ADR 0004 section 9 (PR #91). Until that migration
// is on main the generated enum has no such member, and no row can be ERASED. The member is therefore
// taken from the generated enum at load time (`Object.hasOwn(SessionStatus, 'ERASED')`):
//   present  guardLive adds `NOT: { status: 'ERASED' }` to the write and returns 'ERASED' for an ERASED
//            row, writing nothing;
//   absent   the condition and the checks are left out, which is equivalent on such a database. The
//            moment #91 regenerates the client, the first branch is live with no code change.
import { SessionStatus } from '../generated/prisma/enums.js';
import {
  AccommodationLockedError,
  OrgScopeViolationError,
  SessionLockRetryError,
  SessionNotFoundError,
} from './errors';

/** What guardLive says: the session is still live (the lock is held), or it was erased (nothing written). */
export type GuardLiveResult = 'LIVE' | 'ERASED';

/** Total tries of the compare-and-set, the first included (ADR 0013 section 5.7, ADR 0015 section 6). */
export const MAX_LOCK_ATTEMPTS = 3;

/**
 * The `where` of the lock's compare-and-set: the row, the status that was read, and in guardLive (when
 * the enum has ERASED) the exclusion of ERASED.
 */
export interface SessionLockWhere {
  readonly id: string;
  readonly status: SessionStatus;
  readonly NOT?: { readonly status: SessionStatus };
}

/**
 * What the two functions need of a transaction client: two calls on `session`. The interactive
 * transaction client of the org-scoped client (`prisma.client.$transaction(async (tx) => ...)`) fits,
 * and so does a hand-made fake in a test. Nothing else of the client is reachable from here.
 *
 * `$connect` and `$disconnect` are typed `never`: Prisma removes them from an interactive transaction
 * client and the client itself has them. (`$transaction` is no discriminator: Prisma 7 leaves it on the
 * transaction client.) Passing `prisma.client` would take the lock and release it at once, because each
 * statement commits alone, so it does not compile, and both functions refuse it at run time too.
 */
export interface SessionLockTx {
  readonly $connect?: never;
  readonly $disconnect?: never;
  readonly session: {
    findUnique(args: {
      readonly where: { readonly id: string };
      readonly select: { readonly status: true };
    }): PromiseLike<{ readonly status: SessionStatus } | null>;
    updateMany(args: {
      readonly where: SessionLockWhere;
      readonly data: { readonly status: SessionStatus };
    }): PromiseLike<{ readonly count: number }>;
  };
}

/**
 * The ERASED member of the generated enum, or undefined while the enum lacks it (before PR #91).
 * Exported for the tests, which pass a made-up enum.
 */
export function erasedStatusOf(
  statuses: Readonly<Record<string, SessionStatus>>,
): SessionStatus | undefined {
  return Object.hasOwn(statuses, 'ERASED') ? statuses['ERASED'] : undefined;
}

/** Read once at load: the generated client does not change while the process runs. */
const ERASED: SessionStatus | undefined = erasedStatusOf(SessionStatus);

type LockOutcome =
  | { readonly outcome: 'locked'; readonly status: SessionStatus }
  | { readonly outcome: 'erased' }
  | { readonly outcome: 'exhausted' };

/**
 * The lock is held only until the transaction ends, so it must be taken on the interactive transaction
 * client. The client itself (it has `$connect` and `$disconnect`, which a transaction client lacks) would
 * run the read and the write as two statements that commit alone: no lock is held afterwards, and the
 * caller would believe it is. Fails closed.
 */
function assertTransactionClient(tx: SessionLockTx): void {
  const connection = tx as { readonly $connect?: unknown; readonly $disconnect?: unknown };
  if (typeof connection.$connect === 'function' || typeof connection.$disconnect === 'function') {
    throw new OrgScopeViolationError(
      'The session lock needs the transaction client of prisma.client.$transaction(async (tx) => ...), ' +
        'not the client itself: outside a transaction the lock is released at once.',
    );
  }
}

/** The status of the session in the caller's scope. No row (another org, unknown id) throws. */
async function readStatus(tx: SessionLockTx, sessionId: string): Promise<SessionStatus> {
  const row = await tx.session.findUnique({ where: { id: sessionId }, select: { status: true } });
  if (row === null) throw new SessionNotFoundError();
  return row.status;
}

/**
 * The shared loop. `excluded` is the status that must not be locked (ERASED for guardLive when the
 * enum has it), or undefined to lock a session in any status.
 *
 *   read status; excluded? -> 'erased' (no write)
 *   updateMany where { id, status: <read>, NOT excluded } data { status: <read> }
 *     1 row  -> 'locked' with the status read
 *     0 rows -> the status moved: re-read (a vanished row throws), and go round again
 *   After MAX_LOCK_ATTEMPTS lost tries -> 'exhausted' (unless the last re-read found the excluded status).
 */
async function lockSession(
  tx: SessionLockTx,
  sessionId: string,
  excluded: SessionStatus | undefined,
): Promise<LockOutcome> {
  assertTransactionClient(tx);
  let status = await readStatus(tx, sessionId);
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
    if (excluded !== undefined && status === excluded) return { outcome: 'erased' };
    const where: SessionLockWhere =
      excluded === undefined
        ? { id: sessionId, status }
        : { id: sessionId, status, NOT: { status: excluded } };
    const { count } = await tx.session.updateMany({ where, data: { status } });
    if (count > 0) return { outcome: 'locked', status };
    // 0 rows: the status changed between the read and the write. Look again.
    status = await readStatus(tx, sessionId);
  }
  return excluded !== undefined && status === excluded
    ? { outcome: 'erased' }
    : { outcome: 'exhausted' };
}

/**
 * guardLive with the ERASED member given, so a test can run the "enum has ERASED" branch before PR #91
 * puts it in the generated enum. Production code calls guardLive. Not a second entry point: this module
 * has the same importer allowlist as guardLive itself.
 */
export async function guardLiveWith(
  tx: SessionLockTx,
  sessionId: string,
  erased: SessionStatus | undefined,
): Promise<GuardLiveResult> {
  const result = await lockSession(tx, sessionId, erased);
  if (result.outcome === 'locked') return 'LIVE';
  if (result.outcome === 'erased') return 'ERASED';
  throw new SessionLockRetryError();
}

/**
 * The per-session write lock of a SERVICE writer (ADR 0013 section 5.7, ADR 0006 section 8.5). The first
 * statement of the write transaction; the transaction's writes follow only on 'LIVE'.
 *
 * @returns 'LIVE' when the row lock is held (one row updated). 'ERASED' when the session is erased (the
 *   status read, or the re-read after a lost compare-and-set, is ERASED): nothing was written and the
 *   caller writes nothing either.
 * @throws SessionNotFoundError   no such session in this scope (another org, unknown id): drop the job.
 * @throws SessionLockRetryError  the status changed under it three times in a row: the job's own retry
 *   handles it.
 */
export function guardLive(tx: SessionLockTx, sessionId: string): Promise<GuardLiveResult> {
  return guardLiveWith(tx, sessionId, ERASED);
}

/**
 * The lock in ANY status, ERASED included, for the two functions below: the status read under the lock, or
 * undefined when the three tries were lost. Nothing is excluded, so the 'erased' outcome cannot occur.
 */
async function lockAnyStatus(
  tx: SessionLockTx,
  sessionId: string,
): Promise<SessionStatus | undefined> {
  const result = await lockSession(tx, sessionId, undefined);
  return result.outcome === 'locked' ? result.status : undefined;
}

/**
 * The per-session lock of the accommodation writers (ADR 0015 section 6, ADR 0006 section 8.5): the same
 * lock as guardLive, in ANY status, ERASED included, because the reduction of an erased session's
 * accommodations must run. The first row lock of the transaction (lock order: the ADR 0004 advisory
 * lock where used, then this, then `invitations`).
 *
 * @returns the status the session had when it was locked, so the caller can apply the refusal list of
 *   ADR 0015 section 6 (c) (an ERASED status, the erasure facts, the results marker) on a status that
 *   cannot change under it.
 * @throws SessionNotFoundError      no such session in this scope: the route answers 404.
 * @throws AccommodationLockedError  the status changed under it three times in a row: 409
 *   ACCOMMODATION_LOCKED, or a BullMQ retry for a job.
 */
export async function lockForAccommodation(
  tx: SessionLockTx,
  sessionId: string,
): Promise<SessionStatus> {
  const status = await lockAnyStatus(tx, sessionId);
  if (status === undefined) throw new AccommodationLockedError();
  return status;
}

/**
 * The per-session lock of the erasure-compatible JOBS (ADR 0013 section 5.7 `withAnySession`, ADR 0006
 * section 8.5): ingest close and key destruction, both sweep passes, `evidence-expire`, the erasure re-run
 * and the consent-PDF job must still run on an ERASED session, so this is guardLive without the ERASED
 * stop. The same implementation as lockForAccommodation (any status, ERASED included, the status read
 * under the lock is returned), with the job's own retry error: a job is retried by BullMQ, it is not a 409.
 * Only SessionJobProcessor's `withAnySession` uses it, through SessionStateService.
 *
 * @returns the status the session had when it was locked.
 * @throws SessionNotFoundError   no such session in this scope (another org, unknown id): drop the job.
 * @throws SessionLockRetryError  the status changed under it three times in a row: the job's own retry
 *   handles it.
 */
export async function lockAnySession(tx: SessionLockTx, sessionId: string): Promise<SessionStatus> {
  const status = await lockAnyStatus(tx, sessionId);
  if (status === undefined) throw new SessionLockRetryError();
  return status;
}
