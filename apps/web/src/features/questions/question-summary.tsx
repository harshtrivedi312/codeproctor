import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/features/admin/page-header';
import { DIFFICULTY_LABEL, STATUS_LABEL, TYPE_LABEL } from './labels';
import { MarkdownPreview } from './markdown-preview';
import type { RedactedQuestion } from './queries';

/**
 * The read-only summary a reader without question:update gets (DL-32): what the API's allowlisted
 * view carries and nothing else. There is no editor and no Save, Validate or Publish. The API
 * decides what is in the payload; this screen only shows it.
 */
export function QuestionSummary({ data }: { data: RedactedQuestion }): React.JSX.Element {
  return (
    <>
      <PageHeader title={data.title} />
      <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{TYPE_LABEL[data.type]}</span>
        <span>{DIFFICULTY_LABEL[data.difficulty]}</span>
        <span>Version {data.version}</span>
        <Badge tone={data.status === 'PUBLISHED' ? 'success' : 'warning'}>
          {STATUS_LABEL[data.status]}
        </Badge>
        {data.tags.length > 0 ? <span>Tags: {data.tags.join(', ')}</span> : null}
      </p>
      <Alert tone="info" role="status" className="mb-4">
        You can see the statement and the visible sample cases. The rest of this question (reference
        solutions, answer key, hidden tests, variants and validation results) is hidden for your
        role.
      </Alert>
      <section aria-labelledby="summary-statement" className="mb-6 space-y-2">
        <h2 id="summary-statement" className="font-medium">
          Statement
        </h2>
        <div className="rounded-md border bg-card p-4" data-testid="summary-statement">
          <MarkdownPreview>{data.statementMd}</MarkdownPreview>
        </div>
      </section>
      <section aria-labelledby="summary-samples" className="space-y-2">
        <h2 id="summary-samples" className="font-medium">
          Sample test cases
        </h2>
        {data.sampleTestCases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No visible sample cases.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Visible sample test cases</caption>
              <thead className="border-b bg-muted/60">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Sample
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Input
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Expected output
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.sampleTestCases.map((t, i) => (
                  <tr key={i} className="border-b align-top last:border-0">
                    <td className="px-3 py-2">{i + 1}</td>
                    <td className="px-3 py-2">
                      <pre className="whitespace-pre-wrap font-mono">{t.input}</pre>
                    </td>
                    <td className="px-3 py-2">
                      <pre className="whitespace-pre-wrap font-mono">{t.expectedOutput}</pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
