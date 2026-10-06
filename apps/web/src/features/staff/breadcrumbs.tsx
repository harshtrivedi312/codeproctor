'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

const LABELS: Record<string, string> = {
  questions: 'Questions',
  tests: 'Tests',
  candidates: 'Candidates',
  review: 'Review queue',
  live: 'Live',
  reports: 'Reports',
  settings: 'Settings',
  security: 'Security',
  new: 'New question',
  versions: 'Version history',
  users: 'Users',
  data: 'Data and privacy',
  risk: 'Risk scoring',
  consent: 'Consent',
};

export interface Crumb {
  href: string;
  label: string;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed escape such as %E0%A4%A
  }
}

/** /admin/settings/users becomes Dashboard / Settings / Users. Unknown segments (IDs) show as-is. */
export function crumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ href: '/admin', label: 'Dashboard' }];
  let href = '/admin';
  for (const segment of segments.slice(1)) {
    href += `/${segment}`;
    // "new" names what it creates: a question under Questions, a test under Tests.
    const label =
      segment === 'new' && segments[segments.indexOf(segment) - 1] === 'tests'
        ? 'New test'
        : (LABELS[segment] ?? safeDecode(segment));
    crumbs.push({ href, label });
  }
  return crumbs;
}

export function Breadcrumbs(): React.JSX.Element | null {
  const pathname = usePathname();
  const crumbs = crumbsFor(pathname);
  if (crumbs.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-3 text-sm">
      <ol className="flex flex-wrap items-center gap-1 text-muted-foreground">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={crumb.href} className="flex items-center gap-1">
              {i > 0 ? <span aria-hidden="true">/</span> : null}
              {last ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} className="underline-offset-4 hover:underline">
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
