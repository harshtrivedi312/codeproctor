'use client';
import { Maximize, ShieldAlert } from 'lucide-react';
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
