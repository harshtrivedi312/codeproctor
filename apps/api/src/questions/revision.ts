// A content revision of a version: SHA-256 over its canonical content, test cases and (slice 4b)
// variants with their per-slot overrides. The schema
// has no `updated_at` on question_versions and a column may not be invented here, so this is the
// optimistic-concurrency token (`expectedRevision`) and the binding between a validation run and
// the content it ran on (FR-203, TC-012). Any change to the content, the test cases, a variant's
// params or active flag or an override changes it. A version with no variants hashes exactly as in
// slice 4a (the `variants` key is left out), so no earlier revision changes. The rendered
// statement is derived from content and params, so it is not hashed.
// The validate job (slice 4c) must compute it, with this function, inside the same question row
// lock at job start and store it as `revision` in validation_report; publish refuses a report
// whose `revision` differs from the current one.
import { createHash } from 'node:crypto';

export interface RevisionVersion {
  title: string;
  statementMd: string;
  difficulty: string;
  allowedLanguages: readonly string[];
  limits: unknown;
  starterCode: unknown;
  referenceSolution: unknown;
  answerSpec: unknown;
}

export interface RevisionTestCase {
  id: string;
  position: number;
  isHidden: boolean;
  weight: { toString(): string } | number;
  input: string;
  expectedOutput: string;
}

export interface RevisionVariant {
  id: string;
  params: unknown;
  isActive: boolean;
  testCaseOverrides: readonly { testCaseId: string; input: string; expectedOutput: string }[];
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function computeRevision(
  v: RevisionVersion,
  cases: readonly RevisionTestCase[],
  variants: readonly RevisionVariant[] = [],
): string {
  const sorted = [...cases].sort((a, b) =>
    a.position !== b.position ? a.position - b.position : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const body = canonical({
    title: v.title,
    statementMd: v.statementMd,
    difficulty: v.difficulty,
    allowedLanguages: v.allowedLanguages,
    limits: v.limits,
    starterCode: v.starterCode,
    referenceSolution: v.referenceSolution,
    answerSpec: v.answerSpec ?? null,
    testCases: sorted.map((t) => ({
      id: t.id,
      position: t.position,
      isHidden: t.isHidden,
      weight: Number(t.weight),
      input: t.input,
      expectedOutput: t.expectedOutput,
    })),
    ...(variants.length === 0
      ? {}
      : {
          variants: [...variants]
            .sort((a, b) => byId(a.id, b.id))
            .map((x) => ({
              id: x.id,
              params: x.params,
              isActive: x.isActive,
              overrides: [...x.testCaseOverrides]
                .sort((a, b) => byId(a.testCaseId, b.testCaseId))
                .map((o) => ({
                  testCaseId: o.testCaseId,
                  input: o.input,
                  expectedOutput: o.expectedOutput,
                })),
            })),
        }),
  });
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
