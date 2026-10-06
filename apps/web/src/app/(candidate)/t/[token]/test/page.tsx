import type { Metadata } from 'next';
import { TestScreen } from '@/features/candidate-test/test-screen';
import { mockingEnabled } from '@/lib/env';

export const metadata: Metadata = { title: 'Test (demo preview)' };

export default async function TestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Only the literal token "demo" works, and only with MSW mocks on. The real test opens from the invitation link, after the pre-test steps, at /t/link.
  if (token !== 'demo' || !mockingEnabled) {
    return (
      <main id="main" className="mx-auto my-24 max-w-md px-4 text-center">
        <h1 className="text-2xl font-semibold">This test screen is a preview</h1>
        <p className="mt-2 text-muted-foreground">
          The preview works at /t/demo/test when the app runs with mocked data
          (NEXT_PUBLIC_API_MOCKING=enabled). The real test opens from your invitation link, after
          the pre-test steps.
        </p>
      </main>
    );
  }
  return (
    <main id="main">
      <TestScreen />
    </main>
  );
}
