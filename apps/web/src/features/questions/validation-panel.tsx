import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { Schemas } from '@/lib/api/client';
import { LANGUAGE_LABELS } from './draft';

type Report = Schemas['ValidationReport'];
type Outcome = Schemas['ValidationOutcome'];

const OUTCOME_LABEL: Record<Outcome, string> = {
  pass: 'Passed',
  wrong_answer: 'Wrong answer',
  runtime_error: 'Runtime error',
  compile_error: 'Compile error',
  limit_exceeded: 'Limit exceeded',
};

/** Per-variant, per-test results of a validation job (TC-012, ADR 0007 V-3). */
export function ValidationPanel({
  report,
  isCoding,
  stale,
  fresh,
}: {
  report: Report;
  isCoding: boolean;
  /** The report is older than the form (edits since). Shown as a note. */
  stale: boolean;
  /** Just returned from a job in this session: announce it as an alert. A report loaded with the page is a status. */
  fresh: boolean;
}): React.JSX.Element {
  const failed = report.results.filter((r) => r.outcome !== 'pass');
  const groups = new Map<string, Report['results']>();
  for (const r of report.results) {
    const key = `${r.variantId ?? 'base'}|${r.variantLabel}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const failedVariants = [...new Set(failed.map((r) => r.variantLabel))];

  return (
    <section
      aria-labelledby="validation-heading"
      className="space-y-3 rounded-md border bg-card p-4"
    >
      <h2 id="validation-heading" className="font-medium">
        Validation report
      </h2>
      {stale ? (
        <p className="text-sm text-muted-foreground">
          You changed the question after this validation. Save and validate again.
        </p>
      ) : null}
      {report.passed ? (
        <Alert tone="success" role="status" title="Validation passed">
          {isCoding
            ? `The reference solution passed all ${report.results.length} checks on every variant.`
            : 'The answer key is valid.'}
        </Alert>
      ) : (
        <Alert tone="error" role={fresh ? 'alert' : 'status'} title="Validation failed">
          {failed.length} of {report.results.length} checks failed
          {failedVariants.length > 0 ? `, in: ${failedVariants.join(', ')}` : ''}. Fix them and
          validate again. Publishing stays blocked until every check passes.
        </Alert>
      )}
      {[...groups.entries()].map(([key, rows]) => {
        const label = rows[0]?.variantLabel ?? '';
        return (
          <div key={key} className="space-y-1">
            <h3 className="text-sm font-medium">{label}</h3>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">{`Results for ${label}`}</caption>
                <thead className="border-b bg-muted/60">
                  <tr>
                    <th scope="col" className="px-3 py-1.5">
                      Test
                    </th>
                    <th scope="col" className="px-3 py-1.5">
                      Language
                    </th>
                    <th scope="col" className="px-3 py-1.5">
                      Result
                    </th>
                    <th scope="col" className="px-3 py-1.5">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.language}-${r.testCaseId}`} className="border-b last:border-0">
                      <td className="px-3 py-1.5">Test {r.position}</td>
                      <td className="px-3 py-1.5">{LANGUAGE_LABELS[r.language]}</td>
                      <td className="px-3 py-1.5">
                        <Badge tone={r.outcome === 'pass' ? 'success' : 'error'}>
                          {OUTCOME_LABEL[r.outcome]}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.message ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </section>
  );
}
