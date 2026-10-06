// Variant rules shared by the writes and publish (FR-203, ADR 0007 V-1, V-2, V-5, V-6). Pure.
import type { CandidateTestCaseSource } from './candidate-view';
import type { VariantRow } from './question-tx';
import { paramsFromStored, paramsProblems, renderContent } from './variant-template';
import type { RenderedContent, TemplateContent } from './variant-template';

export interface SlotRow {
  id: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  position: number;
}

/**
 * Renders one variant against the version content. Problems are prefixed so the author sees
 * which variant (by id) and which field failed.
 */
export function renderVariant(
  content: TemplateContent,
  variant: Pick<VariantRow, 'id' | 'params'>,
): { ok: true; content: RenderedContent } | { ok: false; problems: string[] } {
  const params = paramsFromStored(variant.params);
  if (!params) {
    return {
      ok: false,
      problems: [`variants[${variant.id}].params: ${paramsProblems(variant.params).join('; ')}`],
    };
  }
  const r = renderContent(content, params);
  if (r.ok) return r;
  return { ok: false, problems: r.errors.map((e) => `variants[${variant.id}].${e}`) };
}

/**
 * Publish rules for the variants of a version: every ACTIVE variant renders cleanly (V-2), and
 * every override of any variant names a slot of this very version (V-6; a slot that exists in the
 * base version always has an input and an expected output, so "non-null" holds). The hidden flag
 * and the weight always come from the slot (V-1), so there is nothing to check for them.
 * `rendered` is the fresh statement of each active variant, to store as rendered_statement.
 */
export function variantPublishProblems(
  content: TemplateContent,
  slotIds: ReadonlySet<string>,
  variants: readonly VariantRow[],
): { problems: string[]; rendered: Map<string, string> } {
  const problems: string[] = [];
  const rendered = new Map<string, string>();
  for (const v of variants) {
    for (const o of v.testCaseOverrides) {
      if (!slotIds.has(o.testCaseId)) {
        problems.push(`variants[${v.id}]: overrides a test slot that is not in this version`);
      }
    }
    if (!v.isActive) continue;
    const r = renderVariant(content, v);
    if (r.ok) rendered.set(v.id, r.content.statementMd);
    else problems.push(...r.problems);
  }
  return { problems, rendered };
}

/** The slots with one variant's input and output where it overrides them (V-1, V-5). */
export function mergeSlots(
  slots: readonly SlotRow[],
  overrides: readonly { testCaseId: string; input: string; expectedOutput: string }[],
): CandidateTestCaseSource[] {
  const by = new Map(overrides.map((o) => [o.testCaseId, o]));
  return slots.map((s) => {
    const o = by.get(s.id);
    return {
      input: o ? o.input : s.input,
      expectedOutput: o ? o.expectedOutput : s.expectedOutput,
      isHidden: s.isHidden,
      position: s.position,
    };
  });
}
