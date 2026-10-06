'use client';
import { useMutation } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { mockingEnabled } from '@/lib/env';
import { candidateApi } from './api';
import { StepFrame } from './step-frame';

/**
 * Start hands over to the test screen in the SAME document (FU-FEB-10, option (c)): the candidate
 * session token stays in memory and nothing is written to storage or a URL. The cost is the CSP:
 * the document keeps the stepper's policy, which has no WebAssembly allowance (D-45 limits that to
 * /t/[token]/test), so the in-browser ML detectors cannot run and report DETECTOR_UNAVAILABLE.
 * Owner decision still open: extend the CSP allowance to /t/link, or pick option (a) or (b).
 *
 * Until the real backend serves the test routes, Start is only available with mocks on, where the
 * whole path works end to end.
 */
export const START_ENABLED: boolean = mockingEnabled;

const DONE_ITEMS = [
  'You signed the consent document',
  'Your computer passed the system check',
  'Your identity photos were received',
  'Your room scan was received',
];

export function StartStep({
  resuming,
  onStarted,
  onSessionEnded,
}: {
  resuming: boolean;
  onStarted: () => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const start = useMutation({
    mutationFn: async () => {
      // Never start the server clock when the test route cannot continue (see START_ENABLED).
      if (!START_ENABLED) return { ok: false, kind: 'network' } as const;
      return resuming ? ({ ok: true } as const) : candidateApi.startTest();
    },
    onSuccess: (result) => {
      if (result.ok) onStarted();
      else if (result.kind === 'problem' && result.status === 401) onSessionEnded();
    },
  });
  const result = start.data;
  const problem =
    start.isError || (result && !result.ok && result.kind !== 'problem')
      ? 'We could not start. Check your internet connection and press the button again.'
      : result && !result.ok && result.kind === 'problem' && result.status !== 401
        ? result.status === 409
          ? 'Some earlier steps are not finished yet. Reload this page, open your link again and finish the steps in order.'
          : 'The service had a problem. Wait a minute and press the button again.'
        : null;

  return (
    <StepFrame
      title={resuming ? 'Welcome back' : 'You are ready to start'}
      intro={
        resuming
          ? 'Your test is already running. The clock kept running while you were away. Continue where you left off.'
          : 'Read this before you press Start.'
      }
    >
      {!resuming ? (
        <ul className="space-y-2">
          {DONE_ITEMS.map((item) => (
            <li key={item} className="flex items-start gap-2">
              <Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0" />
              <span>
                {item}
                <span className="sr-only"> (done)</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <Alert tone="warning" title="Good to know">
        <ul className="list-disc space-y-1 pl-5">
          <li>The timer starts when you press the button, and it keeps running.</li>
          <li>The test opens in full-screen mode and asks you to share your entire screen.</li>
          <li>Close other apps and windows first. Keep your camera and microphone on.</li>
        </ul>
      </Alert>
      {problem ? (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      ) : null}
      {!START_ENABLED ? (
        <Alert
          tone="info"
          title="The test cannot be started from this page yet"
          data-testid="start-unavailable"
        >
          This step is not connected to the live test screen yet, so the timer cannot start. Nothing
          has been started and your progress is saved. Please contact your recruiter if you see this
          message.
        </Alert>
      ) : null}
      <Button
        size="lg"
        className="min-h-11"
        disabled={start.isPending || !START_ENABLED}
        onClick={() => start.mutate()}
      >
        {start.isPending ? 'Starting...' : resuming ? 'Continue my test' : 'Start the test'}
      </Button>
    </StepFrame>
  );
}
