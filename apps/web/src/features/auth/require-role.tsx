'use client';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
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
  const { status, role, signedOutByUser } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace(
        signedOutByUser
          ? '/admin/login'
          : `/admin/login?reason=expired&next=${encodeURIComponent(pathname)}`,
      );
    }
  }, [status, signedOutByUser, router, pathname]);

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
  return <>{children}</>;
}
