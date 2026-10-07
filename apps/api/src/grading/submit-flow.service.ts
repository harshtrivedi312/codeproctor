// The SUBMITTED edge, from the three places that cause it (ADR 0002 S-5 and P-4, ADR 0013 5.11):
//   finish       the candidate ends the test (POST /candidate/session/finish)
//   auto-submit  the session passed its effective deadline (sweep, then the `auto-submit` job)
//   close-section of the last section (CloseSectionService, deadline and finish variants)
// Each is a compare-and-set through SessionStateService, so two of them racing produce one winner.
// After a win the `grade-session` job is queued (it closes any section still open, then grades).
// Time is the server's: a client sends no time and none is read.
import { Injectable } from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { effectiveSessionDeadline, proctorPauseCapMs } from '../session/deadlines';
import { SessionStateConflictError } from '../session/session-state.errors';
import { SessionStateService } from '../session/session-state.service';
import { LIVE_STATUSES, SESSION_STATUSES, USED_STATUSES } from '../session/session-transitions';
import type { SessionStatus } from '../generated/prisma/enums.js';
import { sessionNotActive } from '../session/session-write-gate';
import { GradingQueue } from './grading-queue';

export type FinishOutcome = { readonly status: SessionStatus; readonly alreadySubmitted: boolean };

@Injectable()
export class SubmitFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly states: SessionStateService,
    private readonly queue: GradingQueue,
  ) {}

  /**
   * The candidate finishes. Allowed in IN_PROGRESS and in PAUSED, including a PROCTOR pause (ADR
   * 0013 CS-4.6: the pause credit stops at SUBMITTED). A repeat call answers with the current state.
   * Must be called from no scope.
   */
  async finish(orgId: string, sessionId: string, now: Date = new Date()): Promise<FinishOutcome> {
    const outcome = await this.orgContext.runInOrg(orgId, async (): Promise<FinishOutcome> => {
      try {
        // TODO(guardLive, ADR 0013 5.7, merge blocker FU-BEB-143): guardLive(sessionId) before this
        // transition (erasure fence); it is a single compare-and-set, so the guard wraps it.
        await this.states.transition({ sessionId, from: LIVE_STATUSES, to: 'SUBMITTED', now });
        return { status: 'SUBMITTED', alreadySubmitted: false };
      } catch (e) {
        if (!(e instanceof SessionStateConflictError)) throw e;
        const raw = e.extensions.sessionStatus;
        const status = SESSION_STATUSES.find((x) => x === raw) ?? null;
        if (status !== null && USED_STATUSES.includes(status)) {
          return { status, alreadySubmitted: true };
        }
        throw sessionNotActive(status ?? 'EXPIRED');
      }
    });
    // Also on a repeat call: the enqueue is single-flight, and a first call whose enqueue failed
    // is thereby recovered.
    if (outcome.status === 'SUBMITTED') await this.queue.enqueueGrade(orgId, sessionId);
    return outcome;
  }

  /** Auto-submit at the session's effective deadline. A no-op unless the session is live and due. */
  async autoSubmit(orgId: string, sessionId: string, now: Date = new Date()): Promise<boolean> {
    const won = await this.orgContext.runInOrg(orgId, async () => {
      const db = this.prisma.client;
      const session = await db.session.findUnique({
        where: { id: sessionId },
        select: {
          status: true,
          pauseReasons: true,
          deadlineAt: true,
          pausedMs: true,
          proctorPausedAt: true,
        },
      });
      if (session === null || !LIVE_STATUSES.includes(session.status)) return false;
      const org = await db.organization.findUnique({
        where: { id: orgId },
        select: { settings: true },
      });
      const due = effectiveSessionDeadline(session, now, proctorPauseCapMs(org?.settings));
      // Not due (an extended deadline, or a running PROCTOR pause): the sweep looks again later.
      if (due === null || due.getTime() > now.getTime()) return false;
      try {
        // TODO(guardLive, ADR 0013 5.7, merge blocker FU-BEB-143): guardLive(sessionId) before this
        // transition (erasure fence); it is a single compare-and-set, so the guard wraps it.
        await this.states.transition({ sessionId, from: LIVE_STATUSES, to: 'SUBMITTED', now });
        return true;
      } catch (e) {
        if (e instanceof SessionStateConflictError) return false;
        throw e;
      }
    });
    if (won) await this.queue.enqueueGrade(orgId, sessionId);
    return won;
  }
}
