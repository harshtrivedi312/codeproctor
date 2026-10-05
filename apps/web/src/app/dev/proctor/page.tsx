import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ProctorDemoClient } from './proctor-demo-client';

export const metadata: Metadata = { title: 'Proctor SDK demo (dev only)' };

/** Dev-only page (FR-601..610, FR-701, FR-702, FR-606, FR-607): 404 in production builds. */
export default function DevProctorPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main id="main" className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Proctor SDK demo (dev only)</h1>
      <p className="text-sm text-muted-foreground">
        Mock API only. Endpoints and wire formats are assumptions pending the architecture hub
        (ARC-03). Not linked from any navigation.
      </p>
      <ProctorDemoClient />
    </main>
  );
}
