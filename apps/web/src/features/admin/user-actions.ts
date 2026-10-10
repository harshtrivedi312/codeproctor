import type { QueryClient } from '@tanstack/react-query';
import { BUSY_CODE } from '@/lib/api/busy';
import { api, type Schemas } from '@/lib/api/client';
import { REAUTH_FAILED_CODE } from '@/features/security/schemas';
import type { StepUpOutcome } from '@/features/security/step-up-dialog';
import { adminKeys, checkInviteOutcome, INVITE_UNKNOWN_TEXT } from './queries';

/*
 * The password-protected staff writes (FR-103; docs/api-contract.md section 6): invite, role
 * change, deactivate and reactivate. Each one sends the admin's own `currentPassword`.
 *
 * These are plain functions, not TanStack mutations, on purpose: a mutation keeps its variables
 * (the password) in the mutation cache. Here the password is a call argument that is dropped when
 * the call settles. Nothing is logged. Every answer becomes a StepUpOutcome in words, with a hint.
 */

type StaffRole = Schemas['StaffRole'];
type StaffUser = Schemas['StaffUser'];

export type UserActionContext = 'invite' | 'role' | 'deactivate' | 'reactivate';

interface Answer<T> {
  /** 0 when the request never got an answer (offline, aborted). */
  status: number;
  code: string;
  data: T | undefined;
}

interface Raw<T> {
  data?: T | undefined;
  error?: { code?: string } | undefined;
  response: Response;
}

/** A write that has not answered after this long is given up on (the answer is then unknown). */
const WRITE_TIMEOUT_MS = 20_000;

async function send<T>(call: (signal: AbortSignal) => Promise<Raw<T>>): Promise<Answer<T>> {
  // One deadline for the whole call, so a hung request cannot freeze the screen. The abort, like
  // an offline error, is status 0: the write may or may not have landed.
  // The deadline covers the requests, not the wait inside refreshForReplay (a refresh has its own).
  const signal = AbortSignal.timeout(WRITE_TIMEOUT_MS);
  try {
    const { data, error, response } = await call(signal);
    return {
      status: response.status,
      code: typeof error?.code === 'string' ? error.code : '',
      data,
    };
  } catch {
    return { status: 0, code: '', data: undefined };
  }
}

const NOT_DONE = 'Nothing was changed.';

/** What each status means for each action. Clients branch on status and `code`, never on `detail`. */
const CONFLICT: Record<UserActionContext, { title: string; hint: string }> = {
  invite: {
    title: 'That email already has an account',
    hint: 'Use a different email, or change their role in the table. The address may belong to an account in another organisation.',
  },
  role: {
    title: 'This role change is not allowed',
    hint: 'You cannot change your own role, and the last Super Admin cannot be changed. Ask another Super Admin if you need this.',
  },
  deactivate: {
    title: 'This user cannot be deactivated',
    hint: 'You cannot deactivate yourself, and the last Super Admin cannot be deactivated. Give another person the role first.',
  },
  reactivate: {
    title: 'This user cannot be reactivated',
    hint: 'Reload the page to see their current status.',
  },
};

const ACTION_FAILED: Record<UserActionContext, string> = {
  invite: 'We could not send the invitation',
  role: 'We could not change the role',
  deactivate: 'We could not deactivate this user',
  reactivate: 'We could not reactivate this user',
};

