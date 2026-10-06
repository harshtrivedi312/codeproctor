'use client';
import Link from 'next/link';
import * as React from 'react';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/features/admin/format';
import { PageHeader } from '@/features/admin/page-header';
import { ApiFailure } from '@/features/admin/queries';
import { RequireRole } from '@/features/auth/require-role';
import { rolesWith } from '@/features/staff/permissions';
import type { Schemas } from '@/lib/api/client';
import { TYPE_LABEL } from './labels';
import { QuestionEditor } from './question-editor';
import { QuestionSummary } from './question-summary';
import { isFullQuestion, useQuestion, useQuestionVersion, useQuestionVersions } from './queries';

function LoadError({ error }: { error: unknown }): React.JSX.Element {
  const notFound = error instanceof ApiFailure && error.status === 404;
  return (
    <Alert
      tone="error"
      role="alert"
      title={notFound ? 'This question does not exist' : 'We could not load the question'}
    >
      {notFound ? 'It may have been removed. ' : 'Check your connection and reload the page. '}
      <Link href="/admin/questions" className="underline">
        Back to the question bank
      </Link>
    </Alert>
  );
}

const Loading = () => (
  <p role="status" className="text-sm text-muted-foreground">
    Loading the question…
  </p>
);

/** /admin/questions/[id]: edit the current version (Authors and Super Admins). */
export function QuestionEditorRoute({
  id,
  pollMs,
  maxPolls,
}: {
  id: string;
  pollMs?: number;
  maxPolls?: number;
}): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('question:read')}>
      <EditorLoader id={id} {...(pollMs ? { pollMs } : {})} {...(maxPolls ? { maxPolls } : {})} />
    </RequireRole>
  );
}

function EditorLoader({
  id,
  pollMs,
  maxPolls,
}: {
  id: string;
  pollMs?: number;
  maxPolls?: number;
}): React.JSX.Element {
  const question = useQuestion(id);
  if (question.isPending) return <Loading />;
  if (question.isError) return <LoadError error={question.error} />;
  // The API decides: a caller without question:update gets the allowlisted view, and that is
  // all this screen can show (no editor).
  if (!isFullQuestion(question.data)) return <SummaryPage data={question.data} />;
  return (
    <>
      <p className="mb-3 text-sm">
        <Link
          href={`/admin/questions/${id}/versions`}
          className="text-primary underline underline-offset-4"
        >
          Version history
        </Link>
      </p>
      <QuestionEditor
        key={id}
        mode="edit"
        detail={question.data}
        {...(pollMs ? { pollMs } : {})}
        {...(maxPolls ? { maxPolls } : {})}
      />
    </>
  );
}

function SummaryPage({
  data,
}: {
  data: Parameters<typeof QuestionSummary>[0]['data'];
}): React.JSX.Element {
  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/admin/questions" className="text-primary underline underline-offset-4">
          Back to the question bank
        </Link>
      </p>
      <QuestionSummary data={data} />
    </>
  );
}

const TYPES: { type: Schemas['QuestionType']; hint: string }[] = [
  {
    type: 'CODING',
    hint: 'Candidates write code that runs against test cases. Supports variants.',
  },
  { type: 'MCQ', hint: 'Candidates pick from options. Scored automatically.' },
  {
    type: 'SHORT_ANSWER',
    hint: 'Candidates type a short answer. Matched automatically, else sent to a reviewer.',
  },
];

/** /admin/questions/new: pick a type, then fill the editor. The type cannot change later. */
export function NewQuestionRoute(): React.JSX.Element {
  const [type, setType] = React.useState<Schemas['QuestionType'] | null>(null);
  return (
    <RequireRole roles={rolesWith('question:create')}>
      {type === null ? (
        <>
          <PageHeader
            title="New question"
            description="What kind of question is it? You cannot change this later."
          />
          <ul className="grid max-w-3xl gap-3 md:grid-cols-3">
            {TYPES.map((t) => (
              <li key={t.type} className="rounded-md border bg-card p-4">
                <h2 className="font-medium">{TYPE_LABEL[t.type]}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t.hint}</p>
                <Button type="button" className="mt-3" onClick={() => setType(t.type)}>
                  {`Create a ${TYPE_LABEL[t.type].toLowerCase()} question`}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <QuestionEditor key={type} mode="create" type={type} />
      )}
    </RequireRole>
  );
}

type VersionRow = Schemas['QuestionVersionSummary'];

/** /admin/questions/[id]/versions: FR-204 version history. */
export function QuestionVersionsRoute({ id }: { id: string }): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('question:update')}>
      <VersionsContent id={id} />
    </RequireRole>
  );
}

function VersionsContent({ id }: { id: string }): React.JSX.Element {
  const versions = useQuestionVersions(id);
  const columns = React.useMemo<Column<VersionRow>[]>(
    () => [
      {
        id: 'version',
        header: 'Version',
        sortValue: (v) => v.version,
        cell: (v) => (
          <Link
            href={`/admin/questions/${id}/versions/${v.version}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Version {v.version}
          </Link>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        sortValue: (v) => (v.isPublished ? 1 : 0),
        cell: (v) => (
          <Badge tone={v.isPublished ? 'success' : 'warning'}>
            {v.isPublished ? 'Published' : 'Draft'}
          </Badge>
        ),
      },
      {
        id: 'created',
        header: 'Saved',
        sortValue: (v) => v.createdAt,
        cell: (v) => formatDate(v.createdAt),
      },
      { id: 'by', header: 'By', sortValue: (v) => v.createdByName, cell: (v) => v.createdByName },
      {
        id: 'validated',
        header: 'Validated',
        sortValue: (v) => v.validatedAt,
        cell: (v) => (v.validatedAt ? formatDate(v.validatedAt) : 'Not validated'),
      },
    ],
    [id],
  );
  return (
    <>
      <PageHeader
        title="Version history"
        description="Published versions never change. Past attempts keep the version they were given."
      />
      <p className="mb-3 text-sm">
        <Link href={`/admin/questions/${id}`} className="text-primary underline underline-offset-4">
          Back to the editor
        </Link>
      </p>
      <DataTable
        caption="Versions"
        columns={columns}
        rows={versions.data}
        getRowId={(v) => String(v.version)}
        isLoading={versions.isPending}
        error={
          versions.isError
            ? {
                title: 'We could not load the versions',
                hint: 'Check your connection, then try again.',
                onRetry: () => void versions.refetch(),
              }
            : null
        }
        empty={{ title: 'No versions' }}
        defaultSort={{ columnId: 'version', direction: 'desc' }}
        searchLabel="Search versions"
      />
    </>
  );
}

/** /admin/questions/[id]/versions/[version]: an older version, read-only. */
export function QuestionVersionRoute({
  id,
  version,
}: {
  id: string;
  version: number;
}): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('question:read')}>
      <VersionLoader id={id} version={version} />
    </RequireRole>
  );
}

function VersionLoader({ id, version }: { id: string; version: number }): React.JSX.Element {
  const data = useQuestionVersion(id, version);
  if (data.isPending) return <Loading />;
  if (data.isError) return <LoadError error={data.error} />;
  if (!isFullQuestion(data.data)) return <SummaryPage data={data.data} />;
  return (
    <>
      <p className="mb-3 text-sm">
        <Link
          href={`/admin/questions/${id}/versions`}
          className="text-primary underline underline-offset-4"
        >
          Back to the version history
        </Link>
      </p>
      <QuestionEditor key={`${id}-${version}`} mode="view" detail={data.data} />
    </>
  );
}
