'use client';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { busyStore } from '@/lib/api/busy';

/**
 * The calm state for a busy service and for a staff write that failed with a 500. Never an error
 * page. A polite live region that always exists, so its text is announced when it appears, once:
 *  - while a call waits to retry after 503 BUSY: "The service is busy; trying again…"
 *  - when the retries ran out: "Still busy. Wait a moment and try again." with a Try again button
 *    that reloads the lists that failed (for a save or a button, press it again);
 *  - after a 500 on a write: the action may have happened, so look before trying again.
 */
export function BusyNotice(): React.JSX.Element {
  const state = React.useSyncExternalStore(busyStore.subscribe, busyStore.get, busyStore.get);
  const qc = useQueryClient();
  const tryAgain = (): void => {
    busyStore.dismiss();
    void qc.refetchQueries({ predicate: (q) => q.state.status === 'error' });
  };
  return (
    <div role="status" aria-live="polite" data-testid="busy-notice" className="px-4">
      {state.retrying ? (
        <p className="py-2 text-sm text-muted-foreground">The service is busy; trying again…</p>
      ) : state.exhausted ? (
        <div className="flex flex-wrap items-center gap-2 py-2 text-sm">
          <p>
            Still busy. Wait a moment and try again. Nothing was changed by the request that failed.
          </p>
          <Button size="sm" variant="outline" onClick={tryAgain}>
            Try again
          </Button>
        </div>
      ) : state.writeFailed ? (
        <div className="flex flex-wrap items-center gap-2 py-2 text-sm">
          <p>
            Something went wrong. Check before trying again: look at the list or the status first,
            because the action may already have happened.
          </p>
          <Button size="sm" variant="outline" onClick={() => busyStore.dismiss()}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}
