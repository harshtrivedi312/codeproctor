// Run, draft and submit (FR-502, FR-504, FR-506; ADR 0002 S-5; ADR 0013 sections 5.10 and 5.11).
// Every method resolves the question ONLY under the token's session (QuestionGateService), checks
// the open section and the pause rules on server time, and never takes a session id from the client.
//
// Scopes (candidate-scope.ts, never nested; interim CS-4 rules until PR 2 of the grants):
//   - reads of content (test cases, limits, answer spec) and the section gate: org scope;
//   - the autosave writes (final_code, final_language, answer): the candidate scope, which allows
//     exactly those columns (draft route and the autosave of Run);
//   - the RUN row WITH its results and the SUBMIT row with the question update in one transaction:
//     org scope, because the candidate scope may create a submission only with
//     (sessionQuestionId, kind, language, sourceCode) and writes no results until PR 2 (FU-BEB-75).
//
// What leaves the API: Run returns sample results only (output of the sample, never of a hidden
// test). Submit returns `{ accepted, submissionId }` and nothing else: no per-test result, weight or
// score, so hidden tests cannot be used as an oracle. Grading happens later, in grade-session.
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CandidateScope } from '../candidate/candidate-scope';
import type { CandidateContext } from '../candidate/candidate.types';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import { ExecutionService, InvalidLimitsError } from '../execution/execution.service';
import { isExecLanguage } from '../judge0/language-map';
import type { ExecLanguage } from '../judge0/language-map';
import { mcqAnswerSpecSchema } from '../questions/answer-spec';
import { isStorableText } from '../questions/text-rules';
import { loadCases } from '../grading/test-data';
import { candidateOptionId } from '../grading/option-ids';
import { mcqAnswerSchema, shortAnswerAnswerSchema } from '../grading/answer-shapes';
import { CLOSE_GRACE_MS, GradingQueue } from '../grading/grading-queue';
import { QuestionGateService, SectionNotOpenError } from './question-gate.service';
import type { OpenQuestion } from './question-gate.service';
import { SubmitLimiter } from './submit-limiter';

export const RUN_LIMIT = { limit: 1, windowSeconds: 5 } as const;
export const SUBMIT_PRE_LIMIT = { limit: 30, windowSeconds: 60 } as const;
export const DRAFT_LIMIT = { limit: 20, windowSeconds: 60 } as const;

export interface RunView {
  readonly serverTime: Date;
  readonly passed: number;
  readonly total: number;
  readonly results: readonly {
    readonly index: number;
    readonly verdict: string;
    readonly passed: boolean;
    readonly timeMs: number | null;
    readonly memoryKb: number | null;
    readonly stdout?: string;
    readonly stdoutTruncated?: boolean;
    readonly message?: string;
  }[];
}

function bad(message: string): BadRequestException {
  return new BadRequestException(message);
}

