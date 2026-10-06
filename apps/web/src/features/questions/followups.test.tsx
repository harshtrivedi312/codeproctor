import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { setMockQuestionScenario } from '@/mocks/question-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { aiReferenceFormSchema } from './ai-schema';
import { QuestionEditorRoute } from './question-pages';
import { questionKeys } from './queries';
import { ValidationPanel } from './validation-panel';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('./monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const V = '/v1/questions';
const base = `${apiBaseUrl}${V}`;
type Role = 'AUTHOR' | 'RECRUITER' | 'REVIEWER' | 'SUPER_ADMIN';
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
interface Detail {
  version: {
    version: number;
    revision: string;
    title: string;
    isPublished: boolean;
    testCases: { id: string; position: number }[];
    variants: { id: string; isActive: boolean; params: Record<string, unknown> }[];
  };
}
const detail = async (id: string, version?: number): Promise<Detail> =>
  (await call<Detail>('AUTHOR', 'GET', `${V}/${id}${version ? `?version=${version}` : ''}`)).body;
const aiRow = (assistant: string, language = 'python', extra: object = {}) => ({
  assistant,
  modelLabel: 'model',
  language,
  solutionCode: 'print(1)',
  ...extra,
});
async function finished(id: string): Promise<Record<string, unknown>> {
  let s = (await call('AUTHOR', 'GET', `${V}/${id}/validation`)).body;
  for (let i = 0; i < 4 && s.status === 'RUNNING'; i += 1) {
    s = (await call('AUTHOR', 'GET', `${V}/${id}/validation`)).body;
  }
  return s;
}

describe('GET /questions/ai-policy (FR-103, AI-5, BE-04 follow-ups)', () => {
  it('AI-5: an Author and a Super Admin read the real policy; the body is {minAssistants, isDefault, refreshIntervalDays}', async () => {
    for (const role of ['AUTHOR', 'SUPER_ADMIN'] as const) {
      const r = await call<Record<string, unknown>>(role, 'GET', `${V}/ai-policy`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ minAssistants: 2, isDefault: true, refreshIntervalDays: null });
    }
    setMockQuestionScenario({ aiMinAssistants: 3, aiRefreshDays: 30 });
    const set = await call('AUTHOR', 'GET', `${V}/ai-policy`);
    expect(set.body).toEqual({ minAssistants: 3, isDefault: false, refreshIntervalDays: 30 });
  });

  it('TC-004 FR-103: recruiters and reviewers get a plain 403 (a problem body without a code)', async () => {
    for (const role of ['RECRUITER', 'REVIEWER'] as const) {
      const r = await call<Record<string, unknown>>(role, 'GET', `${V}/ai-policy`);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ status: 403, title: 'Forbidden' });
      expect(r.body).toHaveProperty('traceId');
      expect(r.body).not.toHaveProperty('code');
    }
  });

  it('AI-5: publish asks for the organisation minAssistants, not a fixed two', async () => {
    setMockQuestionScenario({ aiMinAssistants: 3 });
    const refused = await call<{ errors: string[] }>('AUTHOR', 'POST', `${V}/q-running/publish`);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toContain(
      'aiReferences.python: needs current rows from at least 3 distinct assistants (has 1)',
    );
    setMockQuestionScenario({ aiMinAssistants: 0 });
    const off = await call('AUTHOR', 'POST', `${V}/q-running/publish`);
    expect(off.status).toBe(200); // the gate is off and the seeded run is a passing one
  });

  it('FR-103: the policy query is keyed per user (and the whole cache is cleared on a user or role change)', () => {
    expect(questionKeys.aiPolicy('user-a')).not.toEqual(questionKeys.aiPolicy('user-b'));
    expect(questionKeys.aiPolicy('user-a')[2]).toBe('user-a');
  });
});

