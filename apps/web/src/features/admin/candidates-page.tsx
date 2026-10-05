'use client';
import * as React from 'react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-provider';
import { RequireRole } from '@/features/auth/require-role';
import { can, rolesWith } from '@/features/staff/permissions';
import type { Schemas } from '@/lib/api/client';
import { ConfirmDialog } from './confirm-dialog';
import { formatDate } from './format';
import { PageHeader } from './page-header';
import { useCandidates, useRequestErasure } from './queries';

type Candidate = Schemas['CandidateSummary'];

const STATE_LABEL = {
  none: 'No request',
  waiting: 'Waiting for review or appeal',
  queued: 'Erasure scheduled',
  erased: 'Erased',
} as const;

function ErasureStatus({ candidate }: { candidate: Candidate }): React.JSX.Element {
  const { state, requestedAt, waitingFor } = candidate.erasure;
  if (state === 'waiting') {
    return (
      <div>
        <Badge tone="warning">Waiting for {waitingFor ?? 'review or appeal'}</Badge>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Requested {formatDate(requestedAt)}. It runs as soon as the{' '}
          {waitingFor ?? 'review or appeal'} closes. The candidate has been told.
        </p>
      </div>
    );
  }
  if (state === 'queued') {
    return (
      <div>
        <Badge tone="warning">{STATE_LABEL.queued}</Badge>
        <p className="mt-1 text-xs text-muted-foreground">
          Requested {formatDate(requestedAt)}. Completes within 30 days.
        </p>
      </div>
    );
  }
  if (state === 'erased') return <Badge tone="success">{STATE_LABEL.erased}</Badge>;
  return <span className="text-muted-foreground">{STATE_LABEL.none}</span>;
}

/**
 * Candidate list with the erasure action (NFR-05, D-19, TC-094). The full candidates page with
 * status timelines is Step 5 (FE-05); this step adds the list and the erase action.
 */
export function CandidatesPage(): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('invitation:create', 'candidate:erase')}>
      <CandidatesContent />
    </RequireRole>
  );
}

function CandidatesContent(): React.JSX.Element {
  const { role } = useAuth();
  const candidates = useCandidates();
  const erase = useRequestErasure();
  const [target, setTarget] = React.useState<Candidate | null>(null);
  const mayErase = can(role, 'candidate:erase');

  const columns: Column<Candidate>[] = [
    {
      id: 'name',
      header: 'Name',
      sortValue: (c) => c.name,
      cell: (c) => <span className="font-medium">{c.name}</span>,
    },
    { id: 'email', header: 'Email', sortValue: (c) => c.email, cell: (c) => c.email },
    {
      id: 'last',
      header: 'Last session',
      sortValue: (c) => c.lastSessionAt ?? null,
      searchValue: () => '',
      cell: (c) => formatDate(c.lastSessionAt),
    },
    {
      id: 'erasure',
      header: 'Data erasure',
      sortValue: (c) => STATE_LABEL[c.erasure.state],
      searchValue: (c) => STATE_LABEL[c.erasure.state],
      facet: {
        label: 'Erasure',
        value: (c) => c.erasure.state,
        options: [
          { value: 'none', label: 'No request' },
          { value: 'waiting', label: 'Waiting for review or appeal' },
          { value: 'queued', label: 'Scheduled' },
          { value: 'erased', label: 'Erased' },
        ],
      },
      cell: (c) => <ErasureStatus candidate={c} />,
    },
    ...(mayErase
      ? [
          {
            id: 'actions',
            header: 'Actions',
            cell: (c: Candidate) =>
              c.erasure.state === 'none' ? (
                <Button size="sm" variant="outline" onClick={() => setTarget(c)}>
                  Erase data<span className="sr-only"> for {c.name}</span>
                </Button>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          } satisfies Column<Candidate>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Candidates"
        description="Candidates and their data erasure state. Invitations and status timelines arrive in Step 5."
      />
      <DataTable
        caption="Candidates"
        searchLabel="Search candidates"
        columns={columns}
        rows={candidates.data}
        isLoading={candidates.isLoading}
        error={
          candidates.isError
            ? {
                title: 'We could not load the candidates',
                hint: 'Check your connection, then try again.',
                onRetry: () => void candidates.refetch(),
              }
            : null
        }
        getRowId={(c) => c.id}
        defaultSort={{ columnId: 'name', direction: 'asc' }}
        empty={{
          title: 'No candidates yet',
          hint: 'Candidates appear here after you invite them to a test.',
        }}
      />
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={`Erase data for ${target?.name ?? ''}?`}
        description={
          <>
            <p>
              This permanently removes their recordings, ID images, consent PDFs, code and answers.
              Only anonymised scores remain. It cannot be undone.
            </p>
            <p className="mt-2">
              If a review or appeal is open, erasure waits until it closes (when the hold is on in
              Settings) and the candidate is told.
            </p>
          </>
        }
        confirmLabel="Erase data"
        destructive
        pending={erase.isPending}
        onConfirm={() => {
          const c = target;
          if (!c) return;
          erase.mutate(c.id, {
            onSuccess: (updated) => {
              toast.success(
                updated.erasure.state === 'waiting'
                  ? `Erasure for ${c.name} is waiting for the open ${updated.erasure.waitingFor ?? 'review or appeal'} to close. They have been told.`
                  : `Erasure for ${c.name} is scheduled. It completes within 30 days.`,
              );
              setTarget(null);
            },
            onError: () => {
              toast.error('Could not request erasure. Try again in a moment.');
              setTarget(null);
            },
          });
        }}
      />
    </>
  );
}
