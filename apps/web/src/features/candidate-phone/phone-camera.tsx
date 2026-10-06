'use client';
import { useMutation } from '@tanstack/react-query';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from '@/features/candidate-flow/api';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import {
  cancelClearPhoneToken,
  clearPhoneToken,
  getPhoneToken,
  scheduleClearPhoneToken,
} from './phone-store';

export interface PhoneCameraDeps {
  openCamera: () => Promise<MediaStream>;
}

const defaultDeps: PhoneCameraDeps = {
  // The rear camera, to show the desk and screen from the side. No microphone.
  openCamera: () =>
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    }),
};

/**
 * FR-405 phone side camera page (PROVISIONAL, ARC-03 part 2).
 *
 * The phone holds only the one-time link token, in memory. It pairs with the session and shows a
 * preview so the candidate can aim it. Uploading the side-camera video during the test waits for
 * ARC-03 part 2 (ADR 0013 section 5.5 lists SIDE_CAMERA as not yet allowed), so this page does
 * not record anything yet, and says only what is true: connected and previewing.
 */
export function PhoneCamera({
  deps: injected,
}: {
  deps?: Partial<PhoneCameraDeps>;
}): React.JSX.Element {
  const deps = React.useMemo<PhoneCameraDeps>(() => ({ ...defaultDeps, ...injected }), [injected]);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [paired, setPaired] = React.useState(false);
  const streamRef = React.useRef<MediaStream | null>(null);
  const startingRef = React.useRef(false);
  const [starting, setStarting] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [hasLink, setHasLink] = React.useState(() => getPhoneToken() !== null);
  const mountedRef = React.useRef(false);

  React.useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, paired]);
  // Leaving the page stops the camera and forgets the link token.
  React.useEffect(() => {
    mountedRef.current = true;
    cancelClearPhoneToken();
    return () => {
      mountedRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      scheduleClearPhoneToken();
    };
  }, []);

  const pair = useMutation({
    mutationFn: async () => {
      const token = getPhoneToken();
      if (token === null) return { ok: false, kind: 'network' } as const;
      return candidateApi.pairSideCamera(token);
    },
  });

  async function start(): Promise<void> {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      await connect();
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }

  async function connect(): Promise<void> {
    setProblem(null);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    let s: MediaStream;
    try {
      s = await deps.openCamera();
    } catch {
      if (!mountedRef.current) return;
      setProblem(
        'The camera could not start. Allow the camera for this page in your phone browser settings, close other apps that use it, then press the button again.',
      );
      return;
    }
    if (!mountedRef.current) {
      // The page closed while the camera prompt was open: switch the camera straight off.
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = s;
    setStream(s);
    const result = await pair.mutateAsync();
    if (!mountedRef.current) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    if (result.ok) {
      // The link token has done its job: forget it.
      clearPhoneToken();
      setPaired(true);
      return;
    }
    s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    if (result.kind === 'problem' && [404, 409, 410].includes(result.status)) {
      // The link is spent: forget it and show the "needs the QR code" view with the reason.
      clearPhoneToken();
      setHasLink(false);
      setProblem(
        'This QR code has expired or was already used. On your computer, press "New QR code" and scan it again.',
      );
      return;
    }
    setProblem(
      result.kind === 'problem' &&
        (result.status === 404 || result.status === 409 || result.status === 410)
        ? 'This QR code has expired or was already used. On your computer, press "New QR code" and scan it again.'
        : "We could not connect to your computer session. Check your phone's internet connection and press the button again.",
    );
  }

  if (!hasLink && !paired) {
    return (
      <main id="main" className="mx-auto max-w-xl space-y-4 px-4 py-8">
        <StepFrame title="This page needs the QR code from your computer">
          {problem ? (
            <Alert tone="error" role="alert">
              {problem}
            </Alert>
          ) : null}
          <p>
            Scan the QR code shown on your computer screen with your phone camera. If you reloaded
            this page, scan the QR code again: for your safety the link is not kept.
          </p>
        </StepFrame>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto max-w-xl space-y-4 px-4 py-8">
      <StepFrame
        title={paired ? 'Your phone is connected' : 'Connect your phone camera'}
        focusKey={String(paired)}
      >
        {!paired ? (
          <div className="space-y-4">
            <p>
              Your phone will show a side view of your desk during the test. Only the camera is
              used: no microphone. Nothing is recorded by this page yet.
            </p>
            {problem ? (
              <Alert tone="error" role="alert">
                {problem}
              </Alert>
            ) : null}
            <Button
              size="lg"
              className="min-h-11"
              disabled={starting || pair.isPending}
              onClick={() => void start()}
            >
              {starting || pair.isPending ? 'Connecting...' : 'Turn on the camera and connect'}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Alert tone="success" role="status" data-testid="phone-connected">
              Connected. Look at your computer: it moves on when it sees this phone.
            </Alert>
            <ol className="list-decimal space-y-1 pl-6">
              <li>
                Stand the phone on its side or lean it so it shows your desk, keyboard and screen.
              </li>
              <li>
                Keep this page open and the phone plugged in or charged. Do not lock the screen.
              </li>
              <li>
                If you close this page, the connection ends. Open the QR code link again to
                reconnect.
              </li>
            </ol>
          </div>
        )}
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label="Live preview of your phone camera"
            className="aspect-video w-full rounded-md border bg-muted"
          >
            <track kind="captions" />
          </video>
        ) : null}
      </StepFrame>
    </main>
  );
}
