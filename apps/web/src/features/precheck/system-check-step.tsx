'use client';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Check, X } from 'lucide-react';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from '@/features/candidate-flow/api';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import type { BlockingReason } from '@/features/candidate-flow/wire';
import {
  BrowserSystemChecker,
  type BrowserInfo,
  type CheckId,
  type CheckOutcome,
  type MicHandle,
  type ScreenShareKind,
  type SystemChecker,
} from './checks';
import { buildSystemCheckBody } from './system-check-body';
import type { MultiScreenResult } from '@codeproctor/proctor-sdk';

type RowState = { phase: 'idle' } | { phase: 'running' } | { phase: 'done'; outcome: CheckOutcome };

const ROWS: { id: CheckId; label: string; what: string; button: string }[] = [
  {
    id: 'browser',
    label: 'Browser',
    what: 'Chrome or Edge on a computer.',
    button: 'Check browser',
  },
  { id: 'camera', label: 'Camera', what: 'You should see yourself below.', button: 'Check camera' },
  {
    id: 'microphone',
    label: 'Microphone',
    what: 'Say a few words: the level bar should move.',
    button: 'Check microphone',
  },
  {
    id: 'screen',
    label: 'Screen sharing',
    what: 'Share your entire screen. The share is stopped right after this check.',
    button: 'Test screen sharing',
  },
  {
    id: 'fullscreen',
    label: 'Full screen',
    what: 'The page goes full screen for a moment and comes back.',
    button: 'Test full screen',
  },
  {
    id: 'monitor',
    label: 'Number of screens',
    what: 'Only one screen may be connected.',
    button: 'Check screens',
  },
  {
    id: 'network',
    label: 'Internet connection',
    what: 'Fast enough to upload the recording.',
    button: 'Check connection',
  },
];

const BLOCKING_TEXT: Record<BlockingReason, string> = {
  MULTI_MONITOR:
    'More than one screen was found. Unplug extra monitors and run "Check screens" again.',
  BROWSER_UNSUPPORTED:
    'Your browser is not supported. Use the latest Chrome or Edge on a computer.',
  SCREEN_SHARE_NOT_MONITOR:
    'You did not share your entire screen. Run "Test screen sharing" again and choose "Entire Screen".',
  DEVICE_MISSING: 'A camera or microphone is missing. Check both, then continue.',
};

const STATUS_TEXT = {
  idle: 'Not checked yet',
  running: 'Checking...',
  passed: 'Passed',
  warning: 'Passed with a note',
  failed: 'Needs attention',
} as const;

function StatusLabel({ state }: { state: RowState }): React.JSX.Element {
  const key = state.phase === 'done' ? state.outcome.status : state.phase;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium" data-status={key}>
      {key === 'passed' ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
      {key === 'warning' ? <AlertTriangle aria-hidden="true" className="h-4 w-4" /> : null}
      {key === 'failed' ? <X aria-hidden="true" className="h-4 w-4" /> : null}
      {STATUS_TEXT[key]}
    </span>
  );
}

