'use client';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { ConsentStep } from '@/features/consent/consent-step';
import type { IdentityDeps } from '@/features/identity/capture';
import { IdentityStep } from '@/features/identity/identity-step';
import type { SystemChecker } from '@/features/precheck/checks';
import { SystemCheckStep } from '@/features/precheck/system-check-step';
import { candidateApi } from './api';
import { OtpStep } from './otp-step';
import { terminalForConflict } from './problems';
import {
  captureInvitationToken,
  clearCandidateCredentials,
  clearInvitationToken,
  getInvitationToken,
  scrubTokenFromUrl,
  setSessionToken,
} from './session-store';
import { Stepper } from './step-frame';
import { stepForStatus, type StepId } from './steps';
import { StartStep } from './start-step';
import { TerminalScreen, type Terminal } from './terminal-screens';
import { WelcomeStep, terminalFromLinkState, type CodeSentInfo } from './welcome-step';
import type { LinkView, SessionTokenResponse } from './wire';

/**
 * The candidate pre-test stepper under /t/[token] (FR-401 to FR-403; ADR 0002, 0003, 0013).
 *
 * Credentials: the invitation token is read from the URL once, kept in memory, and the address bar
 * is rewritten at once, so it does not stay in the address bar, the history list or any later
 * Referer. It is sent only in POST bodies. The session token lives in memory only. A reload loses
 * both: the candidate opens the link again and enters a new code, which is what resuming means
 * (ADR 0002). Progress is the server's session status, so a candidate resumes at the right step.
 */
export interface FlowOverrides {
  checker?: SystemChecker;
  identity?: Partial<IdentityDeps>;
  navigate?: (path: string) => void;
}

export function CandidateFlow({
  token,
  overrides,
}: {
  token: string;
  /** Test seam: real browsers never pass this. */
  overrides?: FlowOverrides;
}): React.JSX.Element {
  const [terminal, setTerminal] = React.useState<Terminal | null>(null);
  const [step, setStep] = React.useState<StepId>('welcome');
  const [sent, setSent] = React.useState<CodeSentInfo | null>(null);
  const [resuming, setResuming] = React.useState(false);

  // False while rendering on the server, true in the browser. The token is only ever touched in
  // the browser: module state on the server would be shared between visitors.
  const inBrowser = React.useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  // Read the token, then take it out of the address bar and history straight away.
  React.useEffect(() => {
    captureInvitationToken(token);
    scrubTokenFromUrl();
    return () => {
      // Leaving the flow forgets everything held in memory.
      clearCandidateCredentials();
    };
  }, [token]);

  const link = useQuery({
    queryKey: ['candidate', 'link'],
    enabled: inBrowser,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      captureInvitationToken(token);
      const invitation = getInvitationToken();
      if (invitation === null)
        return {
          ok: false,
          kind: 'problem',
          status: 404,
          code: null,
          retryAfterSeconds: null,
        } as const;
      return candidateApi.resolveLink(invitation);
    },
  });

  const endSession = React.useCallback(() => {
    clearCandidateCredentials();
    setTerminal({ reason: 'SESSION_ENDED' });
  }, []);

  const finishWith = React.useCallback((t: Terminal) => {
    clearCandidateCredentials();
    setTerminal(t);
  }, []);

  const onVerified = React.useCallback((session: SessionTokenResponse) => {
    setSessionToken(session.sessionToken);
    clearInvitationToken();
    setResuming(session.status === 'IN_PROGRESS' || session.status === 'PAUSED');
    setStep(stepForStatus(session.status));
  }, []);

  const goTo = React.useCallback((next: StepId) => () => setStep(next), []);

  let body: React.JSX.Element;
  const result = link.data;
  const linkView: LinkView | null = result?.ok === true ? result.data : null;

  if (terminal) {
    body = <TerminalScreen terminal={terminal} />;
  } else if (!inBrowser || link.isPending) {
    body = (
      <p role="status" className="py-10 text-center">
        Opening your invitation...
      </p>
    );
  } else if (!result || !result.ok) {
    if (result && !result.ok && result.kind === 'problem' && result.status === 404) {
      body = <TerminalScreen terminal={{ reason: 'INVALID' }} />;
    } else if (result && !result.ok && result.kind === 'problem' && result.status === 409) {
      body = <TerminalScreen terminal={terminalForConflict(result.code)} />;
    } else {
      body = <TerminalScreen terminal={{ reason: 'UNAVAILABLE' }} />;
    }
  } else if (linkView && linkView.state !== 'OTP_REQUIRED') {
    body = (
      <TerminalScreen
        terminal={terminalFromLinkState(linkView.state, {
          contact: linkView.declineContact,
          retryAfterSeconds: linkView.retryAfterSeconds,
          windowStart: linkView.windowStart,
        })}
      />
    );
  } else if (linkView) {
    switch (step) {
      case 'welcome':
        body = (
          <WelcomeStep
            orgName={linkView.orgName}
            windowStart={linkView.windowStart}
            onCodeSent={(info) => {
              setSent(info);
              setStep('verify');
            }}
            onTerminal={finishWith}
          />
        );
        break;
      case 'verify':
        body = (
          <OtpStep
            sent={sent ?? { maskedEmail: null, cooldownSeconds: 30 }}
            windowStart={linkView.windowStart}
            onVerified={onVerified}
            onTerminal={finishWith}
          />
        );
        break;
      case 'consent':
        body = (
          <ConsentStep
            onSigned={goTo('check')}
            onDeclined={finishWith}
            onSessionEnded={endSession}
          />
        );
        break;
      case 'check':
        body = (
          <SystemCheckStep
            checker={overrides?.checker}
            onPassed={goTo('identity')}
            onSessionEnded={endSession}
          />
        );
        break;
      case 'identity':
        body = (
          <IdentityStep
            deps={overrides?.identity}
            onDone={goTo('start')}
            onSessionEnded={endSession}
          />
        );
        break;
      case 'start':
        body = (
          <StartStep
            resuming={resuming}
            {...(overrides?.navigate ? { navigate: overrides.navigate } : {})}
            onSessionEnded={endSession}
          />
        );
        break;
    }
  } else {
    body = <TerminalScreen terminal={{ reason: 'UNAVAILABLE' }} />;
  }

  return (
    <main id="main" className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
        <p className="font-semibold">CodeProctor</p>
        {linkView ? (
          <p className="text-sm text-muted-foreground" data-testid="org-name">
            {linkView.orgName}
          </p>
        ) : null}
      </header>
      {!terminal && linkView?.state === 'OTP_REQUIRED' ? <Stepper current={step} /> : null}
      {body}
    </main>
  );
}
