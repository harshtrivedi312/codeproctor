// GET /candidate/questions/:sessionQuestionId (ADR 0013 CS-4.6 `render-question`, FR-301, FR-501,
// TC-011). The candidate-safe projection of ONE question of the open section:
//   { sessionQuestionId, type, title, statementMd, languages, limits, starterCode, samples, mcq? }
// Nothing else: never a hidden test case or its variant override, the reference solution, the
// validation report, the MCQ correct option ids or a short answer's accepted answers. The object is
// built field by field (an allowlist), so a new column on a table cannot leak by accident.
//
// The id is a session_questions.id resolved only under the token's session (CS-2); the section gate
// (open section, server clock, status) runs first and fails closed. Reads stay allowed in every
// pause. The projection is computed per request from the published version the session is pinned
// to; the Redis `qview` cache and the render-question job of the ADR are an optimisation not built
// yet (FU-BEB-156). Content is read in the org scope until the CS-4 PR 2 grants exist (P-24, D-68).
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { CodeLanguage } from '@codeproctor/shared';
import { CandidateScope } from '../candidate/candidate-scope';
import type { CandidateContext } from '../candidate/candidate.types';
import { mcqAnswerSchema, shortAnswerAnswerSchema } from '../grading/answer-shapes';
import { OptionIdService } from '../grading/option-ids';
import { loadCases } from '../grading/test-data';
import { PrismaService } from '../database/prisma.service';
import { InvalidAnswerSpecError, toCandidateQuestion } from '../questions/candidate-view';
import type { Limits } from '../questions/question-content';
import { paramsFromStored, renderContent } from '../questions/variant-template';
import { QuestionGateService } from './question-gate.service';

export interface QuestionView {
  readonly sessionQuestionId: string;
  readonly type: 'CODING' | 'MCQ' | 'SHORT_ANSWER';
  readonly title: string;
  readonly statementMd: string;
  readonly languages: readonly CodeLanguage[];
  readonly limits: Limits;
  readonly starterCode: Readonly<Record<string, string>>;
  readonly samples: readonly { input: string; expectedOutput: string }[];
  readonly mcq?: {
    readonly multiple: boolean;
    readonly options: readonly { id: string; text: string }[];
  };
  /**
   * The candidate's OWN saved work on this question (their draft, Run or Submit autosave), so a
   * reload or a crash resumes from it and the next autosave never overwrites it with the starter
   * code (data-loss fix, D-61). CODING: code and language; MCQ: the selected option ids as shown to
   * this session; SHORT_ANSWER: the typed text; null when nothing was saved. Only the token's own
   * session_questions row: never another candidate's data and never reference content.
   */
  readonly saved:
    | { readonly code: string; readonly language: string }
    | { readonly optionIds: readonly string[] }
    | { readonly text: string }
    | null;
}

@Injectable()
export class QuestionViewService {
  private readonly logger = new Logger(QuestionViewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
    private readonly gate: QuestionGateService,
    private readonly optionIds: OptionIdService,
  ) {}

  async view(
    ctx: CandidateContext,
    sessionQuestionId: string,
    now: Date = new Date(),
  ): Promise<QuestionView> {
    return this.scope.asOrg(ctx, async () => {
      const open = await this.gate.open(ctx, sessionQuestionId, now, 'read');
      const db = this.prisma.client;
      const version = await db.questionVersion.findUnique({
        where: { id: open.questionVersionId },
        select: { title: true, statementMd: true, starterCode: true, allowedLanguages: true },
      });
      if (version === null) throw this.bad('A session question points at a missing version', open);
      const variant =
        open.variantId === null
          ? null
          : await db.questionVariant.findUnique({
              where: { id: open.variantId },
              select: { params: true, renderedStatement: true },
            });

      // A variant must render: a bad stored params value or a failed template is a data bug that
      // fails closed (500, ids in the log), never the raw template with its {{placeholders}}.
      let starterCode: unknown = version.starterCode;
      if (variant !== null && open.type === 'CODING') {
        const params = paramsFromStored(variant.params);
        const rendered =
          params === null
            ? null
            : renderContent(
                { statementMd: '', starterCode: version.starterCode, referenceSolution: {} },
                params,
              );
        if (rendered === null || !rendered.ok) {
          throw this.bad('A variant does not render', open);
        }
        starterCode = rendered.content.starterCode;
      }

      // Sample cases only (is_hidden = false); the variant's own row overrides the base case.
      const cases =
        open.type === 'CODING'
          ? (await loadCases(db, open.questionVersionId, open.variantId, false)).map((c, i) => ({
              input: c.input,
              expectedOutput: c.expectedOutput,
              isHidden: false,
              position: i,
            }))
          : [];
      let projected;
      try {
        // The one candidate-safe projection (TC-011): an allowlist, shared with the preview.
        projected = toCandidateQuestion(
          {
            type: open.type,
            title: version.title,
            statementMd: version.statementMd,
            allowedLanguages: version.allowedLanguages,
            limits: open.limits,
            starterCode,
            answerSpec: open.type === 'MCQ' ? open.answerSpec : null,
          },
          cases,
          { statementMd: variant?.renderedStatement ?? version.statementMd },
        );
      } catch (e) {
        if (e instanceof InvalidAnswerSpecError)
          throw this.bad('An MCQ answer spec is invalid', open);
        throw e;
      }
      const own = await db.sessionQuestion.findFirst({
        where: { id: open.sessionQuestionId, sessionId: ctx.sessionId },
        select: { finalCode: true, finalLanguage: true, answer: true },
      });
      const saved = ((): QuestionView['saved'] => {
        if (own === null) return null;
        if (projected.type === 'CODING') {
          const language = own.finalLanguage;
          return own.finalCode !== null &&
            language !== null &&
            (projected.languages as readonly string[]).includes(language)
            ? { code: own.finalCode, language }
            : null;
        }
        if (projected.type === 'MCQ') {
          const parsed = mcqAnswerSchema.safeParse(own.answer);
          if (!parsed.success || projected.mcq === undefined) return null;
          const shown = this.optionIds.mapAll(
            ctx.sessionId,
            projected.mcq.options.map((o) => o.id),
          );
          const known = new Set(shown.values());
          return { optionIds: parsed.data.optionIds.filter((id) => known.has(id)) };
        }
        const parsed = shortAnswerAnswerSchema.safeParse(own.answer);
        return parsed.success ? { text: parsed.data.text } : null;
      })();
      return {
        sessionQuestionId: open.sessionQuestionId,
        saved,
        type: projected.type,
        title: projected.title,
        statementMd: projected.statementMd,
        languages: projected.languages as CodeLanguage[],
        limits: projected.limits,
        starterCode: projected.starterCode,
        samples: projected.samples,
        ...(projected.mcq === undefined
          ? {}
          : {
              mcq: (() => {
                // Opaque per-session ids, collision-checked over this question's options.
                const ids = this.optionIds.mapAll(
                  ctx.sessionId,
                  projected.mcq.options.map((o) => o.id),
                );
                return {
                  multiple: projected.mcq.multiple,
                  options: projected.mcq.options.map((o) => ({
                    id: ids.get(o.id) as string,
                    text: o.text,
                  })),
                };
              })(),
            }),
      };
    });
  }

  private bad(message: string, open: { sessionQuestionId: string }): InternalServerErrorException {
    this.logger.error(`${message} (session question ${open.sessionQuestionId})`);
    return new InternalServerErrorException();
  }
}
