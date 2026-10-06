import type { Metadata } from 'next';

// Candidate routes: calm layout, no staff chrome. The invitation token is in this page's URL, so
// the page sends no Referer to anything it links or loads, and is kept out of search indexes.
export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function CandidateLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh">{children}</div>;
}
