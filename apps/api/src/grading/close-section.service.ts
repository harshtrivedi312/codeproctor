// close-section (ADR 0002 S-5, ADR 0013 section 5.11): the ONLY writer of session_sections.ended_at.
// One transaction, one server timestamp T, compare-and-set first:
//   1. claim: UPDATE ... SET ended_at = T WHERE ended_at IS NULL AND started_at IS NOT NULL;
//      0 rows means another variant closed it, and this call does nothing more;
//   2. snapshot: one SUBMIT row for EVERY coding question of the section (empty ones too, source ''),
//      created_at = T (set here, never left to a default, so grade-session finds it by that value).
//      Language: final_language, else allowed_languages[0] of the question's PINNED version; none
//      allowed fails the close loudly (`close_snapshot_no_language`);
//   3. last section (finish and deadline variants): the session moves to SUBMITTED through
//      SessionStateService; otherwise the next section is opened with its own deadline.
// Variants: `finish` (candidate ends the section), `deadline` (the sweep, 5 s after the effective
// deadline) and `final` (grade-session closes whatever is still open; it never opens a section).
// Times (hub ruling on #200): `finish` and `final` close at `now`. `deadline` closes at the section's
// effective deadline D: `ended_at` and the snapshot's `created_at` are D, and the gate refuses every
// write after D on request time, so the snapshot is the state saved at D. The NEXT section opens at
// the job's own time N (`now`): started_at = N, deadline_at = min(N + L, effectiveSessionDeadline@N)
// (or that session deadline for a section with no limit); if the session deadline is at or before N
// the opening is skipped and auto-submit ends the session. The candidate keeps the full limit L.
// Raw SQL and FOR UPDATE are not used: updateMany is the only concurrency tool.
import { Injectable, Logger } from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import {
  effectiveSectionDeadline,
  effectiveSessionDeadline,
  proctorPauseCapMs,
} from '../session/deadlines';
import { SessionStateConflictError } from '../session/session-state.errors';
import { SessionStateService } from '../session/session-state.service';
import { LIVE_STATUSES } from '../session/session-transitions';
import { GradingInvariantError } from './errors';
import { CLOSE_GRACE_MS, GradingQueue } from './grading-queue';
import type { CloseVariant } from './grading-queue';

export interface OpenedSection {
  readonly sectionId: string;
  readonly deadlineAt: Date;
}

export type CloseOutcome =
  | { readonly closed: false; readonly reason: 'not-live' | 'not-open' | 'lost-race' }
  | { readonly closed: false; readonly reason: 'not-due'; readonly dueAt: Date }
  | {
      readonly closed: true;
      readonly submittedSession: boolean;
      readonly openedNext: boolean;
      readonly opened?: OpenedSection;
      /** The session deadline had passed: the next section was not opened, auto-submit takes over. */
      readonly sessionPastDeadline?: true;
    };

@Injectable()
export class CloseSectionService {
  private readonly logger = new Logger(CloseSectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly states: SessionStateService,
    private readonly queue: GradingQueue,
  ) {}

  async close(
    orgId: string,
    sessionId: string,
    sectionId: string,
    variant: CloseVariant,
    now: Date = new Date(),
  ): Promise<CloseOutcome> {
    const outcome = await this.orgContext.runInOrg(orgId, () =>
      this.closeInScope(orgId, sessionId, sectionId, variant, now),
    );
    // A retry that finds the section already closed repeats the hand-offs of the first run (ADR
    // 5.11 post-commit work): the grade job and the open section's deadline job. Single-flight ids
    // make this cheap; the sweep is the second line.
    if (!outcome.closed && outcome.reason === 'not-due') {
      // Not yet due (an extended deadline or a running PROCTOR pause): follow up at the new due time.
      // The running job holds its own id, so the follow-up gets a distinct delayed id (it carries
      // the due timestamp, so it cannot collide and strictly moves forward). The sweep stays the
      // reconciler.
      await this.queue.enqueueCloseSection(
        orgId,
        sessionId,
        sectionId,
        'deadline',
        Math.max(1, outcome.dueAt.getTime() - Date.now()),
        String(outcome.dueAt.getTime()),
      );
      return outcome;
    }
    if (!outcome.closed && variant !== 'final') {
      if (outcome.reason === 'not-open' || outcome.reason === 'lost-race') {
        await this.reenqueueHandOffs(orgId, sessionId);
      }
      return outcome;
    }
    // After the commit, and not inside the scope: a failed enqueue throws, the job retries, and the
    // retry finds the session SUBMITTED and the section closed.
    if (outcome.closed && outcome.submittedSession) await this.queue.enqueueGrade(orgId, sessionId);
    if (outcome.closed && outcome.sessionPastDeadline === true) {
      await this.queue.enqueueAutoSubmit(orgId, sessionId);
    }
    if (outcome.closed && outcome.opened !== undefined) {
      // The next section's own deadline job, so it closes on time without waiting for the sweep
      // (which stays as the reconciler).
      const wait = outcome.opened.deadlineAt.getTime() + CLOSE_GRACE_MS - Date.now();
      await this.queue.enqueueCloseSection(
        orgId,
        sessionId,
        outcome.opened.sectionId,
        'deadline',
        Math.max(1, wait),
      );
    }
    return outcome;
  }

