// Staff-facing views of a version. Two builders, both pure and field by field (no spread of a
// database row, so a column added later is not exposed by accident):
//   toFullVersion      callers with question:update (authors, super admins): everything.
//   toStaffReadVersion everyone else who may read (recruiters, FR-103): an allowlist that leaves out
//                      the reference solution, answer_spec, the validation report, the input and
//                      expected output of hidden test cases, and the whole `variants` key (variant
//                      params, rendered statements and variant_test_cases overrides: ADR 0007 V-1,
//                      V-2, V-5; a recruiter sees a variant only through the candidate-shaped
//                      variant preview). Keys are absent, not null.
// The choice is made once, in the controller (`canSeeAnswers`), and passed down as `full`.
import { computeRevision } from './revision';
import { limitsFromStored } from './question-content';
import { paramsFromStored } from './variant-template';
import type { VariantRow } from './question-tx';
import type {
  QuestionVersionDto,
  QuestionVersionRefDto,
  TestCaseDto,
  VariantDto,
} from './dto/questions.dto';
import type { Difficulty } from '../generated/prisma/client';

/** The columns a version ref needs; list and archive load only these. */
export interface VersionRefRow {
  id: string;
  version: number;
  isPublished: boolean;
  title: string;
  difficulty: Difficulty;
  validatedAt: Date | null;
  createdAt: Date;
}
export const VERSION_REF_SELECT = {
  id: true,
  version: true,
  isPublished: true,
  title: true,
  difficulty: true,
  validatedAt: true,
  createdAt: true,
} as const;

/** The content columns of the one version a detail response shows. */
export interface VersionContentRow extends VersionRefRow {
  statementMd: string;
  allowedLanguages: string[];
  limits: unknown;
  starterCode: unknown;
  referenceSolution: unknown;
  answerSpec: unknown;
  validationReport: unknown;
}

export interface TestCaseRow {
  id: string;
  position: number;
  isHidden: boolean;
  weight: { toString(): string } | number;
  input: string;
  expectedOutput: string;
}

export function toVersionRef(v: VersionRefRow): QuestionVersionRefDto {
  return {
    id: v.id,
    version: v.version,
    isPublished: v.isPublished,
    title: v.title,
    difficulty: v.difficulty,
    validatedAt: v.validatedAt ? v.validatedAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
  };
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(asRecord(v) ?? {}))
    if (typeof val === 'string') out[k] = val;
  return out;
}

export function toTestCaseDto(t: TestCaseRow, full: boolean): TestCaseDto {
  const dto: TestCaseDto = {
    id: t.id,
    position: t.position,
    isHidden: t.isHidden,
    weight: Number(t.weight),
  };
  if (full || !t.isHidden) {
    dto.input = t.input;
    dto.expectedOutput = t.expectedOutput;
  }
  return dto;
}

export function toVariantDto(x: VariantRow, cases: readonly TestCaseRow[]): VariantDto {
  const slot = new Map(cases.map((c) => [c.id, c]));
  return {
    id: x.id,
    isActive: x.isActive,
    params: { ...(paramsFromStored(x.params) ?? {}) },
    renderedStatement: x.renderedStatement,
    testCaseOverrides: x.testCaseOverrides.flatMap((o) => {
      const c = slot.get(o.testCaseId);
      return c
        ? [
            {
              testCaseId: o.testCaseId,
              isHidden: c.isHidden,
              position: c.position,
              input: o.input,
              expectedOutput: o.expectedOutput,
            },
          ]
        : [];
    }),
  };
}

const byVariantId = (a: VariantRow, b: VariantRow): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function toFullVersion(
  v: VersionContentRow,
  cases: readonly TestCaseRow[],
  variants: readonly VariantRow[] = [],
): QuestionVersionDto {
  return {
    ...toVersionRef(v),
    statementMd: v.statementMd,
    allowedLanguages: [...v.allowedLanguages],
    limits: limitsFromStored(v.limits),
    starterCode: stringMap(v.starterCode),
    revision: computeRevision(v, cases, variants),
    testCases: cases.map((t) => toTestCaseDto(t, true)),
    variants: [...variants].sort(byVariantId).map((x) => toVariantDto(x, cases)),
    referenceSolution: stringMap(v.referenceSolution),
    answerSpec: asRecord(v.answerSpec),
    validationReport: asRecord(v.validationReport),
  };
}

export function toStaffReadVersion(
  v: VersionContentRow,
  cases: readonly TestCaseRow[],
): QuestionVersionDto {
  return {
    ...toVersionRef(v),
    statementMd: v.statementMd,
    allowedLanguages: [...v.allowedLanguages],
    limits: limitsFromStored(v.limits),
    starterCode: stringMap(v.starterCode),
    testCases: cases.map((t) => toTestCaseDto(t, false)),
  };
}
