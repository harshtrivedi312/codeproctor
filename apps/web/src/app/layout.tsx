import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Providers } from '@/components/providers/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'CodeProctor', template: '%s | CodeProctor' },
  description: 'Proctored coding assessments for hiring.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers makes every page dynamic, which is what lets Next.js stamp the
  // per-request CSP nonce (src/middleware.ts) on its scripts.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2"
        >
          Skip to main content
        </a>
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  );
}