describe('Deleting a variant that has AI rows (ADR 0005 AI-1, VARIANT_HAS_AI_REFERENCES)', () => {
  it('AI-1: the API refuses with 409 and the code, for a current or a retired row, and nothing changes', async () => {
    const before = await detail('q-rotate');
    const row = await call<{ id: string }>(
      'AUTHOR',
      'POST',
      `${V}/q-rotate/versions/1/ai-references`,
      aiRow('ChatGPT', 'python', { variantId: 'ro-v1' }),
    );
    expect(row.status).toBe(201);
    const del = () =>
      call<Record<string, unknown>>('AUTHOR', 'DELETE', `${V}/q-rotate/versions/1/variants/ro-v1`);
    const refused = await del();
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('VARIANT_HAS_AI_REFERENCES');
    expect(String(refused.body.detail)).toMatch(/set it inactive instead/);
    // Retiring the row does not help: rows are never deleted and still point at the variant.
    await call(
      'AUTHOR',
      'POST',
      `${V}/q-rotate/versions/1/ai-references/${row.body.id}/supersede`,
      {},
    );
    expect((await del()).body.code).toBe('VARIANT_HAS_AI_REFERENCES');
    // A variant without rows is still deleted, and an inactive variant is the way out.
    expect((await call('AUTHOR', 'DELETE', `${V}/q-rotate/versions/1/variants/ro-v2`)).status).toBe(
      204,
    );
    const off = await call('AUTHOR', 'PATCH', `${V}/q-rotate/versions/1/variants/ro-v1`, {
      isActive: false,
    });
    expect(off.status).toBe(200);
    const after = await detail('q-rotate');
    expect(after.version.variants.map((v) => v.id)).toEqual(['ro-v1']);
    expect(before.version.variants).toHaveLength(2);
  });

  it('AI-1: the other 409s of the question routes carry no code', async () => {
    const stale = await call<Record<string, unknown>>(
      'AUTHOR',
      'DELETE',
      `${V}/q-rotate/versions/1/variants/ro-v1?expectedRevision=${'0'.repeat(64)}`,
    );
    expect(stale.status).toBe(409);
    expect(stale.body).not.toHaveProperty('code');
    const published = await call<Record<string, unknown>>(
      'AUTHOR',
      'DELETE',
      `${V}/q-merge/versions/2/variants/mi-v1`,
    );
    expect(published.status).toBe(409);
    expect(published.body).not.toHaveProperty('code');
  });
});

