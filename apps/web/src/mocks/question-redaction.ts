import type { Schemas } from '@/lib/api/client';
import type { MockQuestion, MockVersion } from './question-seed';

/*
 * What a caller without question:update (a Recruiter) may see of a question (DL-32). ALLOWLIST
 * semantics: a field that is not named below is dropped, so a new field added to the mock question
 * never reaches the Recruiter by default. PROVISIONAL, pending the exact allowlist of BE-04a:
 * changing the list is a one-line edit of RECRUITER_QUESTION_FIELDS (and the matching schema
 * `QuestionDetailRedacted` in openapi.yaml).
 */
export const RECRUITER_QUESTION_FIELDS = [
  'id',
  'slug',
  'title',
  'type',
  'status',
  'difficulty',
  'tags',
  'statementMd',
  'version',
  'updatedAt',
  'starterCode',
  'limits',
  'allowedLanguages',
  'sampleTestCases',
] as const;

export type RedactedQuestion = Schemas['QuestionDetailRedacted'];

/**
 * Builds the Recruiter's view. The source is the question and the version flattened together with
 * everything they hold (so new fields are present in it on purpose), then only the allowlisted keys
 * are copied out. Visible sample cases carry input and expected output only: no id, no weight, no
 * hidden case, and nothing about hidden cases at all.
 */
export function redactQuestion(
  q: MockQuestion,
  v: MockVersion,
  status: Schemas['QuestionStatus'],
): RedactedQuestion {
  const source: Record<string, unknown> = {
    ...q,
    ...v,
    status,
    sampleTestCases: v.testCases
      .filter((t) => !t.isHidden)
      .map((t) => ({ input: t.input, expectedOutput: t.expectedOutput })),
  };
  const out: Record<string, unknown> = {};
  for (const key of RECRUITER_QUESTION_FIELDS) {
    if (key in source) out[key] = structuredClone(source[key]);
  }
  return out as RedactedQuestion;
}
