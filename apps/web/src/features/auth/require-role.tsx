'use client';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useAuth, type StaffRole } from './auth-provider';

interface RequireRoleProps {
  /** Roles allowed to see the children. Omit to allow any signed-in staff user. */
  roles?: readonly StaffRole[];
  /** Shown when signed in with a role that is not allowed. Defaults to a plain explanation. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Renders children only for a signed-in user with an allowed role. Not signed in (including a
 * failed silent refresh) goes to login and returns here afterwards. This is a UI convenience;
 * the API enforces roles on every route (FR-103).
 */
export function RequireRole({
  roles,
  fallback,
  children,
}: RequireRoleProps): React.JSX.Element | null {
  const { status, role, signedOutByUser, loginPath, refreshBusy, refreshRetryAfter, retryRefresh } =
    useAuth();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace(
        signedOutByUser
          ? loginPath
          : `/admin/login?reason=expired&next=${encodeURIComponent(pathname)}`,
      );
    }
  }, [status, signedOutByUser, loginPath, router, pathname]);

  if (status === 'loading' && refreshBusy) {
    return (
      <div role="status" className="space-y-2 p-6 text-sm">
        <p>
          The service is busy right now, so we could not check your sign-in. We did not sign you
          out.
        </p>
        <Button variant="outline" size="sm" onClick={retryRefresh}>
          Try again
        </Button>
      </div>
    );
  }
  if (status === 'loading') {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Checking your sign-in…
      </p>
    );
  }
  if (status === 'unauthenticated') {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Taking you to the sign-in page…
      </p>
    );
  }
  if (roles && (!role || !roles.includes(role))) {
    return (
      <>
        {fallback ?? (
          <div role="alert" className="p-6 text-sm">
            Your role does not have access to this page. Ask a Super Admin if you need it.
          </div>
        )}
      </>
    );
  }
  // Signed in, but the background sign-in check was refused as rate limited or busy: nobody was
  // signed out. Say so, so the next 401 does not come as a surprise.
  const banner =
    status === 'authenticated' && refreshBusy ? (
      <div
        role="status"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-md border bg-card p-3 text-sm"
      >
        <p>
          The sign-in check is rate limited; we did not sign you out. Try again{' '}
          {refreshRetryAfter
            ? `in about ${Math.ceil(refreshRetryAfter / 60)} minute(s)`
            : 'in a minute'}
          .
        </p>
        <Button variant="outline" size="sm" onClick={retryRefresh}>
          Try again
        </Button>
      </div>
    ) : null;
  return (
    <>
      {banner}
      {children}
    </>
  );
}
