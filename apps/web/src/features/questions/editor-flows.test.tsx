import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api/client';
import { getAccessToken } from '@/lib/auth-token';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { full } from '@/test/question-api';
import { nav, router } from '@/test/nav-mock';
import {
  NewQuestionRoute,
  QuestionEditorRoute,
  QuestionVersionRoute,
  QuestionVersionsRoute,
} from './question-pages';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('./monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const base = `${apiBaseUrl}/v1/questions`;
type User = ReturnType<typeof userEvent.setup>;

async function openEditor(id: string, user = MOCK_USERS.author): Promise<User> {
  nav.pathname = `/admin/questions/${id}`;
  renderAsStaff(
    <main>
      <QuestionEditorRoute id={id} pollMs={5} />
    </main>,
    user,
  );
  await screen.findByRole('tablist', { name: 'Question sections' });
  return userEvent.setup();
}

const goTab = (u: User, name: string | RegExp) => u.click(screen.getByRole('tab', { name }));

/** Replaces the content of a field. Paste keeps braces and brackets literal (user-event types `{` as a key). */
async function setText(u: User, el: HTMLElement, text: string): Promise<void> {
  await u.clear(el);
  await u.click(el);
  if (text !== '') await u.paste(text);
}

const save = (u: User) => u.click(screen.getByRole('button', { name: 'Save' }));
const checkText = (id: string) => screen.getByTestId(`check-${id}`).textContent ?? '';

describe('Test cases tab (FR-202)', () => {
  it('FR-202: adds, removes and toggles hidden, and rejects a weight of 0 or an empty weight', async () => {
    const u = await openEditor('q-twosum');
    await goTab(u, 'Test cases');
    const rows = () =>
      within(screen.getByRole('table', { name: 'Test cases' })).getAllByRole('row');
    expect(rows()).toHaveLength(3); // header + 2 tests

    await u.click(screen.getByRole('button', { name: 'Add test case' }));
    expect(rows()).toHaveLength(4);
    expect(screen.getByText(/3 tests, total weight 3/)).toBeInTheDocument();

    const weight = screen.getByLabelText('Weight of test 3');
    await u.clear(weight);
    await save(u);
    expect(await screen.findByText('Enter a weight.')).toBeInTheDocument();
    await u.type(weight, '0');
    await save(u);
    expect(await screen.findByText('The weight must be at least 0.01.')).toBeInTheDocument();

    // Hidden toggle: hiding the only visible test warns that candidates see no sample.
    await u.clear(weight);
    await u.type(weight, '2');
    await u.click(screen.getByRole('checkbox', { name: /Test 1 is/ }));
    expect(screen.getByText(/No test is visible yet/)).toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: /Test 1 is/ }));
    expect(screen.queryByText(/No test is visible yet/)).not.toBeInTheDocument();

    await save(u);
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    const { data } = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-twosum' } },
    });
    expect(full(data).version.testCases.map((t) => t.weight)).toEqual([1, 1, 2]);

    await u.click(screen.getByRole('button', { name: 'Remove test 3' }));
    expect(screen.getByText(/2 tests, total weight 2/)).toBeInTheDocument();
  });
});

describe('Saving test cases on a published question (FR-202, FR-204, TC-013)', () => {
  it('FR-204 TC-013: adding, removing and editing test cases of a published question lands exactly on version 3, and a variant override follows its slot', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Test cases');
    await setText(u, screen.getByLabelText('Input of test 1'), 'EDITED');
    await u.click(screen.getByRole('button', { name: 'Remove test 2' }));
    await u.click(screen.getByRole('button', { name: 'Add test case' }));
    await setText(u, screen.getByLabelText('Input of test 4'), 'brand new');
    await setText(u, screen.getByLabelText('Expected output of test 4'), 'new out');
    await save(u);
    expect(await screen.findByText(/Saved as version 3/)).toBeInTheDocument();

    const { data } = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-merge' } },
    });
    const v3 = full(data).version;
    expect(v3.version).toBe(3);
    const cases = [...v3.testCases].sort((a, b) => a.position - b.position);
    expect(cases.map((t) => t.position)).toEqual([0, 1, 2, 3]);
    expect(cases.map((t) => (t.input ?? '').split('\n')[0])).toEqual([
      'EDITED',
      '4', // the old third test, now second
      '3', // the old fourth test
      'brand new',
    ]);
    expect(cases[3]?.expectedOutput).toBe('new out');
    // The override of the second variant stayed on the first slot (edited in place), on the new id.
    const overrides = v3.variants.flatMap((v) => v.testCaseOverrides);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.testCaseId).toBe(cases[0]?.id);
    // Version 2 still has its four tests.
    const old = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-merge' }, query: { version: 2 } },
    });
    expect(full(old.data).version.testCases).toHaveLength(4);
  });
});

