// Pure content rules for questions: shape checks on every write, completeness checks on publish
// (FR-201, FR-202, FR-205). No database, no Nest: unit tested directly.
import { CODE_LANGUAGES } from '@codeproctor/shared';
import { z } from 'zod';
import { formatIssues, mcqAnswerSpecSchema, shortAnswerSpecSchema } from './answer-spec';

export type QuestionKind = 'CODING' | 'MCQ' | 'SHORT_ANSWER';

/** question_versions.limits as stored (snake case, same as execution/limits). */
export const DEFAULT_LIMITS = { cpu_ms: 2000, wall_ms: 5000, memory_kb: 262_144 } as const;

export const MAX_CODE_LENGTH = 100_000;

const codeMap = z
  .record(z.string(), z.string().max(MAX_CODE_LENGTH))
  .refine((m) => Object.keys(m).every((k) => (CODE_LANGUAGES as readonly string[]).includes(k)), {
    message: `keys must be one of ${CODE_LANGUAGES.join(', ')}`,
  });
export const codeMapSchema = codeMap;

const storedLimitsSchema = z.object({
  cpu_ms: z.number().int().min(100).max(10_000),
  wall_ms: z.number().int().min(100).max(20_000),
  memory_kb: z
    .number()
    .int()
    .min(16 * 1024)
    .max(512 * 1024),
});

export interface Limits {
  cpuMs: number;
  wallMs: number;
  memoryKb: number;
}

export function limitsToStored(l: Limits): { cpu_ms: number; wall_ms: number; memory_kb: number } {
  return { cpu_ms: l.cpuMs, wall_ms: l.wallMs, memory_kb: l.memoryKb };
}

/** Reads a stored limits value; a malformed one falls back to the defaults (never throws). */
export function limitsFromStored(raw: unknown): Limits {
  const parsed = storedLimitsSchema.safeParse(raw);
  const s = parsed.success ? parsed.data : DEFAULT_LIMITS;
  return { cpuMs: s.cpu_ms, wallMs: s.wall_ms, memoryKb: s.memory_kb };
}

export function checkLimits(l: Limits): string[] {
  const r = storedLimitsSchema.safeParse(limitsToStored(l));
  const problems = r.success ? [] : formatIssues('limits', r.error);
  if (l.wallMs < l.cpuMs) problems.push('limits: wallMs must not be below cpuMs');
  return problems;
}

/** The version fields the rules look at. */
export interface ContentFields {
  allowedLanguages: readonly string[];
  starterCode: unknown;
  referenceSolution: unknown;
  answerSpec: unknown;
}

/** Shape rules checked on every create and update; a draft may still be incomplete. */
export function shapeProblems(type: QuestionKind, c: ContentFields): string[] {
  const problems: string[] = [];
  const starter = codeMap.safeParse(c.starterCode ?? {});
  if (!starter.success) problems.push(...formatIssues('starterCode', starter.error));
  const reference = codeMap.safeParse(c.referenceSolution ?? {});
  if (!reference.success) problems.push(...formatIssues('referenceSolution', reference.error));
  const langs = c.allowedLanguages;
  if (new Set(langs).size !== langs.length) problems.push('allowedLanguages: must be unique');
  if (type === 'CODING') {
    if (c.answerSpec !== null && c.answerSpec !== undefined) {
      problems.push('answerSpec: not allowed on a CODING question');
    }
    return problems;
  }
  if (langs.length > 0) problems.push(`allowedLanguages: must be empty on a ${type} question`);
  if (Object.keys(isRecord(c.starterCode) ? c.starterCode : {}).length > 0) {
    problems.push(`starterCode: must be empty on a ${type} question`);
  }
  if (Object.keys(isRecord(c.referenceSolution) ? c.referenceSolution : {}).length > 0) {
    problems.push(`referenceSolution: must be empty on a ${type} question`);
  }
  if (c.answerSpec !== null && c.answerSpec !== undefined) {
    const schema = type === 'MCQ' ? mcqAnswerSpecSchema : shortAnswerSpecSchema;
    const r = schema.safeParse(c.answerSpec);
    if (!r.success) problems.push(...formatIssues('answerSpec', r.error));
  }
  return problems;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface PublishTestCase {
  isHidden: boolean;
  weight: number;
}

export interface PublishFields extends ContentFields {
  title: string;
  statementMd: string;
  limits: unknown;
}

/**
 * Completeness rules for publishing (FR-201, FR-202, FR-205). The validation gates (reference
 * solution passes every test slot, AI references from enough assistants) come with the validate
 * job and the AI reference endpoints (BE-04 slices 4b, 4c).
 */
export function publishProblems(
  type: QuestionKind,
  v: PublishFields,
  testCases: readonly PublishTestCase[],
): string[] {
  const problems = shapeProblems(type, v);
  if (v.title.trim() === '') problems.push('title: required');
  if (v.statementMd.trim() === '') problems.push('statementMd: required');
  if (type !== 'CODING') {
    if (v.answerSpec === null || v.answerSpec === undefined) {
      problems.push('answerSpec: required to publish');
    }
    if (testCases.length > 0) problems.push(`testCases: not allowed on a ${type} question`);
    return problems;
  }
  problems.push(...checkLimits(limitsFromStored(v.limits)));
  const allowed = v.allowedLanguages;
  if (allowed.length === 0) problems.push('allowedLanguages: at least one language');
  const reference = isRecord(v.referenceSolution) ? v.referenceSolution : {};
  const starter = isRecord(v.starterCode) ? v.starterCode : {};
  const refKeys = Object.keys(reference).filter((k) => String(reference[k]).trim() !== '');
  if (refKeys.length === 0) problems.push('referenceSolution: at least one language');
  for (const k of refKeys) {
    if (!allowed.includes(k)) problems.push(`referenceSolution.${k}: language is not allowed`);
  }
  for (const k of Object.keys(starter)) {
    if (!allowed.includes(k)) problems.push(`starterCode.${k}: language is not allowed`);
  }
  if (testCases.length === 0) problems.push('testCases: at least one');
  if (!testCases.some((t) => !t.isHidden))
    problems.push('testCases: at least one sample (not hidden)');
  if (!testCases.some((t) => t.isHidden)) problems.push('testCases: at least one hidden test');
  if (testCases.some((t) => !(t.weight > 0)))
    problems.push('testCases: every weight must be above 0');
  return problems;
}
