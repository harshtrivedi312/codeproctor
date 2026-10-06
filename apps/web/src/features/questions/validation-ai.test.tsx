import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { setMockQuestionScenario } from '@/mocks/question-handlers';
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

interface Status {
  status: string;
  jobId: string | null;
  version: number;
  currentRevision: string;
  revision: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  validatedAt: string | null;
  report: {
    passed: boolean;
    revision: string;
    error?: string;
    perVariant: {
      variantId: string | null;
      passed: boolean;
      cells: { language: string; passed: boolean; testsPassed: number; testsTotal: number }[];
      failures: Record<string, unknown>[];
    }[];
  } | null;
}
interface Detail {
  version: { version: number; revision: string; validatedAt: string | null };
}
const detail = async (id: string): Promise<Detail> =>
  (await call<Detail>('AUTHOR', 'GET', `${V}/${id}`)).body;
const status = async (id: string): Promise<Status> =>
  (await call<Status>('AUTHOR', 'GET', `${V}/${id}/validation`)).body;
/** Reads the status until the run has finished (the fake run ends on the second read). */
async function finished(id: string): Promise<Status> {
  let s = await status(id);
  for (let i = 0; i < 4 && s.status === 'RUNNING'; i += 1) s = await status(id);
  return s;
}

const aiRow = (assistant: string, language = 'python') => ({
  assistant,
  modelLabel: 'model',
  language,
  solutionCode: 'print(1)',
});

