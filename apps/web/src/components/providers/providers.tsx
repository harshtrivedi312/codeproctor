'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import * as React from 'react';
import { Toaster } from 'sonner';
import { ErrorBoundary } from '@/components/error-boundary';
import { MswInit } from './msw-init';

export function Providers({ nonce, children }: { nonce?: string; children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
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
