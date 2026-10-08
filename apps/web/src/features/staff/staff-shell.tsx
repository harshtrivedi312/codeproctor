'use client';
import { Menu, X } from 'lucide-react';
import * as React from 'react';
import { BusyNotice } from '@/components/busy-notice';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-provider';
import { RequireRole } from '@/features/auth/require-role';
import { TwoFactorNudge } from '@/features/security/two-factor-nudge';
import { Breadcrumbs } from './breadcrumbs';
import { Sidebar } from './sidebar';
import { UserMenu } from './user-menu';

/**
 * Staff layout: sidebar, top bar (organisation name, user menu) and breadcrumbs. Nothing renders
 * until the user is signed in (RequireRole), so no staff chrome shows to a signed-out visitor.
 */
export function StaffShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <RequireRole>
      <ShellFrame>{children}</ShellFrame>
    </RequireRole>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user } = useAuth();
  const [open, setOpen] = React.useState(false);
  return (
    <div className="min-h-dvh md:flex">
      <aside
        className={`${open ? 'block' : 'hidden'} border-r bg-card p-3 md:block md:w-56 md:shrink-0`}
        id="staff-sidebar"
      >
        <p className="mb-3 hidden px-3 text-sm font-semibold md:block">CodeProctor</p>
        <Sidebar onNavigate={() => setOpen(false)} />
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-2 border-b bg-card px-4 py-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="md:hidden"
              aria-expanded={open}
              aria-controls="staff-sidebar"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? (
                <X className="size-4" aria-hidden="true" />
              ) : (
                <Menu className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
            </Button>
            <span className="font-semibold" data-testid="org-name">
              {user?.orgName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <UserMenu />
            <ThemeToggle />
          </div>
        </header>
        <BusyNotice />
        <TwoFactorNudge />
        <main id="main" className="p-4">
          <Breadcrumbs />
          {children}
        </main>
      </div>
    </div>
  );
}
