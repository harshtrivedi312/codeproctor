import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';

/** Centered card used by every staff auth screen. */
export function AuthCard({
  title,
  description,
  children,
  wide = false,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b bg-card px-4 py-2">
        <Link href="/" className="font-semibold">
          CodeProctor staff
        </Link>
        <ThemeToggle />
      </header>
      <main id="main" className="mx-auto px-4 py-12" style={{ maxWidth: wide ? '40rem' : '26rem' }}>
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-xl font-semibold">{title}</h1>
          {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
          <div className="mt-6 space-y-4">{children}</div>
        </div>
      </main>
    </div>
  );
}