/** Maps one non-2xx answer to words. Never says which part of a sign-in check failed. */
function describe(answer: Answer<unknown>, context: UserActionContext): StepUpOutcome {
  const { status, code } = answer;
  if (status === 403) {
    if (code === REAUTH_FAILED_CODE) return { kind: 'wrong' };
    // A guard 403 has no code: a permission problem, not a password problem.
    return {
      kind: 'failed',
      title: 'Your role cannot do this',
      hint: 'Only Super Admins manage users. Ask a Super Admin if you think this is a mistake.',
    };
  }
  if (status === 401) {
    return {
      kind: 'failed',
      title: 'Your session has expired',
      hint: 'Sign in again, then try once more.',
    };
  }
  if (status === 400) {
    return {
      kind: 'failed',
      title: ACTION_FAILED[context],
      hint:
        context === 'invite'
          ? 'The server did not accept these details. Check the name, email and role, go back and fix them.'
          : 'The server did not accept this request. Reload the page and try again.',
    };
  }
  if (status === 404) {
    return {
      kind: 'failed',
      title: 'This user is no longer in your organisation',
      hint: 'Reload the page to see the current list.',
    };
  }
  if (status === 409) return { kind: 'failed', ...CONFLICT[context] };
  if (status === 429) {
    return {
      kind: 'failed',
      title: context === 'invite' ? 'Invitation limit reached' : 'Too many requests',
      hint:
        context === 'invite'
          ? `Your organisation has sent its hourly limit of invitations. ${NOT_DONE} Wait a while, then try again.`
          : `${NOT_DONE} Wait a minute, then try again.`,
    };
  }
  if (status === 503) {
    return code === BUSY_CODE
      ? {
          kind: 'failed',
          title: 'Please wait a moment',
          hint: 'The service is busy and nothing was changed. Wait a moment, then submit again.',
        }
      : {
          kind: 'failed',
          title: 'The service is temporarily unavailable',
          hint: `${NOT_DONE} Try again in a minute. If it keeps failing, ask engineering.`,
        };
  }
  if (status === 500) {
    return {
      kind: 'failed',
      title: 'We could not confirm the result',
      hint: 'Check the list before trying again: the change may already have happened. Nothing was retried for you.',
    };
  }
  if (status === 0) {
    // No answer (offline, or the deadline passed): the write may still have landed.
    return {
      kind: 'failed',
      tone: 'warning',
      title: 'We could not confirm the result',
      hint: 'We could not tell whether it was saved; check the list before trying again.',
    };
  }
  return {
    kind: 'failed',
    title: ACTION_FAILED[context],
    hint: 'Try again in a moment. If it keeps happening, ask engineering.',
  };
}

/** Marks the user list stale after an answer that tells us it may be out of date. */
function staleAfter(qc: QueryClient, status: number): void {
  if (
    (status >= 200 && status < 300) ||
    status === 0 ||
    status === 404 ||
    status === 409 ||
    status === 500
  ) {
    void qc.invalidateQueries({ queryKey: adminKeys.users });
  }
}

export interface InviteDetails {
  email: string;
  name: string;
  role: StaffRole;
}

export async function inviteStaffUser(
  qc: QueryClient,
  details: InviteDetails,
  currentPassword: string,
): Promise<StepUpOutcome & { user?: StaffUser }> {
  const answer = await send((signal) =>
    api.POST('/v1/admin/users', {
      signal,
      body: {
        currentPassword,
        email: details.email,
        name: details.name,
        role: details.role,
      },
    }),
  );
  staleAfter(qc, answer.status);
  if (answer.status === 201 && answer.data) return { kind: 'done', user: answer.data };
  if (answer.status === 500 || answer.status === 0) {
    // Outcome unknown (contract section 8): the row may exist and the mail may or may not have
    // gone out. Read the list, never send again for the user.
    const found = await checkInviteOutcome(qc, details.email);
    return {
      kind: 'failed',
      tone: 'warning',
      title: 'Invitation may have been sent',
      hint: INVITE_UNKNOWN_TEXT[found],
    };
  }
  return describe(answer, 'invite');
}

export async function updateStaffUser(
  qc: QueryClient,
  userId: string,
  change: { role: StaffRole } | { active: boolean },
  currentPassword: string,
): Promise<StepUpOutcome & { user?: StaffUser }> {
  const context: UserActionContext =
    'role' in change ? 'role' : change.active ? 'reactivate' : 'deactivate';
  const answer = await send((signal) =>
    api.PATCH('/v1/admin/users/{userId}', {
      signal,
      params: { path: { userId } },
      body: { currentPassword, ...change },
    }),
  );
  staleAfter(qc, answer.status);
  if (answer.status === 200 && answer.data) return { kind: 'done', user: answer.data };
  return describe(answer, context);
}
