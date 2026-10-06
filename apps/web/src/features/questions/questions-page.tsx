'use client';
import Link from 'next/link';
import * as React from 'react';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { PageHeader } from '@/features/admin/page-header';
import { formatDate } from '@/features/admin/format';
import { useAuth } from '@/features/auth/auth-provider';
import { RequireRole } from '@/features/auth/require-role';
import { can, rolesWith } from '@/features/staff/permissions';
import { DIFFICULTY_LABEL, STATUS_LABEL, TYPE_LABEL } from './labels';
import { statusOf, useQuestions, type QuestionStatus, type QuestionSummary } from './queries';

type Row = QuestionSummary;

/** The title, difficulty and status come from the version references (the list carries no content). */
const titleOf = (q: Row) => q.latest.title;
const difficultyOf = (q: Row) => (q.published ?? q.latest).difficulty;

const STATUS_TONE: Record<QuestionStatus, 'neutral' | 'success' | 'warning'> = {
  DRAFT: 'warning',
  PUBLISHED: 'success',
  ARCHIVED: 'neutral',
};

const facetOptions = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));

/** FR-201..FR-205: the question bank list with filters (tag, difficulty, type, status) and search. */
export function QuestionsPage(): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('question:read')}>
      <QuestionsContent />
    </RequireRole>
  );
}

function QuestionsContent(): React.JSX.Element {
  const { role } = useAuth();
  const editable = can(role, 'question:update');
  // Writers also list archived questions; the API never lists them for anyone else.
  const questions = useQuestions(editable);
  const [tag, setTag] = React.useState('');

  const tags = React.useMemo(
    () => [...new Set((questions.data ?? []).flatMap((q) => q.tags))].sort(),
    [questions.data],
  );
  const rows = React.useMemo(
    () => questions.data?.filter((q) => tag === '' || q.tags.includes(tag)),
    [questions.data, tag],
  );

  const columns = React.useMemo<Column<Row>[]>(
    () => [
      {
        id: 'title',
        header: 'Question',
        sortValue: (q) => titleOf(q).toLowerCase(),
        searchValue: (q) => `${titleOf(q)} ${q.slug} ${q.tags.join(' ')}`,
        // Every reader opens the question: writers get the editor, others the read-only summary.
        cell: (q) => (
          <Link
            href={`/admin/questions/${q.id}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {titleOf(q)}
          </Link>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        sortValue: (q) => q.type,
        facet: { label: 'Type', value: (q) => q.type, options: facetOptions(TYPE_LABEL) },
        cell: (q) => TYPE_LABEL[q.type],
      },
      {
        id: 'difficulty',
        header: 'Difficulty',
        sortValue: (q) => ['EASY', 'MEDIUM', 'HARD'].indexOf(difficultyOf(q)),
        facet: {
          label: 'Difficulty',
          value: (q) => difficultyOf(q),
          options: facetOptions(DIFFICULTY_LABEL),
        },
        cell: (q) => DIFFICULTY_LABEL[difficultyOf(q)],
      },
      {
        id: 'tags',
        header: 'Tags',
        cell: (q) => (
          <span className="text-muted-foreground">
            {q.tags.length > 0 ? q.tags.join(', ') : '—'}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        sortValue: (q) => statusOf(q),
        facet: { label: 'Status', value: (q) => statusOf(q), options: facetOptions(STATUS_LABEL) },
        cell: (q) => <Badge tone={STATUS_TONE[statusOf(q)]}>{STATUS_LABEL[statusOf(q)]}</Badge>,
      },
      {
        id: 'version',
        header: 'Version',
        sortValue: (q) => q.latest.version,
        cell: (q) => `v${q.latest.version}`,
      },
      {
        id: 'updated',
        header: 'Updated',
        sortValue: (q) => q.latest.createdAt,
        cell: (q) => formatDate(q.latest.createdAt),
      },
      ...(editable
        ? [
            {
              id: 'actions',
              header: 'History',
              cell: (q: Row) => (
                <Link
                  href={`/admin/questions/${q.id}/versions`}
                  className="text-primary underline-offset-4 hover:underline"
                  aria-label={`Version history of ${titleOf(q)}`}
                >
                  Versions
                </Link>
              ),
            },
          ]
        : []),
    ],
    [editable],
  );

  return (
    <>
      <PageHeader
        title="Question bank"
        description="Coding, multiple-choice and short-answer questions. Editing a published question creates a new version; past attempts keep the version they were given."
      />
      <DataTable
        caption="Questions"
        columns={columns}
        rows={rows}
        getRowId={(q) => q.id}
        isLoading={questions.isPending}
        error={
          questions.isError
            ? {
                title: 'We could not load the questions',
                hint: 'Check your connection, then try again.',
                onRetry: () => void questions.refetch(),
              }
            : null
        }
        empty={{
          title: 'No questions yet',
          hint: editable
            ? 'Create the first one to start building tests.'
            : 'Authors create questions.',
          ...(can(role, 'question:create')
            ? {
                action: (
                  <Button asChild>
                    <Link href="/admin/questions/new">New question</Link>
                  </Button>
                ),
              }
            : {}),
        }}
        searchLabel="Search by title, slug or tag"
        defaultSort={{ columnId: 'title', direction: 'asc' }}
        toolbar={
          <>
            <label className="flex items-center gap-2 text-sm">
              <span>Tag</span>
              <Select
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                aria-label="Filter by tag"
              >
                <option value="">All tags</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </label>
            {can(role, 'question:create') ? (
              <Button asChild>
                <Link href="/admin/questions/new">New question</Link>
              </Button>
            ) : null}
          </>
        }
      />
    </>
  );
}
