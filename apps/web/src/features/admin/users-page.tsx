'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { USER_ROLES } from '@codeproctor/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/features/auth/auth-provider';
import { ROLE_LABELS } from '@/features/auth/user-badge';
import { StepUpDialog, StepUpForm, type StepUpOutcome } from '@/features/security/step-up-dialog';
import type { Schemas } from '@/lib/api/client';
import { can } from '@/features/staff/permissions';
import { formatDate, lockedUntilText } from './format';
import { useLockEvents, useStaffUsers } from './queries';
import { inviteStaffSchema, type InviteStaffValues } from './schemas';
import {
  inviteStaffUser,
  reissueStaffInvite,
  resetStaffTwoFactor,
  unlockStaffUser,
  updateStaffUser,
  type InviteDetails,
} from './user-actions';
import { SettingsFrame } from './settings-frame';

type StaffUser = Schemas['StaffUser'];

const STATUS_TONE = { active: 'success', invited: 'warning', deactivated: 'neutral' } as const;
const STATUS_LABEL = {
  active: 'Active',
  invited: 'Pending invite',
  deactivated: 'Deactivated',
} as const;

/**
 * FR-103: Super Admin manages users. Invite, change role, deactivate and reactivate. Each write
 * asks for the admin's own password (FR-102 step-up, docs/api-contract.md section 6).
 */
export function UsersPage(): React.JSX.Element {
  return (
    <SettingsFrame
      title="Users"
      description="Invite staff, change what they can do, or stop them signing in. Changes apply to your organisation only."
    >
      <UsersContent />
    </SettingsFrame>
  );
}

/** One password-protected action, staged until the admin confirms with their password. */
type PendingAction =
  | { kind: 'role'; user: StaffUser; role: Schemas['StaffRole'] }
  | { kind: 'deactivate'; user: StaffUser }
  | { kind: 'reactivate'; user: StaffUser }
  | { kind: 'unlock'; user: StaffUser }
  | { kind: 'reissue'; user: StaffUser }
  | { kind: 'resetTwoFactor'; user: StaffUser };

function describeAction(action: PendingAction): {
  title: string;
  description: string;
  submitLabel: string;
  destructive: boolean;
} {
  if (action.kind === 'role') {
    const { user, role } = action;
    const warning =
      user.role === 'SUPER_ADMIN' || role === 'SUPER_ADMIN'
        ? role === 'SUPER_ADMIN'
          ? 'Super Admins can manage users, settings and data retention for your whole organisation. Only give this role to someone you trust with that.'
          : 'They will lose access to user management and organisation settings straight away.'
        : 'Their access changes straight away. You can change it back at any time.';
    return {
      title: `Change ${user.name} from ${ROLE_LABELS[user.role]} to ${ROLE_LABELS[role]}?`,
      description: `${warning} They are signed out everywhere and sign in again with the new role. Confirm with your password.`,
      submitLabel: 'Change role',
      destructive: false,
    };
  }
  if (action.kind === 'deactivate') {
    return {
      title: `Deactivate ${action.user.name}?`,
      description:
        'They are signed out everywhere and cannot sign in until you reactivate them. Their past work stays in the audit log. Confirm with your password.',
      submitLabel: 'Deactivate',
      destructive: true,
    };
  }
  if (action.kind === 'unlock') {
    return {
      title: `Unlock ${action.user.name}?`,
      description:
        'They can try to sign in again straight away. Their password and sessions do not change. Confirm with your password.',
      submitLabel: 'Unlock',
      destructive: false,
    };
  }
  if (action.kind === 'reissue') {
    return {
      title: `Send the invitation to ${action.user.name} again?`,
      description: `We email ${action.user.email} a new link to set a password, valid for 72 hours. The earlier link stops working. Confirm with your password.`,
      submitLabel: 'Resend invite',
      destructive: false,
    };
  }
  if (action.kind === 'resetTwoFactor') {
    return {
      title: `Reset two-factor sign-in for ${action.user.name}?`,
      description:
        'Their account goes back to password-only sign-in until they set two-factor up again, and they are signed out everywhere. We email them to say it was reset. Only do this once you are sure who is asking. Confirm with your password.',
      submitLabel: 'Reset two-factor',
      destructive: true,
    };
  }
  return {
    title: `Reactivate ${action.user.name}?`,
    description: 'They can sign in again straight away. Confirm with your password.',
    submitLabel: 'Reactivate',
    destructive: false,
  };
}

