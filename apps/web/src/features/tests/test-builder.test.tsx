import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav, router } from '@/test/nav-mock';
import { NewTestRoute, TestRoute } from './test-pages';
import { TestsPage } from './tests-page';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const base = `${apiBaseUrl}/v1/tests`;
type User = ReturnType<typeof userEvent.setup>;

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: 'Bearer mock-access-RECRUITER-direct',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

function openBuilder(
  path: string,
  element: React.ReactElement,
  user: { email: string } = MOCK_USERS.recruiter,
) {
  nav.pathname = path;
  renderAsStaff(<main>{element}</main>, user);
  return userEvent.setup();
}
const newTest = () => openBuilder('/admin/tests/new', <NewTestRoute />);
/** Opens the question picker and waits until the published questions have loaded. */
async function openPicker(u: User): Promise<HTMLElement> {
  await u.click(screen.getByRole('button', { name: /Add a question from the bank/ }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).queryByText(/Loading the questions/)).not.toBeInTheDocument(),
  );
  return dialog;
}

describe('Tests list (FR-301, FR-103)', () => {
  it('FR-301: a recruiter sees the tests with duration, profile, content and whether they are in use', async () => {
    openBuilder('/admin/tests', <TestsPage />);
    const row = await screen.findByRole('row', { name: /Backend engineer screening/ });
    expect(row).toHaveTextContent('90 min');
    expect(row).toHaveTextContent('Standard');
    expect(row).toHaveTextContent('2 sections, 3 questions');
    expect(row).toHaveTextContent('In use');
    expect(screen.getByRole('row', { name: /Frontend and algorithms/ })).toHaveTextContent(
      'Strict',
    );
    expect(screen.getByRole('row', { name: /Frontend and algorithms/ })).toHaveTextContent(
      'Can be edited',
    );
    expect(screen.getAllByRole('link', { name: 'New test' }).length).toBeGreaterThan(0);
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('FR-103 TC-004: an author does not get the tests page (no permission), and makes no tests call', async () => {
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/v1/tests')) calls.push(request.url);
    });
    openBuilder('/admin/tests', <TestsPage />, MOCK_USERS.author);
    await waitFor(() =>
      expect(screen.queryByText(/Tests/, { selector: 'h1' })).not.toBeInTheDocument(),
    );
    expect(calls).toEqual([]);
  });

  it('FR-301: a failed load says so and offers a retry', async () => {
    server.use(http.get(base, () => HttpResponse.json({ detail: 'down' }, { status: 500 })));
    openBuilder('/admin/tests', <TestsPage />);
    expect(await screen.findByText('We could not load the tests')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});

describe('Test builder: create (FR-301, FR-302, ADR 0002)', () => {
  it('FR-301 FR-302: builds a test with a fixed and a random question, STRICT, a limit and a pass score, and saves it through the real shape', async () => {
    const bodies: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && request.url === base)
        bodies.push((await request.clone().json()) as Body);
    });
    const u = newTest();
    await u.type(await screen.findByLabelText('Name'), 'Hiring round');
    const duration = screen.getByLabelText('Total duration (minutes)');
    await u.clear(duration);
    await u.type(duration, '60');
    await u.click(screen.getByRole('radio', { name: /Strict/ }));
    expect(screen.getByTestId('profile-selected')).toHaveTextContent('Selected: Strict');
    await u.type(screen.getByLabelText('Section 1 time limit (minutes)'), '45');
    // A fixed question from the bank.
    const dialog = await openPicker(u);
    await u.click(await within(dialog).findByRole('button', { name: 'Add Two sum' }));
    expect(within(dialog).getByRole('button', { name: 'Already added Two sum' })).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: 'Done' }));
    // Two random picks.
    await u.click(screen.getByRole('button', { name: /Add random question/ }));
    await u.type(screen.getByLabelText('Tags (all must match)'), 'arrays');
    await u.selectOptions(screen.getByLabelText('Difficulty'), 'MEDIUM');
    expect(screen.getByText(/1 published question\(s\) match now/)).toBeInTheDocument();
    await u.type(screen.getByLabelText('Pass score (optional)'), '200');
    expect(screen.getByTestId('test-summary')).toHaveTextContent(
      '1 section · 2 questions · 200 points · section limits 45 of 60 minutes',
    );
    await u.click(screen.getByRole('button', { name: 'Create test' }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/admin\/tests\/test-/)),
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      name: 'Hiring round',
      durationMinutes: 60,
      profile: 'STRICT',
      passScore: 200,
      sections: [
        {
          title: 'Section 1',
          position: 1,
          timeLimitMin: 45,
          questions: [
            { position: 1, points: 100, questionVersionId: 'q-twosum-v1' },
            { position: 2, points: 100, randomRule: { tags: ['arrays'], difficulty: 'MEDIUM' } },
          ],
        },
      ],
    });
  });

  it('FR-302: each profile says in plain words what it records, and LOCKDOWN is not offered', async () => {
    newTest();
    const group = await screen.findByRole('group', { name: 'Proctoring profile' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(
      within(group).getByText(/Records the candidate's screen, webcam and microphone/),
    ).toBeInTheDocument();
    expect(within(group).getByText(/also a second camera/)).toBeInTheDocument();
    expect(within(group).queryByText(/lockdown/i)).not.toBeInTheDocument();
  });

  it('FR-301 ADR 0002: the page explains that sections run in order, cannot be reopened and must fit the duration', async () => {
    newTest();
    expect(
      await screen.findByText(
        /Sections run in the order shown\. A candidate cannot go back to a finished section/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The section limits together may not be more than the total duration/),
    ).toBeInTheDocument();
  });

  it('FR-301 ADR 0002: section limits above the duration, an empty section, a pass score above the points are shown next to the field and nothing is sent', async () => {
    const posts: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url === base) posts.push(request.url);
    });
    const u = newTest();
    await u.type(await screen.findByLabelText('Name'), 'Bad test');
    const duration = screen.getByLabelText('Total duration (minutes)');
    await u.clear(duration);
    await u.type(duration, '30');
    await u.type(screen.getByLabelText('Section 1 time limit (minutes)'), '45');
    await u.type(screen.getByLabelText('Pass score (optional)'), '5');
    await u.click(screen.getByRole('button', { name: 'Create test' }));
    expect(
      await screen.findByText(
        /The section time limits add up to 45 minutes, more than the 30 minute duration/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Add at least one question to this section.')).toBeInTheDocument();
    expect(screen.getByText(/The pass score cannot be more than the 0 points/)).toBeInTheDocument();
    expect(screen.getByText('Some fields need attention. Nothing was saved.')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('TC-020 FR-301: a random rule that matches too few published questions is refused before saving, with the fix', async () => {
    const u = newTest();
    await u.type(await screen.findByLabelText('Name'), 'Random');
    await u.click(screen.getByRole('button', { name: /Add random question/ }));
    await u.type(screen.getByLabelText('Tags (all must match)'), 'no-such-tag');
    await u.click(screen.getByRole('button', { name: 'Create test' }));
    expect(
      await screen.findByText(
        /Only 0 published questions match this rule, and the test needs 1 different one/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Change the rule or publish more questions/)).toBeInTheDocument();
  });

  it('FR-301: several random picks are added at once and need as many different matches', async () => {
    const u = newTest();
    await u.type(await screen.findByLabelText('Name'), 'Many');
    const count = screen.getByLabelText(/How many random questions|Random picks/);
    fireEvent.change(count, { target: { value: '3' } });
    await u.click(screen.getByRole('button', { name: /Add random questions/ }));
    expect(screen.getAllByText('Random pick')).toHaveLength(3);
    await u.click(screen.getByRole('button', { name: 'Create test' }));
    // The bank has 5 published questions: three "any" picks fit.
    await waitFor(() => expect(router.push).toHaveBeenCalled());
  });

  it('FR-301: server refusals are shown in words: a question that is no longer available, and the limits', async () => {
    server.use(
      http.post(base, () =>
        HttpResponse.json({ detail: 'A question version was not found.' }, { status: 404 }),
      ),
    );
    const u = newTest();
    await u.type(await screen.findByLabelText('Name'), 'Gone');
    await u.click(screen.getByRole('button', { name: /Add random question/ }));
    await u.click(screen.getByRole('button', { name: 'Create test' }));
    expect(
      await screen.findByText(/A question you picked is no longer available/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Gone');
  });
});

describe('Test builder: reorder (FR-301)', () => {
  async function twoSections(u: User) {
    await u.type(await screen.findByLabelText('Name'), 'Order');
    await u.clear(screen.getByLabelText('Section 1 name'));
    await u.type(screen.getByLabelText('Section 1 name'), 'Alpha');
    await u.click(screen.getByRole('button', { name: 'Add section' }));
    await u.clear(screen.getByLabelText('Section 2 name'));
    await u.type(screen.getByLabelText('Section 2 name'), 'Beta');
  }
  const titles = () =>
    screen.getAllByLabelText(/Section \d+ name/).map((el) => (el as HTMLInputElement).value);

  it('FR-301: sections move up and down with the keyboard (Enter on a button), keep focus on the control and are announced', async () => {
    const u = newTest();
    await twoSections(u);
    expect(titles()).toEqual(['Alpha', 'Beta']);
    const down = screen.getByRole('button', { name: 'Move section 1 down' });
    down.focus();
    await u.keyboard('{Enter}');
    expect(titles()).toEqual(['Beta', 'Alpha']);
    expect(screen.getByText('Section Alpha moved to position 2 of 2.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move section 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move section 2 down' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: 'Move section 2 up' }));
    expect(titles()).toEqual(['Alpha', 'Beta']);
  });

  it('FR-301: questions move within a section and the order goes into the body as positions', async () => {
    type Body = { sections: { questions: { questionVersionId?: string }[] }[] };
    const bodies: Body[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST' && request.url === base)
        bodies.push((await request.clone().json()) as Body);
    });
    const u = newTest();
    await u.type(await screen.findByLabelText('Name'), 'Q order');
    const dialog = await openPicker(u);
    await u.click(await within(dialog).findByRole('button', { name: 'Add Two sum' }));
    await u.click(await within(dialog).findByRole('button', { name: 'Add Cost of binary search' }));
    await u.click(within(dialog).getByRole('button', { name: 'Done' }));
    await u.click(screen.getByRole('button', { name: 'Move question 2 of section 1 up' }));
    await u.click(screen.getByRole('button', { name: 'Create test' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.sections[0]!.questions.map((q) => q.questionVersionId)).toEqual([
      'q-bigo-v1',
      'q-twosum-v1',
    ]);
  });

  it('FR-301: the last section cannot be removed, and removing one renumbers the rest', async () => {
    const u = newTest();
    await twoSections(u);
    expect(screen.getByRole('button', { name: 'Remove section 1' })).toBeEnabled();
    await u.click(screen.getByRole('button', { name: 'Remove section 1' }));
    expect(titles()).toEqual(['Beta']);
    expect(screen.getByRole('button', { name: 'Remove section 1' })).toBeDisabled();
  });
});

describe('Test builder: edit and view (FR-301, ADR 0002 S-6)', () => {
  it('FR-301: an unused test loads into the builder and saves with the sections replaced', async () => {
    const patches: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH') patches.push(await request.clone().json());
    });
    const u = openBuilder('/admin/tests/test-frontend', <TestRoute id="test-frontend" />);
    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Frontend and algorithms (strict)');
    expect(screen.getByRole('radio', { name: /Strict/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await u.clear(name);
    await u.type(name, 'Renamed');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      name: 'Renamed',
      profile: 'STRICT',
      sections: [{ title: 'Warm-up' }],
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('ADR 0002 S-6: a test in use is read-only, says why, and offers a new test built from it', async () => {
    openBuilder('/admin/tests/test-backend', <TestRoute id="test-backend" />);
    expect(await screen.findByText('This test is in use')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add section/ })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Build a new test from this one' });
    expect(link).toHaveAttribute('href', '/admin/tests/new?from=test-backend');
  });

  it('FR-301: "build a new test from this one" starts a copy that can be saved as a new test', async () => {
    nav.search = new URLSearchParams('from=test-backend');
    const u = openBuilder('/admin/tests/new', <NewTestRoute />);
    expect(await screen.findByLabelText('Name')).toHaveValue('Backend engineer screening (copy)');
    expect(screen.getAllByLabelText(/Section \d+ name/)).toHaveLength(2);
    await u.click(screen.getByRole('button', { name: 'Create test' }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    const list = await call<{ total: number }>('GET', '/v1/tests');
    expect(list.body.total).toBe(4);
  });

  it('FR-301: if someone else changed the test since it was opened, the save stops, nothing is written and the edit stays', async () => {
    const patches: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') patches.push(request.url);
    });
    const u = openBuilder('/admin/tests/test-frontend', <TestRoute id="test-frontend" />);
    const name = await screen.findByLabelText('Name');
    await call('PATCH', '/v1/tests/test-frontend', { description: 'Someone else was here' });
    await u.clear(name);
    await u.type(name, 'Mine');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        /Someone else changed this test since you opened it\. Nothing was saved/,
      ),
    ).toBeInTheDocument();
    expect(patches).toHaveLength(1); // only the other editor's own PATCH
    expect(name).toHaveValue('Mine');
    await u.click(screen.getByRole('button', { name: 'Reload the latest version' }));
    expect(await screen.findByText('Loaded the latest saved version.')).toBeInTheDocument();
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Someone else was here');
  });

  it('ADR 0002 S-6: if candidates were invited meanwhile, the save says the test can no longer be changed', async () => {
    server.use(
      http.patch(`${base}/test-frontend`, () =>
        HttpResponse.json(
          {
            detail:
              'This test already has invitations or sessions and cannot be edited; create a new test instead.',
          },
          { status: 409 },
        ),
      ),
    );
    const u = openBuilder('/admin/tests/test-frontend', <TestRoute id="test-frontend" />);
    const name = await screen.findByLabelText('Name');
    await u.clear(name);
    await u.type(name, 'Late');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/already has invitations or sessions and cannot be edited/),
    ).toBeInTheDocument();
    expect(name).toHaveValue('Late');
  });

  it('FR-301: a pass score that is set cannot be removed on the API, and the form says so', async () => {
    openBuilder('/admin/tests/test-random', <TestRoute id="test-random" />);
    expect(
      await screen.findByText(/A pass score that is set cannot be removed, only changed/),
    ).toBeInTheDocument();
  });

  it('FR-301: a missing test explains itself and links back', async () => {
    openBuilder('/admin/tests/test-nope', <TestRoute id="test-nope" />);
    expect(await screen.findByText('This test does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the tests' })).toHaveAttribute(
      'href',
      '/admin/tests',
    );
  });

  it('WCAG 2.1 AA: the builder, the picker and the read-only view have no axe violations', async () => {
    const u = newTest();
    await screen.findByLabelText('Name');
    expect(await axe(document.body)).toHaveNoViolations();
    await u.click(screen.getByRole('button', { name: /Add a question from the bank/ }));
    await screen.findByRole('dialog');
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('WCAG 2.1 AA: the read-only view has no axe violations', async () => {
    openBuilder('/admin/tests/test-backend', <TestRoute id="test-backend" />);
    await screen.findByText('This test is in use');
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