describe('Variants tab (FR-203, ADR 0007)', () => {
  it("FR-203: each variant's explicit parameters must be a JSON object of strings, numbers or booleans that covers the placeholders in use", async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const first = screen.getAllByLabelText('Parameters (JSON)')[0]!;
    expect(screen.getByTestId('placeholders-used')).toHaveTextContent('{{count}}');

    await setText(u, first, '{');
    expect(await screen.findByText(/This is not valid JSON/)).toBeInTheDocument();
    await setText(u, first, '[1]');
    expect(await screen.findByText(/must be a JSON object/)).toBeInTheDocument();
    await setText(u, first, '{}');
    expect(await screen.findByText(/Needs a value for "count"/)).toBeInTheDocument();
    await setText(u, first, '{"count": null}');
    expect(
      await screen.findByText(/"count" must be a string, a number or true or false/),
    ).toBeInTheDocument();
    await setText(u, first, '{"count": [1, 2]}');
    expect(
      await screen.findByText(/"count" must be a string, a number or true or false/),
    ).toBeInTheDocument();

    // A bad variant blocks the save and names the tab.
    await save(u);
    expect(await screen.findByText(/Some fields need attention: Variants/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Variants/ })).toHaveTextContent('needs attention');

    // Strings and numbers are fine, and so are extra names (there is no declared schema).
    await setText(u, first, '{"count": 7, "label": "x"}');
    expect(screen.getByTestId('variant-preview-0')).toHaveTextContent('Given 7 intervals');
    expect(screen.queryByText(/must be a string, a number/)).not.toBeInTheDocument();
  });

  it('FR-203: there is no declared-parameter editor any more', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    expect(screen.queryByRole('button', { name: 'Add parameter' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Parameter 1 name/)).not.toBeInTheDocument();
  });

  it('FR-203: a placeholder in use with no variant to give it a value is reported on the Variants tab', async () => {
    const u = await openEditor('q-twosum');
    const statement = screen.getByLabelText('Statement (Markdown)');
    await u.click(statement);
    await u.paste(' Use {{limit}} items.');
    await save(u);
    expect(await screen.findByText(/Some fields need attention: Variants/)).toBeInTheDocument();
    await goTab(u, /Variants/);
    expect(await screen.findByText(/Add a variant that gives it a value/)).toBeInTheDocument();
  });

  it('FR-203: prefill from the reference solution only proposes; nothing changes until the author accepts', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Variant 1' });
    const overrides = () => within(card).getAllByRole('checkbox', { name: /Override slot/ });
    expect(overrides().filter((c) => (c as HTMLInputElement).checked)).toHaveLength(0);

    await u.click(within(card).getByRole('button', { name: 'Prefill from reference solution' }));
    const proposals = await within(card).findByRole('region', { name: /Proposed outputs/ });
    expect(within(proposals).getAllByText(/Proposed:/)).toHaveLength(4);
    // Still nothing applied.
    expect(overrides().filter((c) => (c as HTMLInputElement).checked)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await u.click(within(proposals).getByRole('button', { name: 'Accept slot 1' }));
    expect(overrides().filter((c) => (c as HTMLInputElement).checked)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(within(card).getByLabelText('Expected output, slot 1')).toHaveValue('1 6\n8 10');

    await u.click(within(card).getByRole('button', { name: 'Accept all proposals' }));
    expect(overrides().filter((c) => (c as HTMLInputElement).checked)).toHaveLength(4);
  });

  it('FR-203: dismissing the proposals changes nothing', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Variant 1' });
    await u.click(within(card).getByRole('button', { name: 'Prefill from reference solution' }));
    await within(card).findByRole('region', { name: /Proposed outputs/ });
    await u.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(
      within(card).queryByRole('region', { name: /Proposed outputs/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('FR-203: a per-slot override can be switched on and carries its own input and output', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Variant 2' });
    expect(within(card).getByLabelText('Expected output, slot 1')).toHaveValue('1 6\n8 10\n15 18');
    await u.click(within(card).getByRole('checkbox', { name: /Override slot 2/ }));
    await setText(u, within(card).getByLabelText('Expected output, slot 2'), '9 9');
    await save(u);
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    // q-merge is published, so the save created version 3; the override is saved on it (the forked
    // draft's test cases have new ids, and the variants were mapped onto them).
    const { data } = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-merge' } },
    });
    const latest = full(data).version;
    expect(latest.version).toBe(3);
    const second = latest.variants.find((v) => v.params.count === 4);
    const slot2 = latest.testCases.find((t) => t.position === 1);
    expect(second?.testCaseOverrides.find((o) => o.testCaseId === slot2?.id)?.expectedOutput).toBe(
      '9 9',
    );
    // The fork gave every variant a new id, and the editor mapped onto them (no leftovers).
    expect(latest.variants).toHaveLength(2);
    expect(latest.variants.map((v) => v.id)).not.toContain('mi-v1');
  });
});

