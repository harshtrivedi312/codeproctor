import type { Metadata } from 'next';
import { TestScreen } from '@/features/candidate-test/test-screen';
import { mockingEnabled } from '@/lib/env';

export const metadata: Metadata = { title: 'Test (demo preview)' };

export default async function TestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Only the literal token "demo" works, and only with MSW mocks on. Real tokens arrive in FE-09.
  if (token !== 'demo' || !mockingEnabled) {
    return (
      <main id="main" className="mx-auto my-24 max-w-md px-4 text-center">
        <h1 className="text-2xl font-semibold">This test screen is a preview</h1>
        <p className="mt-2 text-muted-foreground">
          The preview works at /t/demo/test when the app runs with mocked data
          (NEXT_PUBLIC_API_MOCKING=enabled). Real test links open once the invitation steps are
          built.
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
