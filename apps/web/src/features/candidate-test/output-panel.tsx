import { CheckCircle2, XCircle } from 'lucide-react';
import { LOCAL_STUB_LABEL } from './adr-wire';
import type { RunResultView } from './source';

export function OutputPanel({
  running,
  result,
  errorMessage,
}: {
  running: boolean;
  result: RunResultView | null;
  errorMessage: string | null;
}): React.JSX.Element {
  return (
    <section
      aria-label="Output"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users must be able to scroll this region (axe: scrollable-region-focusable)
      tabIndex={0}
      className="h-full overflow-auto p-3 text-sm"
      aria-live="polite"
    >
      {running && <p>Running your code against the sample tests… this can take a few seconds.</p>}
      {errorMessage && (
        <p role="alert" className="rounded-md bg-destructive-soft p-3 text-destructive">
          {errorMessage}
        </p>
      )}
      {!running && !result && !errorMessage && (
        <p className="text-muted-foreground">
          Press Run to try your code on the sample tests. Results appear here.
        </p>
      )}
      {!running && result && (
        <div className="space-y-3">
          {result.stub === true && (
            <p
              role="status"
              data-testid="run-stub-notice"
              className="rounded-md border border-dashed p-3 font-medium"
            >
              {/* Nothing ran: this is neither a pass nor a fail (DL-58). */}
              Local stub, not real execution. Your code was not run and nothing was checked against
              the sample tests.
              <span className="sr-only"> ({result.message ?? LOCAL_STUB_LABEL})</span>
            </p>
          )}
          {result.stub !== true && result.outcome !== 'completed' && (
            <pre className="whitespace-pre-wrap rounded-md bg-destructive-soft p-3 font-mono text-destructive">
              {result.stderr}
            </pre>
          )}
          {result.stub !== true && result.outcome === 'completed' && result.tests.length === 0 && (
            <p className="text-muted-foreground" data-testid="run-no-samples">
              This question has no sample tests to run.
            </p>
          )}
          {result.stub !== true && result.tests.length > 0 && (
            <>
              <p className="font-medium">
                {result.tests.filter((t) => t.status === 'passed').length} of {result.tests.length}{' '}
                sample tests passed
              </p>
              <ul className="space-y-2">
                {result.tests.map((t) => (
                  <li key={t.id} className="rounded-md border p-2">
                    <div className="flex items-center gap-2 font-medium">
                      {t.status === 'passed' ? (
                        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive" aria-hidden />
                      )}
                      <span>{t.name}</span>
                      <span className={t.status === 'passed' ? 'text-success' : 'text-destructive'}>
                        {t.status === 'passed' ? 'Passed' : 'Failed'}
                      </span>
                    </div>
                    {t.status === 'failed' && (
                      <dl className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs">
                        {t.expectedOutput !== undefined && (
                          <div>
                            <dt className="font-sans text-muted-foreground">Expected</dt>
                            <dd>
                              <pre>{t.expectedOutput}</pre>
                            </dd>
                          </div>
                        )}
                        {t.actualOutput !== undefined && (
                          <div>
                            <dt className="font-sans text-muted-foreground">Your output</dt>
                            <dd>
                              <pre>{t.actualOutput}</pre>
                            </dd>
                          </div>
                        )}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.stdout && (
            <div>
              <p className="font-medium">Printed output (stdout)</p>
              <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
                {result.stdout}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