  private async reenqueueHandOffs(orgId: string, sessionId: string): Promise<void> {
    const state = await this.orgContext.runInOrg(orgId, async () => {
      const db = this.prisma.client;
      const session = await db.session.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      const open = await db.sessionSection.findFirst({
        where: { sessionId, startedAt: { not: null }, endedAt: null },
        orderBy: { position: 'asc' },
        select: { sectionId: true, deadlineAt: true },
      });
      return { status: session?.status ?? null, open };
    });
    if (state.status === 'SUBMITTED') await this.queue.enqueueGrade(orgId, sessionId);
    if (state.status !== null && LIVE_STATUSES.includes(state.status) && state.open?.deadlineAt) {
      const wait = state.open.deadlineAt.getTime() + CLOSE_GRACE_MS - Date.now();
      await this.queue.enqueueCloseSection(
        orgId,
        sessionId,
        state.open.sectionId,
        'deadline',
        Math.max(1, wait),
      );
    }
  }

  private async closeInScope(
    orgId: string,
    sessionId: string,
    sectionId: string,
    variant: CloseVariant,
    now: Date,
  ): Promise<CloseOutcome> {
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
    if (session === null) return { closed: false, reason: 'not-live' };
    if (variant !== 'final' && !LIVE_STATUSES.includes(session.status)) {
      return { closed: false, reason: 'not-live' };
    }
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const cap = proctorPauseCapMs(org?.settings);

    const section = await db.sessionSection.findUnique({
      where: { sessionId_sectionId: { sessionId, sectionId } },
      select: { position: true, startedAt: true, endedAt: true, deadlineAt: true },
    });
    if (section === null || section.startedAt === null || section.endedAt !== null) {
      return { closed: false, reason: 'not-open' };
    }
    // T stamps the close (`ended_at`, the snapshot): `now` for final, a clamp to D for finish, D for
    // deadline (see the header). The next section opens at `now`, not T.
    let T = now;
    if (variant === 'finish') {
      // A finish click after D but before the deadline job closes at D, like the deadline variant,
      // so the snapshot is the state at the deadline whichever variant wins the race.
      const d = effectiveSectionDeadline(section, session, now, cap);
      if (d !== null && d.getTime() < now.getTime()) T = d;
    }
    if (variant === 'deadline') {
      // A running PROCTOR pause pushes the effective deadline out, so the section is not yet due.
      const due = effectiveSectionDeadline(section, session, now, cap);
      if (due === null) throw new GradingInvariantError('A started section has no deadline');
      if (due.getTime() + CLOSE_GRACE_MS > now.getTime()) {
        return {
          closed: false,
          reason: 'not-due',
          dueAt: new Date(due.getTime() + CLOSE_GRACE_MS),
        };
      }
      T = due;
    }
    return db.$transaction(async (tx): Promise<CloseOutcome> => {
      // TODO(guardLive, ADR 0013 5.7, merge blocker FU-BEB-143): first statement of this transaction: guardLive(tx, sessionId)
      // (erasure fence), before the claim, the snapshot inserts and the next-section opening.
      const claim = await tx.sessionSection.updateMany({
        where: {
          sessionId,
          sectionId,
          endedAt: null,
          startedAt: { not: null },
          // D was read outside this transaction: an extension or a PROCTOR resume credit that
          // committed since changes deadline_at, the claim then misses and the job re-evaluates.
          ...(variant === 'deadline' ? { deadlineAt: section.deadlineAt } : {}),
        },
        data: { endedAt: T },
      });
      if (claim.count === 0) return { closed: false, reason: 'lost-race' };

      const testQuestions = await tx.testQuestion.findMany({
        where: { sectionId },
        select: { id: true },
      });
      const questions = await tx.sessionQuestion.findMany({
        where: { sessionId, testQuestionId: { in: testQuestions.map((q) => q.id) } },
        select: { id: true, questionVersionId: true, finalCode: true, finalLanguage: true },
      });
      // One SUBMIT snapshot for EVERY coding question of the section, empty ones included
      // (source_code '' is accepted): grading then always finds exactly one row at T and a missing
      // one is always a bug. Language: the saved one, else the question's first allowed language.
      const versions = await tx.questionVersion.findMany({
        where: { id: { in: questions.map((q) => q.questionVersionId) } },
        select: { id: true, questionId: true, allowedLanguages: true },
      });
      const parents = await tx.question.findMany({
        where: { id: { in: versions.map((v) => v.questionId) } },
        select: { id: true, type: true },
      });
      const typeOf = new Map(parents.map((p) => [p.id, p.type]));
      const versionOf = new Map(versions.map((v) => [v.id, v]));
      const snapshots = questions.flatMap((q) => {
        const version = versionOf.get(q.questionVersionId);
        if (version === undefined || typeOf.get(version.questionId) !== 'CODING') return [];
        const language = q.finalLanguage ?? version.allowedLanguages[0];
        if (language === undefined) {
          this.logger.error(
            JSON.stringify({
              alert: 'close_snapshot_no_language',
              orgId,
              sessionId,
              sessionQuestionId: q.id,
            }),
          );
          throw new GradingInvariantError('A coding question allows no language');
        }
        return [
          {
            sessionQuestionId: q.id,
            kind: 'SUBMIT' as const,
            language,
            sourceCode: q.finalCode ?? '',
            createdAt: T,
          },
        ];
      });
      if (snapshots.length > 0) await tx.submission.createMany({ data: snapshots });

      if (variant === 'final') return { closed: true, submittedSession: false, openedNext: false };

      const next = await tx.sessionSection.findFirst({
        where: { sessionId, position: section.position + 1 },
        select: { sectionId: true, timeLimitMs: true },
      });
      if (next === null) {
        try {
          await this.states.transition({
            sessionId,
            from: LIVE_STATUSES,
            to: 'SUBMITTED',
            now,
            db: tx,
          });
          return { closed: true, submittedSession: true, openedNext: false };
        } catch (e) {
          // Someone else (finish, auto-submit) submitted first: the snapshot above is still right.
          if (e instanceof SessionStateConflictError) {
            return { closed: true, submittedSession: false, openedNext: false };
          }
          throw e;
        }
      }
      // The stored deadline_at is stale during a PROCTOR pause, so the effective one at `now` is used.
      const sessionDeadline = effectiveSessionDeadline(session, now, cap);
      if (sessionDeadline === null) {
        // A live session always has a deadline: roll back and alert rather than skip the opening.
        throw new GradingInvariantError('A live session has no deadline');
      }
      if (sessionDeadline.getTime() <= now.getTime()) {
        // A late job: opening a section that is already past its end would give it a deadline
        // before its start. Leave it unopened (its questions score 0) and let auto-submit run.
        return {
          closed: true,
          submittedSession: false,
          openedNext: false,
          sessionPastDeadline: true,
        };
      }
      const own = next.timeLimitMs === null ? null : now.getTime() + Number(next.timeLimitMs);
      const deadlineAt = new Date(
        own === null ? sessionDeadline.getTime() : Math.min(own, sessionDeadline.getTime()),
      );
      const opened = await tx.sessionSection.updateMany({
        where: {
          sessionId,
          position: section.position + 1,
          startedAt: null,
          session: { status: { in: [...LIVE_STATUSES] } },
        },
        data: { startedAt: now, deadlineAt },
      });
      return opened.count === 1
        ? {
            closed: true,
            submittedSession: false,
            openedNext: true,
            opened: { sectionId: next.sectionId, deadlineAt },
          }
        : { closed: true, submittedSession: false, openedNext: false };
    });
  }
}
