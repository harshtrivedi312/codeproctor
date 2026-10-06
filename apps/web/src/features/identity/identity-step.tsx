'use client';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from '@/features/candidate-flow/api';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import {
  LIVENESS_PROMPTS,
  MAX_IMAGE_BYTES,
  defaultIdentityDeps,
  type IdentityDeps,
} from './capture';

type Phase = 'id' | 'selfie' | 'review' | 'sending' | 'received';

/** A captured image and the object URL used to preview it. Both live in memory only. */
interface Shot {
  blob: Blob;
  url: string | null;
}

function toShot(blob: Blob): Shot {
  return {
    blob,
    url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null,
  };
}

function dropShot(shot: Shot | null): void {
  if (shot?.url) URL.revokeObjectURL(shot.url);
}

export const IDENTITY_COPY = {
  waived: 'No identity check is needed for this test. This was arranged with your recruiter.',
  waivedFaceOn:
    'Your webcam is still recorded, and the browser checks that a face is present and where you are looking. No face matching or identity check runs.',
  received:
    'Your photos were received. Thank you. A person may take a quick look at them later. Nothing is rejected automatically, and you can continue.',
  retry:
    'We could not read your photos clearly. Please take both photos again. Face a window or lamp so your face is evenly lit, remove glare from glasses, and fill the frame with your ID so all four corners and the text can be read. You can do this once more; after that a person looks at your photos and you can continue.',
} as const;

/**
 * FR-403 identity check (ADR 0004, ADR 0015). An ID document photo and a live selfie with
 * liveness prompts. Nothing is rejected automatically, and the candidate only ever sees that the
 * photos were "received": no match score, no pass or fail.
 *
 * Liveness here is guided prompts, reported by the client (ADR 0004 R-05: it can only lead to
 * manual review). In-browser face landmark detection would need WebAssembly, which the stepper's
 * CSP does not allow (D-45), so it is a follow-up that needs an owner decision.
 */
