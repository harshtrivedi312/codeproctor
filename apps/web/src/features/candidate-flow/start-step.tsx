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
 * The test screen needs WebAssembly for the in-browser detectors, and only /t/[token]/test gets
 * the CSP that allows it (D-45, lib/csp.ts). A client-side router push would keep this page's CSP,
 * so entry is a full document navigation.
 *
 * Open question (ARC-03 part 2): a full navigation drops the in-memory session token, and the test
 * route has no transport for it yet. Nothing is written to storage here. See
 * docs/followups/frontend.md.
 */
export function testRoutePath(): string {
  // The segment is a placeholder: the real token never goes back into the address bar.
  return mockingEnabled ? '/t/demo/test' : '/t/session/test';
}

/**
 * Until ARC-03 part 2 decides how the candidate token reaches the test route (FU-FEB-10), a real
 * start would run the timer and then land on a page that cannot authenticate. So Start is only
 * available with mocks on, where the demo test screen takes over.
 */
export const START_ENABLED: boolean = mockingEnabled;

export function defaultNavigate(path: string): void {
  window.location.assign(path);
}

const DONE_ITEMS = [
  'You signed the consent document',
  'Your computer passed the system check',
  'Your identity photos were received',
];

export function StartStep({
  resuming,
  navigate = defaultNavigate,
  onSessionEnded,
}: {
  resuming: boolean;
  navigate?: (path: string) => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const start = useMutation({
    mutationFn: async () => {
      // Never start the server clock when the test route cannot continue (see START_ENABLED).
      if (!START_ENABLED) return { ok: false, kind: 'network' } as const;
      return resuming ? ({ ok: true } as const) : candidateApi.startTest();
    },
    onSuccess: (result) => {
      if (result.ok) navigate(testRoutePath());
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
