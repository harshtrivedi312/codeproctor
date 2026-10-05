import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockAdminState } from '@/mocks/admin-handlers';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { CandidatesPage } from './candidates-page';
import { ConsentPage } from './consent-page';
import { DataSettingsPage } from './data-settings-page';
import { RiskSettingsPage } from './risk-settings-page';
import { UsersPage } from './users-page';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const findRow = (name: string) => screen.findByRole('row', { name: new RegExp(name) });
const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

describe('Settings access (FR-103, TC-004)', () => {
  it('FR-103 TC-004: a recruiter who opens a Settings page gets an explanation, not the page', async () => {
    renderAsStaff(<UsersPage />, MOCK_USERS.recruiter);
    expect(await screen.findByText(/Your role does not have access/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('FR-103 TC-004: the API refuses a non-admin with 403 even if the page were reached directly', async () => {
    renderAsStaff(<div />, MOCK_USERS.recruiter);
    const { api } = await import('@/lib/api/client');
    await waitFor(async () => {
      const { response } = await api.GET('/v1/admin/users');
      expect(response.status).toBe(403);
    });
  });
});

describe('Users (FR-103)', () => {
  it('FR-103: lists staff users sorted by name with status and role', async () => {
    nav.pathname = '/admin/settings/users';
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    expect(await findRow('Casey Newhire')).toBeInTheDocument();
    expect(within(rowOf('Casey Newhire')).getByText('Invited')).toBeInTheDocument();
    expect(within(rowOf('Dana Departed')).getByText('Deactivated')).toBeInTheDocument();
    expect(screen.getByLabelText('Role for Riley Recruiter')).toHaveValue('RECRUITER');
  });

  it('FR-103: shows a loading state first', async () => {
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    expect(await screen.findAllByTestId('table-skeleton-row')).toHaveLength(5);
    await findRow('Casey Newhire');
  });

  it('FR-103: invites a user, with field errors first and the new row after', async () => {
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText('Enter their full name.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Enter the work email/)).toBeInTheDocument();

    await u.type(within(dialog).getByLabelText('Full name'), 'Jo Newperson');
    await u.type(within(dialog).getByLabelText('Work email'), 'jo@example.test');
    await u.selectOptions(within(dialog).getByLabelText('Role'), 'AUTHOR');
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await findRow('Jo Newperson')).toBeInTheDocument();
    expect(within(rowOf('Jo Newperson')).getByText('Invited')).toBeInTheDocument();
    expect(screen.getByLabelText('Role for Jo Newperson')).toHaveValue('AUTHOR');
  });

  it('FR-103: a duplicate email explains what to do', async () => {
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    await u.click(screen.getByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Full name'), 'Dup');
    await u.type(within(dialog).getByLabelText('Work email'), 'author@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already has an account');
  });

  function countPatches(): { count: () => number; stop: () => void } {
    let n = 0;
    const listener = ({ request }: { request: Request }) => {
      if (request.method === 'PATCH' && request.url.includes('/users/')) n++;
    };
    server.events.on('request:start', listener);
    return { count: () => n, stop: () => server.events.removeListener('request:start', listener) };
  }

  it('FR-103: changing a role needs confirmation, then sends one request', async () => {
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    const patches = countPatches();
    await u.selectOptions(screen.getByLabelText('Role for Avery Author'), 'RECRUITER');
    const dialog = await screen.findByRole('dialog');
    expect(patches.count()).toBe(0);
    expect(screen.getByLabelText('Role for Avery Author')).toHaveValue('AUTHOR');
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Role for Avery Author')).toHaveValue('RECRUITER'),
    );
    expect(patches.count()).toBe(1);
    patches.stop();
  });

  it('FR-103: cancelling the role confirmation sends nothing and keeps the role', async () => {
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    const patches = countPatches();
    await u.selectOptions(screen.getByLabelText('Role for Avery Author'), 'REVIEWER');
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(patches.count()).toBe(0);
    expect(screen.getByLabelText('Role for Avery Author')).toHaveValue('AUTHOR');
    patches.stop();
  });

  it('FR-103: promoting someone to Super Admin shows a clear warning before anything is sent', async () => {
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    const patches = countPatches();
    await u.selectOptions(screen.getByLabelText('Role for Avery Author'), 'SUPER_ADMIN');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Super Admin');
    expect(dialog).toHaveTextContent('manage users, settings');
    expect(patches.count()).toBe(0);
    patches.stop();
  });

  it('FR-103: you cannot change your own role or deactivate yourself', async () => {
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    expect(screen.getByLabelText('Role for Alex Admin')).toBeDisabled();
    expect(within(rowOf('Alex Admin')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('FR-103: deactivates after a confirmation, then reactivates', async () => {
    const u = userEvent.setup();
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    await u.click(within(rowOf('Robin Reviewer')).getByRole('button', { name: /Deactivate/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('cannot sign in until you reactivate');
    await u.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(within(rowOf('Robin Reviewer')).getByText('Deactivated')).toBeInTheDocument(),
    );
    await u.click(within(rowOf('Robin Reviewer')).getByRole('button', { name: /Reactivate/ }));
    await waitFor(() =>
      expect(within(rowOf('Robin Reviewer')).queryByText('Deactivated')).not.toBeInTheDocument(),
    );
  });

  it('FR-103: a load failure shows a fix-it message with Try again', async () => {
    server.use(http.get('*/v1/admin/users', () => HttpResponse.error()));
    renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('WCAG 2.1 AA: the users page has no axe violations', async () => {
    const { container } = renderAsStaff(<UsersPage />, MOCK_USERS.admin);
    await findRow('Casey Newhire');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Data and privacy (FR-704, D-19)', () => {
  it('FR-704: saves the retention days and rejects a value outside 7 to 730 with a hint', async () => {
    const u = userEvent.setup();
    renderAsStaff(<DataSettingsPage />, MOCK_USERS.admin);
    const days = await screen.findByLabelText(/Keep recordings/);
    expect(days).toHaveValue(90);
    await u.clear(days);
    await u.type(days, '3');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('retention days must be at least 7.')).toBeInTheDocument();
    await u.clear(days);
    await u.type(days, '120');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('D-19: the erasure hold is on by default and turning it off warns that evidence may be lost', async () => {
    const u = userEvent.setup();
    renderAsStaff(<DataSettingsPage />, MOCK_USERS.admin);
    const hold = await screen.findByLabelText('Wait while a review or appeal is open');
    expect(hold).toBeChecked();
    await u.click(hold);
    expect(screen.getByText('Erasure will not wait')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('WCAG 2.1 AA: the data settings page has no axe violations', async () => {
    const { container } = renderAsStaff(<DataSettingsPage />, MOCK_USERS.admin);
    await screen.findByLabelText(/Keep recordings/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Risk scoring (FR-804, TC-075)', () => {
  it('TC-075 FR-804: the example shows 2 HIGH + 3 MEDIUM = 64, band HIGH, with the default values', async () => {
    renderAsStaff(<RiskSettingsPage />, MOCK_USERS.admin);
    await screen.findByLabelText('HIGH from score');
    expect(screen.getByTestId('risk-example')).toHaveTextContent('score 64, band HIGH');
  });

  it('FR-804: the example follows edits to points and thresholds', async () => {
    const u = userEvent.setup();
    renderAsStaff(<RiskSettingsPage />, MOCK_USERS.admin);
    const high = await screen.findByLabelText('HIGH from score');
    await u.clear(high);
    await u.type(high, '70');
    expect(screen.getByTestId('risk-example')).toHaveTextContent('band MEDIUM');
  });

  it('FR-804: the thresholds must be in order, and the message says how to fix it', async () => {
    const u = userEvent.setup();
    renderAsStaff(<RiskSettingsPage />, MOCK_USERS.admin);
    const medium = await screen.findByLabelText('MEDIUM from score');
    await u.clear(medium);
    await u.type(medium, '80');
    await u.click(screen.getByRole('button', { name: 'Save risk settings' }));
    expect(
      await screen.findByText('The HIGH threshold must be higher than the MEDIUM threshold.'),
    ).toBeInTheDocument();
  });

  it('FR-804: saves a changed weight and resets to defaults', async () => {
    const u = userEvent.setup();
    renderAsStaff(<RiskSettingsPage />, MOCK_USERS.admin);
    const weight = await screen.findByLabelText('Weight for Focus lost');
    expect(weight).toHaveValue(1);
    await u.clear(weight);
    await u.type(weight, '2.5');
    await u.click(screen.getByRole('button', { name: 'Save risk settings' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(screen.getByLabelText('Weight for Focus lost')).toHaveValue(1);
  });

  it('FR-804: the weights table filters by severity', async () => {
    const u = userEvent.setup();
    renderAsStaff(<RiskSettingsPage />, MOCK_USERS.admin);
    await screen.findByLabelText('Weight for Focus lost');
    await u.selectOptions(screen.getByLabelText('Severity'), 'LOW');
    expect(screen.getByLabelText('Weight for Paste attempt')).toBeInTheDocument();
    expect(screen.queryByLabelText('Weight for Focus lost')).not.toBeInTheDocument();
  });

  it('WCAG 2.1 AA: the risk page has no axe violations', async () => {
    const { container } = renderAsStaff(<RiskSettingsPage />, MOCK_USERS.admin);
    await screen.findByLabelText('HIGH from score');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Consent documents (D-17, TC-096)', () => {
  it('D-17: shows an unapproved text as a placeholder and an approved one as approved', async () => {
    renderAsStaff(<ConsentPage />, MOCK_USERS.admin);
    expect(await findRow('v0.1-placeholder')).toBeInTheDocument();
    expect(
      within(rowOf('v0.1-placeholder')).getByText(/Placeholder, not approved by Legal/),
    ).toBeInTheDocument();
    expect(within(rowOf('v0.1-placeholder')).getByText('Current')).toBeInTheDocument();
    expect(within(rowOf('v0.2-mock-approved')).getByText(/^Approved /)).toBeInTheDocument();
  });

  it('D-17: where Legal approval is required, a placeholder cannot be made current', async () => {
    resetMockAdminState({ legalApprovalRequired: true });
    const u = userEvent.setup();
    renderAsStaff(<ConsentPage />, MOCK_USERS.admin);
    await findRow('v0.2-mock-approved');
    await u.click(screen.getByRole('button', { name: 'Add a version' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Version name'), 'v0.3-draft');
    await u.type(
      within(dialog).getByLabelText(/Consent text/),
      'A draft consent text that is long enough.',
    );
    await u.click(within(dialog).getByRole('button', { name: 'Add version' }));
    await findRow('v0.3-draft');
    const blocked = within(rowOf('v0.3-draft')).getByRole('button', { name: /Use as current/ });
    expect(blocked).toBeDisabled();
    expect(within(rowOf('v0.3-draft')).getByText('Needs Legal approval first')).toBeInTheDocument();
    // The approved text can be chosen.
    expect(
      within(rowOf('v0.2-mock-approved')).getByRole('button', { name: /Use as current/ }),
    ).toBeEnabled();
  });

  it('D-17: in a staging-like environment a placeholder can be chosen after a warning', async () => {
    const u = userEvent.setup();
    renderAsStaff(<ConsentPage />, MOCK_USERS.admin);
    await findRow('v0.2-mock-approved');
    await u.click(
      within(rowOf('v0.2-mock-approved')).getByRole('button', { name: /Use as current/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Use this version' }));
    await waitFor(() =>
      expect(within(rowOf('v0.2-mock-approved')).getByText('Current')).toBeInTheDocument(),
    );
    expect(within(rowOf('v0.1-placeholder')).queryByText('Current')).not.toBeInTheDocument();
  });

  it('D-17: adds a new version as a placeholder and validates the form first', async () => {
    const u = userEvent.setup();
    renderAsStaff(<ConsentPage />, MOCK_USERS.admin);
    await findRow('v0.2-mock-approved');
    await u.click(screen.getByRole('button', { name: 'Add a version' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Add version' }));
    expect(await within(dialog).findByText(/Name this version/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Paste the full consent text/)).toBeInTheDocument();
  });

  it('D-17: the view dialog labels an unapproved text as a placeholder', async () => {
    const u = userEvent.setup();
    renderAsStaff(<ConsentPage />, MOCK_USERS.admin);
    await findRow('v0.1-placeholder');
    await u.click(within(rowOf('v0.1-placeholder')).getByRole('button', { name: /View/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Not approved by Legal');
    expect(within(dialog).getByLabelText('Consent text')).toHaveTextContent(
      'Consent to proctored assessment',
    );
  });

  it('D-17 TC-096: saves the contact shown to candidates who decline consent', async () => {
    const u = userEvent.setup();
    renderAsStaff(<ConsentPage />, MOCK_USERS.admin);
    const contact = await screen.findByLabelText('Contact shown after declining');
    await u.clear(contact);
    await u.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText(/Enter who a candidate can contact/)).toBeInTheDocument();
    await u.type(contact, 'people@example.test');
    await u.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('WCAG 2.1 AA: the consent page has no axe violations', async () => {
    const { container } = renderAsStaff(<ConsentPage />, MOCK_USERS.admin);
    await findRow('v0.1-placeholder');
    await screen.findByLabelText('Contact shown after declining');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Candidate erasure (NFR-05, D-19, TC-094)', () => {
  it('TC-094: a candidate with nothing open is scheduled for erasure after a confirmation', async () => {
    const u = userEvent.setup();
    renderAsStaff(<CandidatesPage />, MOCK_USERS.admin);
    await findRow('Ada Lovelace');
    await u.click(within(rowOf('Ada Lovelace')).getByRole('button', { name: /Erase data/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('cannot be undone');
    await u.click(within(dialog).getByRole('button', { name: 'Erase data' }));
    expect(await within(rowOf('Ada Lovelace')).findByText('Erasure scheduled')).toBeInTheDocument();
  });

  it('TC-094 D-19: while an appeal is open the request waits and says so', async () => {
    const u = userEvent.setup();
    renderAsStaff(<CandidatesPage />, MOCK_USERS.admin);
    await findRow('Grace Hopper');
    await u.click(within(rowOf('Grace Hopper')).getByRole('button', { name: /Erase data/ }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Erase data' }),
    );
    const row = rowOf('Grace Hopper');
    expect(await within(row).findByText('Waiting for appeal')).toBeInTheDocument();
    expect(row).toHaveTextContent('runs as soon as the appeal closes');
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('D-19: a request that is already waiting shows the waiting state and no erase button', async () => {
    renderAsStaff(<CandidatesPage />, MOCK_USERS.admin);
    await findRow('Barbara Liskov');
    expect(within(rowOf('Barbara Liskov')).getByText('Waiting for appeal')).toBeInTheDocument();
    expect(within(rowOf('Barbara Liskov')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rowOf('Edsger Dijkstra')).getByText('Erased')).toBeInTheDocument();
  });

  it('D-19: with the hold off, an open review does not delay erasure', async () => {
    const u = userEvent.setup();
    const { api } = await import('@/lib/api/client');
    renderAsStaff(<CandidatesPage />, MOCK_USERS.admin);
    await findRow('Alan Turing');
    await api.PATCH('/v1/admin/settings', {
      body: { erasure: { holdWhileReviewOrAppealOpen: false } },
    });
    await u.click(within(rowOf('Alan Turing')).getByRole('button', { name: /Erase data/ }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Erase data' }),
    );
    expect(await within(rowOf('Alan Turing')).findByText('Erasure scheduled')).toBeInTheDocument();
  });

  it('FR-103 TC-004: a recruiter sees the candidates but has no erase action', async () => {
    renderAsStaff(<CandidatesPage />, MOCK_USERS.recruiter);
    await findRow('Ada Lovelace');
    expect(screen.queryByRole('button', { name: /Erase data/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('FR-103: a reviewer cannot open the candidates page', async () => {
    renderAsStaff(<CandidatesPage />, MOCK_USERS.reviewer);
    expect(await screen.findByText(/Your role does not have access/)).toBeInTheDocument();
  });

  it('WCAG 2.1 AA: the candidates page has no axe violations', async () => {
    const { container } = renderAsStaff(<CandidatesPage />, MOCK_USERS.admin);
    await findRow('Ada Lovelace');
    expect(await axe(container)).toHaveNoViolations();
  });
});
