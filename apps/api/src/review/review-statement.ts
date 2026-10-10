// The statement a reviewer sees is the statement the candidate saw (FR-105, FR-202, FR-205). Pure:
// no database, no Nest. The candidate view (submissions/question-view.service.ts) shows the
// variant's stored `renderedStatement` and never re-renders; this helper returns that same stored
// text. Only when it is empty does it render the version template with the variant params (the
// same `paramsFromStored` + `renderContent` the variant writes use), and on any error it returns
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
  // Exactly what the candidate saw: the variant's stored rendering, never re-rendered.
  if (variant.renderedStatement !== '') return variant.renderedStatement;
  try {
    const params = paramsFromStored(variant.params);
    if (params !== null) {
      const r = renderContent({ statementMd, starterCode: {}, referenceSolution: {} }, params);
      if (r.ok) return r.content.statementMd;
    }
  } catch {
    // Fall through: the bundle must not fail on a bad template.
  }
  return statementMd;
}