describe('The validate job (FR-203, TC-012, BE-04c)', () => {
  it('FR-203: start answers 202 {jobId, status, revision, version, startedAt} bound to the draft revision, and the status follows it', async () => {
    const before = await detail('q-rotate');
    expect((await status('q-rotate')).status).toBe('NONE');
    const started = await call<Record<string, unknown>>(
      'AUTHOR',
      'POST',
      `${V}/q-rotate/validate`,
      {
        expectedRevision: before.version.revision,
      },
    );
    expect(started.status).toBe(202);
    expect(Object.keys(started.body).sort()).toEqual([
      'jobId',
      'revision',
      'startedAt',
      'status',
      'version',
    ]);
    expect(started.body.status).toBe('RUNNING');
    expect(started.body.revision).toBe(before.version.revision);
    const running = await status('q-rotate');
    expect(running).toMatchObject({
      status: 'RUNNING',
      jobId: started.body.jobId,
      revision: before.version.revision,
      currentRevision: before.version.revision,
      finishedAt: null,
      validatedAt: null,
    });
    // One run at a time.
    const second = await call('AUTHOR', 'POST', `${V}/q-rotate/validate`);
    expect(second.status).toBe(409);
    expect(second.body).not.toHaveProperty('code');
  });

  it('TC-012: a failing variant is reported per variant, language and slot, and never shows the output of a hidden slot', async () => {
    await call('AUTHOR', 'POST', `${V}/q-rotate/validate`);
    const done = await finished('q-rotate');
    expect(done.status).toBe('FAILED');
    expect(done.validatedAt).toBeNull();
    const report = done.report!;
    expect(report.passed).toBe(false);
    expect(report.revision).toBe(done.currentRevision);
    expect(report.perVariant.map((p) => [p.variantId, p.passed])).toEqual([
      ['ro-v1', true],
      ['ro-v2', false],
    ]);
    const bad = report.perVariant[1]!;
    expect(bad.cells).toEqual([
      { language: 'python', passed: false, testsPassed: 1, testsTotal: 2 },
    ]);
    expect(bad.failures).toHaveLength(1);
    expect(bad.failures[0]).toMatchObject({
      language: 'python',
      testCaseId: 'ro-t2',
      position: 1,
      verdict: 'FAILED',
    });
    // ro-t2 is a hidden slot: no actualOutput.
    expect(bad.failures[0]).not.toHaveProperty('actualOutput');
  });

  it('TC-012: fixing the data and validating again passes, sets validatedAt and binds the report to the current revision; any edit clears it', async () => {
    await call('AUTHOR', 'PUT', `${V}/q-rotate/versions/1/variants/ro-v2/test-cases/ro-t2`, {
      input: '1 2 3 4 5 6',
      expectedOutput: '4 5 6 1 2 3',
    });
    await call('AUTHOR', 'POST', `${V}/q-rotate/validate`);
    const done = await finished('q-rotate');
    expect(done.status).toBe('PASSED');
    expect(done.validatedAt).not.toBeNull();
    expect(done.report?.revision).toBe(done.currentRevision);
    expect((await detail('q-rotate')).version.validatedAt).not.toBeNull();
    await call('AUTHOR', 'PATCH', `${V}/q-rotate`, { title: 'Rotate again' });
    const after = await status('q-rotate');
    // The job is still the same PASSED one, but the content moved on: the revisions differ and
    // nothing is recorded as validated.
    expect(after.currentRevision).not.toBe(after.revision);
    expect(after.validatedAt).toBeNull();
  });

  it('FR-203: an executor error or a timeout ends as ERROR with the reason, records nothing and keeps publish closed', async () => {
    setMockQuestionScenario({ executor: 'TIMEOUT' });
    await call('AUTHOR', 'POST', `${V}/q-running/validate`);
    const done = await finished('q-running');
    expect(done.status).toBe('ERROR');
    expect(done.validatedAt).toBeNull();
    expect(done.report).toMatchObject({ passed: false, error: 'TIMEOUT', perVariant: [] });
    const publish = await call<{ errors: string[] }>('AUTHOR', 'POST', `${V}/q-running/publish`);
    expect(publish.status).toBe(422);
    expect(publish.body.errors.join(' ')).toMatch(/validation: a passing validation run/);
  });

  it('FR-203: start is 400 for unknown fields or a malformed revision, 409 for a stale one, a published latest or an archived question, 422 for a non-coding question', async () => {
    expect((await call('AUTHOR', 'POST', `${V}/q-rotate/validate`, { force: true })).status).toBe(
      400,
    );
    expect(
      (await call('AUTHOR', 'POST', `${V}/q-rotate/validate`, { expectedRevision: 'stale' }))
        .status,
    ).toBe(400);
    const stale = await call('AUTHOR', 'POST', `${V}/q-rotate/validate`, {
      expectedRevision: '0'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).not.toHaveProperty('code');
    expect((await call('AUTHOR', 'POST', `${V}/q-twosum/validate`)).status).toBe(409); // published
    expect((await call('AUTHOR', 'POST', `${V}/q-old/validate`)).status).toBe(409); // archived
    expect((await call('AUTHOR', 'POST', `${V}/q-mcq-draft/validate`)).status).toBe(422);
    expect((await call('AUTHOR', 'POST', `${V}/q-nope/validate`)).status).toBe(404);
    // Nothing started: the status is still NONE.
    expect((await status('q-rotate')).status).toBe('NONE');
  });

  it('TC-004 TC-011: recruiters and reviewers get 403 on validate, the status and the AI routes', async () => {
    for (const role of ['RECRUITER', 'REVIEWER'] as const) {
      expect((await call(role, 'POST', `${V}/q-rotate/validate`)).status).toBe(403);
      expect((await call(role, 'GET', `${V}/q-rotate/validation`)).status).toBe(403);
      expect((await call(role, 'GET', `${V}/q-merge/versions/2/ai-references`)).status).toBe(403);
      expect(
        (await call(role, 'POST', `${V}/q-merge/versions/2/ai-references`, aiRow('A'))).status,
      ).toBe(403);
      expect(
        (await call(role, 'POST', `${V}/q-merge/versions/2/ai-references/ai-1/supersede`, {}))
          .status,
      ).toBe(403);
    }
  });
});

describe('Publish needs a passing run and the AI gate (TC-012, AI-5)', () => {
  it('AI-5 TC-012: a validated coding draft is refused until every allowed language has two distinct current assistants, then it publishes', async () => {
    const refused = await call<{ errors: string[] }>('AUTHOR', 'POST', `${V}/q-running/publish`);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toContain(
      'aiReferences.python: needs current rows from at least 2 distinct assistants (has 1)',
    );
    expect(refused.body.errors.join(' ')).not.toMatch(/validation:/); // it IS validated
    expect(refused.body).not.toHaveProperty('code');
    for (const language of ['python', 'javascript']) {
      const added = await call(
        'AUTHOR',
        'POST',
        `${V}/q-running/versions/1/ai-references`,
        aiRow('Claude', language),
      );
      expect(added.status).toBe(201);
    }
    // The same assistant under another spelling does not count twice.
    await call('AUTHOR', 'POST', `${V}/q-running/versions/1/ai-references`, aiRow(' chatgpt '));
    const ok = await call<{ version: { isPublished: boolean } }>(
      'AUTHOR',
      'POST',
      `${V}/q-running/publish`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.version.isPublished).toBe(true);
  });

  it('AI-5: superseding a row without a replacement drops a language below the minimum again', async () => {
    for (const language of ['python', 'javascript']) {
      await call(
        'AUTHOR',
        'POST',
        `${V}/q-running/versions/1/ai-references`,
        aiRow('Claude', language),
      );
    }
    const list = await call<{ items: { id: string; language: string; assistant: string }[] }>(
      'AUTHOR',
      'GET',
      `${V}/q-running/versions/1/ai-references`,
    );
    const claudePy = list.body.items.find(
      (r) => r.language === 'python' && r.assistant === 'Claude',
    )!;
    const retired = await call<{
      superseded: { supersededAt: string | null };
      replacement: unknown;
    }>('AUTHOR', 'POST', `${V}/q-running/versions/1/ai-references/${claudePy.id}/supersede`, {});
    expect(retired.status).toBe(200);
    expect(retired.body.replacement).toBeNull();
    expect(retired.body.superseded.supersededAt).not.toBeNull();
    const refused = await call<{ errors: string[] }>('AUTHOR', 'POST', `${V}/q-running/publish`);
    expect(refused.body.errors).toContain(
      'aiReferences.python: needs current rows from at least 2 distinct assistants (has 1)',
    );
  });

  it('TC-012: a content change after a passing run closes the gate again (publish is 422 on validation)', async () => {
    await call('AUTHOR', 'PATCH', `${V}/q-running`, { title: 'Running average, retitled' });
    const refused = await call<{ errors: string[] }>('AUTHOR', 'POST', `${V}/q-running/publish`);
    expect(refused.status).toBe(422);
    expect(refused.body.errors.join(' ')).toMatch(/validation: a passing validation run/);
  });
});

describe('AI reference solutions (ADR 0005, BE-04c): per version, append-only, server time', () => {
  it('AI-1: the list answers {items} newest first; a row has the API fields, no name and no policy', async () => {
    const list = await call<{ items: Record<string, unknown>[] }>(
      'AUTHOR',
      'GET',
      `${V}/q-merge/versions/2/ai-references`,
    );
    expect(list.status).toBe(200);
    expect(Object.keys(list.body)).toEqual(['items']);
    expect(Object.keys(list.body.items[0]!).sort()).toEqual([
      'assistant',
      'collectedAt',
      'collectedById',
      'createdAt',
      'id',
      'language',
      'modelLabel',
      'promptText',
      'solutionCode',
      'supersededAt',
      'variantId',
    ]);
    expect(list.text).not.toContain('collectedByName');
    expect(list.text).not.toContain('refreshDays');
    expect(list.body.items).toHaveLength(6);
  });

  it('AI-1: create stamps the time and the author itself; a client-sent collectedAt or id is a 400', async () => {
    const r = await call<Record<string, unknown>>(
      'AUTHOR',
      'POST',
      `${V}/q-running/versions/1/ai-references`,
      { ...aiRow('Gemini'), promptText: 'Solve it.' },
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      assistant: 'Gemini',
      language: 'python',
      promptText: 'Solve it.',
      variantId: null,
      supersededAt: null,
      collectedById: 'user-author',
    });
    expect(Date.now() - new Date(r.body.collectedAt as string).getTime()).toBeLessThan(60_000);
    const forged = await call<{ errors: string[] }>(
      'AUTHOR',
      'POST',
      `${V}/q-running/versions/1/ai-references`,
      { ...aiRow('Gemini'), collectedAt: '2020-01-01T00:00:00Z', id: 'x' },
    );
    expect(forged.status).toBe(400);
    expect(forged.body.errors).toEqual(
      expect.arrayContaining([
        'property collectedAt should not exist',
        'property id should not exist',
      ]),
    );
  });

  it('AI-1: validation order and codes: 400 body, 404 question or variant, 409 archived, 422 not coding or language not allowed', async () => {
    const path = `${V}/q-rotate/versions/1/ai-references`; // python only
    expect((await call('AUTHOR', 'POST', path, { ...aiRow('  ') })).status).toBe(400);
    expect((await call('AUTHOR', 'POST', path, { ...aiRow('A'), language: 'cobol' })).status).toBe(
      400,
    );
    expect((await call('AUTHOR', 'POST', path, { ...aiRow('A', 'java') })).status).toBe(422);
    expect(
      (await call('AUTHOR', 'POST', path, { ...aiRow('A'), variantId: 'not-a-variant' })).status,
    ).toBe(404);
    expect(
      (await call('AUTHOR', 'POST', `${V}/q-rotate/versions/9/ai-references`, aiRow('A'))).status,
    ).toBe(404);
    expect(
      (await call('AUTHOR', 'POST', `${V}/q-mcq-draft/versions/1/ai-references`, aiRow('A')))
        .status,
    ).toBe(422);
    expect(
      (await call('AUTHOR', 'POST', `${V}/q-old/versions/1/ai-references`, aiRow('A'))).status,
    ).toBe(409);
    const withVariant = await call('AUTHOR', 'POST', path, { ...aiRow('A'), variantId: 'ro-v1' });
    expect(withVariant.status).toBe(201);
  });

  it('AI-1: supersede with a replacement answers {superseded, replacement}; a second retire is 409; an unknown row is 404; the old row stays', async () => {
    const list = await call<{ items: { id: string; assistant: string; language: string }[] }>(
      'AUTHOR',
      'GET',
      `${V}/q-merge/versions/2/ai-references`,
    );
    const old = list.body.items.find((r) => r.language === 'java' && r.assistant === 'Claude')!;
    const path = `${V}/q-merge/versions/2/ai-references/${old.id}/supersede`;
    const r = await call<{
      superseded: { id: string; supersededAt: string | null };
      replacement: { id: string; supersededAt: string | null; assistant: string };
    }>('AUTHOR', 'POST', path, { replacement: aiRow('Claude', 'java') });
    expect(r.status).toBe(200);
    expect(r.body.superseded.id).toBe(old.id);
    expect(r.body.superseded.supersededAt).not.toBeNull();
    expect(r.body.replacement.supersededAt).toBeNull();
    expect((await call('AUTHOR', 'POST', path, {})).status).toBe(409);
    expect(
      (await call('AUTHOR', 'POST', `${V}/q-merge/versions/2/ai-references/nope/supersede`, {}))
        .status,
    ).toBe(404);
    // A bad replacement changes nothing (it rolls back with the retire).
    const other = list.body.items.find(
      (r2) => r2.language === 'python' && r2.assistant === 'Claude',
    )!;
    const bad = await call(
      'AUTHOR',
      'POST',
      `${V}/q-merge/versions/2/ai-references/${other.id}/supersede`,
      { replacement: { ...aiRow('Claude', 'java'), language: 'cobol' } },
    );
    expect(bad.status).toBe(400);
    const after = await call<{ items: { id: string; supersededAt: string | null }[] }>(
      'AUTHOR',
      'GET',
      `${V}/q-merge/versions/2/ai-references`,
    );
    expect(after.body.items.find((x) => x.id === other.id)?.supersededAt).toBeNull();
    expect(after.body.items.some((x) => x.id === old.id)).toBe(true); // the retired row stays
  });

  it('AI-1 FR-204: the rows belong to one version: editing a published question forks a draft that starts with none, and version 2 keeps its rows', async () => {
    const forked = await call<{ createdNewVersion: boolean; version: { version: number } }>(
      'AUTHOR',
      'PATCH',
      `${V}/q-merge`,
      { title: 'Merge, take two' },
    );
    expect(forked.body.createdNewVersion).toBe(true);
    const v3 = await call<{ items: unknown[] }>(
      'AUTHOR',
      'GET',
      `${V}/q-merge/versions/${forked.body.version.version}/ai-references`,
    );
    expect(v3.body.items).toEqual([]);
    const v2 = await call<{ items: unknown[] }>(
      'AUTHOR',
      'GET',
      `${V}/q-merge/versions/2/ai-references`,
    );
    expect(v2.body.items).toHaveLength(6);
  });
});