describe('Test-case routes take expectedRevision (FU-BE-106)', () => {
  const stale = '0'.repeat(64);
  it('FR-204: a stale revision is 409 without a code on POST, PATCH and DELETE, and changes nothing', async () => {
    const before = await detail('q-rotate');
    const slot = before.version.testCases[0]!.id;
    const path = `${V}/q-rotate/versions/1/test-cases`;
    for (const r of [
      await call('AUTHOR', 'POST', path, {
        input: '1',
        expectedOutput: '1',
        expectedRevision: stale,
      }),
      await call('AUTHOR', 'PATCH', `${path}/${slot}`, { input: 'x', expectedRevision: stale }),
      await call('AUTHOR', 'DELETE', `${path}/${slot}?expectedRevision=${stale}`),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body).not.toHaveProperty('code');
    }
    expect((await detail('q-rotate')).version.revision).toBe(before.version.revision);
  });

  it('FR-204: the current revision is accepted and every write moves it', async () => {
    const r0 = (await detail('q-rotate')).version.revision;
    const created = await call<{ id: string }>(
      'AUTHOR',
      'POST',
      `${V}/q-rotate/versions/1/test-cases`,
      {
        input: '1',
        expectedOutput: '1',
        expectedRevision: r0,
      },
    );
    expect(created.status).toBe(201);
    const r1 = (await detail('q-rotate')).version.revision;
    expect(r1).not.toBe(r0);
    // The old revision is stale now.
    expect(
      (
        await call('AUTHOR', 'PATCH', `${V}/q-rotate/versions/1/test-cases/${created.body.id}`, {
          input: '2',
          expectedRevision: r0,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          'AUTHOR',
          'DELETE',
          `${V}/q-rotate/versions/1/test-cases/${created.body.id}?expectedRevision=${r1}`,
        )
      ).status,
    ).toBe(204);
  });

  it('TC-012: a malformed revision is a 400 before any lookup (a missing question is not a 404 first)', async () => {
    expect(
      (
        await call('AUTHOR', 'POST', `${V}/q-nope/versions/1/test-cases`, {
          input: '1',
          expectedOutput: '1',
          expectedRevision: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('AUTHOR', 'DELETE', `${V}/q-nope/versions/1/test-cases/tc-1?expectedRevision=x`))
        .status,
    ).toBe(400);
  });
});

describe('Mock fidelity: DTO checks come first (400 before 404), ids and templates', () => {
  it('TC-012: PATCH and publish with a body no DTO declares are 400 even for a question that does not exist', async () => {
    expect((await call('AUTHOR', 'PATCH', `${V}/q-nope`, { foo: 1 })).status).toBe(400);
    expect((await call('AUTHOR', 'POST', `${V}/q-nope/publish`, { foo: 1 })).status).toBe(400);
    expect((await call('AUTHOR', 'PATCH', `${V}/q-nope`, { title: 'x' })).status).toBe(404);
    // A role that may not write is 403 first, whatever the body.
    expect((await call('RECRUITER', 'PATCH', `${V}/q-nope`, { foo: 1 })).status).toBe(403);
  });

  it('FR-203: the id of an unsaved row (draft-var-...) is a 400 on every variant and AI route, as the @IsUUID pipes answer', async () => {
    const bad = 'draft-var-1234';
    const v = `${V}/q-rotate/versions/1/variants`;
    expect((await call('AUTHOR', 'PATCH', `${v}/${bad}`, { isActive: false })).status).toBe(400);
    expect((await call('AUTHOR', 'DELETE', `${v}/${bad}`)).status).toBe(400);
    expect(
      (
        await call('AUTHOR', 'PUT', `${v}/ro-v1/test-cases/${bad}`, {
          input: 'a',
          expectedOutput: 'b',
        })
      ).status,
    ).toBe(400);
    expect((await call('AUTHOR', 'DELETE', `${v}/${bad}/test-cases/ro-t1`)).status).toBe(400);
    expect(
      (await call('RECRUITER', 'GET', `${V}/q-merge/versions/2/variants/${bad}/preview`)).status,
    ).toBe(400);
    expect(
      (await call('AUTHOR', 'POST', `${V}/q-rotate/versions/1/ai-references/${bad}/supersede`, {}))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          'AUTHOR',
          'POST',
          `${V}/q-rotate/versions/1/ai-references`,
          aiRow('A', 'python', { variantId: bad }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await call('AUTHOR', 'PATCH', `${V}/q-rotate/versions/1/test-cases/${bad}`, { input: 'a' }))
        .status,
    ).toBe(400);
    // A well-formed id of nothing is still a 404.
    expect((await call('AUTHOR', 'PATCH', `${v}/ro-v9`, { isActive: false })).status).toBe(404);
  });

  it('FR-203: a template with a syntax error reports only the syntax errors, like the API', async () => {
    const r = await call<{ errors: string[] }>('AUTHOR', 'PATCH', `${V}/q-rotate`, {
      statementMd: 'Rotate {{#x}} and {{nope}}',
    });
    expect(r.status).toBe(400);
    const text = r.body.errors.join(' ');
    expect(text).toMatch(/only \{\{name\}\} placeholders are supported/);
    expect(text).not.toMatch(/unknown placeholder/);
  });

  it('FR-203: params are bounded in total and refuse a NUL byte', async () => {
    const path = `${V}/q-running/versions/1/variants`;
    const big = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]),
    );
    const tooBig = await call<{ errors: string[] }>('AUTHOR', 'POST', path, { params: big });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.errors.join(' ')).toMatch(/too large in total/);
    const nul = await call<{ errors: string[] }>('AUTHOR', 'POST', path, {
      params: { a: 'x\u0000y' },
    });
    expect(nul.status).toBe(400);
    expect(nul.body.errors.join(' ')).toMatch(/NUL byte or a lone surrogate/);
  });

  it('TC-012: a coding version with no tests fails validation as MISSING_REFERENCE, not as a pass', async () => {
    const created = await call<{ id: string }>('AUTHOR', 'POST', V, {
      type: 'CODING',
      title: 'No tests',
      statementMd: 'S',
      difficulty: 'EASY',
      allowedLanguages: ['python'],
      referenceSolution: { python: 'print(1)' },
    });
    expect(created.status).toBe(201);
    expect((await call('AUTHOR', 'POST', `${V}/${created.body.id}/validate`)).status).toBe(202);
    const done = (await finished(created.body.id)) as {
      status: string;
      report: {
        passed: boolean;
        perVariant: { passed: boolean; cells: unknown[]; failures: Record<string, unknown>[] }[];
      };
    };
    expect(done.status).toBe('FAILED');
    const only = done.report.perVariant[0]!;
    expect(only.passed).toBe(false);
    expect(only.cells).toEqual([
      { language: 'python', passed: false, testsPassed: 0, testsTotal: 0 },
    ]);
    expect(only.failures[0]).toMatchObject({
      verdict: 'MISSING_REFERENCE',
      testCaseId: null,
      position: null,
    });
  });
});

