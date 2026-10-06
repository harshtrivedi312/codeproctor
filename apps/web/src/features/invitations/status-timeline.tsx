import * as React from 'react';
import { formatDate } from '@/features/admin/format';
import { Badge } from '@/components/ui/badge';
import type { Schemas } from '@/lib/api/client';

type Status = Schemas['SessionStatus'];
type Step = Schemas['StatusStep'];

/*
 * The status timeline of one invitation (FR-303, ADR 0002 state machine). Status and times only:
 * a recruiter sees results after the verdict, never scores or flags (owner decision C-28), so
 * GRADED and UNDER_REVIEW are one "In review" step: telling them apart would hint at the risk
 * band. Provisional for the API ([BE-06b]).
 */

type Key =
  | 'INVITED'
  | 'OPENED'
  | 'CONSENTED'
  | 'VERIFIED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'COMPLETED';

const STEPS: { key: Key; label: string; description: string; from: readonly Status[] }[] = [
  {
    key: 'INVITED',
    label: 'Invited',
    description: 'The invitation exists and the link works inside the window.',
    from: ['INVITED'],
  },
  {
    key: 'OPENED',
    label: 'Link opened',
    description: 'The candidate opened the link and entered the email code.',
    from: ['OPENED'],
  },
  {
    key: 'CONSENTED',
    label: 'Consent signed',
    description: 'The candidate read and signed the consent document.',
    from: ['CONSENTED'],
  },
  {
    key: 'VERIFIED',
    label: 'Ready to start',
    description: 'The system check, the identity step and the room scan are done.',
    from: ['VERIFIED'],
  },
  {
    key: 'IN_PROGRESS',
    label: 'Taking the test',
    description: 'The candidate started. The clock is running.',
    from: ['IN_PROGRESS', 'PAUSED'],
  },
  {
    key: 'SUBMITTED',
    label: 'Submitted',
    description: 'The test was handed in, or its time ran out.',
    from: ['SUBMITTED'],
  },
  {
    key: 'IN_REVIEW',
    label: 'In review',
    description: 'A person reviews every session. Results appear here after the verdict.',
    from: ['GRADED', 'UNDER_REVIEW'],
  },
  {
    key: 'COMPLETED',
    label: 'Completed',
    description: 'The review is finished and the verdict is set.',
    from: ['COMPLETED', 'APPEALED'],
  },
];

const POSITION: Partial<Record<Status, number>> = {
  INVITED: 0,
  OPENED: 1,
  CONSENTED: 2,
  VERIFIED: 3,
  IN_PROGRESS: 4,
  PAUSED: 4,
  SUBMITTED: 5,
  GRADED: 6,
  UNDER_REVIEW: 6,
  COMPLETED: 7,
  APPEALED: 7,
};

export const STATUS_LABEL: Record<Status, string> = {
  INVITED: 'Invited',
  OPENED: 'Link opened',
  CONSENTED: 'Consent signed',
  VERIFIED: 'Ready to start',
  IN_PROGRESS: 'Taking the test',
  PAUSED: 'Paused',
  SUBMITTED: 'Submitted',
  GRADED: 'In review',
  UNDER_REVIEW: 'In review',
  COMPLETED: 'Completed',
  EXPIRED: 'Expired',
  APPEALED: 'Appeal open',
  DECLINED: 'Declined consent',
};

export const STATUS_TONE: Record<Status, 'neutral' | 'success' | 'warning' | 'error'> = {
  INVITED: 'neutral',
  OPENED: 'neutral',
  CONSENTED: 'neutral',
  VERIFIED: 'neutral',
  IN_PROGRESS: 'warning',
  PAUSED: 'warning',
  SUBMITTED: 'neutral',
  GRADED: 'neutral',
  UNDER_REVIEW: 'neutral',
  COMPLETED: 'success',
  EXPIRED: 'error',
  APPEALED: 'warning',
  DECLINED: 'error',
};

