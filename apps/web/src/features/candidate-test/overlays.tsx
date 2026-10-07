'use client';
import { Maximize, MonitorUp, PauseCircle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/** Start gate: shown before the demo test begins (the real flow uses the Step 9 system check). */
export function StartGate({
  onEnter,
  demoAction,
  fullscreenFailed,
  timerRunning = false,
}: {
  onEnter: () => void;
  /** Demo-only escape hatch; never passed in a real session. */
  demoAction?: React.ReactNode;
  fullscreenFailed: boolean;
  /** The server clock already runs (the real test): the copy must not promise a later start. */
  timerRunning?: boolean;
}): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent
        overlayClassName="bg-background/95"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle>Enter fullscreen to begin</DialogTitle>
        <DialogDescription>
          {timerRunning
            ? 'The test runs in fullscreen. Your time is already running: it started when you pressed Start. Enter fullscreen to continue.'
            : 'The test runs in fullscreen. Your timer starts when you press the button. Take a breath; you can leave and come back, but time keeps running if you do.'}
        </DialogDescription>
        {fullscreenFailed && (
          <p role="alert" className="mt-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
            Your browser did not allow fullscreen. Fix: click the button again, or check that
            fullscreen is not blocked for this site in your browser settings.
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button size="lg" onClick={onEnter}>
            <Maximize className="h-5 w-5" aria-hidden /> Enter fullscreen and start
          </Button>
          {demoAction}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Non-dismissable overlay while the document is not fullscreen. The clock keeps running. */
export function FullscreenLockOverlay({
  warnings,
  onReenter,
}: {
  warnings: number;
  onReenter: () => void;
}): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent
        role="alertdialog"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-warning" aria-hidden /> You left fullscreen
        </DialogTitle>
        <DialogDescription>
          Your editor is paused until you return to fullscreen.{' '}
          <strong>Your time keeps running.</strong> This was recorded.
        </DialogDescription>
        <p className="mt-3 text-sm" data-testid="warning-count">
          Warnings so far: {warnings}. Your answers so far are saved.
        </p>
        <Button className="mt-6" size="lg" onClick={onReenter}>
          <Maximize className="h-5 w-5" aria-hidden /> Re-enter fullscreen
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/** Non-dismissable overlay when the screen share stopped. The clock keeps running (ADR 0002 P-2). */
export function ScreenShareLostOverlay({
  onShare,
  failed,
}: {
  onShare: () => void;
  failed: string | null;
}): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent
        role="alertdialog"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="flex items-center gap-2">
          <MonitorUp className="h-5 w-5 text-warning" aria-hidden /> Your screen is no longer shared
        </DialogTitle>
        <DialogDescription>
          Your editor is paused until you share your entire screen again.{' '}
          <strong>Your time keeps running.</strong> This was recorded.
        </DialogDescription>
        {failed ? (
          <p role="alert" className="mt-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
            {failed}
          </p>
        ) : null}
        <Button className="mt-6" size="lg" onClick={onShare}>
          <MonitorUp className="h-5 w-5" aria-hidden /> Share your entire screen again
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A proctor paused the test. This is the only pause that stops the clock (ADR 0002 P-2, P-3); the
 * overlay says so and offers nothing to press: the test resumes when the proctor resumes it.
 */
export function ProctorPausedOverlay(): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent
        role="alertdialog"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="flex items-center gap-2">
          <PauseCircle className="h-5 w-5" aria-hidden /> The test is paused
        </DialogTitle>
        <DialogDescription>
          The person running the test paused it.{' '}
          <strong>Your time is stopped while it is paused.</strong> Please wait: this page goes on
          by itself when the test resumes. Your answers so far are saved. Do not close this page.
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The real test's start gate (FR-601, FR-604). Two clicks, because the browser wants a fresh click
 * for each: share the entire screen, then enter fullscreen (which also starts the camera and
 * microphone recording). Nothing is requested before the candidate presses a button, and the
 * consent was signed in an earlier step.
 */
export function ProctorGate({
  ready,
  shared,
  failure,
  busy,
  onShare,
  onEnter,
}: {
  ready: boolean;
  shared: boolean;
  failure: string | null;
  busy: boolean;
  onShare: () => void;
  onEnter: () => void;
}): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent
        overlayClassName="bg-background/95"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle>
          {shared ? 'Enter fullscreen to continue' : 'Share your entire screen'}
        </DialogTitle>
        <DialogDescription>
          Your time is already running: it started when you pressed Start.{' '}
          {shared
            ? 'The test runs in fullscreen, with your camera and microphone on. Press the button to go on.'
            : 'The test needs your entire screen shared, not a window or a tab. In the box your browser shows, choose "Entire Screen" and press Share.'}
        </DialogDescription>
        {!ready ? (
          <p role="status" className="mt-3 text-sm">
            Getting ready...
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="mt-3 rounded-md bg-warning-soft p-3 text-sm text-warning">
            {failure}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          {shared ? (
            <Button size="lg" disabled={!ready || busy} onClick={onEnter}>
              <Maximize className="h-5 w-5" aria-hidden /> Enter fullscreen and continue
            </Button>
          ) : (
            <Button size="lg" disabled={!ready || busy} onClick={onShare}>
              <MonitorUp className="h-5 w-5" aria-hidden /> Share your entire screen
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FinishSectionDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
  error,
  sectionTitle,
  last = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  error?: string | null;
  sectionTitle: string;
  /** The last section: finishing it submits the whole test (ADR 0002 S-5). */
  last?: boolean;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogTitle>Finish the {sectionTitle} section?</DialogTitle>
        <DialogDescription>
          Once you finish this section it <strong>cannot be reopened</strong>, even if there is time
          left. Your latest saved answers are submitted. Make sure you are done with every question
          in it.
          {last ? (
            <>
              {' '}
              <strong>This is the last section: finishing it submits your test.</strong>
            </>
          ) : null}
        </DialogDescription>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md bg-destructive-soft p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Keep working
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? 'Finishing…' : error ? 'Try again' : 'Finish section'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
