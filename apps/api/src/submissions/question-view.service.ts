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
import { Injectable, Logger } from '@nestjs/common';
import type { CodeLanguage } from '@codeproctor/shared';
import { CandidateScope } from '../candidate/candidate-scope';
import type { CandidateContext } from '../candidate/candidate.types';
import { candidateOptionId } from '../grading/option-ids';
import { loadCases } from '../grading/test-data';
import { PrismaService } from '../database/prisma.service';
import { mcqAnswerSpecSchema } from '../questions/answer-spec';
import { paramsFromStored, renderContent } from '../questions/variant-template';
import { QuestionGateService } from './question-gate.service';

const CODE_LANGUAGES: readonly string[] = ['python', 'javascript', 'java'];

export interface QuestionView {
  readonly sessionQuestionId: string;
  readonly type: 'CODING' | 'MCQ' | 'SHORT_ANSWER';
  readonly title: string;
  readonly statementMd: string;
  readonly languages: readonly CodeLanguage[];
  readonly limits: unknown;
  readonly starterCode: Readonly<Record<string, string>>;
  readonly samples: readonly { input: string; expectedOutput: string }[];
  readonly mcq?: {
    readonly multiple: boolean;
    readonly options: readonly { id: string; text: string }[];
  };
}

const asRecord = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
};

@Injectable()
export class QuestionViewService {
  private readonly logger = new Logger(QuestionViewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
    private readonly gate: QuestionGateService,
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
      if (version === null) {
        this.logger.error('A session question points at a missing question version');
        throw new Error('question version missing');
      }
      const variant =
        open.variantId === null
          ? null
          : await db.questionVariant.findUnique({
              where: { id: open.variantId },
              select: { params: true, renderedStatement: true },
            });

      if (open.type === 'MCQ') {
        const spec = mcqAnswerSpecSchema.safeParse(open.answerSpec);
        if (!spec.success) {
          this.logger.error('An MCQ question has an invalid answer spec');
          throw new Error('mcq answer spec invalid');
        }
        return {
          sessionQuestionId: open.sessionQuestionId,
          type: 'MCQ',
          title: version.title,
          statementMd: variant?.renderedStatement ?? version.statementMd,
          languages: [],
          limits: undefined,
          starterCode: {},
          samples: [],
          // The options and their order; the correct ids are never read into the projection.
          mcq: {
            multiple: spec.data.multiple,
            options: spec.data.options.map((o) => ({
              id: candidateOptionId(ctx.sessionId, o.id),
              text: o.text,
            })),
          },
        };
      }

      if (open.type === 'SHORT_ANSWER') {
        return {
          sessionQuestionId: open.sessionQuestionId,
          type: 'SHORT_ANSWER',
          title: version.title,
          statementMd: variant?.renderedStatement ?? version.statementMd,
          languages: [],
          limits: undefined,
          starterCode: {},
          samples: [],
        };
      }

      const params = variant === null ? null : paramsFromStored(variant.params);
      let starterCode = asRecord(version.starterCode);
      if (params !== null) {
        const rendered = renderContent(
          { statementMd: version.statementMd, starterCode, referenceSolution: {} },
          params,
        );
        if (rendered.ok) starterCode = rendered.content.starterCode;
      }
      // Sample cases only (is_hidden = false); the variant's own row overrides the base case.
      const samples = await loadCases(db, open.questionVersionId, open.variantId, false);
      return {
        sessionQuestionId: open.sessionQuestionId,
        type: 'CODING',
        title: version.title,
        statementMd: variant?.renderedStatement ?? version.statementMd,
        languages: version.allowedLanguages.filter((l): l is CodeLanguage =>
          CODE_LANGUAGES.includes(l),
        ),
        limits: open.limits,
        starterCode,
        samples: samples.map((c) => ({ input: c.input, expectedOutput: c.expectedOutput })),
      };
    });
  }
}
