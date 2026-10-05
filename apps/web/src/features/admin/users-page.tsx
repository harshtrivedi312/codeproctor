'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { USER_ROLES } from '@codeproctor/shared';
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
import type { Schemas } from '@/lib/api/client';
import { ConfirmDialog } from './confirm-dialog';
import { formatDate } from './format';
import { ApiFailure, useInviteUser, useStaffUsers, useUpdateUser } from './queries';
import { inviteStaffSchema, type InviteStaffValues } from './schemas';
import { SettingsFrame } from './settings-frame';

type StaffUser = Schemas['StaffUser'];

const STATUS_TONE = { active: 'success', invited: 'warning', deactivated: 'neutral' } as const;
const STATUS_LABEL = { active: 'Active', invited: 'Invited', deactivated: 'Deactivated' } as const;

/** FR-103: Super Admin manages users. Invite, change role, deactivate. */
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

function UsersContent(): React.JSX.Element {
  const { user: me } = useAuth();
  const users = useStaffUsers();
  const update = useUpdateUser();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [toDeactivate, setToDeactivate] = React.useState<StaffUser | null>(null);

  // The select only stages a choice; nothing is sent until the user confirms in the dialog.
  const [roleChange, setRoleChange] = React.useState<{
    user: StaffUser;
    role: Schemas['StaffRole'];
  } | null>(null);

  function confirmRoleChange(): void {
    const target = roleChange;
    if (!target) return;
    const { user, role } = target;
    update.mutate(
      { id: user.id, role },
      {
        onSuccess: () => toast.success(`${user.name} is now ${ROLE_LABELS[role]}.`),
        onError: (e) =>
          toast.error(
            e instanceof ApiFailure && e.status === 409
              ? 'This role change is not allowed. You cannot change your own role, and the last Super Admin cannot be changed. Ask another Super Admin if you need this.'
              : 'Could not change the role. Check your connection and try again.',
          ),
        onSettled: () => setRoleChange(null),
      },
    );
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
        const locked = u.id === me?.id || u.status === 'deactivated';
        return (
          <Select
            aria-label={`Role for ${u.name}`}
            className="h-8"
            value={u.role}
            disabled={locked || update.isPending}
            title={u.id === me?.id ? 'You cannot change your own role.' : undefined}
            onChange={(e) => {
              const role = e.target.value as Schemas['StaffRole'];
              if (role !== u.role) setRoleChange({ user: u, role });
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
      id: 'lastLogin',
      header: 'Last sign-in',
      sortValue: (u) => u.lastLoginAt ?? null,
      searchValue: () => '',
      cell: (u) => formatDate(u.lastLoginAt),
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
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { id: u.id, active: true },
                {
                  onSuccess: () => toast.success(`${u.name} can sign in again.`),
                  onError: () => toast.error('Could not reactivate. Try again in a moment.'),
                },
              )
            }
          >
            Reactivate<span className="sr-only"> {u.name}</span>
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setToDeactivate(u)}>
            Deactivate<span className="sr-only"> {u.name}</span>
          </Button>
        ),
    },
  ];

  return (
    <>
      <DataTable
        caption="Staff users"
        searchLabel="Search staff users"
        columns={columns}
        rows={users.data}
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
        toolbar={<Button onClick={() => setInviteOpen(true)}>Invite a user</Button>}
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog
        open={roleChange !== null}
        onOpenChange={(open) => {
          if (!open) setRoleChange(null);
        }}
        title={
          roleChange
            ? `Change ${roleChange.user.name} from ${ROLE_LABELS[roleChange.user.role]} to ${ROLE_LABELS[roleChange.role]}?`
            : 'Change role?'
        }
        description={
          roleChange &&
          (roleChange.user.role === 'SUPER_ADMIN' || roleChange.role === 'SUPER_ADMIN')
            ? roleChange.role === 'SUPER_ADMIN'
              ? 'Super Admins can manage users, settings and data retention for your whole organisation. Only give this role to someone you trust with that.'
              : 'They will lose access to user management and organisation settings straight away.'
            : 'Their access changes straight away. You can change it back at any time.'
        }
        confirmLabel="Change role"
        pending={update.isPending}
        onConfirm={confirmRoleChange}
      />
      <ConfirmDialog
        open={toDeactivate !== null}
        onOpenChange={(open) => {
          if (!open) setToDeactivate(null);
        }}
        title={`Deactivate ${toDeactivate?.name ?? ''}?`}
        description="They are signed out everywhere and cannot sign in until you reactivate them. Their past work stays in the audit log."
        confirmLabel="Deactivate"
        destructive
        pending={update.isPending}
        onConfirm={() => {
          const target = toDeactivate;
          if (!target) return;
          update.mutate(
            { id: target.id, active: false },
            {
              onSuccess: () => {
                toast.success(`${target.name} was deactivated.`);
                setToDeactivate(null);
              },
              onError: (e) => {
                toast.error(
                  e instanceof ApiFailure && e.status === 409
                    ? 'This user cannot be deactivated (for example the last Super Admin). Give another person the role first.'
                    : 'Could not deactivate. Try again in a moment.',
                );
                setToDeactivate(null);
              },
            },
          );
        }}
      />
    </>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const invite = useInviteUser();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteStaffValues>({
    resolver: zodResolver(inviteStaffSchema),
    defaultValues: { email: '', name: '', role: 'RECRUITER' },
  });

  function onSubmit(values: InviteStaffValues): void {
    setServerError(null);
    invite.mutate(values, {
      onSuccess: (user) => {
        toast.success(`Invitation sent to ${user.email}. The link lets them set a password.`);
        reset();
        onOpenChange(false);
      },
      onError: (e) =>
        setServerError(
          e instanceof ApiFailure && e.status === 409
            ? 'Someone with this email already has an account. Use a different email, or change their role in the table.'
            : 'We could not send the invitation. Check your connection and try again.',
        ),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setServerError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Invite a user</DialogTitle>
        <DialogDescription>
          They get an email with a link to set a password. Super Admins and Reviewers must also set
          up two-factor sign-in.
        </DialogDescription>
        <form
          onSubmit={(e) => void handleSubmit(onSubmit)(e)}
          noValidate
          className="mt-4 space-y-4"
        >
          {serverError ? (
            <Alert tone="error" role="alert" title="Invitation not sent">
              {serverError}
            </Alert>
          ) : null}
          <Field id="invite-name" label="Full name" error={errors.name?.message}>
            {(aria) => <Input {...aria} autoComplete="off" {...register('name')} />}
          </Field>
          <Field id="invite-email" label="Work email" error={errors.email?.message}>
            {(aria) => <Input {...aria} type="email" autoComplete="off" {...register('email')} />}
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? 'Sending…' : 'Send invitation'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
