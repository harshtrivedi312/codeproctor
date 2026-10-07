'use client';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { formatDate } from '@/features/admin/format';
import { useCandidateInvitations } from './queries';
import { STATUS_LABEL, STATUS_TONE, StatusTimeline } from './status-timeline';

/**
 * Where each of a candidate's invitations stands, following the session states of ADR 0002.
 * WEB-ONLY and provisional [BE-06b]. C-28: only the stage is shown, never a score or a flag before
 * the verdict. The candidate id (not an email) is the only thing the request carries, and it is
 * fetched only while the dialog is open.
 */
export function CandidateTimelineDialog({
  candidate,
  onClose,
}: {
  candidate: { id: string; name: string } | null;
  onClose: () => void;
}): React.JSX.Element {
  const invitations = useCandidateInvitations(candidate?.id ?? null);
  return (
    <Dialog
      open={candidate !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
        <DialogTitle>Invitations for {candidate?.name ?? ''}</DialogTitle>
        <DialogDescription>
          The stage of each invitation. Scores and flags are not shown here; they appear once the
          review is complete.
        </DialogDescription>
        <div className="mt-4 space-y-6">
          {invitations.isLoading ? <p role="status">Loading invitations…</p> : null}
          {invitations.isError ? (
            <p role="alert" className="text-sm text-destructive">
              We could not load the invitations. Close this window and try again.
            </p>
          ) : null}
          {invitations.data?.length === 0 ? (
            <p className="text-sm">
              No invitations yet. Invite this candidate from the Tests page.
            </p>
          ) : null}
          {invitations.data?.map((inv) => (
            <section key={inv.id} aria-label={inv.testName} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{inv.testName}</h3>
                <Badge tone={STATUS_TONE[inv.status]}>{STATUS_LABEL[inv.status]}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Window {formatDate(inv.windowStart)} to {formatDate(inv.windowEnd)}
              </p>
              <StatusTimeline
                status={inv.status}
                history={inv.history}
                label={`Progress for ${inv.testName}`}
              />
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
