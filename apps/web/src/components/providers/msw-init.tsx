'use client';
import { useEffect } from 'react';
import { mockingEnabled } from '@/lib/env';
import { markMockingReady } from '@/lib/mock-ready';

/** Starts the MSW browser worker when NEXT_PUBLIC_API_MOCKING=enabled. Renders nothing. */
export function MswInit(): null {
  useEffect(() => {
    if (!mockingEnabled) return;
    void import('@/mocks/browser').then(async ({ worker }) => {
      await worker.start({
        onUnhandledFrame: 'bypass',
        // MSW would print every intercepted request body (passwords, one-time codes and reset
        // tokens included) to the console. Never log those, even for fake data.
        quiet: true,
      });
      markMockingReady();
    });
  }, []);
  return null;
}