describe('The editor validates and collects AI solutions through the real routes (FR-203, AI-5)', () => {
  async function openEditor(id: string, maxPolls?: number) {
    nav.pathname = `/admin/questions/${id}`;
    renderAsStaff(
      <main>
        <QuestionEditorRoute id={id} pollMs={5} {...(maxPolls ? { maxPolls } : {})} />
      </main>,
      MOCK_USERS.author,
    );
    await screen.findByRole('tablist', { name: 'Question sections' });
    return userEvent.setup();
  }
  const checkText = (id: string) => screen.getByTestId(`check-${id}`).textContent ?? '';

  it('TC-012: a run that ends in a timeout says so, records nothing and leaves Publish off', async () => {
    setMockQuestionScenario({ executor: 'TIMEOUT' });
    const u = await openEditor('q-running');
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(
      (await screen.findAllByText(/The validation could not complete/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/The code runner took too long/).length).toBeGreaterThan(0);
    expect(checkText('validated')).toMatch(/To do/);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('FR-203: after a reload mid-run, Validate attaches to the run already going instead of failing', async () => {
    const u = await openEditor('q-rotate');
    // Another tab (or an earlier page) started the run for this very content.
    expect((await call('AUTHOR', 'POST', `${V}/q-rotate/validate`)).status).toBe(202);
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Validation failed')).toBeInTheDocument();
    expect(screen.queryByText('This question changed since you opened it')).not.toBeInTheDocument();
  });

  it('FR-204: Validate on a question that changed since it was opened asks for a reload (409 is not "in progress")', async () => {
    const u = await openEditor('q-rotate');
    await call('AUTHOR', 'PATCH', `${V}/q-rotate`, { title: 'Changed by someone else' });
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(
      await screen.findByText('This question changed since you opened it'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload the latest version/ })).toBeInTheDocument();
  });

  it('AI-1 AI-5: the dialog has no date (the server stamps it), no "By" column exists and the tab says the rows belong to the version', async () => {
    const u = await openEditor('q-running');
    await u.click(screen.getByRole('tab', { name: 'AI reference solutions' }));
    expect(screen.getByText(/They belong to version 1/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'By' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Add solution' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Date collected')).not.toBeInTheDocument();
    await u.type(within(dialog).getByLabelText('Assistant'), 'Claude');
    await u.type(within(dialog).getByLabelText('Model label'), 'sonnet');
    await u.click(await within(dialog).findByLabelText('AI solution code'));
    await u.paste('print(1)');
    await u.click(within(dialog).getByRole('button', { name: 'Add solution' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const rows = await screen.findAllByRole('row', { name: /Claude/ });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('AI-5 FR-204: after a save that forks a new version the AI rows are gone and the gate asks for them again', async () => {
    const u = await openEditor('q-merge');
    await u.click(screen.getByRole('tab', { name: 'AI reference solutions' }));
    expect(await screen.findAllByText(/2\/2 assistants/)).toHaveLength(3);
    await u.click(screen.getByRole('tab', { name: 'Statement' }));
    await u.type(screen.getByLabelText('Title'), ' v3');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved as version 3/)).toBeInTheDocument();
    await u.click(screen.getByRole('tab', { name: 'AI reference solutions' }));
    expect(await screen.findByText('None yet.')).toBeInTheDocument();
    expect(screen.getByText(/They belong to version 3/)).toBeInTheDocument();
    expect(checkText('ai')).toMatch(/To do/);
  });
});
