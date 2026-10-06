'use client';
/**
 * Demo-only controls for the mocked preview at /t/demo/test. This module is loaded only when
 * mock mode is on (see the guarded React.lazy calls in test-screen.tsx). It must never reach a
 * production bundle: it can bypass the fullscreen lock, which a real session must not allow.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import type { LockEvent } from './lock-state';

type Dispatch = (event: LockEvent) => void;

export function DemoBanner(): React.JSX.Element {
  return (
    <div
      className="bg-warning-soft px-4 py-1.5 text-center text-sm font-medium text-warning"
      data-testid="demo-banner"
    >
      Demo — mocked data. Nothing here is real, saved or scored.
    </div>
  );
}

/** Footer control plus the Alt+Shift+X shortcut that simulates leaving fullscreen. */
export function DemoFooterControl({ dispatchLock }: { dispatchLock: Dispatch }): React.JSX.Element {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyX')
        dispatchLock({ type: 'fullscreen-exited', simulated: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatchLock]);
  return (
    <div className="ml-auto flex items-center gap-2 rounded-md border border-dashed px-2 py-1 text-xs">
      <span className="text-muted-foreground">Demo control:</span>
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => dispatchLock({ type: 'fullscreen-exited', simulated: true })}
      >
        Simulate fullscreen exit (Alt+Shift+X)
      </button>
    </div>
  );
}

export function DemoContinueWithoutFullscreen({
  dispatchLock,
}: {
  dispatchLock: Dispatch;
}): React.JSX.Element {
  return (
    <Button variant="ghost" onClick={() => dispatchLock({ type: 'start', fullscreen: false })}>
      Continue without fullscreen (demo only)
    </Button>
  );
}
