// The ports erasure needs from other modules (ADR 0004 9.5; C-06, C-17). Abstract classes, like
// MailPort: Backend B implements the fence over SessionStateService, and the BullMQ module provides
// the scheduler, the notices and the alert. Nothing here may log or throw a value; payloads carry
// ids only (never an email, a name or an object key).
import { Injectable } from '@nestjs/common';

export type FenceResult = 'fenced' | 'alreadyErased' | 'held';

/**
 * The session fence (ADR 0004 9.5 step 3): through SessionStateService.guardLive and closeIngest.
 * Bumps `auth_epoch` (the candidate token gets 401), moves the session to ERASED (terminal, no exit),
 * keeps an existing `retention_anchor_at` or sets the fence time, closes ingest at once with no
 * grace, destroys the HMAC key, tells the worker to evict the selfie embedding, and, when
 * `closeOpenAppeal` is true, moves an OPEN appeal to CLOSED_ERASED (audited). Retention never writes
 * `sessions.status` itself.
 */
export abstract class SessionFencePort {
  /**
   * 'held' when the session is UNDER_REVIEW or APPEALED, or has an open appeal, and `closeOpenAppeal`
   * is false. Idempotent: an ERASED session answers 'alreadyErased'. Never throws a value.
   */
  abstract fence(args: {
    orgId: string;
    sessionId: string;
    closeOpenAppeal: boolean;
  }): Promise<FenceResult>;
}

/** The delayed re-run of the prefix delete and the database steps (ADR 0004 9.5 step 7). */
export abstract class ErasureSchedulerPort {
  /**
   * A delayed job with a fixed id `erasure-rerun_{candidateId}_{epoch}` (underscores), payload ids
   * only, that calls `ErasureService.run`. `runAt` is the fence time + 60 s + the storage sweep margin.
   */
  abstract scheduleRerun(args: {
    orgId: string;
    candidateId: string;
    requestId: string;
    runAt: Date;
  }): Promise<void>;
}

/** The `erasure-completed` and `erasure-delayed` mail jobs (ids only; the worker owns the mail). */
export abstract class ErasureNoticePort {
  /** Job id `erasure-completed_{candidateId}_{epoch}`. The worker writes ERASURE_EMAIL_SENT or ERASURE_EMAIL_FAILED. */
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

/** Each refuses every call until the real module binds it: nothing can erase half-wired. */
@Injectable()
export class UnconfiguredSessionFence extends SessionFencePort {
  fence(): Promise<FenceResult> {
    return Promise.reject(new Error('session fence is not configured'));
  }
}
@Injectable()
export class UnconfiguredErasureScheduler extends ErasureSchedulerPort {
  scheduleRerun(): Promise<void> {
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
