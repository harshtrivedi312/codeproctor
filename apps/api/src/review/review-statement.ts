// The statement a reviewer sees is the statement the candidate saw (FR-105, FR-202, FR-205): the
// session question's own variant applied to the version's statement template. Pure: no database,
// no Nest. The candidate view (submissions/question-view.service.ts) shows the variant's stored
// `renderedStatement`, which is the output of `renderContent` over the variant params; this helper
// renders the same template with the same functions, falls back to the stored text, and finally to
// the version statement. It never throws and never logs the template or the params. Only the
// resulting string leaves the module: params are never returned.
import { paramsFromStored, renderContent } from '../questions/variant-template';

export interface VariantStatementSource {
  readonly params: unknown;
  readonly renderedStatement: string;
}

/**
 * @param statementMd the question version's statement (may hold {{placeholders}})
 * @param variant the session question's variant, or null when it has none
 */
export function reviewStatement(
  statementMd: string,
  variant: VariantStatementSource | null | undefined,
): string {
  if (variant === null || variant === undefined) return statementMd;
  try {
    const params = paramsFromStored(variant.params);
    if (params !== null) {
      const r = renderContent({ statementMd, starterCode: {}, referenceSolution: {} }, params);
      if (r.ok) return r.content.statementMd;
    }
  } catch {
    // Fall through: the bundle must not fail on a bad template.
  }
  return variant.renderedStatement !== '' ? variant.renderedStatement : statementMd;
}
