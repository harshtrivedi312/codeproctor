// The pure parts of the validate job (FR-203, ADR 0007 V-3, TC-012): what to run for a version
// and what to store from the result. No database, no Nest.
import { limitsFromStored } from './question-content';
import type { PortRequest, PortResult, PortVariant } from './reference-validation.port';
import type { VariantRow } from './question-tx';
import { mergeSlots, renderVariant } from './variant-rules';
import type { SlotRow } from './variant-rules';
import type { TemplateContent } from './variant-template';

export interface JobVersion extends TemplateContent {
  id: string;
  allowedLanguages: readonly string[];
  limits: unknown;
}

export interface JobCase extends SlotRow {
  id: string;
}

export type BuiltRequest =
  | { ok: true; request: PortRequest; hiddenSlots: ReadonlySet<string> }
  | { ok: false; problems: string[] };

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/**
 * Every ACTIVE variant is validated with its own rendered reference solution and its own slot data
 * (overrides merged over the base slots). A version with no active variant is validated as one
 * implicit variant on the base content. A variant that does not render is a problem (422), not a
 * failed run.
 */
export function buildRequest(
  version: JobVersion,
  cases: readonly JobCase[],
  variants: readonly VariantRow[],
): BuiltRequest {
  const problems: string[] = [];
  const slots = [...cases].sort((a, b) =>
    a.position !== b.position ? a.position - b.position : a.id < b.id ? -1 : 1,
  );
  const tests = (overrides: VariantRow['testCaseOverrides']): PortVariant['tests'] =>
    mergeSlots(slots, overrides).map((m, i) => ({
      testCaseId: (slots[i] as JobCase).id,
      position: (slots[i] as JobCase).position,
      isHidden: m.isHidden,
      input: m.input,
      expectedOutput: m.expectedOutput,
    }));
  if (version.allowedLanguages.length === 0) problems.push('allowedLanguages: at least one');
  const portVariants: PortVariant[] = [];
  const active = variants.filter((v) => v.isActive);
  if (active.length === 0) {
    portVariants.push({
      variantId: null,
      referenceSources: stringMap(version.referenceSolution),
      tests: tests([]),
    });
  }
  for (const v of [...active].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const r = renderVariant(version, v);
    if (!r.ok) {
      problems.push(...r.problems);
      continue;
    }
    portVariants.push({
      variantId: v.id,
      referenceSources: r.content.referenceSolution,
      tests: tests(v.testCaseOverrides),
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    hiddenSlots: new Set(slots.filter((s) => s.isHidden).map((s) => s.id)),
    request: {
      questionVersionId: version.id,
      limits: limitsFromStored(version.limits),
      languages: [...version.allowedLanguages],
      variants: portVariants,
    },
  };
}

export interface StoredCell {
  language: string;
  passed: boolean;
  testsPassed: number;
  testsTotal: number;
}
export interface StoredFailure {
  language: string;
  testCaseId: string | null;
  position: number | null;
  verdict: string;
  /** Only for a sample slot; never for a hidden one. */
  actualOutput?: string;
  diagnostic?: string;
}
export interface StoredVariantResult {
  variantId: string | null;
  passed: boolean;
  cells: StoredCell[];
  failures: StoredFailure[];
}

/** question_versions.validation_report (author view only; never in a recruiter or candidate view). */
export interface StoredReport {
  passed: boolean;
  /** The content revision the run was bound to, computed under the question lock at job start. */
  revision: string;
  startedAt: string;
  finishedAt: string;
  /** Set when the run could not complete; then `passed` is false and `perVariant` is empty. */
  error?: 'EXECUTION_ERROR' | 'TIMEOUT';
  perVariant: StoredVariantResult[];
}

/**
 * Builds the stored report from the port's answer. `passed` is recomputed here and never taken from
 * the port: every (variant, language) pair must have a passing cell with no failure.
 */
export function buildReport(
  built: Extract<BuiltRequest, { ok: true }>,
  result: PortResult,
  meta: { revision: string; startedAt: Date; finishedAt: Date },
): StoredReport {
  const { request, hiddenSlots } = built;
  const perVariant: StoredVariantResult[] = request.variants.map((v) => {
    const cells = result.cells
      .filter((c) => c.variantId === v.variantId)
      .map((c) => ({
        language: c.language,
        passed: c.passed,
        testsPassed: c.testsPassed,
        testsTotal: c.testsTotal,
      }));
    const failures = result.failures
      .filter((f) => f.variantId === v.variantId)
      .map((f): StoredFailure => {
        const hidden = f.testCaseId !== null && hiddenSlots.has(f.testCaseId);
        return {
          language: f.language,
          testCaseId: f.testCaseId,
          position: f.position,
          verdict: f.verdict,
          ...(f.actualOutput !== undefined && !hidden ? { actualOutput: f.actualOutput } : {}),
          ...(f.diagnostic !== undefined ? { diagnostic: f.diagnostic } : {}),
        };
      });
    const covered = request.languages.every((l) =>
      cells.some(
        (c) => c.language === l && c.passed && c.testsTotal > 0 && c.testsPassed === c.testsTotal,
      ),
    );
    return { variantId: v.variantId, passed: covered && failures.length === 0, cells, failures };
  });
  const allFailures = result.failures.length === 0;
  return {
    passed: perVariant.length > 0 && allFailures && perVariant.every((p) => p.passed),
    revision: meta.revision,
    startedAt: meta.startedAt.toISOString(),
    finishedAt: meta.finishedAt.toISOString(),
    perVariant,
  };
}

export function errorReport(
  error: 'EXECUTION_ERROR' | 'TIMEOUT',
  meta: { revision: string; startedAt: Date; finishedAt: Date },
): StoredReport {
  return {
    passed: false,
    revision: meta.revision,
    startedAt: meta.startedAt.toISOString(),
    finishedAt: meta.finishedAt.toISOString(),
    error,
    perVariant: [],
  };
}