/** FR-402 system check (TC-031, TC-032). Every failure explains the fix. Nothing is recorded. */
export function SystemCheckStep({
  checker: injected,
  onPassed,
  onSessionEnded,
}: {
  checker?: SystemChecker;
  onPassed: () => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const [checker] = React.useState<SystemChecker>(() => injected ?? new BrowserSystemChecker());
  // The browser check needs no permission and is instant; the network check starts on its own.
  const [initialBrowser] = React.useState(() => checker.browser());
  const [rows, setRows] = React.useState<Record<CheckId, RowState>>({
    browser: { phase: 'done', outcome: initialBrowser },
    camera: { phase: 'idle' },
    microphone: { phase: 'idle' },
    screen: { phase: 'idle' },
    fullscreen: { phase: 'idle' },
    monitor: { phase: 'idle' },
    network: { phase: 'running' },
  });
  const [browser, setBrowser] = React.useState<BrowserInfo | null>(initialBrowser);
  const [cameraStream, setCameraStream] = React.useState<MediaStream | null>(null);
  const [micLevel, setMicLevel] = React.useState(0);
  const [heardSound, setHeardSound] = React.useState(false);
  const [screenKind, setScreenKind] = React.useState<ScreenShareKind | null>(null);
  const [network, setNetwork] = React.useState<{ downlinkKbps: number; rttMs: number } | null>(
    null,
  );
  const [monitor, setMonitor] = React.useState<MultiScreenResult | null>(null);
  const [virtualCameraLabel, setVirtualCameraLabel] = React.useState<string | null>(null);
  const micHandle = React.useRef<MicHandle | null>(null);
  const cameraRef = React.useRef<MediaStream | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  const set = React.useCallback((id: CheckId, state: RowState) => {
    setRows((r) => ({ ...r, [id]: state }));
  }, []);

  React.useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = cameraStream;
  }, [cameraStream]);

  // Camera and microphone stop when the step closes. Nothing is recorded or kept.
  React.useEffect(
    () => () => {
      cameraRef.current?.getTracks().forEach((t) => t.stop());
      micHandle.current?.stop();
    },
    [],
  );

  const runBrowser = React.useCallback(() => {
    const result = checker.browser();
    setBrowser(result);
    set('browser', { phase: 'done', outcome: result });
  }, [checker, set]);

  const runNetwork = React.useCallback(async () => {
    const result = await checker.network();
    setNetwork({ downlinkKbps: result.downlinkKbps, rttMs: result.rttMs });
    set('network', { phase: 'done', outcome: result });
  }, [checker, set]);

  // Browser and network need no permission, so they run on their own; the rest wait for a click
  // (screen sharing and full screen need a user gesture anyway).
  React.useEffect(() => {
    let alive = true;
    void checker.network().then((result) => {
      if (!alive) return;
      setNetwork({ downlinkKbps: result.downlinkKbps, rttMs: result.rttMs });
      set('network', { phase: 'done', outcome: result });
    });
    return () => {
      alive = false;
    };
  }, [checker, set]);

  async function run(id: CheckId): Promise<void> {
    switch (id) {
      case 'browser':
        runBrowser();
        return;
      case 'network':
        set('network', { phase: 'running' });
        await runNetwork();
        return;
      case 'camera': {
        cameraRef.current?.getTracks().forEach((t) => t.stop());
        cameraRef.current = null;
        setCameraStream(null);
        set('camera', { phase: 'running' });
        const result = await checker.camera();
        if (result.stream) {
          cameraRef.current = result.stream;
          setCameraStream(result.stream);
        }
        setVirtualCameraLabel(result.virtualCameraLabel ?? null);
        set('camera', { phase: 'done', outcome: result });
        return;
      }
      case 'microphone': {
        micHandle.current?.stop();
        micHandle.current = null;
        setMicLevel(0);
        setHeardSound(false);
        set('microphone', { phase: 'running' });
        const result = await checker.microphone((level) => {
          setMicLevel(level);
          if (level > 8) setHeardSound(true);
        });
        micHandle.current = result.handle ?? null;
        set('microphone', { phase: 'done', outcome: result });
        return;
      }
      case 'screen': {
        set('screen', { phase: 'running' });
        const result = await checker.screen();
        setScreenKind(result.kind);
        set('screen', { phase: 'done', outcome: result });
        return;
      }
      case 'fullscreen': {
        set('fullscreen', { phase: 'running' });
        set('fullscreen', { phase: 'done', outcome: await checker.fullscreen() });
        return;
      }
      case 'monitor': {
        set('monitor', { phase: 'running' });
        const result = await checker.monitor();
        setMonitor(result.result);
        set('monitor', { phase: 'done', outcome: result });
        return;
      }
    }
  }

  const status = (id: CheckId): CheckOutcome['status'] | 'pending' => {
    const r = rows[id];
    return r.phase === 'done' ? r.outcome.status : 'pending';
  };
  const okish = (id: CheckId): boolean => ['passed', 'warning'].includes(status(id));
  const required: CheckId[] = [
    'browser',
    'camera',
    'microphone',
    'screen',
    'fullscreen',
    'monitor',
    'network',
  ];
  const remaining = required.filter((id) => !okish(id));
  const browserBlocked = browser !== null && !browser.supported;

  const submit = useMutation({
    mutationFn: async () => {
      if (!browser) return { ok: false, kind: 'network' } as const;
      return candidateApi.submitSystemCheck(
        buildSystemCheckBody({
          browser,
          cameraOk: okish('camera'),
          microphoneOk: okish('microphone'),
          screen: screenKind,
          network,
          monitor,
          virtualCameraLabel,
        }),
      );
    },
    onSuccess: (result) => {
      if (result.ok && result.data.passed) {
        cameraRef.current?.getTracks().forEach((t) => t.stop());
        micHandle.current?.stop();
        onPassed();
      } else if (!result.ok && result.kind === 'problem' && result.status === 401) {
        onSessionEnded();
      }
    },
  });

  const submitResult = submit.data;
  const blocking = submitResult?.ok && !submitResult.data.passed ? submitResult.data.blocking : [];
  const submitProblem =
    submit.isError || (submitResult && !submitResult.ok && submitResult.kind !== 'problem')
      ? 'We could not send the results. Check your internet connection and press "Continue" again.'
      : submitResult &&
          !submitResult.ok &&
          submitResult.kind === 'problem' &&
          submitResult.status !== 401
        ? 'The service had a problem. Wait a minute and press "Continue" again.'
        : null;

  return (
    <StepFrame
      title="Check your computer"
      intro="We check that your browser, camera, microphone and screen sharing work. Nothing is recorded or saved during these checks."
    >
      {browserBlocked ? (
        <Alert tone="error" role="alert" title="This browser cannot be used for the test">
          Open the link from your invitation email in the latest Google Chrome or Microsoft Edge, on
          a computer. The other checks stay off until you do.
        </Alert>
      ) : null}
      <ul className="space-y-3">
        {ROWS.map((row) => {
          const state = rows[row.id];
          const outcome = state.phase === 'done' ? state.outcome : null;
          const disabled = state.phase === 'running' || (browserBlocked && row.id !== 'browser');
          return (
            <li key={row.id} className="space-y-2 rounded-md border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">{row.label}</h2>
                <StatusLabel state={state} />
              </div>
              <p className="text-sm text-muted-foreground">{row.what}</p>
              <div aria-live="polite" className="space-y-1 text-sm empty:hidden">
                {outcome ? <p>{outcome.message}</p> : null}
                {outcome?.help ? (
                  <p>
                    <strong>What to do: </strong>
                    {outcome.help}
                  </p>
                ) : null}
              </div>
              {row.id === 'camera' && cameraStream ? (
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  aria-label="Live preview of your camera"
                  className="aspect-video w-full max-w-sm rounded-md border bg-muted"
                >
                  <track kind="captions" />
                </video>
              ) : null}
              {row.id === 'camera' && virtualCameraLabel ? (
                <p className="text-sm">
                  We noticed a virtual camera ({virtualCameraLabel}). Please use your real webcam. A
                  reviewer will see this note.
                </p>
              ) : null}
              {row.id === 'microphone' &&
              rows.microphone.phase === 'done' &&
              rows.microphone.outcome.status === 'passed' ? (
                <div className="space-y-1">
                  <div
                    role="meter"
                    aria-label="Microphone level"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={micLevel}
                    className="h-3 w-full max-w-sm overflow-hidden rounded border bg-muted"
                  >
                    <div className="h-full bg-primary" style={{ width: `${micLevel}%` }} />
                  </div>
                  <p className="text-sm">
                    {heardSound
                      ? 'We can hear you.'
                      : 'We have not heard anything yet. Say a few words. If the bar stays empty, check that your microphone is not muted.'}
                  </p>
                </div>
              ) : null}
              <Button
                type="button"
                variant={outcome?.status === 'passed' ? 'outline' : 'default'}
                size="lg"
                className="min-h-11"
                disabled={disabled}
                onClick={() => void run(row.id)}
              >
                {state.phase === 'running'
                  ? 'Checking...'
                  : outcome
                    ? `${row.button} again`
                    : row.button}
              </Button>
            </li>
          );
        })}
      </ul>

      {blocking.length > 0 ? (
        <Alert tone="error" role="alert" title="One more thing before you can continue">
          <ul className="list-disc space-y-1 pl-5">
            {blocking.map((reason) => (
              <li key={reason}>{BLOCKING_TEXT[reason]}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {submitProblem ? (
        <Alert tone="error" role="alert">
          {submitProblem}
        </Alert>
      ) : null}

      <div className="space-y-2">
        <p id="check-remaining" role="status" className="text-sm">
          {remaining.length === 0
            ? 'All checks are done. You can continue.'
            : `Still to do: ${remaining.map((id) => ROWS.find((r) => r.id === id)?.label ?? id).join(', ')}.`}
        </p>
        <Button
          size="lg"
          className="min-h-11"
          disabled={remaining.length > 0 || submit.isPending}
          aria-describedby="check-remaining"
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? 'Sending results...' : 'Continue to identity check'}
        </Button>
      </div>
    </StepFrame>
  );
}