describe('Answer tab (FR-205)', () => {
  it('FR-205: a multiple-choice question needs a marked correct option and distinct option texts', async () => {
    const u = await openEditor('q-bigo');
    await goTab(u, 'Answer');
    expect(screen.getByRole('radio', { name: 'Option 2 is correct' })).toBeChecked();
    // Several correct answers, then clear the key.
    await u.click(screen.getByRole('checkbox', { name: /Several options can be correct/ }));
    await u.click(screen.getByRole('checkbox', { name: 'Option 2 is correct' }));
    await save(u);
    expect(await screen.findByText('Mark the correct answer.')).toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: 'Option 2 is correct' }));
    await u.click(screen.getByRole('checkbox', { name: 'Option 3 is correct' }));

    await setText(u, screen.getByLabelText('Option 4 text'), 'O(n)');
    await save(u);
    expect(await screen.findByText('Two options have the same text.')).toBeInTheDocument();
    await setText(u, screen.getByLabelText('Option 4 text'), 'O(n^2)');
    await save(u);
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    const { data } = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-bigo' } },
    });
    expect(full(data).version.answerSpec).toMatchObject({
      multiple: true,
      correctOptionIds: ['o2', 'o3'],
    });
  });

  it('FR-205: switching back to single choice keeps one correct option, and at least two options are required', async () => {
    const u = await openEditor('q-bigo');
    await goTab(u, 'Answer');
    await u.click(screen.getByRole('button', { name: 'Remove option 4' }));
    await u.click(screen.getByRole('button', { name: 'Remove option 3' }));
    await u.click(screen.getByRole('button', { name: 'Remove option 1' }));
    await save(u);
    expect(await screen.findByText('Add at least two options.')).toBeInTheDocument();
  });

  it('D-23 FR-205: accepted short-answer variants are compared after normalisation and may not repeat the canonical answer', async () => {
    const u = await openEditor('q-http');
    await goTab(u, 'Answer');
    expect(screen.getByLabelText('Canonical answer')).toHaveValue('201');
    await u.click(screen.getByRole('button', { name: 'Add accepted variant' }));
    const added = screen.getByLabelText('Accepted variant 3');
    await setText(u, added, '  201 ');
    expect(screen.getAllByText(/Matches as:/).length).toBeGreaterThan(0);
    await save(u);
    expect(
      await screen.findByText(/matches the canonical answer or another variant/),
    ).toBeInTheDocument();

    await setText(u, added, '  HTTP   201 ');
    await save(u);
    expect(
      await screen.findByText(/matches the canonical answer or another variant/),
    ).toBeInTheDocument();

    await setText(u, added, 'created (201)');
    await save(u);
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    const { data } = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-http' } },
    });
    expect(full(data).version.answerSpec).toMatchObject({
      canonical: '201',
      acceptedVariants: ['201 created', 'http 201', 'created (201)'],
    });
  });

  it('D-23: an empty canonical answer is rejected', async () => {
    const u = await openEditor('q-http');
    await goTab(u, 'Answer');
    await setText(u, screen.getByLabelText('Canonical answer'), '');
    await save(u);
    expect(await screen.findByText('Enter the canonical answer.')).toBeInTheDocument();
  });
});

