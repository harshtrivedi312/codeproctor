import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { useAuth } from '@/features/auth/auth-provider';
import { CandidatesPage } from '@/features/admin/candidates-page';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { mockInvitationCount, setInvitationScenario } from '@/mocks/invitation-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { InviteButton } from './invite-button';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

async function openDialog(
  user: { email: string } = MOCK_USERS.recruiter,
  refusalReasonOffered = false,
) {
  renderAsStaff(
    <main>
      <h1>Test</h1>
      <InviteButton testId="test-backend" refusalReasonOffered={refusalReasonOffered} />
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
  async function withWaiver(refusalOffered = false) {
    const ctx = await openDialog(MOCK_USERS.recruiter, refusalOffered);
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

  it('ADR 0015 section 7: the biometric-refusal reason is not selectable by default', async () => {
    const { dialog } = await withWaiver();
    const option = within(dialog).getByRole('option', { name: /refuses biometric processing/ });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent('not available yet in this build');
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
    const { u, dialog } = await withWaiver(true);
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
    const { u, dialog } = await withWaiver(true);
    await u.selectOptions(
      within(dialog).getByLabelText(/Why is the identity check waived/),
      'REFUSED_BIOMETRIC_PROCESSING',
    );
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /not available yet in this build/,
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

describe('FR-303 ADR 0002 C-28: the candidates page', () => {
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

describe('FR-304: upload robustness', () => {
  const manyRows = (n: number) =>
    'email,name\n' + Array.from({ length: n }, (_, i) => `q${i}@example.test,Q ${i}`).join('\n');

  it('FR-304: sends in React strict mode too (regression: the abort flag stayed set)', async () => {
    const urls = posts();
    nav.pathname = '/admin/tests';
    renderAsStaff(
      <React.StrictMode>
        <main>
          <InviteButton testId="test-backend" />
        </main>
      </React.StrictMode>,
      MOCK_USERS.recruiter,
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Invite candidates' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByLabelText('Several, from a CSV file'));
    await u.upload(within(dialog).getByLabelText('CSV file'), csvFile(manyRows(3)));
    await u.click(await within(dialog).findByRole('button', { name: 'Invite 3 candidates' }));
    expect(await within(dialog).findByTestId('bulk-result')).toHaveTextContent(
      '3 invitations created',
    );
    expect(urls).toHaveLength(1);
  });

  async function uploadMany(n: number) {
    const ctx = await openDialog();
    await ctx.u.click(within(ctx.dialog).getByLabelText('Several, from a CSV file'));
    await ctx.u.upload(within(ctx.dialog).getByLabelText('CSV file'), csvFile(manyRows(n)));
    await ctx.u.click(
      await within(ctx.dialog).findByRole('button', { name: `Invite ${n} candidates` }),
    );
    return ctx;
  }
  const failSecondChunk = (status: number | 'network') => {
    let calls = 0;
    server.use(
      http.post(`${apiBaseUrl}/v1/tests/:testId/invitations/bulk`, () => {
        calls += 1;
        if (calls === 1) return undefined;
        return status === 'network'
          ? HttpResponse.error()
          : HttpResponse.json({ status, title: 'x', detail: 'x' }, { status });
      }),
    );
  };

  it('a failure after the first chunk says how many were created, not "nothing was sent"', async () => {
    failSecondChunk(401);
    const { dialog } = await uploadMany(250);
    const text = (await within(dialog).findByTestId('bulk-result')).textContent ?? '';
    expect(text).toMatch(/The upload stopped after 200 invitations/);
    expect(text).toMatch(/Your session ended/);
    expect(text).toMatch(/Check the candidates list/);
    expect(text).not.toMatch(/nothing was sent/i);
  });

  it('DL-37: a 500 on a chunk is not retried and says those rows may have been sent', async () => {
    failSecondChunk(500);
    const { dialog } = await uploadMany(250);
    const text = (await within(dialog).findByTestId('bulk-result')).textContent ?? '';
    expect(text).toMatch(/The upload stopped after 200 invitations/);
    expect(text).toMatch(/50 rows of those may have been sent/);
    expect(text).toMatch(/Check the candidates list before trying again/);
  });

  it('a lost connection says the request in flight may have been sent', async () => {
    failSecondChunk('network');
    const { dialog } = await uploadMany(250);
    const text = (await within(dialog).findByTestId('bulk-result')).textContent ?? '';
    expect(text).toMatch(/50 rows of those may have been sent/);
  });

  it('after the hourly limit, the rows not sent can be downloaded and a new file chosen', async () => {
    setInvitationScenario({ limitPerHour: 200 });
    const urlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const blobs: Blob[] = [];
    urlSpy.mockImplementation((b) => {
      blobs.push(b as Blob);
      return 'blob:x';
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { u, dialog } = await uploadMany(250);
    const text = (await within(dialog).findByTestId('bulk-result')).textContent ?? '';
    expect(text).toMatch(/50 rows were not sent/);
    expect(within(dialog).getByRole('button', { name: /^Invite 250/ })).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: 'Download the rows not sent' }));
    const csv = await blobs.at(-1)?.text();
    expect(csv?.split('\r\n')).toHaveLength(51);
    expect(csv).toContain('q200@example.test');
    expect(csv).not.toContain('q199@example.test');
    // Choosing a file again clears the result and sends again.
    await u.upload(within(dialog).getByLabelText('CSV file'), csvFile(manyRows(2)));
    expect(
      await within(dialog).findByRole('button', { name: 'Invite 2 candidates' }),
    ).toBeEnabled();
    vi.restoreAllMocks();
  });

  it('a bulk upload refreshes the candidate list behind the dialog', async () => {
    const gets: string[] = [];
    renderAsStaff(<CandidatesPage />, MOCK_USERS.recruiter);
    const u = userEvent.setup();
    await screen.findByText('Ada Lovelace');
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET') gets.push(new URL(request.url).pathname);
    });
    await u.click(screen.getByRole('button', { name: 'Invite candidates' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: 'Random arrays round' }),
      ).toBeInTheDocument(),
    );
    await u.selectOptions(within(dialog).getByLabelText('Test'), 'test-random');
    await u.click(within(dialog).getByLabelText('Several, from a CSV file'));
    await u.upload(within(dialog).getByLabelText('CSV file'), csvFile(manyRows(2)));
    await u.click(await within(dialog).findByRole('button', { name: 'Invite 2 candidates' }));
    await within(dialog).findByTestId('bulk-result');
    await waitFor(() => expect(gets).toContain('/v1/admin/candidates'));
  });

  it('signing out empties an open dialog: the parsed rows do not stay', async () => {
    function SignOut() {
      const { signOutRevoked } = useAuth();
      return (
        <button type="button" onClick={() => void signOutRevoked()}>
          Force sign out
        </button>
      );
    }
    renderAsStaff(
      <main>
        <SignOut />
        <InviteButton testId="test-backend" />
      </main>,
      MOCK_USERS.recruiter,
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Invite candidates' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByLabelText('Several, from a CSV file'));
    await u.upload(
      within(dialog).getByLabelText('CSV file'),
      csvFile('email,name\r\nsecret.person@example.test,Secret\r\n'),
    );
    await within(dialog).findByTestId('csv-summary');
    fireEvent.click(screen.getByText('Force sign out'));
    await waitFor(() => expect(document.body).not.toHaveTextContent('secret.person'));
  });
});

describe('FR-303 TC-023: the window start is worked out at submit time', () => {
  afterEach(() => vi.useRealTimers());

  const captureStart = () => {
    const sent: { windowStart: string; windowEnd: string }[] = [];
    server.events.on('request:start', async ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.endsWith('/invitations')) {
        sent.push((await request.clone().json()) as { windowStart: string; windowEnd: string });
      }
    });
    return sent;
  };

  it('FR-303 TC-023: a dialog left open for 10 minutes sends a start close to the submit time and is accepted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:20'));
    const { u, dialog } = await openDialog();
    const sent = captureStart();
    await u.type(within(dialog).getByLabelText('Candidate name'), 'Nia New');
    await u.type(within(dialog).getByLabelText('Candidate email'), 'nia.new@example.test');
    vi.setSystemTime(new Date('2026-10-08T10:10:40'));
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const start = Date.parse(sent[0]!.windowStart);
    expect(Math.abs(start - Date.now())).toBeLessThan(60_000);
    // The end keeps the 7 day length from the new start.
    expect(Date.parse(sent[0]!.windowEnd) - start).toBe(7 * 86_400_000);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('FR-303: an explicit start that has gone stale is clamped to now with a note, and is accepted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:20'));
    const { u, dialog } = await openDialog();
    const sent = captureStart();
    await u.type(within(dialog).getByLabelText('Candidate name'), 'Nia New');
    await u.type(within(dialog).getByLabelText('Candidate email'), 'nia.new@example.test');
    fireEvent.change(within(dialog).getByLabelText('Window opens'), {
      target: { value: '2026-10-08T10:02' },
    });
    vi.setSystemTime(new Date('2026-10-08T10:12:00'));
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(Math.abs(Date.parse(sent[0]!.windowStart) - Date.now())).toBeLessThan(60_000);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('FR-303: an explicit future start is kept exactly as chosen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:20'));
    const { u, dialog } = await openDialog();
    const sent = captureStart();
    await u.type(within(dialog).getByLabelText('Candidate name'), 'Nia New');
    await u.type(within(dialog).getByLabelText('Candidate email'), 'nia.new@example.test');
    fireEvent.change(within(dialog).getByLabelText('Window opens'), {
      target: { value: '2026-10-09T09:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Window closes'), {
      target: { value: '2026-10-10T09:00' },
    });
    vi.setSystemTime(new Date('2026-10-08T10:10:00'));
    await u.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.windowStart).toBe(new Date('2026-10-09T09:00').toISOString());
  });
});
