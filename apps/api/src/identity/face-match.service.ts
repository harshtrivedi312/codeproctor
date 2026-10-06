// The `face-match` job's logic (FR-403, TC-033; ADR 0014 3.3, 3.4, 5.2, 5.3, 6.2, 6.5; design notes
// section 4). Three steps, never nested: (1) read inside the org, (3) call the worker with no
// transaction, (4) write inside the org after re-reading what could have changed meanwhile.
//
// Rules this file enforces:
//   - the check never rejects: MATCH is PASSED; anything else is LOW_CONFIDENCE (attempt 1, the
//     candidate retries once) or MANUAL_REVIEW (attempt 2, or a match error at once);
//   - nothing is read after an erasure, and a waiver that lands meanwhile deletes the images and
//     writes no result (DL-30, C-34);
//   - the write is a compare-and-set on `status = PENDING`: a redelivered or stalled job cannot
//     rewrite a resolved row or duplicate IDENTITY_MANUAL_REVIEW;
//   - `verify-session` is queued after the commit, for PASSED and MANUAL_REVIEW (never for
//     LOW_CONFIDENCE, ADR 0015 section 7);
//   - the worker is called with cacheSelfie false (the client enforces it): the API never sees an
//     embedding, and no score, threshold or reason ever reaches the candidate.
import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_EVENT_SEVERITY, parseEventPayload } from '@codeproctor/shared';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { IdentityFacts } from './identity-facts';
import { IdentityMedia } from './identity-media';
import { VerifySessionPort } from './identity-ports';
import { IdentityPurgeService } from './identity-purge.service';
import { MAX_ATTEMPTS } from './identity.constants';
import { WorkerClient } from './worker-client';
import type { FaceMatchResponse } from './worker-client';

export interface FaceMatchData {
  readonly orgId: string;
  readonly sessionId: string;
  readonly attempt: number;
}

export type FaceMatchOutcome = 'RESOLVED' | 'SKIPPED';

type ReviewReason =
  'BELOW_THRESHOLD' | 'NO_FACE' | 'MULTIPLE_FACES' | 'LIVENESS_NOT_CONFIRMED' | 'MATCH_ERROR';

interface Resolution {
  readonly status: 'PASSED' | 'LOW_CONFIDENCE' | 'MANUAL_REVIEW';
  readonly reason: ReviewReason | null;
  readonly score: number | null;
  readonly modelId: string | null;
  readonly threshold: number | null;
}

/** ADR 0014 6.2: how a worker answer becomes an identity status. Never a rejection. */
export function resolve(attempt: number, response: FaceMatchResponse | null): Resolution {
  if (response === null) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'MATCH_ERROR',
      score: null,
      modelId: null,
      threshold: null,
    };
  }
  if (response.decision === 'MATCH' && response.reason === null && response.score !== null) {
    return {
      status: 'PASSED',
      reason: null,
      score: response.score,
      modelId: response.modelId,
      threshold: response.threshold,
    };
  }
  // An invalid answer (a MATCH that carries a reason, or a MANUAL_REVIEW with none) is not trusted:
  // it is a match error, which goes to manual review at once (design notes section 4).
  if (response.decision === 'MATCH' || response.reason === null) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'MATCH_ERROR',
      score: null,
      modelId: null,
      threshold: null,
    };
  }
  const reason: ReviewReason = response.reason;
  const retryable = reason !== 'MATCH_ERROR' && attempt < MAX_ATTEMPTS;
  return {
    status: retryable ? 'LOW_CONFIDENCE' : 'MANUAL_REVIEW',
    reason,
    score: response.score,
    modelId: response.modelId,
    threshold: response.threshold,
  };
}

@Injectable()
export class FaceMatchService {
  private readonly logger = new Logger(FaceMatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly media: IdentityMedia,
    private readonly facts: IdentityFacts,
    private readonly worker: WorkerClient,
    private readonly verify: VerifySessionPort,
    private readonly purge: IdentityPurgeService,
  ) {}

  /**
   * One run of the job. Throws what the worker client throws (WorkerBusyError, WorkerRetryableError,
   * WorkerUnrecoverableError) so the queue can retry or re-delay; `resolveAsMatchError` is what the
   * queue calls when no retry is left.
   */
  async run(data: FaceMatchData): Promise<FaceMatchOutcome> {
    // Step 1 (read, inside the org).
    const row = await this.orgContext.runInOrg(data.orgId, async () => {
      const found = await this.prisma.client.identityCheck.findFirst({
        where: { sessionId: data.sessionId, attempt: data.attempt },
        select: { status: true, idImageKey: true, selfieKey: true, livenessPassed: true },
      });
      if (found === null || found.status !== 'PENDING') return null; // done, or never existed
      return found;
    });
    if (row === null) return 'SKIPPED';
    if ((await this.stopReason(data)) !== null) return 'SKIPPED';
    if (row.idImageKey === null || row.selfieKey === null) {
      // No keys and no waiver (for example a waiver withdrawn after its purge): there is nothing to
      // match, so the candidate continues to review (D-05). The key condition does not apply here.
      await this.finish(data, resolve(data.attempt, null), false);
      return 'RESOLVED';
    }

    // Step 3 (no transaction): re-read just before presigning, then call the worker.
    const stop = await this.stopReason(data);
    if (stop !== null) return 'SKIPPED';
    const [idImageUrl, selfieUrl] = await Promise.all([
      this.media.presignForWorker(row.idImageKey),
      this.media.presignForWorker(row.selfieKey),
    ]);
    const response = await this.worker.faceMatch({
      sessionId: data.sessionId,
      attempt: data.attempt === 2 ? 2 : 1,
      idImageUrl,
      selfieUrl,
      livenessConfirmed: row.livenessPassed === true,
    });

    // Step 4 (write, inside the org, after one more look).
    return this.finish(data, resolve(data.attempt, response));
  }

