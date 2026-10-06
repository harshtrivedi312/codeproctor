'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from '@/features/candidate-flow/api';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import {
  MAX_CLIP_BYTES,
  MAX_CLIP_MS,
  ROTATE_STEPS,
  STATIONARY_STEPS,
  defaultRoomScanDeps,
  type RoomClip,
  type RoomRecorder,
  type RoomScanDeps,
} from './room-capture';

type Phase = 'intro' | 'recording' | 'review' | 'sending' | 'done';
type Mode = 'rotate' | 'stationary';

/** Wire retries: a missing object or a mismatch asks for a new presign (ADR 0013 section 5.5). */
const MAX_SEND_ATTEMPTS = 3;

export const ROOM_COPY = {
  intro:
    'We ask for a short video of the room you are in, to see that you are alone and what is on your desk. It has no sound. It is recorded only after you signed the consent document, and it is used only for the review of this assessment.',
  stationaryNote:
    'If you cannot turn the camera around, choose "I cannot rotate my camera". You will show the room from where you sit instead, and a reviewer will see that. You can also ask your recruiter about an accommodation before you start.',
} as const;

/** FR-404 room scan (TC-035). Candidate-paced steps; the clip is uploaded as stream ROOM_SCAN. */
export function RoomScanStep({
  deps: injected,
  onDone,
  onSessionEnded,
}: {
  deps?: Partial<RoomScanDeps>;
  onDone: () => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const deps = React.useMemo<RoomScanDeps>(
    () => ({ ...defaultRoomScanDeps, ...injected }),
    [injected],
  );
  const [phase, setPhase] = React.useState<Phase>('intro');
  const [mode, setMode] = React.useState<Mode>('rotate');
  const [stepIndex, setStepIndex] = React.useState(0);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [clip, setClip] = React.useState<{ clip: RoomClip; url: string | null } | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const [attempt, setAttempt] = React.useState(0);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<RoomRecorder | null>(null);
  const clipRef = React.useRef<{ url: string | null } | null>(null);
  const sendingRef = React.useRef(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  const steps = mode === 'rotate' ? ROTATE_STEPS : STATIONARY_STEPS;

  React.useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, phase]);

  const stopCamera = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  // Leaving the step stops the camera and drops the clip.
  React.useEffect(() => {
    const holder = clipRef;
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (holder.current?.url) URL.revokeObjectURL(holder.current.url);
    };
  }, []);

  const finishRecording = React.useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    const result = await recorder.stop();
    stopCamera();
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(result.blob) : null;
    clipRef.current = { url };
    setClip({ clip: result, url });
    setPhase('review');
  }, [stopCamera]);

  // Elapsed time is shown for sighted users (hidden from screen readers) and caps the clip at the
  // wire limit. The candidate can always stop earlier, and record again.
  React.useEffect(() => {
    if (phase !== 'recording') return undefined;
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [phase]);
  React.useEffect(() => {
    if (phase === 'recording' && elapsed * 1000 >= MAX_CLIP_MS - 500) void finishRecording();
  }, [elapsed, phase, finishRecording]);

  async function begin(chosen: Mode): Promise<void> {
    setProblem(null);
    setMode(chosen);
    try {
      const s = await deps.openCamera();
      streamRef.current = s;
      setStream(s);
    } catch {
      setProblem(
        'The camera could not start. Click the camera or lock icon in the address bar, allow the camera, close other apps that use it, then press the button again.',
      );
      return;
    }
    recorderRef.current = deps.startRecording(streamRef.current);
    setStepIndex(0);
    setElapsed(0);
    setPhase('recording');
  }

  function discard(): void {
    if (clipRef.current?.url) URL.revokeObjectURL(clipRef.current.url);
    clipRef.current = null;
    setClip(null);
    setProblem(null);
    setAttempt((a) => a + 1);
    setPhase('intro');
  }

  async function send(): Promise<void> {
    if (sendingRef.current || !clip) return;
    sendingRef.current = true;
    setProblem(null);
    setPhase('sending');
    try {
      const { blob, durationMs, startedAt } = clip.clip;
      if (blob.size < 1 || blob.size > MAX_CLIP_BYTES) {
        setProblem('That recording is empty or too large. Please record it again.');
        setPhase('review');
        return;
      }
      const ref = { stream: 'ROOM_SCAN', segment: attempt, seq: 0 } as const;
      for (let n = 0; n < MAX_SEND_ATTEMPTS; n += 1) {
        const presign = await candidateApi.presignMedia({
          ...ref,
          bytes: blob.size,
          contentType: 'video/webm',
          startedAt: startedAt.toISOString(),
          durationMs,
        });
        if (!presign.ok) {
          if (presign.kind === 'problem' && presign.status === 401) {
            onSessionEnded();
            return;
          }
          break;
        }
        if (!('alreadyUploaded' in presign.data)) {
          const outcome = await deps.upload(presign.data.url, presign.data.headers, blob);
          if (outcome === 'failed') continue;
        }
        const confirm = await candidateApi.confirmMedia(ref);
        if (confirm.ok) {
          if (clipRef.current?.url) URL.revokeObjectURL(clipRef.current.url);
          clipRef.current = null;
          setClip(null);
          setPhase('done');
          return;
        }
        if (confirm.kind === 'problem' && confirm.status === 401) {
          onSessionEnded();
          return;
        }
        // 409 UPLOAD_NOT_FOUND and 422 UPLOAD_MISMATCH: ask for a new URL and upload again.
        if (!(confirm.kind === 'problem' && (confirm.status === 409 || confirm.status === 422)))
          break;
      }
      setProblem(
        'The upload did not finish. Check your internet connection and press "Send this recording" again. Your recording is still here.',
      );
      setPhase('review');
    } finally {
      sendingRef.current = false;
    }
  }

  if (phase === 'done') {
    return (
      <StepFrame title="Room scan received">
        <Alert tone="success" role="status" data-testid="room-done">
          Thank you. Your recording was received. A person may look at it during the review.
        </Alert>
        <Button size="lg" className="min-h-11" onClick={onDone}>
          Continue
        </Button>
      </StepFrame>
    );
  }

  const title =
    phase === 'intro'
      ? 'Show us your room'
      : phase === 'recording'
        ? 'Recording your room'
        : 'Check your recording';

  return (
    <StepFrame title={title} focusKey={phase}>
      {problem ? (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      ) : null}

      {phase === 'intro' ? (
        <div className="space-y-4">
          <p>{ROOM_COPY.intro}</p>
          <ol className="list-decimal space-y-1 pl-6">
            <li>Press the button. Your camera turns on and recording starts.</li>
            <li>Follow each instruction at your own pace and press &quot;Done, next&quot;.</li>
            <li>It usually takes about 15 to 30 seconds. The most it can run is 60 seconds.</li>
          </ol>
          <p>{ROOM_COPY.stationaryNote}</p>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" className="min-h-11" onClick={() => void begin('rotate')}>
              Start the room scan
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="min-h-11"
              onClick={() => void begin('stationary')}
            >
              I cannot rotate my camera
            </Button>
          </div>
        </div>
      ) : null}

      {phase === 'recording' ? (
        <div className="space-y-4">
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
            <span
              aria-hidden="true"
              className="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-sm font-medium text-white"
            >
              Recording {elapsed} s
            </span>
          </div>
          <p className="text-sm">
            Step {stepIndex + 1} of {steps.length}
          </p>
          <p role="status" className="text-lg font-medium" data-testid="room-step">
            {steps[stepIndex]}
          </p>
          {elapsed >= 45 ? (
            <p role="status">The recording stops at 60 seconds. You can record again afterwards.</p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {stepIndex < steps.length - 1 ? (
              <Button size="lg" className="min-h-11" onClick={() => setStepIndex((i) => i + 1)}>
                Done, next
              </Button>
            ) : (
              <Button size="lg" className="min-h-11" onClick={() => void finishRecording()}>
                Done, stop recording
              </Button>
            )}
            <Button
              size="lg"
              variant="outline"
              className="min-h-11"
              onClick={() => void finishRecording()}
            >
              Stop now
            </Button>
          </div>
        </div>
      ) : null}

      {phase === 'review' || phase === 'sending' ? (
        <div className="space-y-4">
          {clip?.url ? (
            <video
              src={clip.url}
              controls
              aria-label="Your room scan recording"
              className="aspect-video w-full max-w-lg rounded-md border bg-muted"
            >
              <track kind="captions" />
            </video>
          ) : null}
          <p>
            Did the recording show the whole room and your desk surface? If not, record it again.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              className="min-h-11"
              disabled={phase === 'sending'}
              onClick={() => void send()}
            >
              {phase === 'sending' ? 'Sending...' : 'Send this recording'}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="min-h-11"
              disabled={phase === 'sending'}
              onClick={discard}
            >
              Record again
            </Button>
          </div>
        </div>
      ) : null}
    </StepFrame>
  );
}
