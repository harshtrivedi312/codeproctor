'use client';
import { useMutation } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from './api';
import { terminalForConflict } from './problems';
import { StepFrame } from './step-frame';
import type { Terminal } from './terminal-screens';

/**
 * Start hands over to the test screen in the SAME document (FU-FEB-10, option (c)): the candidate
 * session token stays in memory and nothing is written to storage or a URL. /t/link is the one
 * route whose CSP allows WebAssembly (P-17), but the document that runs the test is the one
 * /t/start loaded (the hand-off is a client-side navigation), so today the allowance does not
 * apply; the in-browser detectors are placeholders (DETECTOR_UNAVAILABLE). See FU-FEB-67.
 */

const DONE_ITEMS = [
  'You signed the consent document',
  'Your computer passed the system check',
  'Your identity photos were received',
  'Your room scan was received',
];

type StartResult = Awaited<ReturnType<typeof candidateApi.startTest>>;
/** A resumed test makes no start call. */
type StartOutcome = StartResult | { ok: true; resumed: true };

/** What the candidate reads when the start did not go through (null: nothing to show). */
function messageFor(result: StartOutcome): string | null {
  if (result.ok) return null;
  if (result.kind !== 'problem') {
    return 'We could not start. Check your internet connection and press the button again.';
  }
  switch (result.status) {
    case 401:
      return null; // the session ended: the flow shows its own screen
    case 409:
      return result.code === 'RANDOM_RULE_UNSATISFIABLE'
        ? 'This test could not be set up for you. Please contact the person who invited you.'
        : 'Some earlier steps are not finished yet. Reload this page, open your link again and finish the steps in order.';
    case 429:
      return `Please wait ${result.retryAfterSeconds ?? 10} seconds and press the button again.`;
    default:
      return 'The service had a problem. Wait a minute and press the button again.';
  }
}

export function StartStep({
  resuming,
  onStarted,
  onSessionEnded,
  onTerminal,
}: {
  resuming: boolean;
  onStarted: () => void;
  onSessionEnded: () => void;
  onTerminal: (terminal: Terminal) => void;
}): React.JSX.Element {
  // Guards a double click before React has re-rendered the disabled button.
  const sent = React.useRef(false);
  const start = useMutation({
    mutationFn: async (): Promise<StartOutcome> =>
      resuming ? ({ ok: true, resumed: true } as const) : candidateApi.startTest(),
    onError: () => {
      sent.current = false;
    },
    onSuccess: (result) => {
      if (result.ok) {
        onStarted(); // a started test is never started twice: the guard stays set
        return;
      }
      sent.current = false;
      if (result.kind !== 'problem') return;
      if (result.status === 401) onSessionEnded();
      // A link that has expired (or is used up) ends the flow with its own screen.
      else if (result.status === 409 && result.code && result.code.startsWith('LINK_')) {
        onTerminal(terminalForConflict(result.code));
      }
    },
  });
  const problem = start.isError
    ? 'We could not start. Check your internet connection and press the button again.'
    : start.data
      ? messageFor(start.data)
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
      <Button
        size="lg"
        className="min-h-11"
        disabled={start.isPending}
        onClick={() => {
          if (sent.current) return;
          sent.current = true;
          start.mutate();
        }}
      >
        {start.isPending ? 'Starting...' : resuming ? 'Continue my test' : 'Start the test'}
      </Button>
    </StepFrame>
  );
}
