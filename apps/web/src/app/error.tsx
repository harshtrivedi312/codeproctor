'use client';
import { ErrorPanel } from '@/components/error-boundary';

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main">
      <ErrorPanel onRetry={reset} />
    </main>
  );
}
