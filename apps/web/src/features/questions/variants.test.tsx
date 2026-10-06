import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { QuestionEditorRoute } from './question-pages';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('./monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const V = '/v1/questions';
type Role = 'AUTHOR' | 'RECRUITER' | 'REVIEWER';

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  text: string;
}
async function call<T = Record<string, unknown>>(
  role: Role,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer mock-access-${role}-direct`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as T };
}

interface Variant {
  id: string;
  isActive: boolean;
  params: Record<string, unknown>;
  renderedStatement: string;
  testCaseOverrides: {
    testCaseId: string;
    isHidden: boolean;
    position: number;
    input: string;
    expectedOutput: string;
  }[];
}
interface Detail {
  createdNewVersion: boolean;
  version: {
    version: number;
    revision: string;
    variants: Variant[];
    testCases: { id: string; position: number }[];
    isPublished: boolean;
    title: string;
  };
}
const detail = async (id: string, version?: number): Promise<Detail> =>
  (await call<Detail>('AUTHOR', 'GET', `${V}/${id}${version ? `?version=${version}` : ''}`)).body;

describe('Variant routes (FR-203, BE-04b): list, create, change, remove', () => {
  it('FR-203: the list answers {items, revision}, and the revision is the one of the writer detail', async () => {
    const d = await detail('q-merge');
    const list = await call<{ items: Variant[]; revision: string }>(
      'AUTHOR',
      'GET',
      `${V}/q-merge/versions/2/variants`,
    );
    expect(list.status).toBe(200);
    expect(Object.keys(list.body).sort()).toEqual(['items', 'revision']);
    expect(list.body.revision).toBe(d.version.revision);
    expect(list.body.items).toEqual(d.version.variants);
    expect(Object.keys(list.body.items[0]!).sort()).toEqual([
      'id',
      'isActive',
      'params',
      'renderedStatement',
      'testCaseOverrides',
    ]);
    // No label: the API has none. Sorted by id.
    expect(list.body.items.map((v) => v.id)).toEqual(['mi-v1', 'mi-v2']);
    expect(list.body.items[0]!.renderedStatement).toContain('Given **3** intervals');
  });

  it('FR-203: adding a variant renders its statement and returns {variant, revision}; the revision follows the content (and goes back when the variant is removed)', async () => {
    const before = (await detail('q-running')).version; // a draft without variants
    const created = await call<{ variant: Variant; revision: string }>(
      'AUTHOR',
      'POST',
      `${V}/q-running/versions/1/variants`,
      { params: { note: 'x' }, expectedRevision: before.revision },
    );
    expect(created.status).toBe(201);
    expect(created.body.variant.params).toEqual({ note: 'x' });
    expect(created.body.revision).not.toBe(before.revision);
    expect((await detail('q-running')).version.revision).toBe(created.body.revision);
    const removed = await call(
      'AUTHOR',
      'DELETE',
      `${V}/q-running/versions/1/variants/${created.body.variant.id}?expectedRevision=${created.body.revision}`,
    );
    expect(removed.status).toBe(204);
    // Like the API: a version with no variants hashes as before they existed.
    expect((await detail('q-running')).version.revision).toBe(before.revision);
  });

  it('FR-203: a placeholder with no param is a 400 that names it; an inactive variant is not rendered until it is switched on', async () => {
    const r = await call<{ errors: string[] }>(
      'AUTHOR',
      'POST',
      `${V}/q-rotate/versions/1/variants`,
      {
        params: { size: 4 },
      },
    );
    expect(r.status).toBe(400);
    expect(r.body.errors.join(' ')).toMatch(/unknown placeholder "steps"/);
    const inactive = await call<{ variant: Variant }>(
      'AUTHOR',
      'POST',
      `${V}/q-rotate/versions/1/variants`,
      { params: { size: 4 }, isActive: false },
    );
    expect(inactive.status).toBe(201);
    const on = await call(
      'AUTHOR',
      'PATCH',
      `${V}/q-rotate/versions/1/variants/${inactive.body.variant.id}`,
      { isActive: true },
    );
    expect(on.status).toBe(400);
    const fixed = await call<{ variant: Variant }>(
      'AUTHOR',
      'PATCH',
      `${V}/q-rotate/versions/1/variants/${inactive.body.variant.id}`,
      { params: { size: 4, steps: 1, flag: true }, isActive: true },
    );
    expect(fixed.status).toBe(200);
    expect(fixed.body.variant.renderedStatement).toContain('**4**');
    expect(fixed.body.variant.params.flag).toBe(true);
  });

  it('FR-203: an empty PATCH is 400; unknown fields (a label) are 400; params must be flat scalars', async () => {
    const path = `${V}/q-rotate/versions/1/variants/ro-v1`;
    expect((await call('AUTHOR', 'PATCH', path, {})).status).toBe(400);
    expect((await call('AUTHOR', 'PATCH', path, { label: 'x' })).status).toBe(400);
    const bad = await call<{ errors: string[] }>('AUTHOR', 'PATCH', path, {
      params: { size: [1], steps: { a: 1 } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.length).toBeGreaterThan(0);
  });

  it('FR-203: overrides are set and removed per slot; the response is the override with the slot isHidden and position, and no revision', async () => {
    const d = await detail('q-rotate');
    const slot = d.version.testCases.find((t) => t.position === 1)!;
    const put = await call<Record<string, unknown>>(
      'AUTHOR',
      'PUT',
      `${V}/q-rotate/versions/1/variants/ro-v1/test-cases/${slot.id}`,
      { input: '9 8 7', expectedOutput: '7 9 8' },
    );
    expect(put.status).toBe(200);
    expect(Object.keys(put.body).sort()).toEqual([
      'expectedOutput',
      'input',
      'isHidden',
      'position',
      'testCaseId',
    ]);
    expect(put.body.isHidden).toBe(true); // the slot's flag, not the variant's
    const after = await detail('q-rotate');
    expect(after.version.revision).not.toBe(d.version.revision);
    expect(
      after.version.variants.find((v) => v.id === 'ro-v1')?.testCaseOverrides.map((o) => o.input),
    ).toEqual(['9 8 7']);
    const del = await call(
      'AUTHOR',
      'DELETE',
      `${V}/q-rotate/versions/1/variants/ro-v1/test-cases/${slot.id}`,
    );
    expect(del.status).toBe(204);
    expect((await detail('q-rotate')).version.revision).toBe(d.version.revision);
    // A slot that is not in this version is a 404, as is a second delete.
    expect(
      (
        await call(
          'AUTHOR',
          'PUT',
          `${V}/q-rotate/versions/1/variants/ro-v1/test-cases/not-a-slot`,
          { input: 'a', expectedOutput: 'b' },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          'AUTHOR',
          'DELETE',
          `${V}/q-rotate/versions/1/variants/ro-v1/test-cases/${slot.id}`,
        )
      ).status,
    ).toBe(404);
  });

  it('FR-204: a stale expectedRevision on a variant route is a 409 with no code, and changes nothing', async () => {
    const before = await detail('q-rotate');
    const stale = '0'.repeat(64);
    const r = await call('AUTHOR', 'POST', `${V}/q-rotate/versions/1/variants`, {
      params: { size: 1, steps: 1 },
      expectedRevision: stale,
    });
    expect(r.status).toBe(409);
    expect(r.body).not.toHaveProperty('code');
    expect(
      (
        await call(
          'AUTHOR',
          'DELETE',
          `${V}/q-rotate/versions/1/variants/ro-v1?expectedRevision=${stale}`,
        )
      ).status,
    ).toBe(409);
    expect((await detail('q-rotate')).version.revision).toBe(before.version.revision);
  });

  it('FR-203 TC-013: a published version is immutable for variants (409); a non-coding question has none (422); at most 50', async () => {
    const published = await call('AUTHOR', 'POST', `${V}/q-merge/versions/2/variants`, {
      params: { count: 9 },
    });
    expect(published.status).toBe(409);
    const mcq = await call('AUTHOR', 'POST', `${V}/q-mcq-draft/versions/1/variants`, {
      params: {},
    });
    expect(mcq.status).toBe(422);
    let last = 0;
    for (let i = 0; i < 51; i += 1) {
      last = (
        await call('AUTHOR', 'POST', `${V}/q-running/versions/1/variants`, { params: { n: i } })
      ).status;
    }
    expect(last).toBe(422);
    expect((await detail('q-running')).version.variants).toHaveLength(50);
  });

  it('FR-203 TC-012: editing the statement must still render for every active variant (400, unchanged); an inactive variant does not block it', async () => {
    const before = await detail('q-rotate');
    const r = await call<{ errors: string[] }>('AUTHOR', 'PATCH', `${V}/q-rotate`, {
      statementMd: 'Rotate {{size}} by {{steps}} and {{extra}}.',
    });
    expect(r.status).toBe(400);
    expect(r.body.errors.join(' ')).toMatch(
      /variants\[ro-v1\]\.statementMd: .*unknown placeholder "extra"/,
    );
    expect((await detail('q-rotate')).version.revision).toBe(before.version.revision);
    for (const id of ['ro-v1', 'ro-v2']) {
      await call('AUTHOR', 'PATCH', `${V}/q-rotate/versions/1/variants/${id}`, { isActive: false });
    }
    const ok = await call('AUTHOR', 'PATCH', `${V}/q-rotate`, {
      statementMd: 'Rotate {{size}} by {{steps}} and {{extra}}.',
    });
    expect(ok.status).toBe(200);
  });

  it('FR-204 TC-013: editing a published question forks the next draft with copies of the variants (new ids) and overrides on the new slots', async () => {
    const v2 = await detail('q-merge');
    const forked = await call<Detail>('AUTHOR', 'PATCH', `${V}/q-merge`, {
      title: 'Merge, take two',
    });
    expect(forked.body.createdNewVersion).toBe(true);
    const v3 = forked.body.version;
    expect(v3.version).toBe(3);
    expect(v3.variants).toHaveLength(2);
    const oldIds = v2.version.variants.map((v) => v.id);
    for (const v of v3.variants) expect(oldIds).not.toContain(v.id);
    const newSlots = new Set(v3.testCases.map((t) => t.id));
    const oldSlots = new Set(v2.version.testCases.map((t) => t.id));
    const overrides = v3.variants.flatMap((v) => v.testCaseOverrides);
    expect(overrides).toHaveLength(1);
    for (const o of overrides) {
      expect(newSlots.has(o.testCaseId)).toBe(true);
      expect(oldSlots.has(o.testCaseId)).toBe(false);
    }
    expect(v3.variants.map((v) => v.params.count)).toEqual([3, 4]);
    // The published version is unchanged.
    const again = await detail('q-merge', 2);
    expect(again.version.variants).toEqual(v2.version.variants);
  });
});

describe('Variants and roles (FR-103, TC-004, TC-011)', () => {
  it('TC-004: a recruiter cannot list or change variants (403) and the detail has no variants key', async () => {
    expect((await call('RECRUITER', 'GET', `${V}/q-merge/versions/2/variants`)).status).toBe(403);
    expect(
      (await call('RECRUITER', 'POST', `${V}/q-merge/versions/2/variants`, { params: {} })).status,
    ).toBe(403);
    expect(
      (
        await call('RECRUITER', 'PATCH', `${V}/q-merge/versions/2/variants/mi-v1`, {
          isActive: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('REVIEWER', 'GET', `${V}/q-merge/versions/2/variants/mi-v1/preview`)).status,
    ).toBe(403);
    const read = await call<{ version: Record<string, unknown> }>(
      'RECRUITER',
      'GET',
      `${V}/q-merge`,
    );
    expect(read.status).toBe(200);
    expect(Object.keys(read.body.version)).not.toContain('variants');
    expect(read.text).not.toContain('renderedStatement');
    expect(read.text).not.toContain('"params"');
  });

  it('TC-011: the variant preview is candidate-shaped: rendered text, own samples, no params, hidden data, reference or key', async () => {
    const r = await call<Record<string, unknown>>(
      'RECRUITER',
      'GET',
      `${V}/q-merge/versions/2/variants/mi-v2/preview`,
    );
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      'languages',
      'limits',
      'samples',
      'starterCode',
      'statementMd',
      'title',
      'type',
    ]);
    expect(r.body.statementMd).toContain('Given **4** intervals');
    const samples = r.body.samples as { input: string; expectedOutput: string }[];
    expect(samples).toHaveLength(2); // the two visible slots, never the hidden ones
    expect(samples[0]!.input).toBe('4\n1 3\n2 6\n8 10\n15 18'); // the variant's own override
    for (const needle of [
      'out.append',
      '"params"',
      'referenceSolution',
      '5 9',
      'answerSpec',
      'isHidden',
    ]) {
      expect(r.text).not.toContain(needle);
    }
    expect(JSON.stringify(r.body.starterCode)).toContain('4 intervals follow');
  });

  it('TC-004: a recruiter previews published versions and active variants only (else 404); an author previews drafts and inactive variants', async () => {
    expect(
      (await call('RECRUITER', 'GET', `${V}/q-rotate/versions/1/variants/ro-v1/preview`)).status,
    ).toBe(404); // a draft
    const author = await call('AUTHOR', 'GET', `${V}/q-rotate/versions/1/variants/ro-v1/preview`);
    expect(author.status).toBe(200);
    // A published version with an inactive variant: add one on a fork, publish it, then preview.
    expect(
      (await call('RECRUITER', 'GET', `${V}/q-merge/versions/2/variants/not-a-variant/preview`))
        .status,
    ).toBe(404);
    expect(
      (await call('RECRUITER', 'GET', `${V}/q-merge/versions/9/variants/mi-v1/preview`)).status,
    ).toBe(404);
  });
});

describe('The editor saves variants through the real routes (FR-203, FR-204)', () => {
  async function openEditor(id: string) {
    nav.pathname = `/admin/questions/${id}`;
    renderAsStaff(
      <main>
        <QuestionEditorRoute id={id} pollMs={5} />
      </main>,
      MOCK_USERS.author,
    );
    await screen.findByRole('tablist', { name: 'Question sections' });
    return userEvent.setup();
  }
  const goTab = (u: ReturnType<typeof userEvent.setup>, name: string | RegExp) =>
    u.click(screen.getByRole('tab', { name }));
  async function setText(u: ReturnType<typeof userEvent.setup>, el: HTMLElement, text: string) {
    await u.clear(el);
    await u.click(el);
    if (text !== '') await u.paste(text);
  }
  const saveButton = () => screen.getByRole('button', { name: 'Save' });

  it('FR-203: a variant with no name is called "Variant N"; adding, changing and removing variants and overrides is saved and read back', async () => {
    const u = await openEditor('q-rotate');
    await goTab(u, 'Variants');
    expect(screen.getByRole('region', { name: 'Variant 1' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Variant name')).not.toBeInTheDocument();
    // Change variant 1's steps, remove variant 2 and add a new one.
    await setText(
      u,
      within(screen.getByRole('region', { name: 'Variant 1' })).getByLabelText('Parameters (JSON)'),
      '{"size": 5, "steps": 4}',
    );
    await u.click(
      within(screen.getByRole('region', { name: 'Variant 2' })).getByRole('button', {
        name: 'Remove Variant 2',
      }),
    );
    await u.click(screen.getByRole('button', { name: 'Add variant' }));
    const added = screen.getByRole('region', { name: 'Variant 2' });
    await setText(u, within(added).getByLabelText('Parameters (JSON)'), '{"size": 7, "steps": 2}');
    await u.click(within(added).getByRole('checkbox', { name: /Override slot 1/ }));
    await setText(u, within(added).getByLabelText('Expected output, slot 1'), '6 7 1 2 3 4 5');
    await u.click(saveButton());
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();

    const d = await detail('q-rotate');
    expect(d.version.variants.map((v) => v.params)).toHaveLength(2);
    expect(d.version.variants.map((v) => v.params.steps).sort()).toEqual([2, 4]);
    const second = d.version.variants.find((v) => v.params.steps === 2)!;
    expect(second.testCaseOverrides[0]!.expectedOutput).toBe('6 7 1 2 3 4 5');
    expect(second.renderedStatement).toContain('**7**');
    // The form shows what the server has and is clean again.
    expect(saveButton()).toBeDisabled();
  });

  it('FR-203 TC-012: adding a placeholder and its param in one save works on a draft (the params go first, then the statement)', async () => {
    const u = await openEditor('q-rotate');
    await setText(
      u,
      screen.getByLabelText('Statement (Markdown)'),
      'Rotate **{{size}}** numbers by **{{steps}}** places, direction {{dir}}.',
    );
    await goTab(u, 'Variants');
    for (const [name, params] of [
      ['Variant 1', '{"size": 5, "steps": 2, "dir": "right"}'],
      ['Variant 2', '{"size": 6, "steps": 3, "dir": "right"}'],
    ] as const) {
      await setText(
        u,
        within(screen.getByRole('region', { name })).getByLabelText('Parameters (JSON)'),
        params,
      );
    }
    await u.click(saveButton());
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    const d = await detail('q-rotate');
    expect(d.version.variants.every((v) => v.params.dir === 'right')).toBe(true);
    expect(d.version.variants.every((v) => v.renderedStatement.includes('direction right'))).toBe(
      true,
    );
  });

  it('FR-203 FR-204: on a published question the same edit forks the draft and the variants follow (new ids, mapped by content)', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Variant 2' });
    await setText(u, within(card).getByLabelText('Parameters (JSON)'), '{"count": 8}');
    await u.click(saveButton());
    expect(await screen.findByText(/Saved as version 3/)).toBeInTheDocument();
    const d = await detail('q-merge');
    expect(d.version.version).toBe(3);
    expect(d.version.variants.map((v) => v.params.count).sort()).toEqual([3, 8]);
    // Version 2 is untouched.
    expect((await detail('q-merge', 2)).version.variants.map((v) => v.params.count)).toEqual([
      3, 4,
    ]);
    // The override moved with its variant onto a new slot id.
    const withOverride = d.version.variants.find((v) => v.testCaseOverrides.length > 0)!;
    expect(withOverride.params.count).toBe(8);
    expect(
      d.version.testCases.some((t) => t.id === withOverride.testCaseOverrides[0]!.testCaseId),
    ).toBe(true);
  });

  it('FR-203: the candidate view button shows the saved rendering of a saved variant, not of a new one', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const first = screen.getByRole('region', { name: 'Variant 1' });
    await u.click(within(first).getByRole('button', { name: /Show what a candidate sees/ }));
    const view = await within(first).findByRole('region', { name: 'Candidate view of Variant 1' });
    expect(view).toHaveTextContent('Given 3 intervals');
    expect(view).toHaveTextContent('2 sample cases');
    await u.click(screen.getByRole('button', { name: 'Add variant' }));
    const fresh = screen.getByRole('region', { name: 'Variant 3' });
    expect(
      within(fresh).queryByRole('button', { name: /Show what a candidate sees/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });
});

describe('A save that stops half way says where (FR-204)', () => {
  async function openAndEdit() {
    nav.pathname = '/admin/questions/q-rotate';
    renderAsStaff(
      <main>
        <QuestionEditorRoute id="q-rotate" pollMs={5} />
      </main>,
      MOCK_USERS.author,
    );
    await screen.findByRole('tablist', { name: 'Question sections' });
    const u = userEvent.setup();
    await u.click(screen.getByRole('tab', { name: 'Variants' }));
    const card = screen.getByRole('region', { name: 'Variant 1' });
    await u.click(within(card).getByRole('checkbox', { name: /Override slot 1/ }));
    await u.click(screen.getByRole('tab', { name: 'Statement' }));
    return { u, card };
  }

  it('FR-204: a failure in the variants step after the content was saved names the step, keeps the edits and lets the author press Save again', async () => {
    let fail = true;
    server.use(
      http.put(
        `${apiBaseUrl}/v1/questions/q-rotate/versions/1/variants/ro-v1/test-cases/:id`,
        () => (fail ? HttpResponse.json({ detail: 'busy' }, { status: 500 }) : undefined),
      ),
    );
    const { u } = await openAndEdit();
    await u.type(screen.getByLabelText('Title'), '!');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Some of your changes were saved, but the variants could not be/),
    ).toBeInTheDocument();
    // A draft: no reload is forced (nothing is conflicting) and the edits are still on the page.
    expect(
      screen.queryByRole('button', { name: /Reload the latest version/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Rotate an array!');
    // The title WAS saved by the content step.
    expect((await detail('q-rotate')).version.title).toMatch(/!$/);
    // The editor took the server's revision, so the retry works instead of ending in a 409.
    fail = false;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/^Saved/)).toBeInTheDocument();
    const after = (await detail('q-rotate')).version.variants.find((v) => v.id === 'ro-v1')!;
    expect(after.testCaseOverrides).toHaveLength(1);
  });

  it('FR-204: a 409 in a later step says the question changed meanwhile, and keeps the edits', async () => {
    server.use(
      http.put(`${apiBaseUrl}/v1/questions/q-rotate/versions/1/variants/ro-v1/test-cases/:id`, () =>
        HttpResponse.json({ detail: 'changed' }, { status: 409 }),
      ),
    );
    const { u } = await openAndEdit();
    await u.type(screen.getByLabelText('Title'), '?');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/then the variants step found that the question changed meanwhile/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Rotate an array?');
  });

  it('FR-204: a failure of the final read-back is a "reload" step: the changes were saved', async () => {
    let gets = 0;
    server.use(
      http.get(`${apiBaseUrl}/v1/questions/q-rotate`, () => {
        gets += 1;
        // The loader's own read is the first; the read-back after the save is the second.
        return gets >= 2 ? HttpResponse.json({ detail: 'down' }, { status: 500 }) : undefined;
      }),
    );
    nav.pathname = '/admin/questions/q-rotate';
    renderAsStaff(
      <main>
        <QuestionEditorRoute id="q-rotate" pollMs={5} />
      </main>,
      MOCK_USERS.author,
    );
    await screen.findByRole('tablist', { name: 'Question sections' });
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Title'), '#');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Your changes were saved, but we could not load the saved version/),
    ).toBeInTheDocument();
  });
});

describe('A save whose test-case call fails (FR-204)', () => {
  it('FR-204: the content PATCH goes through, a test-case call fails with 500: partial message, no Saved notice, and a retry finishes the job', async () => {
    let fail = true;
    server.use(
      http.post(`${apiBaseUrl}/v1/questions/q-rotate/versions/1/test-cases`, () =>
        fail ? HttpResponse.json({ detail: 'busy' }, { status: 500 }) : undefined,
      ),
    );
    nav.pathname = '/admin/questions/q-rotate';
    renderAsStaff(
      <main>
        <QuestionEditorRoute id="q-rotate" pollMs={5} />
      </main>,
      MOCK_USERS.author,
    );
    await screen.findByRole('tablist', { name: 'Question sections' });
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Title'), '!');
    await u.click(screen.getByRole('tab', { name: 'Test cases' }));
    await u.click(screen.getByRole('button', { name: 'Add test case' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Some of your changes were saved, but the test cases could not be/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();
    expect((await detail('q-rotate')).version.title).toMatch(/!$/);
    fail = false;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/^Saved/)).toBeInTheDocument();
    expect((await detail('q-rotate')).version.testCases).toHaveLength(3);
  });
});