describe('Pure pieces', () => {
  it('AI-1: the pasted solution is kept exactly as pasted; only a blank one is refused', () => {
    const ok = aiReferenceFormSchema.safeParse({
      assistant: ' ChatGPT ',
      modelLabel: 'm',
      language: 'python',
      variantId: '',
      solutionCode: '  print(1)\n\n',
      promptText: '',
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.solutionCode).toBe('  print(1)\n\n');
    expect(ok.success && ok.data.assistant).toBe('ChatGPT');
    const blank = aiReferenceFormSchema.safeParse({
      assistant: 'A',
      modelLabel: 'm',
      language: 'python',
      variantId: '',
      solutionCode: '  \n ',
      promptText: '',
    });
    expect(blank.success).toBe(false);
  });

  it('TC-012: a verdict the web does not know still gets a label instead of a blank badge', () => {
    render(
      <ValidationPanel
        isCoding
        stale={false}
        fresh={false}
        variantNames={new Map()}
        report={{
          passed: false,
          revision: '0'.repeat(64),
          startedAt: '2026-10-01T00:00:00.000Z',
          finishedAt: '2026-10-01T00:00:01.000Z',
          perVariant: [
            {
              variantId: null,
              passed: false,
              cells: [{ language: 'python', passed: false, testsPassed: 0, testsTotal: 1 }],
              failures: [
                { language: 'python', testCaseId: 't', position: 0, verdict: 'SOMETHING_NEW' },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('Could not be run')).toBeInTheDocument();
  });
});

type User = ReturnType<typeof userEvent.setup>;
async function openEditor(id: string, role: 'author' | 'recruiter' = 'author'): Promise<User> {
  nav.pathname = `/admin/questions/${id}`;
  renderAsStaff(
    <main>
      <QuestionEditorRoute id={id} pollMs={5} />
    </main>,
    role === 'author' ? MOCK_USERS.author : MOCK_USERS.recruiter,
  );
  if (role === 'author') await screen.findByRole('tablist', { name: 'Question sections' });
  return userEvent.setup();
}
const goTab = (u: User, name: string | RegExp) => u.click(screen.getByRole('tab', { name }));
async function setText(u: User, el: HTMLElement, text: string): Promise<void> {
  await u.clear(el);
  await u.click(el);
  if (text !== '') await u.paste(text);
}
const saveButton = () => screen.getByRole('button', { name: 'Save' });
const checkText = (id: string) => screen.getByTestId(`check-${id}`).textContent ?? '';

describe('Variants with AI rows in the editor (S7)', () => {
  it('AI-1: a variant that has AI rows says so before anything is deleted: no Remove button, an inactive switch instead', async () => {
    await call(
      'AUTHOR',
      'POST',
      `${V}/q-rotate/versions/1/ai-references`,
      aiRow('ChatGPT', 'python', { variantId: 'ro-v1' }),
    );
    const u = await openEditor('q-rotate');
    await goTab(u, 'Variants');
    const card1 = screen.getByRole('region', { name: 'Variant 1' });
    expect(
      await within(card1).findByText(/Variant 1 has 1 AI reference solution/),
    ).toBeInTheDocument();
    expect(
      within(card1).getByText(/never deleted, so this variant cannot be removed/),
    ).toBeInTheDocument();
    expect(
      within(card1).queryByRole('button', { name: /Remove Variant 1/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Variant 2' })).toBeInTheDocument();
    await u.click(within(card1).getByRole('button', { name: 'Set Variant 1 inactive' }));
    expect(
      within(card1).getByRole('checkbox', { name: /Active.*for Variant 1/ }),
    ).not.toBeChecked();
    await u.click(saveButton());
    expect(await screen.findByText(/^Saved/)).toBeInTheDocument();
    expect(
      (await detail('q-rotate')).version.variants.find((x) => x.id === 'ro-v1')?.isActive,
    ).toBe(false);
  });

  it('AI-1: when the server still answers 409 VARIANT_HAS_AI_REFERENCES, the message is honest, it is no "changed" conflict, nothing is lost and nobody is signed out', async () => {
    server.use(
      http.delete(`${base}/q-rotate/versions/1/variants/ro-v2`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail:
              'The variant has AI reference rows, which are never deleted; set it inactive instead.',
            code: 'VARIANT_HAS_AI_REFERENCES',
          },
          { status: 409 },
        ),
      ),
    );
    const u = await openEditor('q-rotate');
    await goTab(u, 'Variants');
    await u.click(screen.getByRole('button', { name: 'Remove Variant 2' }));
    await goTab(u, 'Statement');
    await u.type(screen.getByLabelText('Title'), '?');
    await u.click(saveButton());
    expect(
      await screen.findByText(/This variant has AI reference solutions, which are never deleted/),
    ).toBeInTheDocument();
    expect(screen.queryByText('This question changed since you opened it')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Reload the latest version/ }),
    ).not.toBeInTheDocument();
    // Nothing was written, the edit is still on the page, and the editor is still the signed-in editor.
    expect(screen.getByLabelText('Title')).toHaveValue('Rotate an array?');
    expect((await detail('q-rotate')).version.title).toBe('Rotate an array');
    expect(screen.getByRole('tablist', { name: 'Question sections' })).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('AI-1: the same 409 after part of a fork was written says so and asks for a reload (ids changed)', async () => {
    server.use(
      http.delete(`${base}/q-merge/versions/3/variants/:id`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'x',
            code: 'VARIANT_HAS_AI_REFERENCES',
          },
          { status: 409 },
        ),
      ),
    );
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    await u.click(screen.getByRole('button', { name: 'Remove Variant 1' }));
    await u.click(saveButton());
    expect(
      await screen.findByText(
        /Some of your changes were saved, but this variant has AI reference solutions/,
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /Reload the latest version/ }),
    ).toBeInTheDocument();
  });
});

describe('Chained revisions (S3) and the save order (S4, S1)', () => {
  it('FR-204: another editor writing between two of our calls makes the next call a 409, never a silent overwrite', async () => {
    let first = true;
    server.use(
      http.patch(`${base}/q-rotate/versions/1/test-cases/:id`, async () => {
        if (first) {
          first = false;
          // The other author saves just before our first test-case write reaches the API.
          await call('AUTHOR', 'PATCH', `${V}/q-rotate`, { title: 'Rotate (by someone else)' });
        }
        return undefined;
      }),
    );
    const u = await openEditor('q-rotate');
    await goTab(u, 'Test cases');
    await setText(u, screen.getByLabelText('Input of test 1'), 'changed input');
    await u.click(saveButton());
    expect(
      await screen.findByText(/found that the question changed meanwhile/),
    ).toBeInTheDocument();
    // Their change is intact, ours did not overwrite it.
    expect((await detail('q-rotate')).version.title).toBe('Rotate (by someone else)');
    expect(screen.getByLabelText('Input of test 1')).toHaveValue('changed input');
  });

  it('TC-012: every write after the first sends the revision of the last one (the requests carry expectedRevision)', async () => {
    const seen: { method: string; url: string; body: string }[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) &&
        request.url.includes('/q-rotate')
      ) {
        seen.push({ method: request.method, url: request.url, body: await request.clone().text() });
      }
    });
    const u = await openEditor('q-rotate');
    await goTab(u, 'Test cases');
    await setText(u, screen.getByLabelText('Input of test 1'), 'abc');
    await goTab(u, 'Variants');
    const c = screen.getByRole('region', { name: 'Variant 2' });
    await u.click(within(c).getByRole('checkbox', { name: /Override slot 1/ }));
    await u.click(saveButton());
    await screen.findByText(/^Saved/);
    const writes = seen.filter((s) => !s.url.endsWith('/validate'));
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const w of writes) {
      const carried = w.url.includes('expectedRevision=') || w.body.includes('expectedRevision');
      expect(carried).toBe(true);
    }
  });

  it('S4 FR-203: removing a variant and adding a placeholder in one save works on a draft (the removal goes before the statement PATCH)', async () => {
    const u = await openEditor('q-rotate');
    await setText(
      u,
      screen.getByLabelText('Statement (Markdown)'),
      'Rotate **{{size}}** by **{{steps}}** places, mode {{mode}}.',
    );
    await goTab(u, 'Variants');
    await u.click(screen.getByRole('button', { name: 'Remove Variant 1' }));
    const v2 = screen.getByRole('region', { name: 'Variant 1' }); // Variant 2 is now first
    await setText(
      u,
      within(v2).getByLabelText('Parameters (JSON)'),
      '{"size": 6, "steps": 3, "mode": "fast"}',
    );
    await u.click(saveButton());
    expect(await screen.findByText(/^Saved/)).toBeInTheDocument();
    const d = await detail('q-rotate');
    expect(d.version.variants).toHaveLength(1);
    expect(d.version.variants[0]?.params.mode).toBe('fast');
  });

  it('S1 FR-204: after a publish, adding a param to a variant forks a new draft with no false conflict (the old draft snapshot is not written to)', async () => {
    // A validated draft with a variant and the AI rows publish needs.
    await call('AUTHOR', 'POST', `${V}/q-running/versions/1/variants`, { params: { note: 'x' } });
    for (const language of ['python', 'javascript']) {
      await call(
        'AUTHOR',
        'POST',
        `${V}/q-running/versions/1/ai-references`,
        aiRow('Claude', language),
      );
    }
    await call('AUTHOR', 'POST', `${V}/q-running/validate`);
    expect((await finished('q-running')).status).toBe('PASSED');
    const u = await openEditor('q-running');
    await u.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(
      await screen.findByText(/Version 1 is published\. Editing it later/),
    ).toBeInTheDocument();
    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Variant 1' });
    await setText(u, within(card).getByLabelText('Parameters (JSON)'), '{"note": "x", "extra": 1}');
    await u.click(saveButton());
    expect(await screen.findByText(/Saved as version 2 \(draft\)/)).toBeInTheDocument();
    expect(screen.queryByText('This question changed since you opened it')).not.toBeInTheDocument();
    const v2 = await detail('q-running');
    expect(v2.version.version).toBe(2);
    expect(v2.version.variants[0]?.params.extra).toBe(1);
  });
});

