'use client';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { markMockingReady } from '@/lib/mock-ready';

// One start for the whole page, even when React StrictMode runs the effect twice in development.
let starting: Promise<void> | null = null;

/** Starts the MSW browser worker when NEXT_PUBLIC_API_MOCKING=enabled. Renders nothing. */
export function MswInit(): null {
  useEffect(() => {
    // Read inline (static property access, see next.config.ts `env`) so the bundler replaces it with
    // a constant and drops the import of the mock code from builds without mocking. Keep the import
    // inside this block: a separate function would stay in the bundle.
    if (process.env.NEXT_PUBLIC_API_MOCKING === 'enabled') {
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
        .catch((err: unknown) => {
          // Name only: an error message could carry request details.
          console.warn('MSW start failed:', err instanceof Error ? err.name : 'unknown');
          // Never leave API calls waiting for a worker that is not coming (candidate screens included).
          toast.error(
            'The mock API could not start. Reload the page; if it keeps failing, run the app without NEXT_PUBLIC_API_MOCKING.',
          );
        })
        .catch(() => undefined)
        .finally(markMockingReady);
    }
  }, []);
  return null;
}
