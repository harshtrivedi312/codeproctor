'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from '@/features/candidate-flow/api';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import {
  AUTO_STOP_MS,
  MAX_CLIP_BYTES,
  advanceRoomSeq,
  currentRoomSeq,
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
/** How many times a taken seq number is skipped before giving up. */
const MAX_SEQ_ADVANCES = 8;
/** Confirm retries after a 503 (the check could not be queued; the chunk is stored). */
const CONFIRM_503_RETRIES = 3;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const ROOM_COPY = {
  intro:
    'We ask for a short video of the room you are in, to see that you are alone and what is on your desk. It has no sound. It is recorded only after you signed the consent document, and it is used only for the review of this assessment.',
  stationaryNote:
    'If you cannot turn the camera around, choose "I cannot rotate my camera". The video will show the room from where you sit instead. Tell your recruiter if you need an accommodation, before you start.',
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
  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<RoomRecorder | null>(null);
  const clipRef = React.useRef<{ url: string | null } | null>(null);
  const sendingRef = React.useRef(false);
  const startingRef = React.useRef(false);
  // Seq numbers this component has already PUT to (any outcome). Only for those may a 412 mean "our
  // earlier PUT landed"; for any other seq the stored object belongs to an older clip.
  const attemptedSeqs = React.useRef(new Set<number>());
  const mountedRef = React.useRef(false);
  const [starting, setStarting] = React.useState(false);
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

  // Leaving the step stops the camera and the recorder and drops the clip. Anything still waiting
  // (the camera prompt, an upload) checks mountedRef afterwards and does nothing more.
  React.useEffect(() => {
    mountedRef.current = true;
    const holder = clipRef;
    return () => {
      mountedRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) void recorder.stop().catch(() => undefined);
      if (holder.current?.url) URL.revokeObjectURL(holder.current.url);
    };
  }, []);

  const finishRecording = React.useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    const result = await recorder.stop();
    if (!mountedRef.current) return;
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
    if (phase === 'recording' && elapsed * 1000 >= AUTO_STOP_MS) void finishRecording();
  }, [elapsed, phase, finishRecording]);

  async function begin(chosen: Mode): Promise<void> {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      setProblem(null);
      setMode(chosen);
      stopCamera();
      let s: MediaStream;
      try {
        s = await deps.openCamera();
      } catch {
        if (!mountedRef.current) return;
        setProblem(
          'The camera could not start. Click the camera or lock icon in the address bar, allow the camera, close other apps that use it, then press the button again.',
        );
        return;
      }
      if (!mountedRef.current) {
        // The step closed while the camera prompt was open: switch the camera straight off.
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = s;
      setStream(s);
      try {
        recorderRef.current = deps.startRecording(s);
      } catch {
        stopCamera();
        setProblem(
          'This browser could not start the recording. Use the latest Chrome or Edge, then press the button again.',
        );
        return;
      }
      setStepIndex(0);
      setElapsed(0);
      setPhase('recording');
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }

  function discard(): void {
    if (clipRef.current?.url) URL.revokeObjectURL(clipRef.current.url);
    clipRef.current = null;
    setClip(null);
    setProblem(null);
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
        setProblem(
          'That recording is empty or too large. Please record it again and keep it shorter.',
        );
        setPhase('review');
        return;
      }
      let seq = currentRoomSeq();
      let tries = 0;
      let conflicts = 0;
      let message: string | null = null;
      while (tries < MAX_SEND_ATTEMPTS && conflicts < MAX_SEQ_ADVANCES) {
        const ref = { stream: 'ROOM_SCAN', segment: seq, seq } as const;
        const presign = await candidateApi.presignMedia({
          ...ref,
          bytes: blob.size,
          contentType: 'video/webm',
          startedAt: startedAt.toISOString(),
          durationMs,
        });
        if (!mountedRef.current) return;
        if (!presign.ok) {
          if (presign.kind !== 'problem') break;
          if (presign.status === 401) {
            onSessionEnded();
            return;
          }
          if (presign.status === 409 && presign.code === 'SEQ_CONFLICT') {
            // This number is taken by another clip: use the next one.
            seq = advanceRoomSeq();
            conflicts += 1;
            continue;
          }
          if (presign.status === 409 && presign.code === 'SESSION_NOT_ACTIVE') {
            message =
              'Your session is no longer active, so the recording cannot be sent. Open the link from your invitation email again.';
          } else if (presign.status === 429) {
            message = `Too many tries in a row. Wait ${presign.retryAfterSeconds ?? 60} seconds, then press "Send this recording" again.`;
          }
          break;
        }
        if ('alreadyUploaded' in presign.data) {
          // Only a confirmed chunk answers this way, and this component never leaves one
          // unconfirmed unless it finished. So the number belongs to an older clip: use a fresh one.
          seq = advanceRoomSeq();
          conflicts += 1;
          continue;
        }
        const priorPut = attemptedSeqs.current.has(seq);
        const outcome = await deps.upload(presign.data.url, presign.data.headers, blob);
        if (!mountedRef.current) return;
        attemptedSeqs.current.add(seq);
        if (outcome === 'failed') {
          tries += 1;
          continue;
        }
        if (outcome === 'exists' && !priorPut) {
          // A 412 on our first PUT of this number: the stored object is not ours.
          seq = advanceRoomSeq();
          conflicts += 1;
          continue;
        }
        let confirm = await candidateApi.confirmMedia(ref);
        // 503 + Retry-After: the chunk is stored but the check could not be queued. The same
        // confirm recovers it, so retry in place (bounded) instead of uploading the clip again.
        for (
          let wait = 0;
          wait < CONFIRM_503_RETRIES &&
          !confirm.ok &&
          confirm.kind === 'problem' &&
          confirm.status === 503;
          wait += 1
        ) {
          const seconds = Math.min(Math.max(confirm.retryAfterSeconds ?? 2, 1), 15);
          await (deps.sleep ?? defaultSleep)(seconds * 1000);
          if (!mountedRef.current) return;
          confirm = await candidateApi.confirmMedia(ref);
          if (!mountedRef.current) return;
        }
        if (!mountedRef.current) return;
        if (confirm.ok) {
          advanceRoomSeq();
          attemptedSeqs.current.clear();
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
        if (confirm.kind === 'problem' && confirm.status === 503) {
          message =
            'The service is busy and could not take your recording yet. Wait a minute, then press "Send this recording" again.';
          break;
        }
        // 409 UPLOAD_NOT_FOUND and 422 UPLOAD_MISMATCH: ask for a new URL and upload again.
        if (confirm.kind === 'problem' && (confirm.status === 409 || confirm.status === 422)) {
          tries += 1;
          continue;
        }
        break;
      }
      // A failed clip never keeps its number: the next try (or a re-record) starts fresh.
      advanceRoomSeq();
      attemptedSeqs.current.clear();
      if (conflicts >= MAX_SEQ_ADVANCES) {
        message =
          'We could not find a free place for the recording. Press "Send this recording" again.';
      }
      setProblem(
        message ??
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
            <li>It usually takes about 15 to 30 seconds. The most it can run is 59 seconds.</li>
          </ol>
          <p>{ROOM_COPY.stationaryNote}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              className="min-h-11"
              disabled={starting}
              onClick={() => void begin('rotate')}
            >
              Start the room scan
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="min-h-11"
              disabled={starting}
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
            <p role="status">
              The recording stops at 59 seconds. Keep it shorter if you can; you can record again
              afterwards.
            </p>
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
