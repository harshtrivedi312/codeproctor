'use client';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { candidateApi } from '@/features/candidate-flow/api';
import type { Schemas } from '@/lib/api/client';
import type { ProctorBridge } from './proctor/bridge';
import { withRetry } from './proctor/retry';
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
    void withRetry(() => candidateApi.getConsent()).then((r) => {
      if (!alive) return;
      setConsent({ at: r.ok && r.data.signed ? r.data.signedAt : null });
    });
    return () => {
      alive = false;
    };
  }, []);

  // The controller lives in a ref, outside the effect: the key is issued once per epoch (ADR 0013
  // section 4), so a second controller (React StrictMode runs effects twice in development, and a
  // remount would too) would burn the key and end the test with KEY_ALREADY_ISSUED. The stop on
  // cleanup is deferred one tick and cancelled if the effect runs again straight away.
  // Fixed for the life of this screen. Null (no session id in the token, outside mock mode) means
  // the test does not start and the candidate is sent back to the link.
  const [sessionId] = React.useState(() => sessionIdFromToken());
  const controllerRef = React.useRef<ProctorController | null>(null);
  const stopTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The test screen says when the section on screen is finished, so a heartbeat does not write the
  // next section's deadline into it.
  const sectionFinished = React.useRef(false);

  React.useEffect(() => {
    if (typeof consentAt !== 'string') return undefined;
    if (sessionId === null) return undefined;
    if (stopTimer.current !== null) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    if (controllerRef.current === null) {
      const c = new ProctorController({
        consentRecordedAt: consentAt,
        sessionId,
        ...(timing ?? {}),
        root: document.getElementById('main') ?? document.body,
        onHeartbeat: (s, hb) => {
          // The server clock corrects the countdown, and the deadlines it reports (a proctor pause
          // adds its credit on resume, ADR 0002 P-3) replace the ones on screen.
          clockSync.current?.(s.serverTime, hb.startedAt, hb.endedAt);
          queryClient.setQueryData<Schemas['CandidateSession']>(['candidate-session'], (old) =>
            old
              ? {
                  ...old,
                  testDeadlineAt: s.deadlineAt ?? old.testDeadlineAt,
                  section: {
                    ...old.section,
                    deadlineAt: sectionFinished.current
                      ? old.section.deadlineAt
                      : (s.sectionDeadlineAt ?? old.section.deadlineAt),
                  },
                }
              : old,
          );
        },
      });
      controllerRef.current = c;
      setController(c);
      void c.init();
    }
    return () => {
      const c = controllerRef.current;
      stopTimer.current = setTimeout(() => {
        void c?.stop();
        if (controllerRef.current === c) controllerRef.current = null;
        stopTimer.current = null;
      }, 0);
    };
  }, [consentAt, sessionId, queryClient, timing]);

  const state = React.useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIBE,
    controller?.getState ?? IDLE,
    IDLE,
  );

  const needsNewCode =
    consentAt === null ||
    sessionId === null ||
    state.endedBecause === 'reauth' ||
    state.endedBecause === 'key';
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
      onSectionFinishedChange={(finished) => {
        sectionFinished.current = finished;
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
    <div className="mx-auto my-24 max-w-md px-4 text-center" data-testid="test-inactive">
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
    </div>
  );
}
