'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from '@/features/candidate-flow/api';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import { phoneLinkUrl } from './phone-store';

/**
 * FR-405 STRICT profile: pair a phone side camera by QR code (PROVISIONAL, ARC-03 part 2).
 *
 * The step asks the server whether this session needs one (it may not: STANDARD tests, and the
 * accommodations projection can lift it). When it is not needed the step moves on by itself. The
 * link token is held in component state only, rendered into the QR image, and dropped when the
 * step closes. It is also behind a "show the link" button for candidates who cannot scan.
 */
export function PhoneStep({
  pollMs = 3000,
  onRequiredKnown,
  onDone,
  onSessionEnded,
}: {
  pollMs?: number;
  onRequiredKnown?: (required: boolean) => void;
  onDone: () => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const status = useQuery({
    queryKey: ['candidate', 'side-camera'],
    queryFn: () => candidateApi.getSideCamera(),
    gcTime: 0,
    retry: false,
    refetchInterval: (q) => {
      const r = q.state.data;
      return r?.ok && r.data.required && !r.data.connected ? pollMs : false;
    },
  });
  const data = status.data?.ok ? status.data.data : null;

  React.useEffect(() => {
    const r = status.data;
    if (r && !r.ok && r.kind === 'problem' && r.status === 401) onSessionEnded();
  }, [status.data, onSessionEnded]);
  React.useEffect(() => {
    if (data) onRequiredKnown?.(data.required);
    if (data && !data.required) onDone();
  }, [data, onRequiredKnown, onDone]);

  const link = useMutation({ mutationFn: () => candidateApi.createSideCameraLink() });
  const [qr, setQr] = React.useState<string | null>(null);
  const [showLink, setShowLink] = React.useState(false);
  const requested = React.useRef(false);

  const linkResult = link.data;
  const linkToken = linkResult?.ok ? linkResult.data.linkToken : null;
  const linkUrl = linkToken ? phoneLinkUrl(window.location.origin, linkToken) : null;

  React.useEffect(() => {
    if (data?.required && !data.connected && !requested.current) {
      requested.current = true;
      link.mutate();
    }
  }, [data, link]);

  React.useEffect(() => {
    let alive = true;
    if (!linkUrl) return undefined;
    void import('qrcode')
      .then((m) => m.toDataURL(linkUrl, { margin: 2, width: 220 }))
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [linkUrl]);

  function newCode(): void {
    setQr(null);
    setShowLink(false);
    link.mutate();
  }

  if (status.isPending || (data && !data.required)) {
    return (
      <StepFrame title="Phone camera">
        <p role="status">One moment...</p>
      </StepFrame>
    );
  }
  if (!data) {
    return (
      <StepFrame title="We could not check the phone camera">
        <Alert tone="error" role="alert">
          Check your internet connection and press &quot;Try again&quot;.
        </Alert>
        <Button size="lg" className="min-h-11" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </StepFrame>
    );
  }

  if (data.connected) {
    return (
      <StepFrame title="Your phone camera is connected" focusKey="connected">
        <Alert tone="success" role="status" data-testid="phone-paired">
          Your phone is connected. Keep it standing so it shows your desk and screen, and keep its
          page open.
        </Alert>
        <Button size="lg" className="min-h-11" onClick={onDone}>
          Continue
        </Button>
      </StepFrame>
    );
  }

  const linkFailed = link.isError || (linkResult !== undefined && !linkResult.ok);
  return (
    <StepFrame
      title="Connect your phone as a side camera"
      intro="This test needs a second camera. Your phone shows a side view of your desk and screen."
    >
      <ol className="list-decimal space-y-1 pl-6">
        <li>Open the camera app on your phone and point it at the QR code below.</li>
        <li>Open the link it shows and press &quot;Turn on the camera and connect&quot;.</li>
        <li>
          Stand the phone so it shows your desk, keyboard and screen. This page continues by itself.
        </li>
      </ol>
      {linkFailed ? (
        <Alert tone="error" role="alert">
          We could not make a QR code. Check your internet connection and press &quot;New QR
          code&quot;.
        </Alert>
      ) : null}
      <div className="space-y-3">
        {qr ? (
          // A data URL of the candidate's own QR code, not a remote image.
          <img
            src={qr}
            width={220}
            height={220}
            alt="QR code to scan with your phone. A text link is available below."
          />
        ) : (
          <p role="status">{link.isPending ? 'Making your QR code...' : 'No QR code yet.'}</p>
        )}
        <p role="status" className="text-sm" data-testid="phone-waiting">
          Waiting for your phone to connect.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            size="lg"
            variant="outline"
            className="min-h-11"
            disabled={link.isPending}
            onClick={newCode}
          >
            New QR code
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="min-h-11"
            aria-expanded={showLink}
            disabled={!linkUrl}
            onClick={() => setShowLink((v) => !v)}
          >
            {showLink ? 'Hide the link' : 'I cannot scan: show the link'}
          </Button>
        </div>
        {showLink && linkUrl ? (
          <div className="space-y-1">
            <label htmlFor="phone-link" className="block text-sm font-medium">
              Link for your phone (single use, do not share it)
            </label>
            <input
              id="phone-link"
              readOnly
              value={linkUrl}
              className="h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        ) : null}
      </div>
    </StepFrame>
  );
}