describe('Validate button (S2) and the publish checklist (S5)', () => {
  it('S2 FR-205: there is no Validate for a multiple-choice question, and it is off on a published latest version', async () => {
    await openEditor('q-mcq-draft');
    expect(screen.queryByRole('button', { name: 'Validate' })).not.toBeInTheDocument();
    cleanup2();
    await openEditor('q-twosum');
    expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
  });

  it('S2 FR-204: a 409 that is not a stale revision (the question is archived) is not shown as "someone saved a newer version"', async () => {
    server.use(
      http.post(`${base}/q-rotate/validate`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'The question is archived.',
          },
          { status: 409 },
        ),
      ),
    );
    const u = await openEditor('q-rotate');
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(
      await screen.findByText(/The question is archived\. Reload the page/),
    ).toBeInTheDocument();
    expect(screen.queryByText('This question changed since you opened it')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validate' })).toBeEnabled();
  });

  it('S5 TC-012: the checklist asks for a visible and a hidden test and weights above 0', async () => {
    const u = await openEditor('q-rotate');
    expect(checkText('tests')).toMatch(/Done/);
    await goTab(u, 'Test cases');
    await u.click(screen.getByRole('checkbox', { name: /Test 1 is/ })); // hide the only visible one
    expect(checkText('tests')).toMatch(/To do/);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await u.click(screen.getByRole('checkbox', { name: /Test 1 is/ }));
    expect(checkText('tests')).toMatch(/Done/);
  });
});

