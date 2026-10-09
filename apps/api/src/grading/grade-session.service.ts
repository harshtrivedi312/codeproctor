// grade-session (FR-506, FR-205, D-23; ADR 0013 section 5.11; ADR 0007 section 5). Runs after the
// session is SUBMITTED. Idempotent: a second run finds GRADED and only re-queues analyze-session.
//   1. close every started section still open (final variant), so each coding question has its
//      close snapshot: the SUBMIT row whose created_at equals the section's ended_at;
//   2. read everything the grading needs in one org scope, then LEAVE it: Judge0 runs outside any
//      scope and outside any transaction;
//   3. one transaction: SUBMITTED -> GRADED (compare-and-set through SessionStateService; a lost
//      race rolls everything back) and the scores;
//   4. queue analyze-session (BE-12). BE-12 also owns GRADED -> UNDER_REVIEW (C-28: every session
//      ends UNDER_REVIEW; there is no GRADED -> COMPLETED edge).
// Hidden-test results are stored without stdin, stdout, expected output or variant data
// (CS-4.4: `{ testCaseId, passed, status, timeMs, memoryKb }`). Only the close snapshot is graded,
// never final_code. The close writes one snapshot per coding question of a started section (empty
// ones score 0 with no runner call), so a missing snapshot, or more than one at the close timestamp,
// is a bug: the job alerts and fails instead of scoring 0. Sections that never started score 0 with
// no snapshot lookup. A save that differs from the snapshot is flagged with an audit row and
// grading goes on. A runner failure (INTERNAL_ERROR) fails the job: retried, never scored as wrong.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { devReviewFlowEnabled, type Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import type { QuestionScoring, QuestionType } from '../generated/prisma/enums.js';
import { ExecutionService, InvalidLimitsError } from '../execution/execution.service';
import { isExecLanguage } from '../judge0/language-map';
import { mcqAnswerSpecSchema, shortAnswerSpecSchema } from '../questions/answer-spec';
import { SessionStateConflictError } from '../session/session-state.errors';
import { SessionStateService } from '../session/session-state.service';
import { GradingInvariantError, RunnerUnavailableError } from './errors';
import { CloseSectionService } from './close-section.service';
import { GradingQueue } from './grading-queue';
import {
  classifyShortAnswer,
  codingScore,
  formatHundredths,
  mcqCorrect,
  toHundredths,
} from './scoring';
import { isLocalStub, LOCAL_STUB_NOTE } from './local-stub';
import { OptionIdService } from './option-ids';
import { loadCases } from './test-data';

export { GradingInvariantError };

/** Audit action for a save that landed after its section closed (api-contract section 3). */
export const LATE_WRITE_ACTION = 'LATE_WRITE_AFTER_SECTION_CLOSE';

export type GradeOutcome = 'graded' | 'already-graded' | 'skipped' | 'lost-race';

type StoredResult = {
  readonly testCaseId: string;
  readonly passed: boolean;
  readonly status: string;
  readonly timeMs: number | null;
  readonly memoryKb: number | null;
};

interface QuestionOutcome {
  readonly sessionQuestionId: string;
  /** Hundredths; null while a reviewer has to decide. */
  readonly score: bigint | null;
  readonly scoring: Extract<QuestionScoring, 'AUTO' | 'MANUAL_PENDING'>;
  /** scoring_note to store (the local stub marker); otherwise the column is left alone. */
  readonly note?: string;
  /** The graded close snapshot (coding), to compare with final_code at store time. */
  readonly snapshot?: { readonly sourceCode: string; readonly language: string };
  readonly submission?: {
    readonly id: string;
    readonly results: readonly StoredResult[];
    readonly passed: number;
    readonly total: number;
  };
}

