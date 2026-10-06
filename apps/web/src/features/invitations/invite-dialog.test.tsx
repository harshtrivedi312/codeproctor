import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { CandidatesPage } from '@/features/admin/candidates-page';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { mockInvitationCount, setInvitationScenario } from '@/mocks/invitation-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { InviteButton } from './invite-button';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

async function openDialog(user: { email: string } = MOCK_USERS.recruiter) {
  renderAsStaff(
    <main>
      <h1>Test</h1>
      <InviteButton testId="test-backend" />
    </main>,
    user,
  );
  const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Invite candidates' }));
  const dialog = await screen.findByRole('dialog');
  return { u, dialog };
}
const csvFile = (text: string, name = 'people.csv') => new File([text], name, { type: 'text/csv' });
const posts = () => {
  const urls: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path.endsWith('/bulk')) urls.push(path);
  });
  return urls;
};

describe('FR-303 TC-023: invite one candidate', () => {
  it('sends the invitation and closes', async () => {
    const { u, dialog } = await openDialog();
    const before = mockInvitationCount();
    await u.type(within(dialog).getByLabelText('Candidate name'), 'Nia New');
    await u.type(within(dialog).getByLabelText('Candidate email'), 'nia.new@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockInvitationCount()).toBe(before + 1);
  });

  it('shows a fix-it hint for each missing field', async () => {
    const { u, dialog } = await openDialog();
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText("Enter the candidate's name.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the candidate's email address.")).toBeInTheDocument();
  });

  it('409: says the candidate already has an open invitation and what to do', async () => {
    const { u, dialog } = await openDialog();
    await u.type(within(dialog).getByLabelText('Candidate name'), 'Tim');
    await u.type(
      within(dialog).getByLabelText('Candidate email'),
      'tim.berners.lee@candidates.example.test',
    );
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /already has an open invitation/,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('429: says nothing was sent and when to try again', async () => {
    setInvitationScenario({ limitPerHour: 0 });
    const { u, dialog } = await openDialog();
    await u.type(within(dialog).getByLabelText('Candidate name'), 'Nia');
    await u.type(within(dialog).getByLabelText('Candidate email'), 'nia@example.test');
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/Nothing was sent/);
    expect(alert).toHaveTextContent(/30 minutes/);
  });

  it('passes axe', async () => {
    const { dialog } = await openDialog();
    expect(await axe(dialog)).toHaveNoViolations();
  });
});

describe('ADR 0015 C-19: accommodations and the identity waiver', () => {
  async function withWaiver() {
    const ctx = await openDialog();
    await ctx.u.type(within(ctx.dialog).getByLabelText('Candidate name'), 'Wen Waiver');
    await ctx.u.type(within(ctx.dialog).getByLabelText('Candidate email'), 'wen@example.test');
    await ctx.u.click(within(ctx.dialog).getByLabelText('No face match / no identity check'));
    return ctx;
  }

  it('explains what the waiver means and advises a video-call ID check', async () => {
    const { dialog } = await withWaiver();
    expect(
      within(dialog).getByText(/will not be asked for an ID photo or a selfie/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Check the candidate’s ID on a video call/),
    ).toBeInTheDocument();
  });

  it('will not send without a reason, and asks for a note with OTHER', async () => {
    const { u, dialog } = await withWaiver();
    const before = mockInvitationCount();
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(
      await within(dialog).findByText(/Choose why the identity check is waived/),
    ).toBeInTheDocument();
    await u.selectOptions(
      within(dialog).getByLabelText(/Why is the identity check waived/),
      'OTHER',
    );
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(
      await within(dialog).findByText(/Describe the reason in a few words/),
    ).toBeInTheDocument();
    expect(mockInvitationCount()).toBe(before);
    await u.type(within(dialog).getByLabelText(/Describe the reason/), 'Court order');
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(mockInvitationCount()).toBe(before + 1));
  });

  it('refusing biometric processing locks the face and gaze detectors off', async () => {
    const { u, dialog } = await withWaiver();
    await u.selectOptions(
      within(dialog).getByLabelText(/Why is the identity check waived/),
      'REFUSED_BIOMETRIC_PROCESSING',
    );
    expect(within(dialog).getByTestId('waiver-face-note')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Face detection/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Face detection/ })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: /Gaze/ })).toBeChecked();
  });

  it('REASON_NOT_ENABLED: shows a plain message and keeps the dialog open', async () => {
    setInvitationScenario({ biometricRefusalEnabled: false });
    const { u, dialog } = await withWaiver();
    await u.selectOptions(
      within(dialog).getByLabelText(/Why is the identity check waived/),
      'REFUSED_BIOMETRIC_PROCESSING',
    );
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /not switched on for your organisation/,
    );
  });

  it('rejects extra time above 200 with a hint', async () => {
    const { u, dialog } = await openDialog();
    await u.type(within(dialog).getByLabelText('Candidate name'), 'Eli');
    await u.type(within(dialog).getByLabelText('Candidate email'), 'eli@example.test');
    fireEvent.change(within(dialog).getByLabelText(/Extra time/), { target: { value: '250' } });
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText(/whole number from 0 to 200/)).toBeInTheDocument();
  });

  it('the waiver and accommodations are not offered for a CSV upload', async () => {
    const { u, dialog } = await openDialog();
    await u.click(within(dialog).getByLabelText('Several, from a CSV file'));
    expect(
      within(dialog).queryByLabelText('No face match / no identity check'),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Accommodations are set per candidate/)).toBeInTheDocument();
  });
});

