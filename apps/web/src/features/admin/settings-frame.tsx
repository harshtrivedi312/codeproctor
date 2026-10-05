'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { RequireRole } from '@/features/auth/require-role';
import { cn } from '@/lib/utils';
import { rolesWith } from '@/features/staff/permissions';
import { PageHeader } from './page-header';

const TABS = [
  { href: '/admin/settings/users', label: 'Users' },
  { href: '/admin/settings/data', label: 'Data and privacy' },
  { href: '/admin/settings/risk', label: 'Risk scoring' },
  { href: '/admin/settings/consent', label: 'Consent' },
] as const;

/** Guards a Settings page (Super Admin only, FR-103) and shows the Settings sub-navigation. */
export function SettingsFrame({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  return (
    <RequireRole roles={rolesWith('user:manage', 'org_settings:manage')}>
      <nav aria-label="Settings sections" className="mb-4 border-b">
        <ul className="flex flex-wrap gap-1">
          {TABS.map((tab) => {
            const active = pathname === tab.href;
            return (
              <li key={tab.href}>
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    '-mb-px inline-block border-b-2 px-3 py-2 text-sm hover:bg-accent',
                    active ? 'border-primary font-medium' : 'border-transparent',
                  )}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <PageHeader title={title} description={description} />
      {children}
    </RequireRole>
  );
}
