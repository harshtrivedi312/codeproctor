import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';

export default function LandingPage() {
  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">CodeProctor</span>
        <ThemeToggle />
      </header>
      <main id="main" className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-3xl font-semibold tracking-tight">Proctored coding assessments</h1>
        <p className="mt-4 text-muted-foreground">
          Candidates: open the link from your invitation email to start. Hiring teams: sign in to
          manage questions, tests and reviews.
        </p>
        <div className="mt-8 flex flex-wrap gap-4 text-sm">
          <Link className="text-primary underline underline-offset-4" href="/admin">
            Staff area
          </Link>
          {/* A plain anchor on purpose: /t/[token]/test needs a full document load so it gets its own
              CSP with 'wasm-unsafe-eval' (D-45 (P-05)); a client-side Link would keep this page's. */}
          <a className="text-primary underline underline-offset-4" href="/t/demo/test">
            Preview the candidate test screen (mock data)
          </a>
        </div>
      </main>
    </>
  );
}
