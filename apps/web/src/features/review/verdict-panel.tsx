'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiFailure } from '@/features/admin/queries';
import { useAuth } from '@/features/auth/auth-provider';
import { can } from '@/features/staff/permissions';
import {
  formatDateTime,
  VERDICT_LABEL,
  VERDICTS,
  type ReviewSession,
  type Verdict,
  pendingCount,
  verdictOf,
  isDecidable,
} from './model';
import { useSetVerdict } from './queries';

/** Pending answers are 409 in the contract; the code name is ASSUMED until the route exists. */
export const PENDING_CODE = 'MANUAL_PENDING';

function verdictError(e: unknown): string {
  if (e instanceof ApiFailure && e.status === 409) {
    if (e.code === 'VERDICT_ALREADY_SET') return 'A verdict is already set for this session.';
    if (e.code === 'SESSION_NOT_UNDER_REVIEW') {
      return 'This session is not under review right now. The page has been reloaded with its current status.';
    }
    if (e.code === PENDING_CODE) {
      return 'Some short answers still need scoring. Score them above, then set the verdict.';
    }
    return 'The session changed since you opened it. The page has been reloaded; check it and try again.';
  }
  if (e instanceof ApiFailure && e.status === 403) return 'Your role cannot set a verdict.';
  return 'The verdict was not saved. Check your connection and try again.';
}

export function VerdictPanel({ data }: { data: ReviewSession }): React.JSX.Element {
  const { role } = useAuth();
  const mutation = useSetVerdict(data.session.id);
  const [verdict, setVerdict] = React.useState<Verdict>('CLEAN');
  const [note, setNote] = React.useState('');
  const done = verdictOf(data);
  const pending = pendingCount(data);
  const blocked = pending > 0;
  const hintId = 'verdict-blocked';
  return (
    <section aria-labelledby="verdict-h" className="space-y-3">
      <h2 id="verdict-h" className="text-lg font-semibold">
        Verdict
      </h2>
      {done ? (
        <p className="text-sm">
          Verdict: <strong>{VERDICT_LABEL[done.verdict]}</strong>, set{' '}
          {formatDateTime(done.completedAt)}.{done.notes ? ` Note: ${done.notes}` : ''}
        </p>
      ) : !can(role, 'review_verdict:set') ? (
        <p className="text-sm text-muted-foreground">Your role cannot set a verdict.</p>
      ) : !isDecidable(data) ? (
        <p className="text-sm text-muted-foreground">
          A verdict can be set only while the session is under review. This session is{' '}
          {data.session.status.replace(/_/g, ' ').toLowerCase()}.
        </p>
      ) : (
        <form
          className="max-w-xl space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate({ verdict, ...(note.trim() ? { note: note.trim() } : {}) });
          }}
        >
          {blocked ? (
            <p id={hintId} className="text-sm text-muted-foreground">
              {pending} short answer{pending === 1 ? ' is' : 's are'} still waiting for a decision.
              Score {pending === 1 ? 'it' : 'them'} in the Answers section to enable the verdict.
            </p>
          ) : null}
          <Field id="verdict-select" label="Verdict">
            {(aria) => (
              <Select
                {...aria}
                value={verdict}
                disabled={blocked}
                aria-describedby={blocked ? hintId : undefined}
                onChange={(e) => setVerdict(e.target.value as Verdict)}
              >
                {VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {VERDICT_LABEL[v]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="verdict-note" label="Note (optional)">
            {(aria) => (
              <Textarea
                {...aria}
                className="min-h-16"
                maxLength={2000}
                disabled={blocked}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={blocked || mutation.isPending}>
            Set verdict
          </Button>
          {mutation.isError ? (
            <Alert tone="error" role="alert">
              {verdictError(mutation.error)}
            </Alert>
          ) : null}
        </form>
      )}
    </section>
  );
}