function UsersContent(): React.JSX.Element {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  // The page is Super Admin only; this also keeps controls off for any other role (FR-103).
  const mayManage = can(me?.role, 'user:manage');
  const users = useStaffUsers();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [lockEventsOpen, setLockEventsOpen] = React.useState(false);
  // The selects and buttons only stage a choice; nothing is sent until the password is confirmed.
  const [action, setAction] = React.useState<PendingAction | null>(null);
  // Password-protected actions run one at a time: every other control is disabled meanwhile.
  const [inFlight, setInFlight] = React.useState(false);
  const inFlightRef = React.useRef(false);

  async function exclusive(run: () => Promise<StepUpOutcome>): Promise<StepUpOutcome> {
    if (inFlightRef.current) {
      return {
        kind: 'failed',
        title: 'Another change is still being saved',
        hint: 'Wait for it to finish, then submit again.',
      };
    }
    inFlightRef.current = true;
    setInFlight(true);
    try {
      return await run();
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }

  async function runAction(current: PendingAction, password: string): Promise<StepUpOutcome> {
    const { user } = current;
    let out: StepUpOutcome;
    let success: string;
    switch (current.kind) {
      case 'unlock':
        out = await unlockStaffUser(qc, user.id, password);
        success = `${user.name} is unlocked and can try to sign in.`;
        break;
      case 'reissue':
        out = await reissueStaffInvite(qc, user.id, password);
        success = `A new invitation was sent to ${user.email}. The earlier link no longer works.`;
        break;
      case 'resetTwoFactor':
        out = await resetStaffTwoFactor(qc, user.id, password);
        success = `Two-factor sign-in was reset for ${user.name}. They sign in with a password only.`;
        break;
      case 'role':
        out = await updateStaffUser(qc, user.id, { role: current.role }, password);
        success = `${user.name} is now ${ROLE_LABELS[current.role]}.`;
        break;
      case 'deactivate':
        out = await updateStaffUser(qc, user.id, { active: false }, password);
        success = `${user.name} was deactivated.`;
        break;
      case 'reactivate':
        out = await updateStaffUser(qc, user.id, { active: true }, password);
        success = `${user.name} can sign in again.`;
        break;
    }
    if (out.kind === 'done') toast.success(success);
    return out;
  }

  const columns: Column<StaffUser>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (u) => (
        <span className="font-medium">
          {u.name}
          {u.id === me?.id ? (
            <span className="ml-1 font-normal text-muted-foreground">(you)</span>
          ) : null}
        </span>
      ),
      sortValue: (u) => u.name,
    },
    { id: 'email', header: 'Email', cell: (u) => u.email, sortValue: (u) => u.email },
    {
      id: 'role',
      header: 'Role',
      sortValue: (u) => ROLE_LABELS[u.role],
      searchValue: (u) => ROLE_LABELS[u.role],
      facet: {
        label: 'Role',
        value: (u) => u.role,
        options: USER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
      },
      cell: (u) => {
        const fixed = u.id === me?.id || u.status === 'deactivated';
        return (
          <Select
            aria-label={`Role for ${u.name}`}
            className="h-8"
            value={u.role}
            disabled={fixed || inFlight || !mayManage}
            title={u.id === me?.id ? 'You cannot change your own role.' : undefined}
            onChange={(e) => {
              const role = e.target.value as Schemas['StaffRole'];
              if (role !== u.role) setAction({ kind: 'role', user: u, role });
            }}
          >
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (u) => STATUS_LABEL[u.status],
      searchValue: (u) => STATUS_LABEL[u.status],
      facet: {
        label: 'Status',
        value: (u) => u.status,
        options: [
          { value: 'active', label: 'Active' },
          { value: 'invited', label: 'Pending invite' },
          { value: 'deactivated', label: 'Deactivated' },
        ],
      },
      cell: (u) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Badge>
          {u.locked ? <Badge tone="warning">{lockedUntilText(u.lockedUntil)}</Badge> : null}
        </span>
      ),
    },
    {
      id: 'twoFactor',
      header: 'Two-factor',
      sortValue: (u) => (u.totpEnabled ? 'On' : 'Off'),
      searchValue: () => '',
      cell: (u) => (u.totpEnabled ? 'On' : 'Off'),
    },
    {
      id: 'createdAt',
      header: 'Added',
      sortValue: (u) => u.createdAt,
      searchValue: () => '',
      cell: (u) => formatDate(u.createdAt),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (u) => {
        // Your own account is changed from the Security page, and a role that cannot manage
        // users sees no actions (the API refuses them anyway).
        if (u.id === me?.id || !mayManage) return <span className="text-muted-foreground">—</span>;
        const row = (kind: PendingAction['kind'], label: string) => (
          <Button
            key={kind}
            size="sm"
            variant="outline"
            disabled={inFlight}
            onClick={() => setAction({ kind, user: u } as PendingAction)}
          >
            {label}
            <span className="sr-only"> {u.name}</span>
          </Button>
        );
        return (
          <span className="flex flex-wrap gap-1">
            {u.locked ? row('unlock', 'Unlock') : null}
            {u.status === 'invited' ? row('reissue', 'Resend invite') : null}
            {u.totpEnabled ? row('resetTwoFactor', 'Reset two-factor') : null}
            {u.status === 'deactivated'
              ? row('reactivate', 'Reactivate')
              : row('deactivate', 'Deactivate')}
          </span>
        );
      },
    },
  ];

  const copy = action ? describeAction(action) : null;

  return (
    <>
      <DataTable
        caption="Staff users"
        searchLabel="Search staff users"
        columns={columns}
        rows={users.isError ? undefined : users.data}
        isLoading={users.isLoading}
        error={
          users.isError
            ? {
                title: 'We could not load the users',
                hint: 'Check your connection, then try again. If it keeps failing, ask engineering.',
                onRetry: () => void users.refetch(),
              }
            : null
        }
        getRowId={(u) => u.id}
        defaultSort={{ columnId: 'name', direction: 'asc' }}
        empty={{
          title: 'No staff users yet',
          hint: 'Invite the first person to get started.',
          action: <Button onClick={() => setInviteOpen(true)}>Invite a user</Button>,
        }}
        toolbar={
          <>
            <Button variant="outline" onClick={() => setLockEventsOpen(true)}>
              Recent lockouts
            </Button>
            <Button disabled={inFlight} onClick={() => setInviteOpen(true)}>
              Invite a user
            </Button>
          </>
        }
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} exclusive={exclusive} />
      <LockEventsDialog open={lockEventsOpen} onOpenChange={setLockEventsOpen} />
      {action && copy ? (
        <StepUpDialog
          open
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
          title={copy.title}
          description={copy.description}
          submitLabel={copy.submitLabel}
          destructive={copy.destructive}
          onRun={(password) => exclusive(() => runAction(action, password))}
        />
      ) : null}
    </>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  exclusive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exclusive: (run: () => Promise<StepUpOutcome>) => Promise<StepUpOutcome>;
}): React.JSX.Element {
  const qc = useQueryClient();
  // Step 1 collects the person's details; step 2 asks for the admin's password and sends.
  const [details, setDetails] = React.useState<InviteDetails | null>(null);
  // While the invitation is being sent the dialog cannot be dismissed: the answer must be seen.
  const [sending, setSending] = React.useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteStaffValues>({
    resolver: zodResolver(inviteStaffSchema),
    defaultValues: { email: '', name: '', role: 'RECRUITER' },
  });

  function close(): void {
    reset();
    setDetails(null);
    onOpenChange(false);
  }

  async function send(password: string): Promise<StepUpOutcome> {
    const current = details;
    if (!current)
      return { kind: 'failed', title: 'Nothing to send', hint: 'Go back and fill in the details.' };
    setSending(true);
    try {
      return await exclusive(async () => {
        const out = await inviteStaffUser(qc, current, password);
        if (out.kind === 'done') {
          toast.success(
            `Invitation sent to ${out.user?.email ?? current.email}. The link lets them set a password.`,
          );
        }
        return out;
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !sending) close();
        else if (next) onOpenChange(true);
      }}
    >
      <DialogContent>
        {details ? (
          <>
            <DialogTitle>Confirm with your password</DialogTitle>
            <DialogDescription>
              {`We will email ${details.email} a link to set a password. Enter your own password to send the invitation.`}
            </DialogDescription>
            <StepUpForm
              submitLabel="Send invitation"
              onRun={send}
              onDone={close}
              onCancel={() => setDetails(null)}
              cancelLabel="Back"
            />
          </>
        ) : (
          <>
            <DialogTitle>Invite a user</DialogTitle>
            <DialogDescription>
              They get an email with a link to set a password. You confirm with your own password in
              the next step.
            </DialogDescription>
            <form
              onSubmit={(e) => void handleSubmit((values) => setDetails(values))(e)}
              noValidate
              className="mt-4 space-y-4"
            >
              <Field id="invite-name" label="Full name" error={errors.name?.message}>
                {(aria) => <Input {...aria} autoComplete="off" {...register('name')} />}
              </Field>
              <Field id="invite-email" label="Work email" error={errors.email?.message}>
                {(aria) => (
                  <Input {...aria} type="email" autoComplete="off" {...register('email')} />
                )}
              </Field>
              <Field
                id="invite-role"
                label="Role"
                hint="Recruiters build tests and invite candidates. Authors write questions. Reviewers decide on flags. Super Admins manage settings."
                error={errors.role?.message}
              >
                {(aria) => (
                  <Select {...aria} className="w-full" {...register('role')}>
                    {USER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit">Continue</Button>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** FR-101, P-03: who was locked out recently, newest first. Read only; no password needed. */
function LockEventsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const events = useLockEvents(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogTitle>Recent lockouts</DialogTitle>
        <DialogDescription>
          Accounts that were locked after too many wrong passwords, newest first. A locked account
          unlocks by itself after 15 minutes, or you can unlock it from the users table.
        </DialogDescription>
        <div className="mt-4">
          {events.isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading lockouts…
            </p>
          ) : events.isError ? (
            <Alert tone="error" role="alert" title="We could not load the lockouts">
              Check your connection, then{' '}
              <button type="button" className="underline" onClick={() => void events.refetch()}>
                try again
              </button>
              .
            </Alert>
          ) : events.data && events.data.items.length > 0 ? (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Recent account lockouts</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Person
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Locked at
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.data.items.map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3">
                      {e.name ?? 'Unknown user'}
                      {e.email ? (
                        <span className="block text-muted-foreground">{e.email}</span>
                      ) : null}
                    </td>
                    <td className="py-1.5">
                      <time dateTime={e.lockedAt}>
                        {new Date(e.lockedAt).toLocaleString([], {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">
              No accounts have been locked out recently.
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
