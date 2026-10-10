import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as React from 'react';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/features/auth/auth-provider';
import { MOCK_USERS, seedMockRefresh } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { findLoadedRow } from '@/test/table-utils';
import { UsersPage } from './users-page';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
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
    if (request.method !== 'GET' && pathname.includes('/admin/users')) {
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