describe('FR-304 TC-023: invite from a CSV', () => {
  async function upload(text: string) {
    const ctx = await openDialog();
    await ctx.u.click(within(ctx.dialog).getByLabelText('Several, from a CSV file'));
    await ctx.u.upload(within(ctx.dialog).getByLabelText('CSV file'), csvFile(text));
    return ctx;
  }

  it('previews valid rows and problems, then invites only the valid ones', async () => {
    const urls = posts();
    const { u, dialog } = await upload(
      '﻿email,name\r\na@example.test,Ada\r\nbad,Bob\r\nA@example.test,Ada again\r\nc@example.test,=cmd\r\n',
    );
    expect(await within(dialog).findByTestId('csv-summary')).toHaveTextContent(
      '4 rows: 2 can be invited, 2 cannot',
    );
    expect(within(dialog).getByText(/kept as plain text and never run/)).toBeInTheDocument();
    expect(within(dialog).getByText('This is not a valid email address.')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Invite 2 candidates' }));
    expect(await within(dialog).findByTestId('bulk-result')).toHaveTextContent(
      '2 invitations created',
    );
    expect(urls).toEqual(['/v1/tests/test-backend/invitations/bulk']);
    expect(
      within(dialog).getByRole('button', { name: /Download the rows with a problem/ }),
    ).toBeInTheDocument();
  });

  it('shows a plain message for an unusable file', async () => {
    const { dialog } = await upload('who,what\r\nx,y\r\n');
    expect(await within(dialog).findByText(/it needs "email" and "name"/)).toBeInTheDocument();
  });

  it('sends 450 rows in chunks of 200 (3 requests)', async () => {
    const urls = posts();
    const text =
      'email,name\n' +
      Array.from({ length: 450 }, (_, i) => `p${i}@example.test,P ${i}`).join('\n');
    const { u, dialog } = await upload(text);
    await u.click(await within(dialog).findByRole('button', { name: 'Invite 450 candidates' }));
    expect(await within(dialog).findByTestId('bulk-result')).toHaveTextContent(
      '450 invitations created',
    );
    expect(urls).toHaveLength(3);
  });

  it('429: reports how many were not sent and keeps the ones already sent', async () => {
    setInvitationScenario({ limitPerHour: 250 });
    const text =
      'email,name\n' +
      Array.from({ length: 450 }, (_, i) => `p${i}@example.test,P ${i}`).join('\n');
    const { u, dialog } = await upload(text);
    await u.click(await within(dialog).findByRole('button', { name: 'Invite 450 candidates' }));
    expect(await within(dialog).findByTestId('bulk-result')).toHaveTextContent(
      '200 invitations created',
    );
    expect(within(dialog).getByText(/hourly limit: 250 rows were not sent/)).toBeInTheDocument();
  });

  it('keeps no candidate data in storage or the URL', async () => {
    const { dialog } = await upload('email,name\r\nsecret.person@example.test,Secret\r\n');
    await within(dialog).findByTestId('csv-summary');
    const dump =
      JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href;
    expect(dump).not.toContain('secret.person');
  });

  it('closing the dialog drops the parsed rows', async () => {
    const { u, dialog } = await upload('email,name\r\nsecret.person@example.test,Secret\r\n');
    await within(dialog).findByTestId('csv-summary');
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent('secret.person');
    await u.click(screen.getByRole('button', { name: 'Invite candidates' }));
    expect(screen.queryByTestId('csv-summary')).not.toBeInTheDocument();
  });

  it('passes axe with a preview', async () => {
    const { dialog } = await upload('email,name\r\na@example.test,Ada\r\nbad,Bob\r\n');
    await within(dialog).findByTestId('csv-summary');
    expect(await axe(dialog)).toHaveNoViolations();
  });
});

describe('FR-305 ADR 0002 C-28: the candidates page', () => {
  it('lists the latest status and opens a per-candidate timeline with no scores', async () => {
    renderAsStaff(<CandidatesPage />, MOCK_USERS.recruiter);
    const u = userEvent.setup();
    const row = (await screen.findByText('Ada Lovelace')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Completed')).toBeInTheDocument();
    await u.click(within(row).getByRole('button', { name: 'Timeline for Ada Lovelace' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('list', { name: /Progress for/ })).toBeInTheDocument();
    const list = within(dialog).getByRole('list', { name: /Progress for/ });
    expect(list.textContent).not.toMatch(/flagged|integrity|score/i);
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('shows the timeline of a candidate who declined consent as ended', async () => {
    renderAsStaff(<CandidatesPage />, MOCK_USERS.recruiter);
    const u = userEvent.setup();
    const row = (await screen.findByText('Dennis Ritchie')).closest('tr') as HTMLElement;
    await u.click(within(row).getByRole('button', { name: /Timeline for Dennis Ritchie/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/declined the consent document/)).toBeInTheDocument();
  });

  it('the Invite candidates button opens the dialog with a test choice', async () => {
    renderAsStaff(<CandidatesPage />, MOCK_USERS.recruiter);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Invite candidates' }));
    expect(await screen.findByLabelText('Test')).toBeInTheDocument();
  });

  it('FR-103 TC-004: a super admin sees the button too; the page passes axe', async () => {
    const { container } = renderAsStaff(
      <main>
        <CandidatesPage />
      </main>,
      MOCK_USERS.admin,
    );
    expect(await screen.findByRole('button', { name: 'Invite candidates' })).toBeInTheDocument();
    await screen.findByText('Ada Lovelace');
    expect(await axe(container)).toHaveNoViolations();
  });
});
