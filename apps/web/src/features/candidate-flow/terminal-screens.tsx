'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { StepFrame } from './step-frame';
import { RETENTION_SCHEDULE_HREF } from './steps';

export type TerminalReason =
  | 'ALREADY_USED'
  | 'EXPIRED'
  | 'DECLINED'
  | 'BLOCKED'
  | 'NOT_YET_OPEN'
  | 'INVALID'
  | 'SESSION_ENDED'
  | 'UNAVAILABLE';

export interface Terminal {
  reason: TerminalReason;
  /** Recruiter contact for alternatives or accommodations (untrusted text, shown as plain text). */
  contact?: string | null;
  retryAfterSeconds?: number | null;
  windowStart?: string | undefined;
}

export function RetentionLink(): React.JSX.Element {
  return (
    <a className="underline underline-offset-4" href={RETENTION_SCHEDULE_HREF}>
      How long we keep your data (retention schedule)
    </a>
  );
}

function Contact({ contact }: { contact: string | null | undefined }): React.JSX.Element {
  return contact ? (
    <p>
      Your recruiter&apos;s contact: <strong data-testid="recruiter-contact">{contact}</strong>
    </p>
  ) : (
    <p>Please contact the person who invited you.</p>
  );
}

function minutes(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return 'a little while';
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? 'about a minute' : `about ${m} minutes`;
}

function formatWindow(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

/** End-of-road screens. Each says what happened and what to do next; none starts anything. */
export function TerminalScreen({ terminal }: { terminal: Terminal }): React.JSX.Element {
  switch (terminal.reason) {
    case 'ALREADY_USED':
      return (
        <StepFrame title="This link has already been used">
          <p>
            Each invitation link can be used for one test only, so there is nothing more to do here.
          </p>
          <p>
            If you think this is a mistake, contact your recruiter and ask for a new invitation.
          </p>
          <Contact contact={terminal.contact} />
        </StepFrame>
      );
    case 'EXPIRED':
      return (
        <StepFrame title="This invitation has expired">
          <p>The time window for this test has closed.</p>
          <p>Ask your recruiter for a new invitation if you still want to take the test.</p>
          <Contact contact={terminal.contact} />
        </StepFrame>
      );
    case 'NOT_YET_OPEN': {
      const when = formatWindow(terminal.windowStart);
      return (
        <StepFrame title="Your test window has not opened yet">
          <p>{when ? `You can start from ${when} (UTC).` : 'Please come back later.'}</p>
          <p>Open the same link from your invitation email then. Nothing was started.</p>
        </StepFrame>
      );
    }
    case 'BLOCKED':
      return (
        <StepFrame title="This link is paused for a short while">
          <Alert tone="warning">
            Too many wrong codes were entered. For your safety the link is paused for{' '}
            {minutes(terminal.retryAfterSeconds)}. Your recruiter has been told.
          </Alert>
          <p>
            Wait, then open the link from your invitation email again and ask for a new code. If you
            did not enter those codes, tell your recruiter.
          </p>
          <Contact contact={terminal.contact} />
        </StepFrame>
      );
    case 'DECLINED':
      return (
        <StepFrame title="You chose not to continue">
          <p>
            Nothing was recorded, and your camera, microphone and screen were never used. Declining
            is your right.
          </p>
          <p>
            If you would like an alternative, or you need an accommodation (for example because you
            cannot use a webcam, microphone or ID check), please get in touch. We handle every
            request individually.
          </p>
          <Contact contact={terminal.contact} />
          <p>
            <RetentionLink />
          </p>
        </StepFrame>
      );
    case 'SESSION_ENDED':
      return (
        <StepFrame title="Your session ended">
          <p>
            For your safety the session stops after a while without activity, or when you sign in
            somewhere else.
          </p>
          <p>
            To continue, open the link from your invitation email again and enter a new code. Your
            progress so far is kept.
          </p>
        </StepFrame>
      );
    case 'UNAVAILABLE':
      return (
        <StepFrame title="We cannot reach the test service right now">
          <p>
            This is usually temporary. Check your internet connection, wait a minute, and reload.
          </p>
          <p>
            For your safety this page does not keep your link. After reloading, open the link from
            your invitation email again.
          </p>
        </StepFrame>
      );
    case 'INVALID':
      return (
        <StepFrame title="We could not open this link">
          <p>
            The link may be incomplete, or this page was reloaded. For your safety the secret part
            of the link is removed from the address bar as soon as the page opens.
          </p>
          <p>
            Open the link from your invitation email again. If it still fails, contact your
            recruiter.
          </p>
        </StepFrame>
      );
  }
}
