'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import * as React from 'react';
import { Toaster } from 'sonner';
import { ErrorBoundary } from '@/components/error-boundary';
import { BUSY_CODE } from '@/lib/api/busy';
import { MswInit } from './msw-init';

/** A read is retried once, but never after BUSY: the API client already did that, up to 3 times. */
export const shouldRetryQuery = (count: number, error: unknown): boolean =>
  count < 1 && !isBusyError(error);

const isBusyError = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'status' in e &&
  'code' in e &&
  e.status === 503 &&
  e.code === BUSY_CODE;

export function Providers({ nonce, children }: { nonce?: string; children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A busy answer was already retried by the API client (up to 3 times): no second
            // layer on top of it. Other read failures keep one retry. A write is never retried.
            retry: shouldRetryQuery,
            refetchOnWindowFocus: false,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem nonce={nonce}>
      <QueryClientProvider client={queryClient}>
        <MswInit />
        <ErrorBoundary>{children}</ErrorBoundary>
        <Toaster position="bottom-right" richColors closeButton />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
