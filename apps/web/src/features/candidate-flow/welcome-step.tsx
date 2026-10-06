'use client';
import { useMutation } from '@tanstack/react-query';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from './api';
import { terminalForConflict } from './problems';
import { getInvitationToken } from './session-store';
import { StepFrame } from './step-frame';
import { RetentionLink, type Terminal } from './terminal-screens';
import type { OtpSent } from './wire';

/** The server refuses a second code for 30 seconds (BE-07, OTP_COOLDOWN). */
export const OTP_RESEND_SECONDS = 30;

export interface CodeSentInfo {
  /** Null when the server did not say (a code was sent a moment ago). Untrusted text. */
  maskedEmail: string | null;
  cooldownSeconds: number;
}

export function terminalFromLinkState(
  state: Exclude<OtpSent['state'], 'OTP_SENT' | 'OTP_REQUIRED'>,
  extra: Pick<Terminal, 'contact' | 'retryAfterSeconds' | 'windowStart'>,
): Terminal {
  return { reason: state, ...extra };
}

/** FR-401 landing: rules, what is recorded, retention. Information only: no device access. */
export function WelcomeStep({
  orgName,
  windowStart,
  onCodeSent,
  onTerminal,
}: {
  orgName: string;
  windowStart: string;
  onCodeSent: (sent: CodeSentInfo) => void;
  onTerminal: (terminal: Terminal) => void;
}): React.JSX.Element {
  const send = useMutation({
    mutationFn: async () => {
      const token = getInvitationToken();
      if (token === null) return { ok: false, kind: 'network' } as const;
      return candidateApi.sendOtp(token);
    },
    onSuccess: (result) => {
      if (!result.ok) {
        if (result.kind !== 'problem') return;
        if (result.status === 429 && result.code === 'LINK_BLOCKED') {
          onTerminal({ reason: 'BLOCKED', retryAfterSeconds: result.retryAfterSeconds });
        } else if (result.status === 429) {
          // OTP_COOLDOWN: a code went out a moment ago, so go on and let the candidate enter it.
          onCodeSent({ maskedEmail: null, cooldownSeconds: result.retryAfterSeconds ?? 30 });
        } else if (result.status === 404) {
          onTerminal({ reason: 'INVALID' });
        } else if (result.status === 409) {
          onTerminal(terminalForConflict(result.code, windowStart));
        }
        return;
      }
      const sent = result.data;
      if (sent.state === 'OTP_SENT') {
        onCodeSent({ maskedEmail: sent.maskedEmail, cooldownSeconds: OTP_RESEND_SECONDS });
      } else if (sent.state !== 'OTP_REQUIRED') {
        onTerminal(
          terminalFromLinkState(sent.state, {
            contact: sent.declineContact,
            retryAfterSeconds: sent.retryAfterSeconds,
            windowStart,
          }),
        );
      }
    },
  });

  const problem =
    send.isError || (send.data && !send.data.ok && send.data.kind !== 'problem')
      ? 'We could not send the code. Check your internet connection and press the button again.'
      : send.data && !send.data.ok && send.data.status >= 500
        ? 'The service had a problem sending the code. Wait a minute and press the button again.'
        : null;

  return (
    <StepFrame
      title="Welcome to your proctored coding test"
      intro={`This test is run by ${orgName}. Please read this page, then we email you a one-time code to confirm it is you.`}
    >
      <div className="space-y-4">
        <section aria-labelledby="rules-h" className="space-y-2">
          <h2 id="rules-h" className="text-lg font-semibold">
            The rules
          </h2>
          <ul className="list-disc space-y-1 pl-6">
            <li>Take the test alone, in a quiet room, in Chrome or Edge on a computer.</li>
            <li>Share your whole screen and stay in full-screen mode.</li>
            <li>Keep your camera and microphone on for the whole test.</li>
            <li>Do not use other people, websites or AI tools, and do not paste code.</li>
          </ul>
        </section>
        <section aria-labelledby="rec-h" className="space-y-2">
          <h2 id="rec-h" className="text-lg font-semibold">
            What is recorded
          </h2>
          <p>
            Your screen, webcam and microphone, your typing in the code editor, and what your
            browser does during the test. We also check your identity with a photo of your ID and a
            selfie. A person reviews every test; software only raises flags and never decides
            anything.
          </p>
          <p className="font-medium">
            Nothing is recorded, and your camera, microphone and screen are not used, until you have
            read and signed the consent document in a later step.
          </p>
        </section>
        <section aria-labelledby="ret-h" className="space-y-2">
          <h2 id="ret-h" className="text-lg font-semibold">
            How long we keep it
          </h2>
          <p>
            Recordings and images are deleted after a set time (normally 90 days after your
            assessment is finished). Face images are never kept longer than 90 days.
          </p>
          <p>
            <RetentionLink />
          </p>
        </section>
        <section aria-labelledby="help-h" className="space-y-2">
          <h2 id="help-h" className="text-lg font-semibold">
            Need changes or help?
          </h2>
          <p>
            If you need extra time, assistive technology, or cannot use a webcam, microphone or ID
            check, tell your recruiter before you start. Every request is handled individually.
          </p>
        </section>
      </div>

      {problem ? (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      ) : null}
      <Button
        size="lg"
        className="min-h-11"
        onClick={() => send.mutate()}
        disabled={send.isPending}
        aria-disabled={send.isPending}
      >
        {send.isPending ? 'Sending your code...' : 'Email me a one-time code'}
      </Button>
    </StepFrame>
  );
}