@Injectable()
export class AnswersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
    private readonly gate: QuestionGateService,
    private readonly execution: ExecutionService,
    private readonly limiter: SessionRateLimiter,
    private readonly submitLimiter: SubmitLimiter,
    private readonly queue: GradingQueue,
  ) {}

  /**
   * A refusal for a passed deadline also queues the close (lazy opening, 5.11): the next section
   * opens on the first request after the deadline, anchored at the deadline D (5.11 timing rule). Best effort;
   * the sweep is the reconciler.
   */
  private async lazyClose<T>(ctx: CandidateContext, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SectionNotOpenError && e.due !== undefined) {
        const due = e.due;
        try {
          // Delayed to the moment the job can act (deadline plus grace for a section), so the job
          // is not a wasted not-due no-op; the sweep stays the reconciler for any miss.
          if (due.kind === 'section') {
            const wait = due.at.getTime() + CLOSE_GRACE_MS - Date.now();
            await this.queue.enqueueCloseSection(
              ctx.orgId,
              ctx.sessionId,
              due.sectionId,
              'deadline',
              Math.max(1, wait),
            );
          } else {
            await this.queue.enqueueAutoSubmit(
              ctx.orgId,
              ctx.sessionId,
              Math.max(1, due.at.getTime() - Date.now()),
            );
          }
        } catch {
          // The sweep recovers it.
        }
      }
      throw e;
    }
  }

  private codeChecks(question: OpenQuestion, code: string, language: string): ExecLanguage {
    if (question.type !== 'CODING') throw bad('This question takes no code.');
    if (!isExecLanguage(language) || !question.allowedLanguages.includes(language)) {
      throw bad('That language is not allowed for this question.');
    }
    if (!isStorableText(code)) throw bad('The code contains a character that cannot be stored.');
    return language;
  }

  // ---- Run (FR-502) ----

  async run(
    ctx: CandidateContext,
    sessionQuestionId: string,
    input: { code: string; language: string },
    now: Date = new Date(),
  ): Promise<RunView> {
    // One run per 5 s per session, atomic in Redis, before any database or runner work (TC-041).
    await this.limiter.hit('run', ctx.sessionId, RUN_LIMIT.limit, RUN_LIMIT.windowSeconds);

    const loaded = await this.lazyClose(ctx, () =>
      this.scope.asOrg(ctx, async () => {
        const question = await this.gate.open(ctx, sessionQuestionId, now);
        const language = this.codeChecks(question, input.code, input.language);
        const samples = await loadCases(
          this.prisma.client,
          question.questionVersionId,
          question.variantId,
          false,
        );
        return { question, samples, language };
      }),
    );

    // FR-504: autosave on every run, before the runner, so a crash loses nothing.
    await this.saveCode(ctx, loaded.question.sessionQuestionId, input.code, input.language);

    let result;
    try {
      result = await this.execution.run({
        language: loaded.language,
        sourceCode: input.code,
        limits: loaded.question.limits,
        tests: loaded.samples.map((s) => ({
          id: s.id,
          input: s.input,
          expectedOutput: s.expectedOutput,
          reveal: true,
        })),
      });
    } catch (e) {
      // Limits are authored data: a bad row is ours to fix, not the candidate's.
      if (e instanceof InvalidLimitsError)
        throw new BadRequestException('This question cannot be run.');
      throw e;
    }

    const passed = result.results.filter((r) => r.passed).length;
    await this.scope.asOrg(ctx, () =>
      this.prisma.client.submission.create({
        data: {
          sessionQuestionId: loaded.question.sessionQuestionId,
          kind: 'RUN',
          language: input.language,
          sourceCode: input.code,
          // Samples only; the pinned shape of ADR 0013 CS-4.4, with no stdout or case data.
          results: result.results.map((r) => ({
            testCaseId: r.testId,
            passed: r.passed,
            status: r.verdict,
            timeMs: r.timeMs,
            memoryKb: r.memoryKb,
          })),
          passed,
          total: result.results.length,
        },
        select: { id: true },
      }),
    );

    return {
      serverTime: new Date(),
      passed,
      total: result.results.length,
      results: result.results.map((r, i) => ({
        index: i + 1,
        verdict: r.verdict,
        passed: r.passed,
        timeMs: r.timeMs,
        memoryKb: r.memoryKb,
        ...(r.stdout !== undefined ? { stdout: r.stdout } : {}),
        ...(r.stdoutTruncated !== undefined ? { stdoutTruncated: r.stdoutTruncated } : {}),
        ...(r.message !== undefined ? { message: r.message } : {}),
      })),
    };
  }

  // ---- Draft (FR-504) ----

  async draft(
    ctx: CandidateContext,
    sessionQuestionId: string,
    input: { code?: string; language?: string; answer?: Record<string, unknown> },
    now: Date = new Date(),
  ): Promise<Date> {
    await this.limiter.hit('draft', ctx.sessionId, DRAFT_LIMIT.limit, DRAFT_LIMIT.windowSeconds);
    const question = await this.lazyClose(ctx, () =>
      this.scope.asOrg(ctx, () => this.gate.open(ctx, sessionQuestionId, now)),
    );

    if (question.type === 'CODING') {
      if (input.answer !== undefined) throw bad('A coding question takes code, not an answer.');
      if (input.code === undefined || input.language === undefined) {
        throw bad('Send code and language.');
      }
      this.codeChecks(question, input.code, input.language);
      await this.saveCode(ctx, question.sessionQuestionId, input.code, input.language);
      return new Date();
    }

    if (input.code !== undefined || input.language !== undefined) {
      throw bad('This question takes an answer, not code.');
    }
    if (input.answer === undefined) throw bad('Send an answer.');
    const answer = this.checkAnswer(ctx, question, input.answer);
    await this.scope.asCandidate(ctx, () =>
      this.prisma.client.sessionQuestion.update({
        where: { id: question.sessionQuestionId },
        data: { answer },
        select: { id: true },
      }),
    );
    return new Date();
  }

  private checkAnswer(
    ctx: CandidateContext,
    question: OpenQuestion,
    raw: Record<string, unknown>,
  ): { optionIds: string[] } | { text: string } {
    if (question.type === 'MCQ') {
      const spec = mcqAnswerSpecSchema.safeParse(question.answerSpec);
      const parsed = mcqAnswerSchema.safeParse(raw);
      if (!spec.success || !parsed.success) throw bad('The answer is not valid for this question.');
      const known = new Set(spec.data.options.map((o) => candidateOptionId(ctx.sessionId, o.id)));
      const ids = parsed.data.optionIds;
      if (new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
        throw bad('The answer is not valid for this question.');
      }
      if (!spec.data.multiple && ids.length > 1) {
        throw bad('This question takes one option.');
      }
      return { optionIds: ids };
    }
    const parsed = shortAnswerAnswerSchema.safeParse(raw);
    if (!parsed.success) throw bad('The answer is not valid for this question.');
    return { text: parsed.data.text };
  }

  /** The candidate-scope autosave: final_code and final_language, the allowlisted columns. */
  private async saveCode(
    ctx: CandidateContext,
    sessionQuestionId: string,
    code: string,
    language: string,
  ): Promise<void> {
    await this.scope.asCandidate(ctx, () =>
      this.prisma.client.sessionQuestion.update({
        where: { id: sessionQuestionId },
        data: { finalCode: code, finalLanguage: language },
        select: { id: true },
      }),
    );
  }

  // ---- Section finish (ADR 0013 5.11) ----

  /**
   * The candidate ends the section at `position` of their own session (ADR 0013 5.11). Enqueue only:
   * the close-section `finish` variant is the one writer of session_sections.ended_at. It finishes
   * no section other than the one named, so a retry or double click after the close opened the next
   * section is a no-op and never touches it. A pause that locks writes refuses it (409
   * SESSION_PAUSED, Q21 recommendation).
   */
  async finishSection(ctx: CandidateContext, position: number): Promise<void> {
    await this.limiter.hit('finish-section', ctx.sessionId, 6, 60);
    const sectionId = await this.scope.asOrg(ctx, () => this.gate.openSectionAt(ctx, position));
    // Single-flight job id: a double click or a race with the deadline job closes once.
    if (sectionId !== null) {
      await this.queue.enqueueCloseSection(ctx.orgId, ctx.sessionId, sectionId, 'finish');
    }
  }

  // ---- Submit (FR-506) ----

  async submit(
    ctx: CandidateContext,
    sessionQuestionId: string,
    input: { code: string; language: string },
    now: Date = new Date(),
  ): Promise<{ submissionId: string }> {
    // Before the gate query: a client that hammers submit costs one Redis call, not database reads.
    await this.limiter.hit(
      'submit-pre',
      ctx.sessionId,
      SUBMIT_PRE_LIMIT.limit,
      SUBMIT_PRE_LIMIT.windowSeconds,
    );
    const question = await this.lazyClose(ctx, () =>
      this.scope.asOrg(ctx, async () => {
        const open = await this.gate.open(ctx, sessionQuestionId, now);
        this.codeChecks(open, input.code, input.language);
        return open;
      }),
    );

    // Checked atomically before any insert: 429 inside 10 s, 409 past 20 per question.
    const giveBack = await this.submitLimiter.acquire(ctx.sessionId, question.sessionQuestionId);
    try {
      // One transaction: the SUBMIT row and final_code, so "has saved code" never lags a submit.
      return await this.scope.asOrg(ctx, () =>
        this.prisma.client.$transaction(async (tx) => {
          const row = await tx.submission.create({
            data: {
              sessionQuestionId: question.sessionQuestionId,
              kind: 'SUBMIT',
              language: input.language,
              sourceCode: input.code,
            },
            select: { id: true },
          });
          await tx.sessionQuestion.update({
            where: { id: question.sessionQuestionId },
            data: { finalCode: input.code, finalLanguage: input.language },
            select: { id: true },
          });
          return { submissionId: row.id };
        }),
      );
    } catch (e) {
      await giveBack();
      throw e;
    }
  }
}

export interface SectionFinishQueued {
  readonly accepted: true;
}