function cleanup2(): void {
  document.body.innerHTML = '';
}

describe('The AI tab reads the real policy (ai-policy) and lists saved variants only (S6, S8)', () => {
  it('AI-5: the tab shows the organisation requirement and the gate counts against it', async () => {
    setMockQuestionScenario({ aiMinAssistants: 3 });
    const u = await openEditor('q-merge');
    await goTab(u, 'AI reference solutions');
    expect(await screen.findAllByText(/Needs 1 more/)).toHaveLength(3);
    expect(screen.getByText(/at least 3 different AI assistants/)).toBeInTheDocument();
    expect(checkText('ai')).toMatch(/To do/);
  });

  it('AI-5: the standard requirement is called that; an unreadable policy keeps Publish off and says so', async () => {
    const u = await openEditor('q-running');
    await goTab(u, 'AI reference solutions');
    expect(
      await screen.findByText(/standard requirement: your organisation has not set its own/),
    ).toBeInTheDocument();
  });

  it('AI-5 TC-012: if the policy cannot be read the gate fails closed ("Unknown") instead of guessing', async () => {
    server.use(
      http.get(`${base}/ai-policy`, () => HttpResponse.json({ detail: 'down' }, { status: 500 })),
    );
    const u = await openEditor('q-running');
    await goTab(u, 'AI reference solutions');
    expect(
      await screen.findByText(/could not read your organisation's requirement/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('FR-103: a recruiter reading a question never calls the policy or the AI routes', async () => {
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (/ai-policy|ai-references|\/validation/.test(request.url)) calls.push(request.url);
    });
    await openEditor('q-merge', 'recruiter');
    await screen.findByTestId('summary-statement');
    expect(calls).toEqual([]);
  });

  it('S6 FR-203: "Applies to" lists saved variants only (an unsaved one has no id the API accepts)', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    await u.click(screen.getByRole('button', { name: 'Add variant' }));
    await goTab(u, 'AI reference solutions');
    await u.click(await screen.findByRole('button', { name: 'Add solution' }));
    const dialog = screen.getByRole('dialog');
    const options = within(within(dialog).getByLabelText('Applies to'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Base statement', 'Variant 1', 'Variant 2']);
  });

  it('S8 AI-5: a refused publish stops being refused as soon as the AI list changes', async () => {
    // The policy the editor reads says one assistant is enough; the API still wants two.
    server.use(
      http.get(`${base}/ai-policy`, () =>
        HttpResponse.json({ minAssistants: 1, isDefault: false, refreshIntervalDays: null }),
      ),
    );
    const u = await openEditor('q-running');
    const publish = await screen.findByRole('button', { name: 'Publish' });
    await waitFor(() => expect(publish).toBeEnabled());
    await u.click(publish);
    expect(await screen.findByText(/Publishing was refused: .*aiReferences/)).toBeInTheDocument();
    expect(publish).toBeDisabled();
    await goTab(u, 'AI reference solutions');
    await u.click(await screen.findByRole('button', { name: 'Add solution' }));
    const dialog = screen.getByRole('dialog');
    await u.type(within(dialog).getByLabelText('Assistant'), 'Claude');
    await u.type(within(dialog).getByLabelText('Model label'), 'sonnet');
    await u.click(await within(dialog).findByLabelText('AI solution code'));
    await u.paste('print(1)');
    await u.click(within(dialog).getByRole('button', { name: 'Add solution' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByText(/Publishing was refused/)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });
});

describe('Accessible names per variant card (a11y)', () => {
  it('WCAG 2.1 AA: every card has its own Remove, Active and Override names, and the tab has no axe violations', async () => {
    const u = await openEditor('q-merge');
    await goTab(u, 'Variants');
    for (const n of [1, 2]) {
      expect(screen.getByRole('button', { name: `Remove Variant ${n}` })).toBeInTheDocument();
      expect(
        screen.getByRole('checkbox', { name: new RegExp(`Active.*for Variant ${n}`) }),
      ).toBeInTheDocument();
    }
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
