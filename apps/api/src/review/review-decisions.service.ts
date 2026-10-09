// Reviewer write routes (BE-13; FR-205, FR-902, D-23, TC-099; docs/api-contract.md section 7):
// manual scoring of a short answer, and the final verdict.
//
// Locking (contract section 7). Both transactions take the `sessions` row FIRST:
//   - scoring with a status-guarded updateMany that writes total_score = NULL (the lock column; the
//     value is overwritten in the same transaction),
//   - the verdict with the UNDER_REVIEW -> COMPLETED compare-and-set of SessionStateService, which
//     is the only code that writes sessions.status.
// Every statement after the lock sees the previous holder's commit (READ COMMITTED), so two scorers
// cannot leave a stale total, and a scorer that loses to the verdict finds the session COMPLETED.
// The verdict counts MANUAL_PENDING answers after its compare-and-set and rolls everything back
// when one remains. The audit row is written in the same transaction as the decision. It holds ids
// and booleans only: never the answer text or the note. Lock waits are capped, so contention is a
// 503 BUSY from the problem filter (section 8), never a hang. The reviewer is the token's user.
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { devReviewFlowEnabled, type Env } from '../config/env';
import { LOCAL_STUB_NOTE } from '../grading/local-stub';
import { CodedConflictException } from '../common/coded.exception';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { formatHundredths, toHundredths } from '../grading/scoring';
import { Prisma } from '../generated/prisma/client';
import type { QuestionScoring, SessionStatus } from '../generated/prisma/enums';
import { SessionStateConflictError } from '../session/session-state.errors';
import { SessionStateService } from '../session/session-state.service';
import type {
  ReviewVerdictDto,
  ScoreAnswerDto,
  ScoredAnswerDto,
  SetVerdictDto,
} from './dto/decisions.dto';

type Tx = Parameters<Parameters<PrismaService['client']['$transaction']>[0]>[0];
const NOT_FOUND = 'Session not found.';
const LOCK_TIMEOUT_MS = 2000;

export interface Reviewer {
  readonly id: string;
  readonly orgId: string;
}

/** A verdict is set: COMPLETED, or APPEALED after an appeal. */
const VERDICT_STATUSES: readonly SessionStatus[] = ['COMPLETED', 'APPEALED'];

function notUnderReview(status: SessionStatus): CodedConflictException {
  return VERDICT_STATUSES.includes(status)
    ? new CodedConflictException(
        'A verdict is already set for this session.',
        'VERDICT_ALREADY_SET',
      )
    : new CodedConflictException('The session is not under review.', 'SESSION_NOT_UNDER_REVIEW');
}

