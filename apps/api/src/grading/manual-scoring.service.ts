// Manual scoring of a short answer (D-23, FR-205, ADR 0007 section 10). SERVICE METHOD ONLY: the
// reviewer route (PATCH /review/sessions/:id/answers/:sessionQuestionId, permission to be named by
// the review module, BE-13) calls it with the reviewer's user id and org from the staff JWT. No
// review module exists on main yet.
//   - only a question in MANUAL_PENDING can be scored; the update is a compare-and-set on that state,
//     so two reviewers cannot both decide (the loser gets 409);
//   - it sets score (points or 0), scoring MANUAL, scored_by and scored_at (server time), and writes an
//     audit row. The note is stored on the question, never copied into the audit metadata;
//   - sessions.total_score is computed when the LAST pending answer is scored (verdict gate, D-23).
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { CodedHttpException } from '../common/coded.exception';
import { formatHundredths, toHundredths } from './scoring';

const MAX_SERIALIZATION_RETRIES = 5;

/** Prisma 7 with the pg adapter reports a Postgres 40001 as P2034 or as TransactionWriteConflict. */
function isSerializationFailure(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return (
    code === 'P2034' ||
    (typeof message === 'string' && message.includes('TransactionWriteConflict'))
  );
}

export interface ManualScoreRequest {
  readonly orgId: string;
  readonly reviewerId: string;
  readonly sessionQuestionId: string;
  readonly correct: boolean;
  readonly note?: string;
  readonly ip?: string;
}

export interface ManualScoreResult {
  readonly score: string;
  /** Present once no answer of the session waits any more. */
  readonly totalScore: string | null;
  readonly pendingLeft: number;
}

@Injectable()
export class ManualScoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  async score(request: ManualScoreRequest, now: Date = new Date()): Promise<ManualScoreResult> {
    // Serializable, retried on a serialization failure (P2034): two reviewers scoring the last two
    // pending answers at once must leave exactly one total_score, computed from both scores.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.scoreOnce(request, now);
      } catch (e) {
        if (!isSerializationFailure(e) || attempt >= MAX_SERIALIZATION_RETRIES) throw e;
      }
    }
  }

  private scoreOnce(request: ManualScoreRequest, now: Date): Promise<ManualScoreResult> {
    return this.orgContext.runInOrg(request.orgId, () =>
      this.prisma.client.$transaction(
        async (tx) => {
          // TODO(guardLive, ADR 0013 5.7, merge blocker FU-BEB-143): first statement: guardLive(tx, question.sessionId) once the
          // session is known (the score write, the audit row and total_score).
          const question = await tx.sessionQuestion.findUnique({
            where: { id: request.sessionQuestionId },
            select: { id: true, sessionId: true, points: true, scoring: true },
          });
          // The org scope finds only this org's rows: another org's id is a plain 404.
          if (question === null) throw new NotFoundException();
          const session = await tx.session.findUnique({
            where: { id: question.sessionId },
            select: { status: true },
          });
          if (session === null) throw new NotFoundException();
          const score = request.correct ? question.points.toFixed(2) : '0.00';
          const claimed = await tx.sessionQuestion.updateMany({
            where: { id: question.id, scoring: 'MANUAL_PENDING' },
            data: {
              score,
              scoring: 'MANUAL',
              scoredById: request.reviewerId,
              scoredAt: now,
              scoringNote: request.note ?? null,
            },
          });
          if (claimed.count !== 1) {
            throw new CodedHttpException(
              HttpStatus.CONFLICT,
              'This answer is not waiting for manual scoring.',
              'SESSION_STATE_CONFLICT',
              { sessionStatus: session.status },
            );
          }
          await tx.auditLog.create({
            data: {
              orgId: request.orgId,
              actorId: request.reviewerId,
              action: 'answer.manual_score',
              entityType: 'session_question',
              entityId: question.id,
              ip: request.ip ?? null,
              metadata: { sessionId: question.sessionId, correct: request.correct, score },
            },
          });
          const all = await tx.sessionQuestion.findMany({
            where: { sessionId: question.sessionId },
            select: { score: true, scoring: true },
          });
          const pendingLeft = all.filter((q) => q.scoring === 'MANUAL_PENDING').length;
          let totalScore: string | null = null;
          if (pendingLeft === 0 && all.every((q) => q.score !== null)) {
            let total = 0n;
            for (const q of all) total += toHundredths(q.score?.toFixed(2) ?? '0');
            totalScore = formatHundredths(total);
            await tx.session.update({
              where: { id: question.sessionId },
              data: { totalScore },
              select: { id: true },
            });
          }
          return { score, totalScore, pendingLeft };
        },
        { isolationLevel: 'Serializable' },
      ),
    );
  }
}
