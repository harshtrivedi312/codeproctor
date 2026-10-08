'use client';
import { X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-provider';

/**
 * FR-102: two-factor sign-in is optional for every role and recommended. While the session user
 * has `twoFactorRecommended`, the staff shell shows this dismissible note with a link to the
 * Security page. Dismissal lives in this component's state only: it lasts while the shell stays
 * mounted (until sign-out or a reload), so it comes back on the next sign-in. Nothing is stored.
 */
export function TwoFactorNudge(): React.JSX.Element | null {
  const { user } = useAuth();
  const pathname = usePathname();
  const [dismissed, setDismissed] = React.useState(false);
  // The flag is always sent; fall back to totpEnabled === false if an older session lacks it.
  const recommended = user?.twoFactorRecommended ?? user?.totpEnabled === false;
  if (!user || !recommended || dismissed || pathname === '/admin/security') return null;
  return (
    <div
      role="region"
      aria-label="Two-factor sign-in recommendation"
      data-testid="two-factor-nudge"
      className="flex items-center justify-between gap-3 border-b bg-muted px-4 py-2 text-sm"
    >
      <p>
        We recommend turning on two-factor sign-in.{' '}
        <Link className="text-primary underline underline-offset-4" href="/admin/security">
          Set it up in Security
        </Link>
      </p>
      <Button type="button" variant="ghost" size="icon" onClick={() => setDismissed(true)}>
        <X className="size-4" aria-hidden="true" />
        <span className="sr-only">Dismiss the two-factor recommendation</span>
      </Button>
    </div>
  );
}