describe('AI reference solutions (D-20, ADR 0005)', () => {
  it('D-20: shows the refresh-due badge when the newest solution is older than the refresh window', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'AI reference solutions');
    expect(await screen.findByTestId('refresh-due')).toHaveTextContent('Refresh due');
    expect(screen.getAllByText('Ready')).toHaveLength(3);
  });

  it('D-20: no refresh-due badge for fresh solutions, and a language with too few assistants says so', async () => {
    const u = await openEditor('q-running');
    await goTab(u, 'AI reference solutions');
    await screen.findByText('Collected solutions');
    expect(screen.queryByTestId('refresh-due')).not.toBeInTheDocument();
    expect(screen.getAllByText('Needs 1 more')).toHaveLength(2);
  });

  it('D-20: adds a solution (validated form), and supersedes one: the old row stays, marked superseded', async () => {
    const u = await openEditor('q-running');
    await goTab(u, 'AI reference solutions');
    await screen.findByText('Collected solutions');
    await u.click(screen.getByRole('button', { name: 'Add solution' }));
    const dialog = screen.getByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Add solution' }));
    expect(await within(dialog).findByText(/Enter the assistant/)).toBeInTheDocument();
    expect(within(dialog).getByText("Paste the assistant's solution.")).toBeInTheDocument();

    await u.type(within(dialog).getByLabelText('Assistant'), 'Claude');
    await u.type(within(dialog).getByLabelText('Model label'), 'sonnet (team)');
    await u.click(await within(dialog).findByLabelText('AI solution code'));
    await u.paste('print("hi")');
    await u.click(within(dialog).getByRole('button', { name: 'Add solution' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('row', { name: /Claude/ })).toHaveTextContent('Current');
    expect(screen.getByText('Ready', { selector: 'span' })).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: /Supersede the Claude Python solution/ }));
    const d2 = screen.getByRole('dialog');
    expect(
      within(d2).getByRole('heading', { name: 'Supersede an AI solution' }),
    ).toBeInTheDocument();
    expect(within(d2).getByLabelText('Assistant')).toHaveValue('Claude');
    await u.click(await within(d2).findByLabelText('AI solution code'));
    await u.paste('print("hi v2")');
    await u.click(within(d2).getByRole('button', { name: 'Supersede' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByRole('row', { name: /Claude/ })).toHaveLength(2));
    const rows = screen.getAllByRole('row', { name: /Claude/ });
    expect(
      rows.map((r) => (/Superseded/.test(r.textContent ?? '') ? 'old' : 'new')).sort(),
    ).toEqual(['new', 'old']);
  });

  it('D-20: adding a solution does not save the question or clear its validation (the dialog form is separate)', async () => {
    let patches = 0;
    server.use(
      http.patch(`${base}/q-running`, () => {
        patches += 1;
        return undefined;
      }),
    );
    const u = await openEditor('q-running');
    expect(checkText('validated')).toMatch(/Done/);
    await goTab(u, 'AI reference solutions');
    await u.click(await screen.findByRole('button', { name: 'Add solution' }));
    const dialog = screen.getByRole('dialog');
    await u.type(within(dialog).getByLabelText('Assistant'), 'Claude');
    await u.type(within(dialog).getByLabelText('Model label'), 'm');
    await u.click(await within(dialog).findByLabelText('AI solution code'));
    await u.paste('x = 1');
    await u.click(within(dialog).getByRole('button', { name: 'Add solution' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(patches).toBe(0);
    expect(checkText('validated')).toMatch(/Done/);
  });

  it('D-20: an unsaved question cannot have AI solutions yet', async () => {
    nav.pathname = '/admin/questions/new';
    renderAsStaff(
      <main>
        <NewQuestionRoute />
      </main>,
      MOCK_USERS.author,
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Create a coding question' }));
    await goTab(u, 'AI reference solutions');
    expect(screen.getByText(/Save the question first/)).toBeInTheDocument();
  });
});

describe('Validate and publish (TC-012, AI-5)', () => {
  it('TC-012 FR-203: validation shows the failing variant and test, and publishing stays blocked', async () => {
    const u = await openEditor('q-rotate');
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Validation failed')).toBeInTheDocument();
    const failing = screen.getByRole('table', { name: 'Results for Variant 2' });
    expect(within(failing).getByText('Wrong answer')).toBeInTheDocument();
    expect(within(failing).getByRole('row', { name: /Test 2/ })).toHaveTextContent('Wrong answer');
    expect(
      within(screen.getByRole('table', { name: 'Results for Variant 1' })).queryByText(
        'Wrong answer',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(checkText('validated')).toMatch(/To do/);
  });

  it('TC-012: fixing the variant, validating again and collecting the AI solutions enables Publish', async () => {
    const u = await openEditor('q-rotate');
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    await screen.findByText('Validation failed');

    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Variant 2' });
    await setText(u, within(card).getByLabelText('Expected output, slot 2'), '4 5 6 1 2 3');
    // Unsaved edits: validation and publishing are off, and the report says it is stale.
    expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByText(/You changed the question after this validation/)).toBeInTheDocument();
    await save(u);
    await screen.findByText(/Saved/);
    expect(checkText('validated')).toMatch(/To do/);

    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Validation passed')).toBeInTheDocument();
    expect(checkText('validated')).toMatch(/Done/);
    // The AI publish gate still blocks.
    expect(checkText('ai')).toMatch(/To do/);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();

    await goTab(u, 'AI reference solutions');
    for (const assistant of ['ChatGPT', 'Claude']) {
      await u.click(await screen.findByRole('button', { name: 'Add solution' }));
      const dialog = screen.getByRole('dialog');
      await u.type(within(dialog).getByLabelText('Assistant'), assistant);
      await u.type(within(dialog).getByLabelText('Model label'), 'model');
      await u.click(await within(dialog).findByLabelText('AI solution code'));
      await u.paste('print(1)');
      await u.click(within(dialog).getByRole('button', { name: 'Add solution' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
    expect(checkText('ai')).toMatch(/Done/);

    await u.click(screen.getByRole('button', { name: 'Publish' }));
    expect(
      await screen.findByText(/Version 1 is published\. Editing it later/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('AI-5: a validated question without enough AI solutions cannot be published', async () => {
    await openEditor('q-running');
    expect(checkText('validated')).toMatch(/Done/);
    expect(checkText('ai')).toMatch(/To do/);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('TC-012: an edit after a passing validation clears it', async () => {
    const u = await openEditor('q-running');
    expect(checkText('validated')).toMatch(/Done/);
    await u.type(screen.getByLabelText('Title'), ' v2');
    await save(u);
    await screen.findByText(/Saved/);
    expect(checkText('validated')).toMatch(/To do/);
  });
});

describe('Publish that fails (DL-32): honest messages, never marked published', () => {
  async function openPublishable() {
    const u = await openEditor('q-mcq-draft');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
    return u;
  }
  const publishButton = () => screen.getByRole('button', { name: 'Publish' });

  it('FR-203 TC-012: a publish answered 501 says it is not available yet, publishes nothing, and stays off', async () => {
    server.use(
      http.post(`${base}/q-mcq-draft/publish`, () =>
        HttpResponse.json({ detail: 'x' }, { status: 501 }),
      ),
    );
    const u = await openPublishable();
    await u.click(publishButton());
    expect(await screen.findByText(/Publishing is not available yet/)).toBeInTheDocument();
    expect(screen.queryByText(/is published\./)).not.toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
    // Nothing was marked published on the server either.
    const { data } = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-mcq-draft' } },
    });
    expect(full(data).version.isPublished).toBe(false);
  });

  it('FR-203: a publish answered 404 says the question no longer exists, and is not "unavailable"', async () => {
    server.use(
      http.post(`${base}/q-mcq-draft/publish`, () =>
        HttpResponse.json({ detail: 'Question not found.' }, { status: 404 }),
      ),
    );
    const u = await openPublishable();
    await u.click(publishButton());
    expect(await screen.findByText(/This question no longer exists/)).toBeInTheDocument();
    expect(screen.queryByText(/Publishing is not available yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/is published\./)).not.toBeInTheDocument();
  });

  it.each([405, 501])(
    'FR-203: a publish answered %i is treated as not available yet',
    async (status) => {
      server.use(
        http.post(`${base}/q-mcq-draft/publish`, () =>
          HttpResponse.json({ detail: 'x' }, { status }),
        ),
      );
      const u = await openPublishable();
      await u.click(publishButton());
      expect(await screen.findByText(/Publishing is not available yet/)).toBeInTheDocument();
      expect(publishButton()).toBeDisabled();
    },
  );

  it('TC-012: a 422 shows the gate message from errors[] and waits for a change before another try', async () => {
    server.use(
      http.post(`${base}/q-mcq-draft/publish`, () =>
        HttpResponse.json(
          { detail: 'Not ready', errors: ['Validation is required.', 'Add the AI solutions.'] },
          { status: 422 },
        ),
      ),
    );
    const u = await openPublishable();
    await u.click(publishButton());
    expect(
      await screen.findByText(
        /Publishing was refused: Validation is required\. Add the AI solutions\./,
      ),
    ).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
    // An edit and a save clear the refusal.
    await u.type(screen.getByLabelText('Title'), '!');
    await save(u);
    await screen.findByText(/Saved/);
    expect(screen.queryByText(/Publishing was refused/)).not.toBeInTheDocument();
  });

  it('TC-012: a 409 on publish asks for a reload instead of claiming anything', async () => {
    server.use(
      http.post(`${base}/q-mcq-draft/publish`, () =>
        HttpResponse.json({ detail: 'changed' }, { status: 409 }),
      ),
    );
    const u = await openPublishable();
    await u.click(publishButton());
    expect(
      await screen.findByText('This question changed since you opened it'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload the latest version/ })).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
  });

  it.each([500, 503])(
    'FR-203: a %i is transient: honest message, Publish stays available for a retry',
    async (status) => {
      let calls = 0;
      server.use(
        http.post(`${base}/q-mcq-draft/publish`, () => {
          calls += 1;
          return HttpResponse.json({ detail: 'busy' }, { status });
        }),
      );
      const u = await openPublishable();
      await u.click(publishButton());
      expect(
        await screen.findByText(/Nothing was published\. Try again in a moment/),
      ).toBeInTheDocument();
      expect(publishButton()).toBeEnabled();
      await u.click(publishButton());
      await waitFor(() => expect(calls).toBe(2));
    },
  );

  it('FR-203: a network error on publish is transient too and publishes nothing', async () => {
    server.use(http.post(`${base}/q-mcq-draft/publish`, () => HttpResponse.error()));
    const u = await openPublishable();
    await u.click(publishButton());
    expect(await screen.findByText(/so nothing was published/)).toBeInTheDocument();
    expect(publishButton()).toBeEnabled();
    expect(screen.queryByText(/is published\./)).not.toBeInTheDocument();
  });
});

describe('Versions (FR-204, TC-013)', () => {
  it('TC-013 FR-204: editing a published question creates a new draft version and leaves the published one unchanged', async () => {
    const u = await openEditor('q-merge');
    expect(screen.getByText(/Version 2 is published and cannot change/)).toBeInTheDocument();
    await u.type(screen.getByLabelText('Title'), ' (revised)');
    await save(u);
    expect(
      await screen.findByText(
        /Saved as version 3 \(draft\). The published version 2 is unchanged./,
      ),
    ).toBeInTheDocument();

    const v2 = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-merge' }, query: { version: 2 } },
    });
    expect(full(v2.data).version.title).toBe('Merge intervals');
    expect(full(v2.data).version.isPublished).toBe(true);
    const v3 = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-merge' }, query: { version: 3 } },
    });
    expect(full(v3.data).version.title).toBe('Merge intervals (revised)');
    expect(full(v3.data).version.isPublished).toBe(false);
    expect(full(v3.data).createdNewVersion).toBe(false);
  });

  it('FR-204: the history lists every version, newest first, with a link to each', async () => {
    nav.pathname = '/admin/questions/q-merge/versions';
    renderAsStaff(
      <main>
        <QuestionVersionsRoute id="q-merge" />
      </main>,
      MOCK_USERS.author,
    );
    const rows = await screen.findAllByRole('row', { name: /Version \d/ });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Version 2'),
      expect.stringContaining('Version 1'),
    ]);
    expect(screen.getByRole('link', { name: 'Version 1' })).toHaveAttribute(
      'href',
      '/admin/questions/q-merge/versions/1',
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('FR-204: an older version opens read-only: no Save, disabled fields, its own content', async () => {
    renderAsStaff(
      <main>
        <QuestionVersionRoute id="q-merge" version={1} />
      </main>,
      MOCK_USERS.author,
    );
    const u = userEvent.setup();
    await screen.findByRole('tablist', { name: 'Question sections' });
    expect(screen.getByText(/You are looking at version 1. It is read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Validate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.getByLabelText('Statement (Markdown)')).toBeDisabled();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Statement (Markdown)').value).toContain(
      'Given **some** intervals',
    );
    await goTab(u, 'Test cases');
    expect(screen.queryByRole('button', { name: 'Add test case' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Weight of test 1')).toBeDisabled();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('FR-204: a version that does not exist says so', async () => {
    renderAsStaff(
      <main>
        <QuestionVersionRoute id="q-merge" version={9} />
      </main>,
      MOCK_USERS.author,
    );
    expect(await screen.findByText('This question does not exist')).toBeInTheDocument();
  });
});

describe('Unsaved changes, session and creation', () => {
  it('FR-201: leaving through a link with unsaved edits asks first; Cancel keeps the page, Leave goes on', async () => {
    const u = await openEditor('q-merge');
    await u.type(screen.getByLabelText('Title'), ' edit');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await u.click(screen.getByRole('link', { name: 'Version history' }));
    expect(router.push).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Leave without saving?')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await u.click(screen.getByRole('link', { name: 'Version history' }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave and discard' }),
    );
    expect(router.push).toHaveBeenCalledWith('/admin/questions/q-merge/versions');
  });

  it('FR-201: no prompt when nothing changed, and a reload prompt only while there are unsaved edits', async () => {
    const u = await openEditor('q-merge');
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await u.click(screen.getByRole('link', { name: 'Version history' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await u.type(screen.getByLabelText('Title'), 'x');
    expect(unload()).toBe(true);
    await save(u);
    await screen.findByText(/Saved as version 3/);
    expect(unload()).toBe(false);
  });

  it('FR-103 FR-104: a 403 on save explains it and does not sign the user out', async () => {
    server.use(
      http.patch(`${base}/q-twosum`, () =>
        HttpResponse.json({ code: 'forbidden', message: 'No.' }, { status: 403 }),
      ),
    );
    const u = await openEditor('q-twosum');
    await u.type(screen.getByLabelText('Title'), '!');
    await save(u);
    expect(await screen.findByText(/Your role cannot do this/)).toBeInTheDocument();
    expect(getAccessToken()).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    // The edit is still there.
    expect(screen.getByLabelText('Title')).toHaveValue('Two sum!');
  });

  it('FR-104: a 401 on save is retried once after a silent refresh for the same user (shared guard)', async () => {
    let calls = 0;
    server.use(
      http.patch(`${base}/q-twosum`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: 'unauthenticated', message: 'x' }, { status: 401 })
          : undefined;
      }),
    );
    const u = await openEditor('q-twosum');
    await u.type(screen.getByLabelText('Title'), '!');
    await save(u);
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('TC-010 FR-201: creates a multiple-choice question and moves to its editor', async () => {
    nav.pathname = '/admin/questions/new';
    renderAsStaff(
      <main>
        <NewQuestionRoute />
      </main>,
      MOCK_USERS.author,
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Create a multiple choice question' }));
    await save(u).catch(() => undefined);
    await u.type(screen.getByLabelText('Title'), 'What is a stack?');
    await u.click(screen.getByLabelText('Statement (Markdown)'));
    await u.paste('Pick the best description.');
    await goTab(u, 'Answer');
    await u.type(screen.getByLabelText('Option 1 text'), 'Last in, first out');
    await u.type(screen.getByLabelText('Option 2 text'), 'First in, first out');
    await u.click(screen.getByRole('radio', { name: 'Option 1 is correct' }));
    await save(u);
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        expect.stringMatching(/^\/admin\/questions\/q-new-/),
      ),
    );
    expect(localStorage.length).toBe(0);
  });

  it('TC-010: a new question without a title or statement is not saved and names what is missing', async () => {
    nav.pathname = '/admin/questions/new';
    renderAsStaff(
      <main>
        <NewQuestionRoute />
      </main>,
      MOCK_USERS.author,
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Create a coding question' }));
    await u.type(screen.getByLabelText('Title'), 'x');
    await save(u);
    expect(await screen.findByText('Write the statement.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
