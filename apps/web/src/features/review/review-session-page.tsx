'use client';
import Link from 'next/link';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiFailure } from '@/features/admin/queries';
import { RequireRole } from '@/features/auth/require-role';
import { rolesWith } from '@/features/staff/permissions';
import { AnswersPanel } from './answers-panel';
import { formatDateTime, formatScore, riskLabel, riskTone, pendingCount } from './model';
import { useReviewSession } from './queries';
import { RecordingsPanel } from './recordings-panel';
import { TimelinePanel } from './timeline-panel';
import { VerdictPanel } from './verdict-panel';

export function ReviewSessionPage({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('review_session:read')}>
      <SessionContent sessionId={sessionId} />
    </RequireRole>
  );
}

function SessionContent({ sessionId }: { sessionId: string }): React.JSX.Element {
  const q = useReviewSession(sessionId);
  if (q.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the session…
      </p>
    );
  }
  if (q.isError) {
    const gone = q.error instanceof ApiFailure && q.error.status === 404;
    return (
      <Alert
        tone="error"
        role="alert"
        title={gone ? 'This session does not exist' : 'We could not load this session'}
      >
        {gone ? (
          'It may belong to another organisation.'
        ) : (
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            Try again
          </Button>
        )}{' '}
        <Link
          href="/admin/review"
          className="font-medium text-primary underline underline-offset-4"
        >
          Back to the review queue
        </Link>
      </Alert>
    );
  }
  const d = q.data;
  const pending = pendingCount(d);
  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm">
          <Link href="/admin/review" className="text-primary underline underline-offset-4">
            Review queue
          </Link>
        </p>
        <h1 className="mt-1 text-xl font-semibold">{d.candidate.name}</h1>
        <p className="text-sm text-muted-foreground">
          {d.candidate.email} · {d.test.title}
        </p>
        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <Badge>{d.session.status.replace(/_/g, ' ').toLowerCase()}</Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Total score</dt>
            <dd>
              {pending > 0 || d.session.totalScore === null
                ? 'Pending manual scoring'
                : formatScore(d.session.totalScore)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Risk score</dt>
            <dd>
              <Badge tone={riskTone(d.session.riskScore)}>{riskLabel(d.session.riskScore)}</Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Submitted</dt>
            <dd>{formatDateTime(d.session.submittedAt)}</dd>
          </div>
        </dl>
      </header>
      <AnswersPanel sessionId={d.session.id} answers={d.answers} />
      <TimelinePanel events={d.events} startedAt={d.session.startedAt} />
      <RecordingsPanel sessionId={d.session.id} recordings={d.recordings} />
      <VerdictPanel data={d} />
    </div>
  );
}
