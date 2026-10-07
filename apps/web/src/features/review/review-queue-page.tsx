'use client';
import Link from 'next/link';
import * as React from 'react';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/features/admin/page-header';
import { RequireRole } from '@/features/auth/require-role';
import { rolesWith } from '@/features/staff/permissions';
import { DASH, formatDateTime, riskLabel, riskTone, type QueueItem } from './model';
import { useReviewQueue } from './queries';

const STATUS_LABEL: Record<string, string> = {
  GRADED: 'Graded',
  UNDER_REVIEW: 'Under review',
};
const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;

export function ReviewQueuePage(): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('review_queue:read')}>
      <QueueContent />
    </RequireRole>
  );
}

function QueueContent(): React.JSX.Element {
  const queue = useReviewQueue();
  const columns: Column<QueueItem>[] = [
    {
      id: 'candidate',
      header: 'Candidate',
      sortValue: (r) => r.candidateName.toLowerCase(),
      searchValue: (r) => `${r.candidateName} ${r.candidateEmail} ${r.testTitle}`,
      cell: (r) => (
        <Link
          href={`/admin/review/${r.sessionId}`}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {r.candidateName}
          <span className="sr-only"> ({r.testTitle})</span>
        </Link>
      ),
    },
    {
      id: 'test',
      header: 'Test',
      sortValue: (r) => r.testTitle.toLowerCase(),
      searchValue: () => '',
      cell: (r) => r.testTitle,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      searchValue: () => '',
      facet: {
        label: 'Status',
        value: (r) => r.status,
        options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
      },
      cell: (r) => <Badge>{statusLabel(r.status)}</Badge>,
    },
    {
      id: 'submitted',
      header: 'Submitted',
      sortValue: (r) => r.submittedAt,
      searchValue: () => '',
      cell: (r) => formatDateTime(r.submittedAt),
    },
    {
      id: 'risk',
      header: 'Risk score',
      sortValue: (r) => r.riskScore,
      searchValue: () => '',
      cell: (r) => <Badge tone={riskTone(r.riskScore)}>{riskLabel(r.riskScore)}</Badge>,
    },
    {
      id: 'flags',
      header: 'Flags',
      sortValue: (r) => r.flagCount,
      searchValue: () => '',
      cell: (r) => r.flagCount,
    },
    {
      id: 'pending',
      header: 'Manual answers pending',
      sortValue: (r) => r.pendingManualCount,
      searchValue: () => '',
      cell: (r) =>
        r.pendingManualCount > 0 ? (
          <Badge tone="warning">{r.pendingManualCount} to score</Badge>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Review queue"
        description="Sessions waiting for a reviewer. Open one to score short answers, read the proctoring timeline, play the recordings and set the verdict."
      />
      <DataTable
        caption="Sessions awaiting review"
        searchLabel="Search by candidate or test"
        columns={columns}
        rows={queue.isError ? undefined : queue.data}
        getRowId={(r) => r.sessionId}
        isLoading={queue.isPending}
        error={
          queue.isError
            ? {
                title: 'We could not load the review queue',
                hint: 'Check your connection, then try again.',
                onRetry: () => void queue.refetch(),
              }
            : null
        }
        defaultSort={{ columnId: 'submitted', direction: 'asc' }}
        empty={{
          title: 'Nothing is waiting for review',
          hint: 'Sessions appear here after grading when they need a person to look at them.',
        }}
      />
    </>
  );
}
