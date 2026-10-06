'use client';
import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { hasVisibleSample, newId } from '../draft';
import { errorAt, useDraftField, type TabProps } from '../use-draft-field';

/** FR-202: the test slots. Visible ones are shown to candidates as samples; hidden ones never leave the API. */
export function TestsTab({ form, readOnly }: TabProps): React.JSX.Element {
  const [tests, setTests] = useDraftField(form, 'testCases');
  const [variants, setVariants] = useDraftField(form, 'variants');

  function update(i: number, patch: Partial<(typeof tests)[number]>): void {
    setTests(tests.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }
  function remove(i: number): void {
    const gone = tests[i];
    setTests(tests.filter((_, j) => j !== i));
    if (gone) {
      // A variant override for a slot that no longer exists would be orphaned.
      setVariants(
        variants.map((v) => ({
          ...v,
          overrides: v.overrides.filter((o) => o.testCaseId !== gone.id),
        })),
      );
    }
  }
  const total = tests.reduce((sum, t) => sum + (Number.isFinite(t.weight) ? t.weight : 0), 0);

  return (
    <div className="space-y-4">
      <Alert tone="info">
        <strong>Visible</strong> tests are shown to candidates as samples. <strong>Hidden</strong>{' '}
        tests are used only for grading and never leave the server. Variants can replace a
        slot&apos;s input and expected output on the Variants tab; the weight and the hidden flag
        stay the same for every variant.
      </Alert>
      {tests.length > 0 && !hasVisibleSample(tests) ? (
        <Alert tone="warning" role="status">
          No test is visible yet. Candidates will see no sample. Untick &quot;Hidden&quot; on at
          least one test.
        </Alert>
      ) : null}
      {tests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tests yet. Add the first one.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Test cases</caption>
            <thead className="border-b bg-muted/60">
              <tr>
                <th scope="col" className="px-3 py-2">
                  #
                </th>
                <th scope="col" className="px-3 py-2">
                  Input
                </th>
                <th scope="col" className="px-3 py-2">
                  Expected output
                </th>
                <th scope="col" className="px-3 py-2">
                  Hidden
                </th>
                <th scope="col" className="px-3 py-2">
                  Weight
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t, i) => {
                const weightError = errorAt(form, `testCases.${i}.weight`);
                return (
                  <tr key={t.id} className="border-b align-top last:border-0">
                    <td className="px-3 py-2">{i + 1}</td>
                    <td className="px-3 py-2">
                      <Textarea
                        aria-label={`Input of test ${i + 1}`}
                        className="min-h-20 min-w-48 font-mono"
                        value={t.input}
                        disabled={readOnly}
                        onChange={(e) => update(i, { input: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Textarea
                        aria-label={`Expected output of test ${i + 1}`}
                        className="min-h-20 min-w-48 font-mono"
                        value={t.expectedOutput}
                        disabled={readOnly}
                        onChange={(e) => update(i, { expectedOutput: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={t.isHidden}
                          disabled={readOnly}
                          onChange={(e) => update(i, { isHidden: e.target.checked })}
                        />
                        <span className="sr-only">{`Test ${i + 1} is`}</span>
                        <Badge tone={t.isHidden ? 'neutral' : 'success'}>
                          {t.isHidden ? 'Hidden' : 'Visible'}
                        </Badge>
                      </label>
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        aria-label={`Weight of test ${i + 1}`}
                        aria-invalid={Boolean(weightError)}
                        aria-describedby={weightError ? `tc-${i}-weight-error` : undefined}
                        type="number"
                        step="any"
                        className="w-24"
                        value={Number.isNaN(t.weight) ? '' : t.weight}
                        disabled={readOnly}
                        onChange={(e) => update(i, { weight: e.target.valueAsNumber })}
                      />
                      {weightError ? (
                        <p
                          id={`tc-${i}-weight-error`}
                          role="alert"
                          className="mt-1 text-sm text-destructive"
                        >
                          {weightError}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {readOnly ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove test ${i + 1}`}
                          onClick={() => remove(i)}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {readOnly ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setTests([
                ...tests,
                {
                  id: newId('tc'),
                  input: '',
                  expectedOutput: '',
                  isHidden: tests.length > 0,
                  weight: 1,
                },
              ])
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add test case
          </Button>
        )}
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {tests.length} {tests.length === 1 ? 'test' : 'tests'}, total weight {total}
        </p>
      </div>
    </div>
  );
}
