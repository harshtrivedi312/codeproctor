'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/features/admin/page-header';
import { useAuth } from '@/features/auth/auth-provider';
import { ActionDialog, type SecurityAction, type SecurityResult } from './action-dialog';
import { fetchTwoFactorStatus } from './api';
import { isTwoFactorMandatory } from './schemas';

const NOTICES: Record<SecurityResult, string> = {
  enabled: 'Two-factor sign-in is now on. Next time you sign in you will be asked for a code.',
  disabled: 'Two-factor sign-in is now off.',
  regenerated: 'New recovery codes are ready. Your old recovery codes no longer work.',
};

/** FR-102: set up, turn off and refresh recovery codes for TOTP. Open to every signed-in staff role. */
export function SecurityPage(): React.JSX.Element {
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const [action, setAction] = React.useState<SecurityAction | null>(null);
  const [notice, setNotice] = React.useState<SecurityResult | null>(null);
  const userId = user?.id ?? null;
  const status = useQuery({
    queryKey: ['2fa-status', userId],
    enabled: userId !== null,
    queryFn: fetchTwoFactorStatus,
    retry: false,
  });
  const mandatory = isTwoFactorMandatory(role);
  const enabled = status.data === true;

  return (
    <>
      <PageHeader
        title="Security"
        description="Protect your account with a second sign-in step. Every change here asks for your current password."
      />
      {notice ? (
        <Alert tone="success" role="status" className="mb-4">
          {NOTICES[notice]}
        </Alert>
      ) : null}
      <section
        aria-labelledby="two-factor-heading"
        className="max-w-2xl space-y-4 rounded-md border bg-card p-5"
      >
        <h2 id="two-factor-heading" className="font-medium">
          Two-factor sign-in (2FA)
        </h2>
        {status.isError ? (
          <Alert tone="error" role="alert" title="We could not load your 2FA status">
            Check your connection and reload the page.
          </Alert>
        ) : status.data === undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        ) : (
          <>
            <p className="text-sm" data-testid="two-factor-status">
              {enabled
                ? 'Two-factor sign-in is on for your account.'
                : 'Two-factor sign-in is off. It is optional for your role, and adds protection if your password leaks.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {!enabled ? (
                <Button type="button" onClick={() => setAction('setup')}>
                  Set up 2FA
                </Button>
              ) : null}
              {enabled ? (
                <Button type="button" variant="outline" onClick={() => setAction('regenerate')}>
                  Regenerate recovery codes
                </Button>
              ) : null}
              {enabled && !mandatory ? (
                <Button type="button" variant="outline" onClick={() => setAction('disable')}>
                  Disable 2FA
                </Button>
              ) : null}
            </div>
            {mandatory ? (
              <p className="text-sm text-muted-foreground" data-testid="two-factor-required">
                Two-factor sign-in is required for your role, so it cannot be turned off. If you
                lose your phone, use a recovery code, or ask a Super Admin for help.
              </p>
            ) : null}
          </>
        )}
      </section>
      {action ? (
        <ActionDialog
          action={action}
          onClose={() => setAction(null)}
          onDone={(result) => {
            setAction(null);
            setNotice(result);
            void queryClient.invalidateQueries({ queryKey: ['2fa-status', userId] });
          }}
        />
      ) : null}
    </>
  );
}
