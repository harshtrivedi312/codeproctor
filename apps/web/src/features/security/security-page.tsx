'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/features/admin/page-header';
import { useAuth } from '@/features/auth/auth-provider';
import { ActionDialog, type SecurityAction, type SecurityResult } from './action-dialog';

const NOTICES: Record<SecurityResult, string> = {
  enabled: 'Two-factor sign-in is now on. Next time you sign in you will be asked for a code.',
  regenerated: 'New recovery codes are ready. Your old recovery codes no longer work.',
};

/** FR-102: set up, turn off and refresh recovery codes for TOTP. Optional for every signed-in staff role. */
export function SecurityPage(): React.JSX.Element {
  const { user } = useAuth();
  const [action, setAction] = React.useState<SecurityAction | null>(null);
  const [notice, setNotice] = React.useState<SecurityResult | null>(null);
  // The session user carries `totpEnabled`; undefined (an older session) is treated as unknown.
  const known = typeof user?.totpEnabled === 'boolean';
  const enabled = user?.totpEnabled === true;

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
        {!known ? (
          <p role="status" className="text-sm text-muted-foreground">
            Your two-factor status is not available yet, so no changes are offered here. If this
            keeps happening, contact your administrator.
          </p>
        ) : (
          <>
            <p className="text-sm" data-testid="two-factor-status">
              {enabled
                ? 'Two-factor sign-in is on for your account.'
                : 'Two-factor sign-in is off. It is optional, and we recommend it: it adds protection if your password leaks.'}
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
              {enabled ? (
                <Button type="button" variant="outline" onClick={() => setAction('disable')}>
                  Disable 2FA
                </Button>
              ) : null}
            </div>
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
          }}
        />
      ) : null}
    </>
  );
}
