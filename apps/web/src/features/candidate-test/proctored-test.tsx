'use client';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { candidateApi } from '@/features/candidate-flow/api';
import type { Schemas } from '@/lib/api/client';
import type { ProctorBridge } from './proctor/bridge';
import {
  ProctorController,
  initialProctorState,
  sessionIdFromToken,
  type ProctorUiState,
} from './proctor/controller';
import type { TestSource } from './source';
import { TestScreen } from './test-screen';

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
const IDLE = (): ProctorUiState => initialProctorState;

/**
 * The real test: the test screen with the proctor SDK wired in (ADR 0013). It needs the consent
 * time (D-17) before anything starts, so it reads the signed consent first; without a signature
 * nothing is started and the candidate is sent back to the link.
 */
export function ProctoredTest({
  source,
  onSubmitted,
  onSessionEnded,
  timing,
}: {
  source: TestSource;
  onSubmitted: () => void;
  onSessionEnded: () => void;
  /** Test seam: faster heartbeat and flush. Real code never passes it. */
  timing?: { heartbeatIntervalMs: number; flushIntervalMs: number; finishDrainMs?: number };
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [consent, setConsent] = React.useState<{ at: string | null } | null>(null);
  const consentAt = consent === null ? undefined : consent.at;
  const [controller, setController] = React.useState<ProctorController | null>(null);
  // Set when the test was submitted by the candidate: the server's "not active" that follows is
  // the normal end, not a problem, and must not replace the "submitted" page.
  const [submitted, setSubmitted] = React.useState(false);
  const clockSync = React.useRef<((iso: string, start: number, end: number) => void) | null>(null);

  React.useEffect(() => {
    let alive = true;
    void candidateApi.getConsent().then((r) => {
      if (!alive) return;
      setConsent({ at: r.ok && r.data.signed ? r.data.signedAt : null });
    });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    if (typeof consentAt !== 'string') return undefined;
    const c = new ProctorController({
      consentRecordedAt: consentAt,
      sessionId: sessionIdFromToken(),
      ...(timing ?? {}),
      root: document.getElementById('main') ?? document.body,
      onHeartbeat: (s, timing) => {
        // The server clock corrects the countdown, and the deadlines it reports (a proctor pause
        // adds its credit on resume, ADR 0002 P-3) replace the ones on screen.
        clockSync.current?.(s.serverTime, timing.startedAt, timing.endedAt);
        queryClient.setQueryData<Schemas['CandidateSession']>(['candidate-session'], (old) =>
          old
            ? {
                ...old,
                testDeadlineAt: s.deadlineAt ?? old.testDeadlineAt,
                section: {
                  ...old.section,
                  deadlineAt: s.sectionDeadlineAt ?? old.section.deadlineAt,
                },
              }
            : old,
        );
      },
    });
    // A fresh controller for each run of this effect (a stopped one cannot start again).
    setController(c);
    void c.init();
    return () => {
      void c.stop();
    };
  }, [consentAt, queryClient, timing]);

  const state = React.useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIBE,
    controller?.getState ?? IDLE,
    IDLE,
  );

  const needsNewCode =
    consentAt === null || state.endedBecause === 'reauth' || state.endedBecause === 'key';
  React.useEffect(() => {
    if (needsNewCode) onSessionEnded();
  }, [needsNewCode, onSessionEnded]);

  const bridge = React.useMemo<ProctorBridge | undefined>(
    () =>
      controller
        ? {
            state,
            shareScreen: () => controller.shareScreen(),
            enterFullscreen: () => controller.enterFullscreen(),
            startRecorders: () => controller.startRecorders(),
            clearNotice: () => controller.clearNotice(),
          }
        : undefined,
    [controller, state],
  );

  if (consentAt === undefined || !bridge) {
    return (
      <p role="status" className="p-8 text-center text-muted-foreground">
        Getting your test ready...
      </p>
    );
  }
  if (state.endedBecause === 'not-active' && !submitted) return <InactivePanel />;

  return (
    <TestScreen
      source={source}
      proctor={bridge}
      registerClockSync={(sync) => {
        clockSync.current = sync;
      }}
      onSubmitted={() => {
        setSubmitted(true);
        void controller?.finish().then(onSubmitted);
      }}
    />
  );
}

/** The server says the session is not active: submitted, expired or closed. No score, no detail. */
function InactivePanel(): React.JSX.Element {
  const ref = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <main id="main" className="mx-auto my-24 max-w-md px-4 text-center" data-testid="test-inactive">
      <h1 ref={ref} tabIndex={-1} className="text-2xl font-semibold outline-none">
        This test is no longer running
      </h1>
      <p className="mt-3">
        The test was submitted or its time ran out, so nothing more can be saved. The recording has
        stopped. You can close this window.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        If you think this is a mistake, tell the person who invited you.
      </p>
    </main>
  );
}
