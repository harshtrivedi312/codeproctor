'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { USER_ROLES } from '@codeproctor/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/data-table/data-table';
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
import { formatDate } from './format';
import { useStaffUsers } from './queries';
import { inviteStaffSchema, type InviteStaffValues } from './schemas';
import { inviteStaffUser, updateStaffUser, type InviteDetails } from './user-actions';
import { SettingsFrame } from './settings-frame';

type StaffUser = Schemas['StaffUser'];

const STATUS_TONE = { active: 'success', invited: 'warning', deactivated: 'neutral' } as const;
const STATUS_LABEL = { active: 'Active', invited: 'Invited', deactivated: 'Deactivated' } as const;

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
  | { kind: 'reactivate'; user: StaffUser };

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
    const out = await updateStaffUser(
      qc,
      user.id,
      current.kind === 'role' ? { role: current.role } : { active: current.kind === 'reactivate' },
      password,
    );
    if (out.kind === 'done') {
      toast.success(
        current.kind === 'role'
          ? `${user.name} is now ${ROLE_LABELS[current.role]}.`
          : current.kind === 'deactivate'
            ? `${user.name} was deactivated.`
            : `${user.name} can sign in again.`,
      );
    }
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
          { value: 'invited', label: 'Invited' },
          { value: 'deactivated', label: 'Deactivated' },
        ],
      },
      cell: (u) => <Badge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Badge>,
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
      cell: (u) =>
        u.id === me?.id ? (
          <span className="text-muted-foreground">—</span>
        ) : u.status === 'deactivated' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={inFlight}
            onClick={() => setAction({ kind: 'reactivate', user: u })}
          >
            Reactivate<span className="sr-only"> {u.name}</span>
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={inFlight}
            onClick={() => setAction({ kind: 'deactivate', user: u })}
          >
            Deactivate<span className="sr-only"> {u.name}</span>
          </Button>
        ),
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
          <Button disabled={inFlight} onClick={() => setInviteOpen(true)}>
            Invite a user
          </Button>
        }
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} exclusive={exclusive} />
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
            <DialogTitle>Confirm the invitation</DialogTitle>
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
