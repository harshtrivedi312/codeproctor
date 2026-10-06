'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-provider';
import { can } from '@/features/staff/permissions';
import { InviteDialog } from './invite-dialog';

/** Opens the invite dialog for one test. Only roles that may invite see it (FR-303). */
export function InviteButton({
  testId,
  disabled,
}: {
  testId: string;
  disabled?: boolean;
}): React.JSX.Element | null {
  const { role } = useAuth();
  const [open, setOpen] = React.useState(false);
  if (!can(role, 'invitation:create')) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        title={disabled ? 'Save your changes first' : undefined}
        onClick={() => setOpen(true)}
      >
        Invite candidates
      </Button>
      <InviteDialog open={open} onOpenChange={setOpen} testId={testId} />
    </>
  );
}
