import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as React from 'react';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/features/auth/auth-provider';
import { MOCK_USERS, seedMockRefresh } from '@/mocks/auth-handlers';
import { retryCopies } from '@/lib/api/client';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { findLoadedRow } from '@/test/table-utils';
import { UsersPage } from './users-page';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  // Spies on AbortSignal.timeout and retryCopies.set must not leak out of a failed test.
  vi.restoreAllMocks();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const PASSWORD = MOCK_USERS.admin.password;
const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

/** Who the screen thinks is signed in, so a test can prove a wrong password did not sign anyone out. */
const seen: { user: unknown } = { user: undefined };
function WhoAmI(): null {
  const { user } = useAuth();
  React.useEffect(() => {
    seen.user = user;
  });
  return null;
}

let client: QueryClient;
function renderUsers() {
  seedMockRefresh(MOCK_USERS.admin.email);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  nav.pathname = '/admin/settings/users';
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <WhoAmI />
        <UsersPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
/** Records every staff write to /admin/users, and every auth call that would end a session. */
function watchWrites(): { writes: Seen[]; authCalls: string[]; stop: () => void } {
  const writes: Seen[] = [];
  const authCalls: string[] = [];
  const listener = ({ request }: { request: Request }) => {
    const { pathname } = new URL(request.url);
    if (
      request.method !== 'GET' &&
      (pathname.includes('/admin/users') || pathname.includes('/auth/2fa/reset/'))
    ) {
      void request
        .clone()
        .json()
        .then((body: Record<string, unknown>) =>
          writes.push({ method: request.method, path: pathname, body }),
        );
    }
    if (/\/auth\/(refresh|logout)$/.test(pathname)) authCalls.push(pathname);
  };
  server.events.on('request:start', listener);
  return { writes, authCalls, stop: () => server.events.removeListener('request:start', listener) };
}

async function openRoleChange(u: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await findLoadedRow('Casey Newhire');
  await u.selectOptions(screen.getByLabelText('Role for Avery Author'), 'RECRUITER');
  return screen.findByRole('dialog');
}

describe('Users: password step-up (FR-103, FR-102, TC-002)', () => {
  it('FR-103 FR-102: a role change sends currentPassword and only the fields the API accepts', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    const dialog = await openRoleChange(u);
    expect(dialog).toHaveTextContent('Confirm with your password');
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Role for Avery Author')).toHaveValue('RECRUITER'),
    );
    await waitFor(() => expect(watch.writes).toHaveLength(1));
    expect(watch.writes[0]).toEqual({
      method: 'PATCH',
      path: expect.stringMatching(/\/admin\/users\/user-author$/) as string,
      body: { currentPassword: PASSWORD, role: 'RECRUITER' },
    });
    watch.stop();
  });

  it('FR-102 FR-103: a wrong password says "Password incorrect", keeps the dialog open, clears the field and does not sign out', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    const dialog = await openRoleChange(u);
    await waitFor(() => expect(seen.user).toBeTruthy());
    const before = watch.authCalls.length;
    await u.type(within(dialog).getByLabelText('Your password'), 'not-my-password');
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await within(dialog).findByText('Password incorrect')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Your password')).toHaveValue('');
    expect(screen.getByLabelText('Role for Avery Author')).toHaveValue('AUTHOR');
    // Still signed in, and nothing refreshed or logged out because of the 403.
    expect(seen.user).toBeTruthy();
    expect(watch.authCalls.length).toBe(before);
    // The right password then works in the same dialog.
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Role for Avery Author')).toHaveValue('RECRUITER');
    watch.stop();
  });

  it('FR-101 TC-002: a locked admin account gets the same "Password incorrect" even with the right password', async () => {
    server.use(
      http.patch('*/v1/admin/users/:id', ({ request }) =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'The current password is incorrect.',
            instance: new URL(request.url).pathname,
            traceId: 't',
            code: 'REAUTH_FAILED',
          },
          { status: 403 },
        ),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    const dialog = await openRoleChange(u);
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await within(dialog).findByText('Password incorrect')).toBeInTheDocument();
    expect(seen.user).toBeTruthy();
  });

  it('FR-103: a 403 without a code is a permission message, not a password message', async () => {
    server.use(
      http.patch('*/v1/admin/users/:id', () =>
        HttpResponse.json({ title: 'Forbidden', status: 403 }, { status: 403 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    const dialog = await openRoleChange(u);
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your role cannot do this');
    expect(within(dialog).queryByText('Password incorrect')).not.toBeInTheDocument();
  });

  it('FR-102: the password step needs a password and never sends an empty one', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    const dialog = await openRoleChange(u);
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await within(dialog).findByText('Enter your current password.')).toBeInTheDocument();
    expect(watch.writes).toHaveLength(0);
    watch.stop();
  });

  it('FR-102: the password is gone when the dialog is closed and reopened, and never in the mutation cache', async () => {
    const u = userEvent.setup();
    renderUsers();
    const dialog = await openRoleChange(u);
    await u.type(within(dialog).getByLabelText('Your password'), 'half-typed');
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await u.selectOptions(screen.getByLabelText('Role for Avery Author'), 'REVIEWER');
    const again = await screen.findByRole('dialog');
    expect(within(again).getByLabelText('Your password')).toHaveValue('');
    await u.type(within(again).getByLabelText('Your password'), PASSWORD);
    await u.click(within(again).getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Neither the mutation cache nor the query cache holds the password.
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(PASSWORD);
    expect(window.location.href).not.toContain(PASSWORD);
    // Never in web storage either.
    expect(JSON.stringify({ ...localStorage })).not.toContain(PASSWORD);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(PASSWORD);
  });

  it('FR-103 FR-102: invite is two steps (details, then password) and sends only the DTO fields', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), '  Jo Newperson ');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.selectOptions(within(dialog).getByLabelText('Role'), 'REVIEWER');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(watch.writes).toHaveLength(0);
    await u.type(await within(dialog).findByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(watch.writes).toHaveLength(1);
    expect(watch.writes[0]?.body).toEqual({
      currentPassword: PASSWORD,
      email: 'jo@example.test',
      name: 'Jo Newperson',
      role: 'REVIEWER',
    });
    expect(await findLoadedRow('Jo Newperson')).toBeInTheDocument();
    watch.stop();
  });

  it('FR-103: invite with a wrong password stays on the password step; Back keeps what was typed', async () => {
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo Newperson');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('Your password'), 'nope');
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText('Password incorrect')).toBeInTheDocument();
    expect(seen.user).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByLabelText('Full name')).toHaveValue('Jo Newperson');
    expect(within(dialog).getByLabelText('Work email')).toHaveValue('jo@example.test');
  });

  it('FR-103: the real name limit is 200 and the email limit 254', async () => {
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByLabelText('Full name'));
    await u.paste('a'.repeat(201));
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('Use at most 200 characters.')).toBeInTheDocument();
  });

  it('FR-103: a 429 on invite names the hourly limit and says nothing was sent', async () => {
    server.use(
      http.post('*/v1/admin/users', () =>
        HttpResponse.json({ title: 'Too Many Requests', status: 429 }, { status: 429 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Invitation limit reached');
  });

  it('FR-103: a 400 from the server is explained, not shown as a crash', async () => {
    server.use(
      http.post('*/v1/admin/users', () =>
        HttpResponse.json({ title: 'Bad Request', status: 400, errors: ['x'] }, { status: 400 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Check the name, email');
  });

  it('FR-103: password-protected actions run one at a time: other controls are disabled while one is pending', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.patch('*/v1/admin/users/:id', async () => {
        await gate;
        return HttpResponse.json({ error: 'late' }, { status: 500 });
      }),
    );
    const u = userEvent.setup();
    renderUsers();
    const dialog = await openRoleChange(u);
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Checking…' })).toBeDisabled(),
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText('Role for Riley Recruiter')).toBeDisabled());
    release();
    await within(dialog).findByRole('alert');
    await waitFor(() => expect(screen.getByLabelText('Role for Riley Recruiter')).toBeEnabled());
  });

  it('FR-103: reactivating asks for the password too', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    await findLoadedRow('Casey Newhire');
    await u.click(within(rowOf('Dana Departed')).getByRole('button', { name: /Reactivate/ }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() =>
      expect(within(rowOf('Dana Departed')).getByText('Active')).toBeInTheDocument(),
    );
    expect(watch.writes[0]?.body).toEqual({ currentPassword: PASSWORD, active: true });
    watch.stop();
  });

  it('WCAG 2.1 AA: the password step has no axe violations', async () => {
    const u = userEvent.setup();
    renderUsers();
    const dialog = await openRoleChange(u);
    await within(dialog).findByLabelText('Your password');
    expect(await axe(dialog)).toHaveNoViolations();
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await within(dialog).findByText('Enter your current password.');
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('WCAG 2.1 AA: the invite password step has no axe violations', async () => {
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await within(dialog).findByLabelText('Your password');
    expect(await axe(dialog)).toHaveNoViolations();
  });
});

const AUTHOR_UPDATED = {
  id: 'user-author',
  email: 'author@example.test',
  name: 'Avery Author',
  role: 'RECRUITER',
  status: 'active',
  locked: false,
  lockedUntil: null,
  totpEnabled: false,
  createdAt: '2026-06-03T09:00:00.000Z',
};

/** Counts the PATCH calls and keeps their bodies, answering with `answer(n)`. */
function patchSequence(answer: (n: number) => Response): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  server.use(
    http.patch('*/v1/admin/users/:id', async ({ request }) => {
      bodies.push(await request.json());
      return answer(bodies.length);
    }),
  );
  return { bodies };
}

const busyAnswer = () =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'BUSY' },
    { status: 503, headers: { 'Retry-After': '1' } },
  );

describe('Users: risky paths of a password-protected write (FR-102, FR-103)', () => {
  async function submitRoleChange(u: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    const dialog = await openRoleChange(u);
    await waitFor(() => expect(seen.user).toBeTruthy());
    return dialog;
  }
  async function send(u: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> {
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
  }

  it('FR-102: a 401 refreshes once and replays the write exactly once with the same body', async () => {
    const u = userEvent.setup();
    renderUsers();
    const calls = patchSequence((n) =>
      n === 1
        ? HttpResponse.json({ title: 'Unauthorized', status: 401 }, { status: 401 })
        : HttpResponse.json(AUTHOR_UPDATED),
    );
    let refreshes = 0;
    const dialog = await submitRoleChange(u);
    const count = ({ request }: { request: Request }) => {
      if (request.url.endsWith('/auth/refresh')) refreshes += 1;
    };
    server.events.on('request:start', count);
    await send(u, dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    server.events.removeListener('request:start', count);
    expect(calls.bodies).toHaveLength(2);
    expect(calls.bodies[1]).toEqual(calls.bodies[0]);
    expect(calls.bodies[0]).toEqual({ currentPassword: PASSWORD, role: 'RECRUITER' });
    expect(refreshes).toBe(1);
  });

  it('FR-102 FR-104: a 401 whose refresh fails sends no second request and signs the user out', async () => {
    const u = userEvent.setup();
    renderUsers();
    const calls = patchSequence(() =>
      HttpResponse.json({ title: 'Unauthorized', status: 401 }, { status: 401 }),
    );
    const dialog = await submitRoleChange(u);
    server.use(
      http.post('*/v1/auth/refresh', () =>
        HttpResponse.json({ title: 'Unauthorized', status: 401 }, { status: 401 }),
      ),
    );
    await send(u, dialog);
    await waitFor(() => expect(seen.user).toBeFalsy());
    expect(calls.bodies).toHaveLength(1);
  });

  it('FR-103 TC-005: a refresh that answers as another person sends no second request', async () => {
    const u = userEvent.setup();
    renderUsers();
    const calls = patchSequence(() =>
      HttpResponse.json({ title: 'Unauthorized', status: 401 }, { status: 401 }),
    );
    const dialog = await submitRoleChange(u);
    seedMockRefresh(MOCK_USERS.reviewer.email);
    await send(u, dialog);
    await waitFor(() => expect(calls.bodies).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.bodies).toHaveLength(1);
  });

  it('FR-102: the copy kept for a 401 replay is dropped when the call settles', async () => {
    const keys: Request[] = [];
    const set = vi.spyOn(retryCopies, 'set').mockImplementation(function (this: unknown, k, v) {
      keys.push(k);
      return WeakMap.prototype.set.call(this, k, v) as typeof retryCopies;
    });
    const u = userEvent.setup();
    renderUsers();
    patchSequence(() => HttpResponse.json(AUTHOR_UPDATED));
    const dialog = await submitRoleChange(u);
    const before = keys.length;
    await send(u, dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const writes = keys.slice(before).filter((k) => k.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(retryCopies.has(writes[0]!)).toBe(false);
    // Also when the call never gets an answer.
    server.use(http.patch('*/v1/admin/users/:id', () => HttpResponse.error()));
    await u.selectOptions(screen.getByLabelText('Role for Riley Recruiter'), 'AUTHOR');
    const again = await screen.findByRole('dialog');
    const mark = keys.length;
    await u.type(within(again).getByLabelText('Your password'), PASSWORD);
    await u.click(within(again).getByRole('button', { name: 'Change role' }));
    await within(again).findByRole('alert');
    const failed = keys.slice(mark).filter((k) => k.method === 'PATCH');
    expect(failed).toHaveLength(1);
    expect(retryCopies.has(failed[0]!)).toBe(false);
    set.mockRestore();
  });

  it('FR-103: a 503 BUSY on a role change is sent exactly once and says to wait', async () => {
    const u = userEvent.setup();
    renderUsers();
    const calls = patchSequence(busyAnswer);
    const dialog = await submitRoleChange(u);
    await send(u, dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Please wait a moment');
    expect(alert).toHaveTextContent('busy and nothing was changed');
    expect(calls.bodies).toHaveLength(1);
  });

  it('FR-103: a 503 BUSY on invite is sent exactly once and says to wait', async () => {
    let posts = 0;
    server.use(
      http.post('*/v1/admin/users', () => {
        posts += 1;
        return busyAnswer();
      }),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Please wait a moment');
    expect(posts).toBe(1);
  });

  it('FR-103: no answer at all says the result is unconfirmed, not that nothing changed', async () => {
    patchSequence(() => HttpResponse.error());
    const u = userEvent.setup();
    renderUsers();
    const dialog = await submitRoleChange(u);
    await send(u, dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('We could not confirm the result');
    expect(alert).toHaveTextContent('check the list before trying again');
    expect(alert).not.toHaveTextContent('Nothing was changed');
  });

  it('FR-103: a request that hangs is given up on and the dialog can be used again', async () => {
    const deadline = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    server.use(http.patch('*/v1/admin/users/:id', () => new Promise<Response>(() => undefined)));
    const u = userEvent.setup();
    renderUsers();
    const dialog = await submitRoleChange(u);
    await send(u, dialog);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Checking…' })).toBeDisabled(),
    );
    let listReads = 0;
    const count = ({ request }: { request: Request }) => {
      if (request.method === 'GET' && request.url.includes('/admin/users')) listReads += 1;
    };
    server.events.on('request:start', count);
    deadline.abort();
    const alert = await within(dialog).findByRole('alert');
    // No answer: the list may be stale, so it is read again.
    await waitFor(() => expect(listReads).toBeGreaterThan(0));
    server.events.removeListener('request:start', count);
    expect(alert).toHaveTextContent('We could not confirm the result');
    expect(within(dialog).getByRole('button', { name: 'Change role' })).toBeEnabled();
    spy.mockRestore();
  });

  it('FR-103: an invite with no answer reads the list and does not claim nothing was sent', async () => {
    server.use(http.post('*/v1/admin/users', () => HttpResponse.error()));
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Jo');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await u.type(await within(dialog).findByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Invitation may have been sent');
    expect(alert).toHaveTextContent('may not have been created yet');
  });

  it('FR-103: a 409 on deactivate explains the last Super Admin rule', async () => {
    patchSequence(() => HttpResponse.json({ title: 'Conflict', status: 409 }, { status: 409 }));
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(within(rowOf('Robin Reviewer')).getByRole('button', { name: /Deactivate/ }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await u.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('This user cannot be deactivated');
    expect(alert).toHaveTextContent('last Super Admin');
  });
});

describe('Users: unlock, resend invite, two-factor reset, lockouts (FR-101, FR-102, FR-103, TC-002)', () => {
  it('FR-101 TC-002: a locked account shows "Locked until" and Unlock only there; unlocking asks for the password', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    await findLoadedRow('Lee Locked');
    expect(within(rowOf('Lee Locked')).getByText(/^Locked until /)).toBeInTheDocument();
    expect(within(rowOf('Lee Locked')).getByRole('button', { name: /Unlock/ })).toBeInTheDocument();
    expect(within(rowOf('Avery Author')).queryByRole('button', { name: /Unlock/ })).toBeNull();
    await u.click(within(rowOf('Lee Locked')).getByRole('button', { name: /Unlock/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, PASSWORD, 'Unlock');
    await waitFor(() =>
      expect(within(rowOf('Lee Locked')).queryByText(/^Locked until/)).not.toBeInTheDocument(),
    );
    expect(watch.writes[0]).toMatchObject({
      method: 'POST',
      path: expect.stringMatching(/\/admin\/users\/user-locked\/unlock$/) as string,
      body: { currentPassword: PASSWORD },
    });
    watch.stop();
  });

  it('FR-103: Resend invite appears only for a pending invite and sends currentPassword', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    await findLoadedRow('Casey Newhire');
    expect(within(rowOf('Casey Newhire')).getByText('Pending invite')).toBeInTheDocument();
    expect(within(rowOf('Avery Author')).queryByRole('button', { name: /Resend/ })).toBeNull();
    expect(within(rowOf('Dana Departed')).queryByRole('button', { name: /Resend/ })).toBeNull();
    await u.click(within(rowOf('Casey Newhire')).getByRole('button', { name: /Resend invite/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('earlier link stops working');
    await confirm(u, dialog, PASSWORD, 'Resend invite');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(watch.writes[0]).toMatchObject({
      path: expect.stringMatching(/\/admin\/users\/user-invited\/invite$/) as string,
      body: { currentPassword: PASSWORD },
    });
    watch.stop();
  });

  it('FR-103: resending to someone who already set a password is a 409 with a fix-it hint', async () => {
    server.use(
      http.post('*/v1/admin/users/:id/invite', () =>
        HttpResponse.json({ title: 'Conflict', status: 409 }, { status: 409 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(within(rowOf('Casey Newhire')).getByRole('button', { name: /Resend invite/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, PASSWORD, 'Resend invite');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already set a password');
  });

  it('FR-102: Reset two-factor shows only for accounts with 2FA on, warns about password-only sign-in, and sends currentPassword', async () => {
    const u = userEvent.setup();
    renderUsers();
    const watch = watchWrites();
    await findLoadedRow('Sam Secure');
    expect(
      within(rowOf('Avery Author')).queryByRole('button', { name: /Reset two-factor/ }),
    ).toBeNull();
    // Your own account has no actions: use the Security page.
    expect(within(rowOf('Alex Admin')).queryByRole('button')).toBeNull();
    await u.click(within(rowOf('Sam Secure')).getByRole('button', { name: /Reset two-factor/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('password-only sign-in');
    await confirm(u, dialog, PASSWORD, 'Reset two-factor');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(watch.writes).toHaveLength(1));
    expect(watch.writes[0]).toMatchObject({
      path: expect.stringMatching(/\/auth\/2fa\/reset\/user-secure$/) as string,
      body: { currentPassword: PASSWORD },
    });
    await waitFor(() =>
      expect(
        within(rowOf('Sam Secure')).queryByRole('button', { name: /Reset two-factor/ }),
      ).toBeNull(),
    );
    watch.stop();
  });

  it('FR-102: a wrong password on the 2FA reset says "Password incorrect", stays open and keeps you signed in', async () => {
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Sam Secure');
    await u.click(within(rowOf('Sam Secure')).getByRole('button', { name: /Reset two-factor/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, 'wrong-password', 'Reset two-factor');
    expect(await within(dialog).findByText('Password incorrect')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Your password')).toHaveValue('');
    expect(seen.user).toBeTruthy();
  });

  it('FR-102: the fixed 500 on a 2FA reset is not retried and the list says what happened', async () => {
    let posts = 0;
    server.use(
      http.post('*/v1/auth/2fa/reset/:id', () => {
        posts += 1;
        return HttpResponse.json({ title: 'Internal Server Error', status: 500 }, { status: 500 });
      }),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Sam Secure');
    await u.click(within(rowOf('Sam Secure')).getByRole('button', { name: /Reset two-factor/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, PASSWORD, 'Reset two-factor');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('We could not confirm the reset');
    expect(alert).toHaveTextContent('still shows as on');
    expect(posts).toBe(1);
  });

  it('FR-101: Recent lockouts lists who was locked, newest first, with no password step', async () => {
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Recent lockouts' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Lee Locked')).toBeInTheDocument();
    const rows = within(dialog).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Lee Locked');
    expect(rows[2]).toHaveTextContent('Robin Reviewer');
    expect(rows[3]).toHaveTextContent('Unknown user');
    expect(within(dialog).queryByLabelText('Your password')).toBeNull();
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('FR-101: a lockouts load failure says what to do', async () => {
    server.use(http.get('*/v1/admin/users/lock-events', () => HttpResponse.error()));
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Recent lockouts' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('try again');
  });

  it('FR-103: unlocking a user who is gone is a 404 with a reload hint', async () => {
    server.use(
      http.post('*/v1/admin/users/:id/unlock', () =>
        HttpResponse.json({ title: 'Not Found', status: 404 }, { status: 404 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Lee Locked');
    await u.click(within(rowOf('Lee Locked')).getByRole('button', { name: /Unlock/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, PASSWORD, 'Unlock');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('no longer in your organisation');
    expect(alert).toHaveTextContent('Reload the page');
  });

  it('FR-102: unlock with a wrong password says "Password incorrect" and keeps you signed in', async () => {
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Lee Locked');
    await u.click(within(rowOf('Lee Locked')).getByRole('button', { name: /Unlock/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, 'wrong-password', 'Unlock');
    expect(await within(dialog).findByText('Password incorrect')).toBeInTheDocument();
    expect(seen.user).toBeTruthy();
  });

  it('FR-103 TC-004: a guard 403 on unlock is a permission message, not a password one', async () => {
    server.use(
      http.post('*/v1/admin/users/:id/unlock', () =>
        HttpResponse.json({ title: 'Forbidden', status: 403 }, { status: 403 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Lee Locked');
    await u.click(within(rowOf('Lee Locked')).getByRole('button', { name: /Unlock/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, PASSWORD, 'Unlock');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your role cannot do this');
  });

  it('FR-103: a 429 on resend names the hourly invitation limit', async () => {
    server.use(
      http.post('*/v1/admin/users/:id/invite', () =>
        HttpResponse.json({ title: 'Too Many Requests', status: 429 }, { status: 429 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(within(rowOf('Casey Newhire')).getByRole('button', { name: /Resend invite/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, PASSWORD, 'Resend invite');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Invitation limit reached');
    expect(alert).toHaveTextContent('hourly limit');
  });

  it('FR-103: an unconfirmed resend (500) says no email was sent and to use Resend invite again', async () => {
    server.use(
      http.post('*/v1/admin/users/:id/invite', () =>
        HttpResponse.json({ title: 'Internal Server Error', status: 500 }, { status: 500 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Casey Newhire');
    await u.click(within(rowOf('Casey Newhire')).getByRole('button', { name: /Resend invite/ }));
    const dialog = await screen.findByRole('dialog');
    await confirm(u, dialog, PASSWORD, 'Resend invite');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('No email was sent');
    expect(alert).toHaveTextContent('Use Resend invite to make a new link');
  });

  it('FR-102: a 500 on the 2FA reset whose list shows two-factor off says it went through', async () => {
    server.use(
      http.post('*/v1/auth/2fa/reset/:id', () =>
        HttpResponse.json({ title: 'Internal Server Error', status: 500 }, { status: 500 }),
      ),
    );
    const u = userEvent.setup();
    renderUsers();
    await findLoadedRow('Sam Secure');
    await u.click(within(rowOf('Sam Secure')).getByRole('button', { name: /Reset two-factor/ }));
    const dialog = await screen.findByRole('dialog');
    server.use(
      http.get('*/v1/admin/users', () =>
        HttpResponse.json({
          items: [
            {
              id: 'user-secure',
              email: 'sam.secure@example.test',
              name: 'Sam Secure',
              role: 'AUTHOR',
              status: 'active',
              locked: false,
              lockedUntil: null,
              totpEnabled: false,
              createdAt: '2026-06-06T09:00:00.000Z',
            },
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      ),
    );
    await confirm(u, dialog, PASSWORD, 'Reset two-factor');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('so the reset went through');
  });

  it('WCAG 2.1 AA: the users table with lock, resend and reset actions has no axe violations', async () => {
    const { container } = renderUsers();
    await findLoadedRow('Lee Locked');
    expect(await axe(container)).toHaveNoViolations();
  });
});

async function confirm(
  u: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  password: string,
  submit: string,
): Promise<void> {
  await u.type(await within(dialog).findByLabelText('Your password'), password);
  await u.click(within(dialog).getByRole('button', { name: submit }));
}

describe('Users: 2FA reset 401 replay and unknown-outcome guard (FR-102)', () => {
  async function openReset(u: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await findLoadedRow('Sam Secure');
    await waitFor(() => expect(seen.user).toBeTruthy());
    await u.click(within(rowOf('Sam Secure')).getByRole('button', { name: /Reset two-factor/ }));
    return screen.findByRole('dialog');
  }
  function resetSequence(answer: (n: number) => Response): { bodies: unknown[] } {
    const bodies: unknown[] = [];
    server.use(
      http.post('*/v1/auth/2fa/reset/:id', async ({ request }) => {
        bodies.push(await request.json());
        return answer(bodies.length);
      }),
    );
    return { bodies };
  }
  const unauthorized = () =>
    HttpResponse.json({ title: 'Unauthorized', status: 401 }, { status: 401 });

  it('FR-102: a 401 on the reset refreshes once and replays the same body once', async () => {
    const u = userEvent.setup();
    renderUsers();
    const calls = resetSequence((n) =>
      n === 1 ? unauthorized() : new HttpResponse(null, { status: 204 }),
    );
    const dialog = await openReset(u);
    let refreshes = 0;
    const count = ({ request }: { request: Request }) => {
      if (request.url.endsWith('/auth/refresh')) refreshes += 1;
    };
    server.events.on('request:start', count);
    await confirm(u, dialog, PASSWORD, 'Reset two-factor');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    server.events.removeListener('request:start', count);
    expect(calls.bodies).toHaveLength(2);
    expect(calls.bodies[1]).toEqual(calls.bodies[0]);
    expect(calls.bodies[0]).toEqual({ currentPassword: PASSWORD });
    expect(refreshes).toBe(1);
  });

  it('FR-102 FR-104: a failed refresh sends nothing more and signs the user out', async () => {
    const u = userEvent.setup();
    renderUsers();
    const calls = resetSequence(unauthorized);
    const dialog = await openReset(u);
    server.use(http.post('*/v1/auth/refresh', unauthorized));
    await confirm(u, dialog, PASSWORD, 'Reset two-factor');
    await waitFor(() => expect(seen.user).toBeFalsy());
    expect(calls.bodies).toHaveLength(1);
  });

  it('FR-103 TC-005: a refresh that comes back as another person sends nothing more', async () => {
    const u = userEvent.setup();
    renderUsers();
    const calls = resetSequence(unauthorized);
    const dialog = await openReset(u);
    seedMockRefresh(MOCK_USERS.reviewer.email);
    await confirm(u, dialog, PASSWORD, 'Reset two-factor');
    await waitFor(() => expect(calls.bodies).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.bodies).toHaveLength(1);
  });
});