@Injectable()
export class ReviewDecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly state: SessionStateService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * DEVELOPMENT-ONLY STOPGAP (Delivery Lead ruling DL-72, 'go dev-only'). Only when APP_ENV is
   * exactly 'development' (devReviewFlowEnabled): a CODING answer may be scored by hand when the
   * local Judge0 stub left it undecided, that is scoring MANUAL_PENDING with the exact marker note
   * only the grader writes (LOCAL_STUB_NOTE), or already MANUAL (reachable for a coding answer only
   * through this path, so a changed decision keeps the previousCorrect chain). This is NOT
   * production behaviour: BE-12 and FU-BEB-145 own the real coding review contract. In every other
   * environment a CODING answer stays 409 ANSWER_NOT_MANUAL.
   */
  private devCodingManual(scoring: QuestionScoring, scoringNote: string | null): boolean {
    if (
      !devReviewFlowEnabled({
        APP_ENV: this.config.get('APP_ENV', { infer: true }),
        NODE_ENV: this.config.get('NODE_ENV', { infer: true }),
      })
    ) {
      return false;
    }
    return (
      scoring === 'MANUAL' || (scoring === 'MANUAL_PENDING' && scoringNote === LOCAL_STUB_NOTE)
    );
  }

  async scoreAnswer(
    reviewer: Reviewer,
    ip: string | undefined,
    sessionId: string,
    sessionQuestionId: string,
    dto: ScoreAnswerDto,
  ): Promise<ScoredAnswerDto> {
    return this.prisma.client.$transaction(async (tx) => {
      await this.capLockWait(tx);
      // 404 first, then ANSWER_NOT_MANUAL, then the status (contract check order). The org scope
      // is on every query; ids are walked flat.
      const session = await tx.session.findFirst({
        where: { id: sessionId },
        select: { status: true, orgId: true },
      });
      if (!session) throw new NotFoundException(NOT_FOUND);
      await this.assertReviewer(tx, reviewer, session.orgId);
      const question = await tx.sessionQuestion.findFirst({
        where: { id: sessionQuestionId, sessionId },
        select: { questionVersionId: true, scoring: true, scoringNote: true },
      });
      if (!question) throw new NotFoundException(NOT_FOUND);
      const version = await tx.questionVersion.findFirst({
        where: { id: question.questionVersionId },
        select: { questionId: true },
      });
      const kind = version
        ? await tx.question.findFirst({ where: { id: version.questionId }, select: { type: true } })
        : null;
      const manualKind =
        kind?.type === 'SHORT_ANSWER' ||
        (kind?.type === 'CODING' && this.devCodingManual(question.scoring, question.scoringNote));
      if (!manualKind || question.scoring === 'AUTO') {
        throw new CodedConflictException('This answer is not scored by hand.', 'ANSWER_NOT_MANUAL');
      }

      // The session lock (see the header). Zero rows: a verdict is set, or not under review.
      const locked = await tx.session.updateMany({
        where: { id: sessionId, status: 'UNDER_REVIEW' },
        data: { totalScore: null },
      });
      if (locked.count !== 1) {
        const now = await tx.session.findFirst({
          where: { id: sessionId },
          select: { status: true },
        });
        if (!now) throw new NotFoundException(NOT_FOUND);
        throw notUnderReview(now.status);
      }

      // Under the lock: the committed state of this answer and of every sibling.
      const before = await tx.sessionQuestion.findFirst({
        where: { id: sessionQuestionId, sessionId },
        select: { points: true, score: true, scoring: true, scoringNote: true },
      });
      if (!before) throw new NotFoundException(NOT_FOUND);
      if (
        before.scoring === 'AUTO' ||
        (kind?.type === 'CODING' && !this.devCodingManual(before.scoring, before.scoringNote))
      ) {
        throw new CodedConflictException('This answer is not scored by hand.', 'ANSWER_NOT_MANUAL');
      }
      // The previous decision is read from the last audit row of this answer (a score of 0 on a
      // 0-point question cannot tell true from false); without a row, from the stored score.
      let previousCorrect: boolean | null = null;
      if (before.scoring === 'MANUAL') {
        const last = await tx.auditLog.findFirst({
          where: {
            entityId: sessionId,
            action: 'ANSWER_SCORED_MANUALLY',
            metadata: { path: ['sessionQuestionId'], equals: sessionQuestionId },
          },
          orderBy: { id: 'desc' },
          select: { metadata: true },
        });
        const recorded = (last?.metadata as { correct?: unknown } | null)?.correct;
        previousCorrect =
          typeof recorded === 'boolean'
            ? recorded
            : before.score !== null && before.score.eq(before.points);
      }
      const score = dto.correct ? before.points.toFixed(2) : '0.00';
      await tx.sessionQuestion.update({
        where: { id: sessionQuestionId },
        data: {
          score,
          scoring: 'MANUAL',
          scoredById: reviewer.id,
          scoredAt: new Date(),
          // A change that omits the note keeps the previous one.
          ...(dto.note !== undefined ? { scoringNote: dto.note } : {}),
        },
        select: { id: true },
      });

      const all = await tx.sessionQuestion.findMany({
        where: { sessionId },
        select: { score: true, scoring: true },
      });
      const waiting = all.some((q) => q.scoring === 'MANUAL_PENDING' || q.score === null);
      const total = waiting
        ? null
        : formatHundredths(
            all.reduce((sum, q) => sum + toHundredths(q.score?.toFixed(2) ?? '0'), 0n),
          );
      await tx.session.updateMany({
        where: { id: sessionId },
        data: { totalScore: total },
      });

      await tx.auditLog.create({
        data: {
          orgId: reviewer.orgId,
          actorId: reviewer.id,
          action: 'ANSWER_SCORED_MANUALLY',
          entityType: 'session',
          entityId: sessionId,
          ip: ip ?? null,
          metadata: { sessionQuestionId, correct: dto.correct, previousCorrect },
        },
      });
      return { sessionQuestionId, correct: dto.correct, score: Number(score) };
    });
  }

  async setVerdict(
    reviewer: Reviewer,
    ip: string | undefined,
    sessionId: string,
    dto: SetVerdictDto,
  ): Promise<ReviewVerdictDto> {
    return this.prisma.client.$transaction(async (tx) => {
      await this.capLockWait(tx);
      const session = await tx.session.findFirst({
        where: { id: sessionId },
        select: { status: true, orgId: true },
      });
      if (!session) throw new NotFoundException(NOT_FOUND);
      await this.assertReviewer(tx, reviewer, session.orgId);

      // The compare-and-set takes the session row lock first (the scorers hold it until commit).
      try {
        await this.state.transition({
          sessionId,
          from: 'UNDER_REVIEW',
          to: 'COMPLETED',
          db: tx,
        });
      } catch (e) {
        if (!(e instanceof SessionStateConflictError)) throw e;
        const now = await tx.session.findFirst({
          where: { id: sessionId },
          select: { status: true },
        });
        if (!now) throw new NotFoundException(NOT_FOUND);
        throw notUnderReview(now.status);
      }
      if (
        (await tx.sessionReview.findFirst({ where: { sessionId }, select: { id: true } })) !== null
      ) {
        throw new CodedConflictException(
          'A verdict is already set for this session.',
          'VERDICT_ALREADY_SET',
        );
      }
      // After the lock: a scorer that committed first is counted; one that comes later waits and
      // then finds COMPLETED. Anything pending rolls the transition back.
      const pending = await tx.sessionQuestion.count({
        where: { sessionId, scoring: 'MANUAL_PENDING' },
      });
      if (pending > 0) {
        throw new CodedConflictException(
          'Short answers are still waiting for a manual decision.',
          'MANUAL_PENDING',
        );
      }

      const completedAt = new Date();
      await tx.sessionReview.create({
        data: {
          sessionId,
          reviewerId: reviewer.id,
          verdict: dto.verdict,
          notes: dto.note ?? null,
          completedAt,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          orgId: reviewer.orgId,
          actorId: reviewer.id,
          action: 'REVIEW_VERDICT_SET',
          entityType: 'session',
          entityId: sessionId,
          ip: ip ?? null,
          metadata: { verdict: dto.verdict },
        },
      });
      return {
        verdict: dto.verdict,
        notes: dto.note ?? null,
        completedAt: completedAt.toISOString(),
      };
    });
  }

  /**
   * The actor (from the access token) must be an active REVIEWER or SUPER_ADMIN of the SESSION's
   * organisation, checked in the writing transaction. Anything else is the same 404 as a missing
   * session, so a foreign user is never recorded as scorer or reviewer and nothing is told apart.
   */
  private async assertReviewer(tx: Tx, reviewer: Reviewer, sessionOrgId: string): Promise<void> {
    const user = await tx.user.findFirst({
      where: {
        id: reviewer.id,
        orgId: sessionOrgId,
        isActive: true,
        role: { in: ['REVIEWER', 'SUPER_ADMIN'] },
      },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(NOT_FOUND);
  }

  /** SET LOCAL lock_timeout: a busy sessions row answers 503 BUSY (section 8), never a hang. */
  private capLockWait(tx: Tx): Promise<unknown> {
    return this.orgContext.runRawSql(
      'cap lock waits of this transaction (SET LOCAL, no data access)',
      () =>
        tx.$executeRaw(
          Prisma.sql`SELECT set_config('lock_timeout', ${`${LOCK_TIMEOUT_MS}ms`}, true)`,
        ),
    );
  }
}
