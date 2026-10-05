'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/auth-provider';
import { isActive, navItemsFor } from './nav-config';

/** Main navigation. Items the role cannot use are not rendered at all (FR-103). */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const { role } = useAuth();
  const pathname = usePathname();
  const items = navItemsFor(role);
  return (
    <nav aria-label="Main">
      <ul className="space-y-0.5">
        {items.map(({ href, label, icon: Icon }) => {
          const active = isActive(href, pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
                  active && 'bg-accent font-medium',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
