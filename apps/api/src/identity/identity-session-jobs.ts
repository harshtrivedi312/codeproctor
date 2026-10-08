// The identity job's two session writes, on SessionJobProcessor (ADR 0013 5.7, CS-4.7; FU-INB-29 for
// the part that is still on the org scope: the Worker file and the reads before the worker call).
//
//   commit(...)        the compare-and-set that resolves an identity_checks row and the review event,
//                      in the locked transaction of withLiveSession (guardLive first: an ERASED or
//                      missing session writes nothing). No external call inside it.
//   enqueueVerify(...) queues `verify-session` AFTER that commit, from the session-job scope of the
//                      same org and session (the only scope enqueueVerifySession accepts).
import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_EVENT_SEVERITY, parseEventPayload } from '@codeproctor/shared';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { SessionJobProcessor } from '../session/session-job.processor';
import { SessionStateService } from '../session/session-state.service';
import { VerifySessionPort } from './identity-ports';

export type ReviewReason =
  'BELOW_THRESHOLD' | 'NO_FACE' | 'MULTIPLE_FACES' | 'LIVENESS_NOT_CONFIRMED' | 'MATCH_ERROR';

export interface IdentityCommit {
  readonly orgId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly status: 'PASSED' | 'LOW_CONFIDENCE' | 'MANUAL_REVIEW';
  readonly reason: ReviewReason | null;
  readonly score: number | null;
  readonly modelId: string | null;
  readonly threshold: number | null;
}

/** GONE: erased or missing; LOST: another run (or a waiver's purge) got there first. */
export type CommitOutcome = 'WROTE' | 'LOST' | 'GONE';

@Injectable()
export class IdentitySessionJobs extends SessionJobProcessor {
  protected readonly logger = new Logger(IdentitySessionJobs.name);

  constructor(
    prisma: PrismaService,
    orgContext: OrgContextService,
    states: SessionStateService,
    private readonly verify: VerifySessionPort,
  ) {
    super(prisma, orgContext, states);
  }

  async commit(data: IdentityCommit, requireKeys: boolean): Promise<CommitOutcome> {
    const result = await this.withLiveSession(data.sessionId, data.orgId, async (tx) => {
      // The erasure fence on the candidate, read again under the session lock (ADR 0004 9.5).
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
      // there are none to compare): a waiver's purge nulls them under the row lock, so a result
      // computed before the purge updates nothing (DL-30).
      const keys = requireKeys ? { idImageKey: { not: null }, selfieKey: { not: null } } : {};
      const target = await tx.identityCheck.findFirst({
        where: { sessionId: data.sessionId, attempt: data.attempt, status: 'PENDING', ...keys },
        select: { id: true },
      });
      if (target === null) return 'LOST' as const; // resolved, or purged, since the pre-check
      const updated = await tx.identityCheck.updateMany({
        where: { id: target.id, status: 'PENDING', ...keys },
        data: {
          status: data.status,
          reviewReason: data.reason,
          faceMatchScore: data.score,
          modelId: data.modelId,
          threshold: data.threshold,
        },
      });
      if (updated.count !== 1) return 'LOST' as const;
      if (data.status === 'MANUAL_REVIEW') {
        await tx.proctorEvent.create({
          data: {
            sessionId: data.sessionId,
            type: 'IDENTITY_MANUAL_REVIEW',
            severity: DEFAULT_EVENT_SEVERITY.IDENTITY_MANUAL_REVIEW,
            source: 'SERVER',
            occurredAt: new Date(),
            payload: parseEventPayload('IDENTITY_MANUAL_REVIEW', {
              identityCheckId: target.id,
              reason: data.reason ?? 'MATCH_ERROR',
            }),
          },
        });
      }
      return 'WROTE' as const;
    });
    return result.outcome === 'LIVE' ? result.value : 'GONE';
  }

  /** After the commit: the gate is PASSED or MANUAL_REVIEW, never LOW_CONFIDENCE (ADR 0015 section 7). */
  async enqueueVerify(orgId: string, sessionId: string): Promise<void> {
    await this.withLiveSession(sessionId, orgId, () => this.verify.enqueue(orgId, sessionId));
  }
}