  /** The queue calls this when the worker failed for good: the candidate continues (D-05). */
  async resolveAsMatchError(data: FaceMatchData): Promise<FaceMatchOutcome> {
    return this.finish(data, resolve(data.attempt, null));
  }

  /** Why the job must not touch images or write, or null: ERASED, a waiver (DL-30). */
  private async stopReason(data: FaceMatchData): Promise<'ERASED' | 'WAIVED' | null> {
    const session = await this.orgContext.runInOrg(data.orgId, () =>
      this.facts.session(data.sessionId),
    );
    if (session === null || session.imagesGone) return 'ERASED';
    const policy = await this.orgContext.runInOrg(data.orgId, () =>
      this.facts.policy(data.sessionId),
    );
    if (policy.waived) {
      // The waiver landed after the upload: the images go at once and nothing is written.
      await this.purge.purgeAfterWaiver(data.orgId, data.sessionId);
      this.logger.log({
        event: 'identity.face-match',
        sessionId: data.sessionId,
        outcome: 'waived',
      });
      return 'WAIVED';
    }
    return null;
  }

  private async finish(
    data: FaceMatchData,
    result: Resolution,
    requireKeys = true,
  ): Promise<FaceMatchOutcome> {
    const wrote = await this.orgContext.runInOrg(data.orgId, async () => {
      // guardLive in spirit: look again at what could have changed during the worker call.
      const session = await this.facts.session(data.sessionId);
      if (session === null || session.imagesGone) return 'GONE' as const;
      if ((await this.facts.policy(data.sessionId)).waived) return 'WAIVED' as const;
      return this.prisma.client.$transaction(async (tx) => {
        // Re-read the erasure fence inside the transaction (guardLive's job once it exists).
        const live = await tx.session.findUnique({
          where: { id: data.sessionId },
          select: {
            invitation: {
              select: { candidate: { select: { erasureRequestedAt: true, erasedAt: true } } },
            },
          },
        });
        const fence = live?.invitation.candidate;
        if (live === null || fence?.erasureRequestedAt != null || fence?.erasedAt != null) {
          return 'GONE' as const;
        }
        // The keys still being there is part of the compare-and-set (except on the keyless path, where
        // there are none to compare): a waiver's purge nulls them
        // under the row lock, so a result computed before the purge updates nothing (DL-30).
        const target = await tx.identityCheck.findFirst({
          where: {
            sessionId: data.sessionId,
            attempt: data.attempt,
            status: 'PENDING',
            ...(requireKeys ? { idImageKey: { not: null }, selfieKey: { not: null } } : {}),
          },
          select: { id: true },
        });
        if (target === null) return 'LOST' as const; // resolved, or purged, since the pre-check
        const updated = await tx.identityCheck.updateMany({
          where: {
            id: target.id,
            status: 'PENDING',
            ...(requireKeys ? { idImageKey: { not: null }, selfieKey: { not: null } } : {}),
          },
          data: {
            status: result.status,
            reviewReason: result.reason,
            faceMatchScore: result.score,
            modelId: result.modelId,
            threshold: result.threshold,
          },
        });
        if (updated.count !== 1) return 'LOST' as const; // another run resolved it first
        if (result.status === 'MANUAL_REVIEW') {
          await tx.proctorEvent.create({
            data: {
              sessionId: data.sessionId,
              type: 'IDENTITY_MANUAL_REVIEW',
              severity: DEFAULT_EVENT_SEVERITY.IDENTITY_MANUAL_REVIEW,
              source: 'SERVER',
              occurredAt: new Date(),
              payload: parseEventPayload('IDENTITY_MANUAL_REVIEW', {
                identityCheckId: target.id,
                reason: result.reason ?? 'MATCH_ERROR',
              }),
            },
          });
        }
        return 'WROTE' as const;
      });
    });
    if (wrote === 'WAIVED') {
      await this.purge.purgeAfterWaiver(data.orgId, data.sessionId);
      return 'SKIPPED';
    }
    if (wrote !== 'WROTE') return 'SKIPPED';
    // After the commit: the gate is PASSED or MANUAL_REVIEW, never LOW_CONFIDENCE.
    if (result.status === 'PASSED' || result.status === 'MANUAL_REVIEW') {
      await this.verify.enqueue(data.orgId, data.sessionId).catch(() => {
        // Nothing here retries it: the CONSENTED reconciler (ADR 0015 section 11, BE-07) does.
        this.logger.warn('verify-session could not be queued');
      });
    }
    this.logger.log({
      event: 'identity.face-match',
      sessionId: data.sessionId,
      attempt: data.attempt,
      outcome: result.status,
    });
    return 'RESOLVED';
  }
}
