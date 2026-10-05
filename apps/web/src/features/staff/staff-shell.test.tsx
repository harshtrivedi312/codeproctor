import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { crumbsFor } from './breadcrumbs';
import { StaffShell } from './staff-shell';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

async function shellAs(user: { email: string }) {
  const view = renderAsStaff(
    <StaffShell>
      <h1>Page body</h1>
    </StaffShell>,
    user,
  );
  await screen.findByRole('navigation', { name: 'Main' });
  return view;
}
const navLabels = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((a) => a.textContent);

describe('StaffShell', () => {
  it('FR-103: a recruiter sees only the sections the matrix gives them', async () => {
    await shellAs(MOCK_USERS.recruiter);
    expect(navLabels()).toEqual(['Dashboard', 'Questions', 'Tests', 'Candidates', 'Reports']);
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('FR-103: a super admin sees all eight sections', async () => {
    await shellAs(MOCK_USERS.admin);
    expect(navLabels()).toEqual([
      'Dashboard',
      'Questions',
      'Tests',
      'Candidates',
      'Review queue',
      'Live',
      'Reports',
      'Settings',
    ]);
  });

  it('FR-103: an author and a reviewer see their own subsets', async () => {
    const author = await shellAs(MOCK_USERS.author);
    expect(navLabels()).toEqual(['Dashboard', 'Questions']);
    author.unmount();
    resetAuthTestState();
    await shellAs(MOCK_USERS.reviewer);
    expect(navLabels()).toEqual(['Dashboard', 'Review queue', 'Live', 'Reports']);
  });

  it('FR-103: the top bar shows the organisation and the user, and the page is marked in the sidebar', async () => {
    nav.pathname = '/admin/questions';
    await shellAs(MOCK_USERS.recruiter);
    expect(screen.getByTestId('org-name')).toHaveTextContent('Acme Hiring (demo)');
    expect(screen.getByTestId('user-menu')).toHaveTextContent('Riley Recruiter');
    const main = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(main.getByRole('link', { name: 'Questions' })).toHaveAttribute('aria-current', 'page');
    expect(main.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Dashboard/Questions',
    );
  });

  it('FR-104: the user menu signs out and returns to login', async () => {
    await shellAs(MOCK_USERS.recruiter);
    const u = userEvent.setup();
    await u.click(screen.getByTestId('user-menu'));
    await u.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith('/admin/login'));
  });

  it('FR-103: nothing is shown to a signed-out visitor, who is sent to login with a way back', async () => {
    nav.pathname = '/admin/settings/users';
    const { container } = (await import('@/test/auth-test-utils')).renderWithAuth(
      <StaffShell>
        <h1>Page body</h1>
      </StaffShell>,
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        '/admin/login?reason=expired&next=%2Fadmin%2Fsettings%2Fusers',
      ),
    );
    expect(container).not.toHaveTextContent('Page body');
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('WCAG 2.1 AA: the shell has no axe violations', async () => {
    nav.pathname = '/admin/questions';
    const { container } = await shellAs(MOCK_USERS.admin);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('breadcrumbs', () => {
  it('FR-103: builds the trail from the path', () => {
    expect(crumbsFor('/admin')).toEqual([{ href: '/admin', label: 'Dashboard' }]);
    expect(crumbsFor('/admin/settings/risk').map((c) => c.label)).toEqual([
      'Dashboard',
      'Settings',
      'Risk scoring',
    ]);
  });
});
