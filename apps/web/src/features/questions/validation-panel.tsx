import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { Schemas } from '@/lib/api/client';
import { LANGUAGE_LABELS } from './draft';

type Report = Schemas['ValidationReport'];
type Verdict = Schemas['ValidationVerdict'];
type Failure = Schemas['ValidationFailure'];

const VERDICT_LABEL: Record<Verdict, string> = {
  FAILED: 'Wrong answer',
  COMPILE_ERROR: 'Compile error',
  TIME_LIMIT: 'Time limit exceeded',
  MEMORY_LIMIT: 'Memory limit exceeded',
  OUTPUT_LIMIT: 'Output limit exceeded',
  RUNTIME_ERROR: 'Runtime error',
  INTERNAL_ERROR: 'Runner error',
  MISSING_REFERENCE: 'No reference solution',
};

/** What the author can do about a failure; a hidden slot never shows its expected or actual output. */
function detailOf(f: Failure): string {
  if (f.verdict === 'MISSING_REFERENCE') {
    return `Add a ${LANGUAGE_LABELS[f.language]} reference solution on the Reference solution tab.`;
  }
  const parts: string[] = [];
  if (f.verdict === 'FAILED') {
    parts.push(
      f.actualOutput !== undefined
        ? `The reference solution printed ${f.actualOutput === '' ? 'nothing' : `"${f.actualOutput}"`}.`
        : 'The output of a hidden test is not shown.',
    );
  }
  if (f.diagnostic) parts.push(f.diagnostic);
  return parts.join(' ');
}

/**
 * Per-variant results of a validation run (TC-012, ADR 0007 V-3), from the API's report: one entry
 * per active variant (or the base content when none is active) with a cell per language and the
 * failures. `variantNames` maps a variant id to the name the editor shows ("Variant 2").
 */
export function ValidationPanel({
  report,
  isCoding,
  stale,
  fresh,
  variantNames,
}: {
  report: Report;
  isCoding: boolean;
  /** The report is older than the form (edits since). Shown as a note. */
  stale: boolean;
  /** Just returned from a run in this session: announce it as an alert. A report loaded with the page is a status. */
  fresh: boolean;
  variantNames: ReadonlyMap<string, string>;
}): React.JSX.Element {
  const nameOf = (id: string | null): string =>
    id === null ? 'Base statement' : (variantNames.get(id) ?? 'A variant that was removed');
  const failedVariants = report.perVariant.filter((p) => !p.passed);

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
      {report.error ? (
        <Alert
          tone="error"
          role={fresh ? 'alert' : 'status'}
          title="The validation could not complete"
        >
          {report.error === 'TIMEOUT'
            ? 'The code runner took too long.'
            : 'The code runner could not run the reference solution.'}{' '}
          Nothing was recorded and publishing stays blocked. Press Validate to try again; if it
          keeps failing, check the reference solution and the limits.
        </Alert>
      ) : report.passed ? (
        <Alert tone="success" role="status" title="Validation passed">
          {isCoding
            ? `The reference solution passed every test on ${report.perVariant.length === 1 ? 'the' : 'all'} ${report.perVariant.length} ${report.perVariant.length === 1 ? 'variant' : 'variants'} in every language.`
            : 'The answer key is valid.'}
        </Alert>
      ) : (
        <Alert tone="error" role={fresh ? 'alert' : 'status'} title="Validation failed">
          {failedVariants.length} of {report.perVariant.length} variants failed
          {failedVariants.length > 0
            ? `, in: ${failedVariants.map((p) => nameOf(p.variantId)).join(', ')}`
            : ''}
          . Fix them and validate again. Publishing stays blocked until every check passes.
        </Alert>
      )}
      {report.perVariant.map((p) => {
        const name = nameOf(p.variantId);
        return (
          <div key={p.variantId ?? 'base'} className="space-y-1">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {name}
              <Badge tone={p.passed ? 'success' : 'error'}>{p.passed ? 'Passed' : 'Failed'}</Badge>
            </h3>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">{`Results for ${name}`}</caption>
                <thead className="border-b bg-muted/60">
                  <tr>
                    <th scope="col" className="px-3 py-1.5">
                      Language
                    </th>
                    <th scope="col" className="px-3 py-1.5">
                      Test
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
                  {p.cells.map((c) => {
                    const failures = p.failures.filter((f) => f.language === c.language);
                    if (c.passed && failures.length === 0) {
                      return (
                        <tr key={c.language} className="border-b last:border-0">
                          <td className="px-3 py-1.5">{LANGUAGE_LABELS[c.language]}</td>
                          <td className="px-3 py-1.5">All {c.testsTotal}</td>
                          <td className="px-3 py-1.5">
                            <Badge tone="success">Passed</Badge>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground" />
                        </tr>
                      );
                    }
                    return failures.length > 0 ? (
                      failures.map((f, i) => (
                        <tr
                          key={`${c.language}-${f.testCaseId ?? 'x'}-${i}`}
                          className="border-b last:border-0"
                        >
                          <td className="px-3 py-1.5">{LANGUAGE_LABELS[c.language]}</td>
                          <td className="px-3 py-1.5">
                            {f.position === null ? 'All' : `Test ${f.position + 1}`}
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge tone="error">{VERDICT_LABEL[f.verdict]}</Badge>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">{detailOf(f)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr key={c.language} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{LANGUAGE_LABELS[c.language]}</td>
                        <td className="px-3 py-1.5">
                          {c.testsPassed} of {c.testsTotal}
                        </td>
                        <td className="px-3 py-1.5">
                          <Badge tone="error">Failed</Badge>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground" />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </section>
  );
}
