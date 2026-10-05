'use client';
import Link from 'next/link';
import { navItemsFor } from '@/features/staff/nav-config';
import { useAuth } from './auth-provider';
import { ROLE_LABELS } from './user-badge';

/** Dashboard placeholder until the dashboard step: who is signed in and where they can go. */
export function WelcomePanel(): React.JSX.Element | null {
  const { user, role } = useAuth();
  if (!user || !role) return null;
  const links = navItemsFor(role).filter((item) => item.href !== '/admin');
  return (
    <>
      <p className="mt-2 text-sm text-muted-foreground">
        Signed in as {user.email} ({ROLE_LABELS[role]}) at {user.orgName}.
      </p>
      <h2 className="mt-6 text-base font-semibold">Your areas</h2>
      <ul className="mt-2 grid max-w-2xl gap-2 sm:grid-cols-2">
        {links.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex items-center gap-2 rounded-md border bg-card p-3 text-sm hover:bg-accent"
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