export interface TimelineItem {
  key: string;
  label: string;
  description: string;
  state: 'done' | 'current' | 'upcoming' | 'ended';
  at: string | null;
  note?: string;
}

/** The steps of an invitation from its status and the times of the statuses it has reached. */
export function timelineSteps(status: Status, history: readonly Step[]): TimelineItem[] {
  const timeOf = (from: readonly Status[]): string | null =>
    history.find((h) => from.includes(h.status))?.at ?? null;
  const terminal = status === 'EXPIRED' || status === 'DECLINED';
  const here = POSITION[status];
  const items: TimelineItem[] = [];
  STEPS.forEach((step, i) => {
    const at = timeOf(step.from);
    if (terminal) {
      // Only what actually happened, then the end.
      if (at !== null)
        items.push({
          key: step.key,
          label: step.label,
          description: step.description,
          state: 'done',
          at,
        });
      return;
    }
    const state = i < (here ?? -1) ? 'done' : i === here ? 'current' : 'upcoming';
    items.push({
      key: step.key,
      label: step.label,
      description: step.description,
      state,
      at,
      ...(state === 'current' && status === 'PAUSED'
        ? {
            note: 'Paused: the test is stopped for now and will carry on or end.',
          }
        : {}),
    });
  });
  if (status === 'APPEALED') {
    items.push({
      key: 'APPEALED',
      label: 'Appeal open',
      description: 'The candidate appealed the verdict. It is reviewed again.',
      state: 'current',
      at: timeOf(['APPEALED']),
    });
    const completed = items.find((x) => x.key === 'COMPLETED');
    if (completed) completed.state = 'done';
  }
  if (status === 'EXPIRED') {
    items.push({
      key: 'EXPIRED',
      label: 'Expired',
      description:
        'The window closed before the candidate started the test. Invite them again to give them another chance.',
      state: 'ended',
      at: timeOf(['EXPIRED']),
    });
  }
  if (status === 'DECLINED') {
    items.push({
      key: 'DECLINED',
      label: 'Declined consent',
      description:
        'The candidate declined the consent document. Nothing was recorded. Offer the alternatives or accommodations your organisation has.',
      state: 'ended',
      at: timeOf(['DECLINED']),
    });
  }
  return items;
}

const STATE_TEXT: Record<TimelineItem['state'], string> = {
  done: 'reached',
  current: 'current step',
  upcoming: 'not reached yet',
  ended: 'ended here',
};

export function StatusTimeline({
  status,
  history,
  label,
}: {
  status: Status;
  history: readonly Step[];
  /** Names the list for screen readers. */
  label: string;
}): React.JSX.Element {
  const items = timelineSteps(status, history);
  return (
    <ol aria-label={label} className="space-y-2" data-testid="status-timeline">
      {items.map((item) => (
        <li
          key={item.key}
          aria-current={item.state === 'current' ? 'step' : undefined}
          data-state={item.state}
          className="flex gap-3"
        >
          <span
            aria-hidden="true"
            className={
              item.state === 'done'
                ? 'mt-1.5 size-3 shrink-0 rounded-full bg-primary'
                : item.state === 'current'
                  ? 'mt-1.5 size-3 shrink-0 rounded-full border-2 border-primary bg-card ring-2 ring-primary/30'
                  : item.state === 'ended'
                    ? 'mt-1.5 size-3 shrink-0 rounded-full bg-destructive'
                    : 'mt-1.5 size-3 shrink-0 rounded-full border border-muted-foreground bg-card'
            }
          />
          <div className={item.state === 'upcoming' ? 'text-muted-foreground' : undefined}>
            <p className="text-sm font-medium">
              {item.label} <span className="sr-only">({STATE_TEXT[item.state]})</span>
              {item.state === 'current' ? <Badge tone="warning">Now</Badge> : null}
              {item.at ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  {formatDate(item.at)}
                </span>
              ) : null}
            </p>
            <p className="text-sm text-muted-foreground">{item.note ?? item.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