interface LoadedQuestion {
  readonly id: string;
  readonly points: bigint;
  readonly type: QuestionType;
  readonly questionVersionId: string;
  readonly variantId: string | null;
  readonly answer: unknown;
  readonly limits: unknown;
  readonly answerSpec: unknown;
  readonly sectionStarted: boolean;
  readonly snapshots: readonly { id: string; language: string; sourceCode: string }[];
  readonly hidden: readonly {
    id: string;
    input: string;
    expectedOutput: string;
    weight: bigint;
  }[];
}

@Injectable()
export class GradeSessionService {
  private readonly logger = new Logger(GradeSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly states: SessionStateService,
    private readonly execution: ExecutionService,
    private readonly closeSection: CloseSectionService,
    private readonly queue: GradingQueue,
    private readonly optionIds: OptionIdService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Call from no scope (a job callback). */
  async grade(orgId: string, sessionId: string, now: Date = new Date()): Promise<GradeOutcome> {
    const head = await this.orgContext.runInOrg(orgId, async () => {
      const session = await this.prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (session === null) return null;
      const open = await this.prisma.client.sessionSection.findMany({
        where: { sessionId, startedAt: { not: null }, endedAt: null },
        select: { sectionId: true },
      });
      return { status: session.status, open: open.map((s) => s.sectionId) };
    });
    if (head === null) return 'skipped';
    if (head.status === 'GRADED') {
      // A retry after a failed enqueue: grading is done, the hand-off is not.
      await this.devMoveToReview(orgId, sessionId, now);
      await this.queue.enqueueAnalyze(orgId, sessionId);
      return 'already-graded';
    }
    if (head.status !== 'SUBMITTED') return 'skipped';

    for (const sectionId of head.open) {
      await this.closeSection.close(orgId, sessionId, sectionId, 'final', now);
    }

    const questions = await this.orgContext.runInOrg(orgId, () => this.load(sessionId));
    // Judge0 runs here: no scope, no transaction.
    const outcomes: QuestionOutcome[] = [];
    for (const q of questions) outcomes.push(await this.gradeQuestion(q, orgId, sessionId));

    const wrote = await this.orgContext.runInOrg(orgId, () =>
      this.store(orgId, sessionId, outcomes, now),
    );
    if (!wrote) return 'lost-race';
    await this.devMoveToReview(orgId, sessionId, now);
    await this.queue.enqueueAnalyze(orgId, sessionId);
    return 'graded';
  }

  /**
   * DEVELOPMENT-ONLY STOPGAP (Delivery Lead ruling DL-72, 'go dev-only'). Only when APP_ENV is
   * exactly 'development' (devReviewFlowEnabled): GRADED -> UNDER_REVIEW right after grading, so the
   * local pilot can reach the review routes. This is NOT production behaviour: BE-12 owns the real
   * GRADED -> UNDER_REVIEW hand-off (analyze-session) and FU-BEB-145 tracks it. Every other
   * environment is untouched. Idempotent: a session that is no longer GRADED (already
   * UNDER_REVIEW or COMPLETED, or moved by another run) is left alone.
   */
  private async devMoveToReview(orgId: string, sessionId: string, now: Date): Promise<void> {
    if (
      !devReviewFlowEnabled({
        APP_ENV: this.config.get('APP_ENV', { infer: true }),
        NODE_ENV: this.config.get('NODE_ENV', { infer: true }),
      })
    ) {
      return;
    }
    try {
      await this.orgContext.runInOrg(orgId, () =>
        this.prisma.client.$transaction(async (tx) => {
          await this.states.transition({
            sessionId,
            from: 'GRADED',
            to: 'UNDER_REVIEW',
            now,
            db: tx,
          });
        }),
      );
    } catch (e) {
      if (e instanceof SessionStateConflictError) return;
      throw e;
    }
  }

  private async load(sessionId: string): Promise<LoadedQuestion[]> {
    const db = this.prisma.client;
    const rows = await db.sessionQuestion.findMany({
      where: { sessionId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        testQuestionId: true,
        questionVersionId: true,
        variantId: true,
        points: true,
        answer: true,
      },
    });
    const sections = await db.sessionSection.findMany({
      where: { sessionId },
      select: { sectionId: true, startedAt: true, endedAt: true },
    });
    const bySection = new Map(sections.map((s) => [s.sectionId, s]));
    const testQuestions = await db.testQuestion.findMany({
      where: { id: { in: rows.map((r) => r.testQuestionId) } },
      select: { id: true, sectionId: true },
    });
    const sectionOf = new Map(testQuestions.map((t) => [t.id, t.sectionId]));
    const versions = await db.questionVersion.findMany({
      where: { id: { in: rows.map((r) => r.questionVersionId) } },
      select: { id: true, questionId: true, limits: true, answerSpec: true },
    });
    const parents = await db.question.findMany({
      where: { id: { in: versions.map((v) => v.questionId) } },
      select: { id: true, type: true },
    });
    const typeOf = new Map(parents.map((p) => [p.id, p.type]));
    const versionOf = new Map(versions.map((v) => [v.id, v]));

    const out: LoadedQuestion[] = [];
    for (const r of rows) {
      const version = versionOf.get(r.questionVersionId);
      const type = version === undefined ? undefined : typeOf.get(version.questionId);
      if (version === undefined || type === undefined) {
        throw new GradingInvariantError('A question of the session has no content row');
      }
      const section = bySection.get(sectionOf.get(r.testQuestionId) ?? '');
      const sectionStarted = section?.startedAt != null;
      let snapshots: LoadedQuestion['snapshots'] = [];
      let hidden: LoadedQuestion['hidden'] = [];
      if (type === 'CODING') {
        if (sectionStarted && section?.endedAt != null) {
          snapshots = await db.submission.findMany({
            where: { sessionQuestionId: r.id, kind: 'SUBMIT', createdAt: section.endedAt },
            select: { id: true, language: true, sourceCode: true },
            orderBy: { id: 'asc' },
          });
        }
        hidden = await loadCases(db, r.questionVersionId, r.variantId, true);
      }
      out.push({
        id: r.id,
        points: toHundredths(r.points.toFixed(2)),
        type,
        questionVersionId: r.questionVersionId,
        variantId: r.variantId,
        answer: r.answer,
        limits: version.limits,
        answerSpec: version.answerSpec,
        sectionStarted,
        snapshots,
        hidden,
      });
    }
    return out;
  }

  private async gradeQuestion(
    q: LoadedQuestion,
    orgId: string,
    sessionId: string,
  ): Promise<QuestionOutcome> {
    if (q.type === 'MCQ') {
      const spec = mcqAnswerSpecSchema.safeParse(q.answerSpec);
      if (!spec.success) throw new GradingInvariantError('An MCQ question has no valid answer key');
      const right = mcqCorrect(spec.data, q.answer, (id) => this.optionIds.of(sessionId, id));
      return { sessionQuestionId: q.id, score: right ? q.points : 0n, scoring: 'AUTO' };
    }
    if (q.type === 'SHORT_ANSWER') {
      const spec = shortAnswerSpecSchema.safeParse(q.answerSpec);
      if (!spec.success) {
        throw new GradingInvariantError('A short answer question has no valid answer spec');
      }
      const outcome = classifyShortAnswer(spec.data, q.answer);
      if (outcome === 'NEEDS_MANUAL') {
        return { sessionQuestionId: q.id, score: null, scoring: 'MANUAL_PENDING' };
      }
      return {
        sessionQuestionId: q.id,
        score: outcome === 'CORRECT' ? q.points : 0n,
        scoring: 'AUTO',
      };
    }
    return this.gradeCoding(q, orgId, sessionId);
  }

  private async gradeCoding(
    q: LoadedQuestion,
    orgId: string,
    sessionId: string,
  ): Promise<QuestionOutcome> {
    const zero: QuestionOutcome = { sessionQuestionId: q.id, score: 0n, scoring: 'AUTO' };
    // A section that never opened: its questions score 0 (ADR 0013 5.11).
    if (!q.sectionStarted) return zero;
    // More than one row at the close timestamp (a candidate write in the same millisecond: Prisma
    // fills created_at on the API server's millisecond clock, FU-BEB-89) cannot be told apart from
    // the snapshot, so grading refuses to guess: never a wrong grade (ADR 0013 5.11). It alerts.
    if (q.snapshots.length > 1) {
      this.logger.error(
        JSON.stringify({
          alert: 'grading_snapshot_ambiguous',
          orgId,
          sessionId,
          sessionQuestionId: q.id,
        }),
      );
      throw new GradingInvariantError('More than one close snapshot matches a question');
    }
    const snapshot = q.snapshots[0];
    // The close always writes one snapshot per coding question of a started section, so a missing
    // one is a bug, never a late write: alert and fail (ADR 0013 5.11).
    if (snapshot === undefined) {
      this.logger.error(
        JSON.stringify({
          alert: 'grading_snapshot_missing',
          orgId,
          sessionId,
          sessionQuestionId: q.id,
        }),
      );
      throw new GradingInvariantError('A coding question has no close snapshot');
    }
    // Only the snapshot is graded, never final_code, so an in-flight autosave cannot change a grade.
    // An empty snapshot scores 0 without a runner call.
    if (snapshot.sourceCode === '') {
      return {
        sessionQuestionId: q.id,
        score: 0n,
        scoring: 'AUTO',
        snapshot,
        // total counts the hidden tests although none ran, so a reviewer reads "0 of N".
        submission: { id: snapshot.id, results: [], passed: 0, total: q.hidden.length },
      };
    }
    // Data errors fail loudly (never a silent 0): the job alerts and stops.
    if (q.hidden.length === 0) {
      throw new GradingInvariantError('A coding question has no hidden tests');
    }
    if (q.hidden.reduce((sum, t) => sum + t.weight, 0n) <= 0n) {
      throw new GradingInvariantError('A coding question has no hidden test weight');
    }
    const language = snapshot.language;
    if (!isExecLanguage(language)) {
      throw new GradingInvariantError('A snapshot has a language the runner does not support');
    }
    let run;
    try {
      // `mode: 'submit'` (PR #298) makes a local-stub result say it was not graded. It is built
      // outside an object literal so this compiles before and after #298 adds the option (until
      // then the service ignores it): FU-BEB-144.
      const request = {
        language,
        sourceCode: snapshot.sourceCode,
        limits: q.limits,
        tests: q.hidden.map((t) => ({
          id: t.id,
          input: t.input,
          expectedOutput: t.expectedOutput,
          reveal: false,
        })),
        mode: 'submit' as const,
      };
      run = await this.execution.run(request);
    } catch (e) {
      if (e instanceof InvalidLimitsError) {
        throw new GradingInvariantError('A question has invalid limits');
      }
      throw e;
    }
    const stubbed = run.results.some((r) => isLocalStub(r));
    if (stubbed) {
      // All or nothing per question: any stub result means nothing real ran, so the question is
      // "not graded (local stub)": no score (never 0), MANUAL_PENDING, and the job succeeds.
      return {
        sessionQuestionId: q.id,
        score: null,
        scoring: 'MANUAL_PENDING',
        note: LOCAL_STUB_NOTE,
        snapshot,
        submission: {
          id: snapshot.id,
          results: run.results.map((r) => ({
            testCaseId: r.testId,
            passed: false,
            status: r.verdict,
            timeMs: r.timeMs,
            memoryKb: r.memoryKb,
          })),
          passed: 0,
          total: run.results.length,
        },
      };
    }
    if (run.results.some((r) => r.verdict === 'INTERNAL_ERROR')) {
      // The runner failed, not the candidate: retry, never a silent 0.
      throw new RunnerUnavailableError();
    }
    const weights = new Map(q.hidden.map((t) => [t.id, t.weight]));
    const results: StoredResult[] = run.results.map((r) => ({
      testCaseId: r.testId,
      passed: r.passed,
      status: r.verdict,
      timeMs: r.timeMs,
      memoryKb: r.memoryKb,
    }));
    const score = codingScore(
      q.points,
      results.map((r) => ({ passed: r.passed, weight: weights.get(r.testCaseId) ?? 0n })),
    );
    return {
      sessionQuestionId: q.id,
      score,
      scoring: 'AUTO',
      snapshot,
      submission: {
        id: snapshot.id,
        results,
        passed: results.filter((r) => r.passed).length,
        total: results.length,
      },
    };
  }

  /** The transaction. Returns false when another run won the SUBMITTED -> GRADED race. */
  private async store(
    orgId: string,
    sessionId: string,
    outcomes: readonly QuestionOutcome[],
    now: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.client.$transaction(async (tx) => {
        // TODO(guardLive, ADR 0013 5.7, merge blocker FU-BEB-143): first statement: guardLive(tx, sessionId), before the
        // GRADED compare-and-set, the late-write audit rows and the score writes.
        // First: the compare-and-set. A second run changes 0 rows and rolls everything back.
        await this.states.transition({
          sessionId,
          from: 'SUBMITTED',
          to: 'GRADED',
          now,
          db: tx,
        });
        // Informational only: a save that differs from the graded close snapshot (an autosave in
        // flight at the close, or a write after it) is recorded for the reviewer and grading goes
        // on. No row lock is taken and nothing here can fail or change a grade.
        const current = await tx.sessionQuestion.findMany({
          where: {
            sessionId,
            id: { in: outcomes.filter((o) => o.snapshot).map((o) => o.sessionQuestionId) },
          },
          select: { id: true, finalCode: true, finalLanguage: true },
        });
        const nowOf = new Map(current.map((q) => [q.id, q]));
        for (const o of outcomes) {
          const snap = o.snapshot;
          const saved = nowOf.get(o.sessionQuestionId);
          if (snap === undefined || saved === undefined) continue;
          const differs =
            (saved.finalCode ?? '') !== snap.sourceCode ||
            (saved.finalLanguage !== null && saved.finalLanguage !== snap.language);
          if (!differs) continue;
          this.logger.warn(
            JSON.stringify({
              event: 'late_write_after_close',
              orgId,
              sessionId,
              sessionQuestionId: o.sessionQuestionId,
            }),
          );
          // Append-only job audit row (api-contract section 3): no actor, no ip, ids only, never
          // code or an answer. P-27 will add a SERVER event; this row is the record until then.
          await tx.auditLog.create({
            data: {
              orgId,
              actorId: null,
              action: LATE_WRITE_ACTION,
              entityType: 'session',
              entityId: sessionId,
              ip: null,
              metadata: { system: true, sessionId, sessionQuestionId: o.sessionQuestionId },
              createdAt: now,
            },
          });
        }
        for (const o of outcomes) {
          await tx.sessionQuestion.update({
            where: { id: o.sessionQuestionId },
            data: {
              score: o.score === null ? null : formatHundredths(o.score),
              scoring: o.scoring,
              ...(o.note !== undefined ? { scoringNote: o.note } : {}),
            },
            select: { id: true },
          });
          if (o.submission !== undefined) {
            await tx.submission.update({
              where: { id: o.submission.id },
              data: {
                results: [...o.submission.results],
                passed: o.submission.passed,
                total: o.submission.total,
                score: o.score === null ? null : formatHundredths(o.score),
              },
              select: { id: true },
            });
          }
        }
        // total_score exists only when no answer waits for a reviewer (D-23).
        if (outcomes.every((o) => o.score !== null)) {
          const total = outcomes.reduce((sum, o) => sum + (o.score ?? 0n), 0n);
          await tx.session.update({
            where: { id: sessionId },
            data: { totalScore: formatHundredths(total) },
            select: { id: true },
          });
        }
      });
      return true;
    } catch (e) {
      if (e instanceof SessionStateConflictError) return false;
      throw e;
    }
  }
}
