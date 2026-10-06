'use client';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { markMockingReady } from '@/lib/mock-ready';

// One start for the whole page, even when React StrictMode runs the effect twice in development.
let starting: Promise<void> | null = null;

function startMockWorker(): Promise<void> {
  starting ??= import('@/mocks/browser')
    .then(({ worker }) =>
      worker.start({
        onUnhandledFrame: 'bypass',
        // MSW would print every intercepted request body (passwords, one-time codes and reset
        // tokens included) to the console. Never log those, even for fake data.
        quiet: true,
      }),
    )
    .then(() => undefined)
    .catch(() => {
      // Never leave API calls waiting for a worker that is not coming (FR-505 screens included).
      toast.error(
        'The mock API could not start. Reload the page; if it keeps failing, run the app without NEXT_PUBLIC_API_MOCKING.',
      );
    })
    .finally(markMockingReady);
  return starting;
}

/** Starts the MSW browser worker when NEXT_PUBLIC_API_MOCKING=enabled. Renders nothing. */
export function MswInit(): null {
  useEffect(() => {
    // Read inline (static property access) so the bundler replaces it with a constant and drops
    // the dynamic import of the mock code from production bundles. Keep it in this expression.
    if (process.env.NEXT_PUBLIC_API_MOCKING !== 'enabled') return;
    void startMockWorker();
  }, []);
  return null;
}
