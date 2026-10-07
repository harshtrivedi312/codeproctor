// The ports erasure needs from other modules (ADR 0004 9.5; C-06, C-17). Abstract classes, like
// MailPort: Backend B implements the fence over SessionStateService, and the BullMQ module provides
// the scheduler, the notices and the alert. Nothing here may log or throw a value; payloads carry
// ids only (never an email, a name or an object key).
import { Injectable } from '@nestjs/common';

/**
 * The session fence (ADR 0004 9.5 step 3; hub ruling on the erasure fence): a SERVICE session job in
 * `SessionJobProcessor.withLiveSession`, enqueued with ids and the `closeOpenAppeal` flag only. Inside
 * the job, under the session lock, `guardLive` returning ERASED means "already erased"; a session that is
 * UNDER_REVIEW or APPEALED, or has an open appeal, while `closeOpenAppeal` is false, is held and left as
 * it is (the C-06 hold); otherwise the job bumps `auth_epoch` (the candidate token gets 401), moves the
 * session to ERASED (terminal, no exit), keeps `retention_anchor_at` or sets the fence time, closes
 * ingest at once with no grace, destroys the HMAC key, tells the worker to evict the selfie embedding,
 * and, when `closeOpenAppeal` is true, moves an OPEN appeal to CLOSED_ERASED (audited).
 * Retention never writes `sessions.status` itself and never calls `guardLive` from a plain org scope.
 *
 * The port only REQUESTS the fence; the answer is read back from the database. The erasure service runs
 * its data steps (object delete, row purge) only for sessions it reads as ERASED, and runs again until
 * every session is.
 */
export abstract class SessionFencePort {
  /**
   * Enqueues the fence job for one session. The job id is `erasure-fence_{sessionId}_{epoch seconds of
   * requestedAt}`: two requests in the same second collapse into one, and a FINISHED or FAILED job
   * never blocks a later request (BullMQ keeps a finished job's id until it is removed, so a fixed id
   * per session would turn a request after a closed hold into a no-op). The job should also set
   * `removeOnComplete` and `removeOnFail`. Resolves once the job is queued, not when it has run. Never
   * throws a value.
   */
  abstract requestFence(args: {
    orgId: string;
    sessionId: string;
    closeOpenAppeal: boolean;
    requestedAt: Date;
  }): Promise<void>;
}

/** The delayed re-run of the prefix delete and the database steps (ADR 0004 9.5 step 7). */
export abstract class ErasureSchedulerPort {
  /**
   * A delayed job with a fixed id `erasure-rerun_{requestId}_{epoch seconds of fencedAt}`
   * (underscores: one job per request and fence, so a fence after a hold closes is not dropped as a
   * duplicate), payload ids only, that calls `ErasureService.run`. `runAt` is the fence time + 60 s +
   * the storage sweep margin. The daily sweep retries if the job is lost.
   */
  abstract scheduleRerun(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
    fencedAt: Date;
    runAt: Date;
  }): Promise<void>;
  /**
   * A short delayed look-again after a fence was REQUESTED (not a fence time): a job with the id
   * `erasure-fence-poll_{requestId}_{epoch seconds of runAt}` that calls `ErasureService.run`. The
   * service stops asking once the request is older than an hour; the daily sweep covers the rest.
   */
  abstract scheduleFencePoll(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
    runAt: Date;
  }): Promise<void>;
}

/** The `erasure-completed` and `erasure-delayed` mail jobs (ids only; the worker owns the mail). */
export abstract class ErasureNoticePort {
  /** Job id `erasure-completed_{requestId}`. Every run re-enqueues until the email-sent row exists, so the worker's own sent-check is what deduplicates (a removed job's id can be reused). The worker writes ERASURE_EMAIL_SENT or ERASURE_EMAIL_FAILED. */
  abstract enqueueCompleted(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
  }): Promise<void>;
  /** The hold delays the erasure: the candidate is told once. */
  abstract enqueueDelayed(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
  }): Promise<void>;
}

export type ErasureAlertKind = 'ERASURE_DAY_25_NO_NOTICE' | 'ERASURE_PREFIX_UNVERIFIED';

/** A person must act (tell the candidate; look at an undeletable object). Deduplicated by the implementation. */
export abstract class ErasureAlertPort {
  abstract raise(args: {
    kind: ErasureAlertKind;
    orgId: string;
    candidateId: string;
    requestId: string;
  }): Promise<void>;
}

/**
 * The erasure list that survives a restore (ADR 0004 9.7, FU-DBB-02; `infra/backup/erasure-list.sh`):
 * an object `<prefix>erasure-list/<stamp>-<candidateId>.json` kept outside the dumps, re-applied after
 * a restore. Both calls are idempotent (the adapter must not write a second entry for a candidate that
 * has one) and carry the candidate id only. A failed `append` throws before anything is erased; a failed
 * `complete` throws after, and the daily sweep retries it until it succeeds.
 */
export abstract class ErasureListPort {
  /** Before the first fence of the request: without it a restore brings the candidate back. */
  abstract append(args: { orgId: string; candidateId: string }): Promise<void>;
  /** After the completion row exists and the candidate is anonymised: lets the entry be pruned. */
  abstract complete(args: { orgId: string; candidateId: string }): Promise<void>;
}

/** Each refuses every call until the real module binds it: nothing can erase half-wired. */
@Injectable()
export class UnconfiguredSessionFence extends SessionFencePort {
  requestFence(): Promise<void> {
    return Promise.reject(new Error('session fence is not configured'));
  }
}
@Injectable()
export class UnconfiguredErasureScheduler extends ErasureSchedulerPort {
  scheduleRerun(): Promise<void> {
    return Promise.reject(new Error('erasure scheduler is not configured'));
  }
  scheduleFencePoll(): Promise<void> {
    return Promise.reject(new Error('erasure scheduler is not configured'));
  }
}
@Injectable()
export class UnconfiguredErasureNotice extends ErasureNoticePort {
  enqueueCompleted(): Promise<void> {
    return Promise.reject(new Error('erasure notice is not configured'));
  }
  enqueueDelayed(): Promise<void> {
    return Promise.reject(new Error('erasure notice is not configured'));
  }
}
@Injectable()
export class UnconfiguredErasureAlert extends ErasureAlertPort {
  raise(): Promise<void> {
    return Promise.reject(new Error('erasure alert is not configured'));
  }
}
@Injectable()
export class UnconfiguredErasureList extends ErasureListPort {
  append(): Promise<void> {
    return Promise.reject(new Error('erasure list is not configured'));
  }
  complete(): Promise<void> {
    return Promise.reject(new Error('erasure list is not configured'));
  }
}