export function IdentityStep({
  deps: injected,
  onDone,
  onSessionEnded,
}: {
  deps?: Partial<IdentityDeps>;
  onDone: () => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const deps = React.useMemo<IdentityDeps>(
    () => ({ ...defaultIdentityDeps, ...injected }),
    [injected],
  );

  const accommodations = useQuery({
    queryKey: ['candidate', 'accommodations'],
    queryFn: () => candidateApi.getAccommodations(),
    gcTime: 0,
    retry: false,
  });
  const [forcedWaived, setForcedWaived] = React.useState(false);

  const [phase, setPhase] = React.useState<Phase>('id');
  const [attempt, setAttempt] = React.useState(1);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [idShot, setIdShot] = React.useState<Shot | null>(null);
  const [selfieShot, setSelfieShot] = React.useState<Shot | null>(null);
  const [promptIndex, setPromptIndex] = React.useState(0);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [retryHint, setRetryHint] = React.useState(false);
  const streamRef = React.useRef<MediaStream | null>(null);
  const sendingRef = React.useRef(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const shotsRef = React.useRef<{ id: Shot | null; selfie: Shot | null }>({
    id: null,
    selfie: null,
  });

  const replaceShot = React.useCallback((kind: 'id' | 'selfie', next: Shot | null) => {
    dropShot(shotsRef.current[kind]);
    shotsRef.current[kind] = next;
    if (kind === 'id') setIdShot(next);
    else setSelfieShot(next);
  }, []);

  React.useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, phase]);
  // Leaving the step stops the camera and drops the previews.
  React.useEffect(() => {
    const shots = shotsRef.current;
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      dropShot(shots.id);
      dropShot(shots.selfie);
    };
  }, []);

  const stopCamera = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  React.useEffect(() => {
    const r = accommodations.data;
    if (r && !r.ok && r.kind === 'problem' && r.status === 401) onSessionEnded();
  }, [accommodations.data, onSessionEnded]);

  async function turnOnCamera(): Promise<void> {
    setCameraError(null);
    try {
      const s = await deps.openCamera();
      streamRef.current = s;
      setStream(s);
    } catch {
      setCameraError(
        'The camera could not start. Click the camera or lock icon in the address bar, allow the camera, make sure no other app is using it, then press "Turn on camera" again.',
      );
    }
  }

  async function takePhoto(kind: 'id' | 'selfie'): Promise<void> {
    const video = videoRef.current;
    if (!video) return;
    setProblem(null);
    try {
      const blob = await deps.snapshot(video);
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('size');
      replaceShot(kind, toShot(blob));
    } catch {
      setProblem('We could not take the photo. Press the button again.');
    }
  }

  async function chooseFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setProblem(null);
    if (!file.type.startsWith('image/')) {
      setProblem('That file is not a picture. Choose a photo (JPEG or PNG) of your ID.');
      return;
    }
    try {
      const blob = await deps.fileToJpeg(file);
      if (blob.size > MAX_IMAGE_BYTES) {
        setProblem(
          'That photo is too large. Choose a photo under 5 MB or take one with the camera.',
        );
        return;
      }
      replaceShot('id', toShot(blob));
    } catch {
      setProblem('We could not read that file. Choose another photo of your ID.');
    }
  }

  function restart(): void {
    replaceShot('id', null);
    replaceShot('selfie', null);
    setPromptIndex(0);
    setProblem(null);
    setPhase('id');
  }

  async function send(): Promise<void> {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      await sendOnce();
    } finally {
      sendingRef.current = false;
    }
  }

  async function sendOnce(): Promise<void> {
    const idBlob = idShot?.blob;
    const selfieBlob = selfieShot?.blob;
    if (!idBlob || !selfieBlob) return;
    setProblem(null);
    setPhase('sending');
    const names: string[] = [];
    for (const [purpose, blob] of [
      ['ID_IMAGE', idBlob],
      ['SELFIE', selfieBlob],
    ] as const) {
      const presign = await candidateApi.presignIdentityImage(purpose, blob.size);
      if (!presign.ok) {
        if (presign.kind === 'problem' && presign.status === 401) {
          onSessionEnded();
          return;
        }
        if (presign.kind === 'problem' && presign.code === 'IDENTITY_CHECK_WAIVED') {
          stopCamera();
          setForcedWaived(true);
          void accommodations.refetch();
          return;
        }
        setProblem(
          'We could not start the upload. Check your internet connection and press "Send my photos" again.',
        );
        setPhase('review');
        return;
      }
      const uploaded = await deps.upload(presign.data.url, presign.data.headers, blob);
      if (!uploaded) {
        setProblem(
          'The upload did not finish. Check your internet connection and press "Send my photos" again. Your photos are still here.',
        );
        setPhase('review');
        return;
      }
      names.push(presign.data.evidenceKey);
    }
    const [idImageName, selfieName] = names;
    if (idImageName === undefined || selfieName === undefined) return;
    const result = await candidateApi.submitIdentity({
      idImageName,
      selfieName,
      liveness: { prompts: LIVENESS_PROMPTS.map((p) => p.id), completed: true },
    });
    if (!result.ok) {
      if (result.kind === 'problem' && result.status === 401) {
        onSessionEnded();
        return;
      }
      if (result.kind === 'problem' && result.code === 'IDENTITY_CHECK_WAIVED') {
        stopCamera();
        setForcedWaived(true);
        return;
      }
      setProblem('We could not finish sending your photos. Press "Send my photos" again.');
      setPhase('review');
      return;
    }
    // Photos are in the server's hands now; drop our copies and the camera.
    replaceShot('id', null);
    replaceShot('selfie', null);
    stopCamera();
    if (result.data.retrySuggested && attempt === 1) {
      setAttempt(2);
      setRetryHint(true);
      setPromptIndex(0);
      setPhase('id');
    } else {
      setRetryHint(false);
      setPhase('received');
    }
  }

  if (accommodations.isPending) {
    return (
      <StepFrame title="Identity check">
        <p role="status">One moment...</p>
      </StepFrame>
    );
  }
  const projection = accommodations.data?.ok === true ? accommodations.data.data : null;
  if (forcedWaived || projection?.identityCheckWaived === true) {
    return (
      <StepFrame title="No identity check needed">
        <div data-testid="identity-waived" className="space-y-3">
          <p>{IDENTITY_COPY.waived}</p>
          {projection?.faceDetectorsOff === false ? <p>{IDENTITY_COPY.waivedFaceOn}</p> : null}
        </div>
        <Button size="lg" className="min-h-11" onClick={onDone}>
          Continue
        </Button>
      </StepFrame>
    );
  }

  if (phase === 'received') {
    return (
      <StepFrame title="Photos received">
        <Alert tone="success" role="status" data-testid="identity-received">
          {IDENTITY_COPY.received}
        </Alert>
        <Button size="lg" className="min-h-11" onClick={onDone}>
          Continue
        </Button>
      </StepFrame>
    );
  }

  const prompt = LIVENESS_PROMPTS[promptIndex];
  const allPromptsDone = promptIndex >= LIVENESS_PROMPTS.length;

  return (
    <StepFrame
      focusKey={phase}
      title={
        phase === 'id'
          ? 'Photo of your ID'
          : phase === 'selfie'
            ? 'Live selfie'
            : 'Check your photos'
      }
      intro="We compare your ID photo with a live selfie to confirm it is you. Nothing is rejected automatically: if we are unsure, a person looks at the photos."
    >
      {retryHint ? (
        <Alert tone="info" role="status" data-testid="identity-retry">
          {IDENTITY_COPY.retry}
        </Alert>
      ) : null}
      {problem ? (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      ) : null}
      {cameraError ? (
        <Alert tone="error" role="alert">
          {cameraError}
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Photo {phase === 'id' ? '1' : '2'} of 2{attempt === 2 ? ' (second try)' : ''}
      </p>

      {phase === 'id' || phase === 'selfie' ? (
        <div className="space-y-3">
          {phase === 'id' ? (
            <p>
              Hold your government ID flat inside the frame. Use even light, avoid glare, and make
              sure all four corners and the text can be read.
            </p>
          ) : (
            <div className="space-y-2">
              {allPromptsDone ? (
                <p role="status">Great. Look straight at the camera, then take your selfie.</p>
              ) : (
                <>
                  <p className="text-sm">
                    Prompt {promptIndex + 1} of {LIVENESS_PROMPTS.length}
                  </p>
                  <p role="status" className="text-lg font-medium" data-testid="liveness-prompt">
                    {prompt?.text}
                  </p>
                </>
              )}
            </div>
          )}

          {stream ? (
            <div className="relative w-full max-w-lg overflow-hidden rounded-md border bg-muted">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                aria-label="Live preview of your camera"
                className="aspect-video w-full"
              >
                <track kind="captions" />
              </video>
              {phase === 'id' ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <div className="flex aspect-[1.586] w-3/4 items-end justify-center rounded-lg border-4 border-dashed border-white pb-1 text-sm font-medium text-white [text-shadow:0_0_3px_#000]">
                    Place your ID here
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {phase === 'id' && idShot?.url ? (
            <div className="space-y-2">
              <img
                src={idShot.url}
                alt="Preview of your ID"
                className="max-w-lg rounded-md border"
              />
              <p className="text-sm">
                Can you read every word and see all four corners? If not, retake it.
              </p>
            </div>
          ) : null}
          {phase === 'selfie' && selfieShot?.url ? (
            <img
              src={selfieShot.url}
              alt="Preview of your selfie"
              className="max-w-sm rounded-md border"
            />
          ) : null}

          <div className="flex flex-wrap gap-3">
            {!stream && !(phase === 'id' && idShot) ? (
              <Button size="lg" className="min-h-11" onClick={() => void turnOnCamera()}>
                Turn on camera
              </Button>
            ) : null}

            {phase === 'id' && !idShot ? (
              <>
                {stream ? (
                  <Button size="lg" className="min-h-11" onClick={() => void takePhoto('id')}>
                    Take photo of my ID
                  </Button>
                ) : null}
                <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-input bg-card px-6 text-base font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring hover:bg-accent">
                  Upload a photo of my ID instead
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => void chooseFile(e.target.files?.[0])}
                  />
                </label>
              </>
            ) : null}
            {phase === 'id' && idShot ? (
              <>
                <Button
                  size="lg"
                  className="min-h-11"
                  onClick={() => {
                    setPhase('selfie');
                    if (!stream) void turnOnCamera();
                  }}
                >
                  Use this photo, next: selfie
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => replaceShot('id', null)}
                >
                  Retake
                </Button>
              </>
            ) : null}

            {phase === 'selfie' && stream && !allPromptsDone && !selfieShot ? (
              <Button size="lg" className="min-h-11" onClick={() => setPromptIndex((i) => i + 1)}>
                {promptIndex === LIVENESS_PROMPTS.length - 1
                  ? 'Done, last step'
                  : 'Done, next prompt'}
              </Button>
            ) : null}
            {phase === 'selfie' && stream && allPromptsDone && !selfieShot ? (
              <Button size="lg" className="min-h-11" onClick={() => void takePhoto('selfie')}>
                Take selfie
              </Button>
            ) : null}
            {phase === 'selfie' && selfieShot ? (
              <>
                <Button
                  size="lg"
                  className="min-h-11"
                  onClick={() => {
                    stopCamera();
                    setPhase('review');
                  }}
                >
                  Use this selfie
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    replaceShot('selfie', null);
                    setPromptIndex(0);
                  }}
                >
                  Retake
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {phase === 'review' || phase === 'sending' ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4">
            {idShot?.url ? (
              <img
                src={idShot.url}
                alt="Your ID, as captured"
                className="max-h-40 rounded-md border"
              />
            ) : null}
            {selfieShot?.url ? (
              <img
                src={selfieShot.url}
                alt="Your selfie, as captured"
                className="max-h-40 rounded-md border"
              />
            ) : null}
          </div>
          <p>
            These photos are used only to confirm your identity for this assessment, and are deleted
            as set out in the retention schedule.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              className="min-h-11"
              disabled={phase === 'sending'}
              onClick={() => void send()}
            >
              {phase === 'sending' ? 'Sending...' : 'Send my photos'}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="min-h-11"
              disabled={phase === 'sending'}
              onClick={restart}
            >
              Retake both photos
            </Button>
          </div>
        </div>
      ) : null}
    </StepFrame>
  );
}
