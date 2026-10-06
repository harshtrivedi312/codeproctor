// The candidate-facing view of a question (FR-202, TC-011, ADR 0013 render-question shape).
// A pure function that BUILDS the output field by field from an allowlist; it never spreads or
// copies its input, so a column added to the database later cannot leak by accident. It must
// never expose: hidden test cases, the reference solution, AI reference solutions, answer_spec
// (the MCQ key and short-answer answers) or variant params. Only the MCQ option ids and texts and
// the single or multiple flag are shown (the key stays out).
import { CODE_LANGUAGES } from '@codeproctor/shared';
import { mcqAnswerSpecSchema } from './answer-spec';
import { limitsFromStored } from './question-content';
import type { Limits, QuestionKind } from './question-content';

export interface CandidateVersionSource {
  type: QuestionKind;
  title: string;
  statementMd: string;
  allowedLanguages: readonly string[];
  limits: unknown;
  starterCode: unknown;
  answerSpec: unknown;
}

export interface CandidateTestCaseSource {
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  position?: number;
}

export interface CandidateQuestionView {
  type: QuestionKind;
  title: string;
  statementMd: string;
  languages: string[];
  limits: Limits;
  starterCode: Record<string, string>;
  samples: { input: string; expectedOutput: string }[];
  mcq?: { multiple: boolean; options: { id: string; text: string }[] };
}

export class InvalidAnswerSpecError extends Error {
  constructor() {
    super('The question answer_spec is invalid');
    this.name = 'InvalidAnswerSpecError';
  }
}

/**
 * `options.statementMd` is the rendered statement (variants, slice 4b); `testCases` may already
 * be merged with a variant's per-slot data. Without them the plain statement is shown.
 */
export function toCandidateQuestion(
  version: CandidateVersionSource,
  testCases: readonly CandidateTestCaseSource[],
  options: { statementMd?: string } = {},
): CandidateQuestionView {
  const languages = version.allowedLanguages.filter((l) =>
    (CODE_LANGUAGES as readonly string[]).includes(l),
  );
  const starterIn =
    typeof version.starterCode === 'object' &&
    version.starterCode !== null &&
    !Array.isArray(version.starterCode)
      ? (version.starterCode as Record<string, unknown>)
      : {};
  const starterCode: Record<string, string> = {};
  for (const lang of languages) {
    const code = starterIn[lang];
    if (typeof code === 'string') starterCode[lang] = code;
  }
  const samples = testCases
    .filter((t) => t.isHidden === false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((t) => ({ input: t.input, expectedOutput: t.expectedOutput }));
  const view: CandidateQuestionView = {
    type: version.type,
    title: version.title,
    statementMd: options.statementMd ?? version.statementMd,
    languages,
    limits: limitsFromStored(version.limits),
    starterCode,
    samples: version.type === 'CODING' ? samples : [],
  };
  if (version.type === 'MCQ') {
    const spec = mcqAnswerSpecSchema.safeParse(version.answerSpec);
    if (!spec.success) throw new InvalidAnswerSpecError();
    view.mcq = {
      multiple: spec.data.multiple,
      options: spec.data.options.map((o) => ({ id: o.id, text: o.text })),
    };
  }
  return view;
}
