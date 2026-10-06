'use client';
import Link from 'next/link';
import * as React from 'react';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/features/admin/format';
import { PageHeader } from '@/features/admin/page-header';
import { RequireRole } from '@/features/auth/require-role';
import { rolesWith } from '@/features/staff/permissions';
import { PROFILE_LABEL } from './labels';
import { useTests, type TestSummary } from './queries';
import { NewTestButton } from './test-pages';

export function TestsPage(): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('test:read')}>
      <TestsContent />
    </RequireRole>
  );
}

function TestsContent(): React.JSX.Element {
  const tests = useTests();
  const columns: Column<TestSummary>[] = [
    {
      id: 'name',
      header: 'Test',
      sortValue: (t) => t.name.toLowerCase(),
      searchValue: (t) => `${t.name} ${t.description ?? ''}`,
      cell: (t) => (
        <Link
          href={`/admin/tests/${t.id}`}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t.name}
        </Link>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      sortValue: (t) => t.durationMinutes,
      cell: (t) => `${t.durationMinutes} min`,
    },
    {
      id: 'profile',
      header: 'Proctoring',
      sortValue: (t) => t.profile,
      facet: {
        label: 'Proctoring',
        value: (t) => t.profile,
        options: Object.entries(PROFILE_LABEL).map(([value, label]) => ({ value, label })),
      },
      cell: (t) => PROFILE_LABEL[t.profile],
    },
    {
      id: 'content',
      header: 'Content',
      sortValue: (t) => t.questionCount,
      searchValue: () => '',
      cell: (t) =>
        `${t.sectionCount} section${t.sectionCount === 1 ? '' : 's'}, ${t.questionCount} question${t.questionCount === 1 ? '' : 's'}`,
    },
    {
      id: 'pass',
      header: 'Pass score',
      sortValue: (t) => t.passScore,
      searchValue: () => '',
      cell: (t) =>
        t.passScore === null ? <span className="text-muted-foreground">—</span> : t.passScore,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (t) => (t.used ? 1 : 0),
      searchValue: () => '',
      facet: {
        label: 'Status',
        value: (t) => (t.used ? 'used' : 'open'),
        options: [
          { value: 'open', label: 'Can be edited' },
          { value: 'used', label: 'In use' },
        ],
      },
      cell: (t) => (
        <Badge tone={t.used ? 'neutral' : 'success'}>{t.used ? 'In use' : 'Can be edited'}</Badge>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      sortValue: (t) => t.createdAt,
      searchValue: () => '',
      cell: (t) => formatDate(t.createdAt),
    },
  ];
  return (
    <>
      <PageHeader
        title="Tests"
        description="A test is a template: ordered sections of questions with a duration and a proctoring profile. Once candidates are invited, a test can no longer be edited; build a new one from it."
      />
      <DataTable
        caption="Tests"
        searchLabel="Search tests"
        columns={columns}
        rows={tests.isError ? undefined : tests.data}
        getRowId={(t) => t.id}
        isLoading={tests.isPending}
        error={
          tests.isError
            ? {
                title: 'We could not load the tests',
                hint: 'Check your connection, then try again.',
                onRetry: () => void tests.refetch(),
              }
            : null
        }
        defaultSort={{ columnId: 'created', direction: 'desc' }}
        empty={{
          title: 'No tests yet',
          hint: 'Create the first test from published questions.',
          action: <NewTestButton />,
        }}
        toolbar={<NewTestButton />}
      />
    </>
  );
}
