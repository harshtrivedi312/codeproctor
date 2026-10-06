import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { AuthProvider } from '@/features/auth/auth-provider';
import { api } from '@/lib/api/client';
import { refreshSession } from '@/lib/auth-session';
import { MOCK_USERS, seedMockRefresh } from '@/mocks/auth-handlers';
import { READ_DETAIL_FIELDS, READ_VERSION_FIELDS, toReadDetail } from '@/mocks/question-redaction';
import { seedQuestions } from '@/mocks/question-seed';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { full } from '@/test/question-api';
import { QuestionEditorRoute, QuestionVersionRoute } from './question-pages';
import { disposeModels } from './monaco-registry';
import { QuestionSummary } from './question-summary';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('./monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule());
vi.mock('./monaco-registry', async (original) => {
  const real = await original<typeof import('./monaco-registry')>();
  return { ...real, disposeModels: vi.fn(real.disposeModels) };
});

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.mocked(disposeModels).mockClear();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

/** Names of every field that must never reach a Recruiter, as they appear in the full detail. */
const SENSITIVE_KEYS = [
  'referenceSolution',
  'answerSpec',
  'correctOptionIds',
  'canonical',
  'acceptedVariants',
  'validationReport',
  'revision',
  'variants',
  'params',
  'overrides',
  'aiReferencePolicy',
  'aiReferences',
];
/** A hidden test case reaches a Recruiter as exactly these keys (QuestionDetailRedacted). */
const STALE = '0'.repeat(64);
const HIDDEN_ROW_KEYS = ['id', 'isHidden', 'position', 'weight'];

interface ReadBody {
  version: { testCases: Record<string, unknown>[] } & Record<string, unknown>;
  versions: { version: number }[];
}

async function recruiterGet(
  path: string,
): Promise<{ status: number; body: unknown; text: string }> {
  renderAsStaff(<div />, MOCK_USERS.recruiter);
  const { api: client } = await import('@/lib/api/client');
  void client;
  let out: { status: number; body: unknown; text: string } | null = null;
  await waitFor(async () => {
    const res = await fetch(`http://localhost:4000${path}`, {
      headers: {
        authorization: `Bearer ${(await import('@/lib/auth-token')).getAccessToken() ?? ''}`,
      },
    });
    const text = await res.text();
    expect(res.status).not.toBe(401);
    out = { status: res.status, body: JSON.parse(text) as unknown, text };
  });
  return out!;
}

describe('Recruiter detail routes: 200 with an allowlisted view (DL-32, BE-04a)', () => {
  it('FR-103 TC-004: a coding question comes back redacted, with exactly the allowlisted keys and no sensitive field', async () => {
    const { status, body, text } = await recruiterGet('/v1/questions/q-merge');
    expect(status).toBe(200);
    const keys = Object.keys(body as object);
    expect(keys.sort()).toEqual([...READ_DETAIL_FIELDS].sort());
    const version = (body as ReadBody).version;
    expect(Object.keys(version).sort()).toEqual([...READ_VERSION_FIELDS].sort());
    for (const k of SENSITIVE_KEYS) {
      expect(keys).not.toContain(k);
      expect(Object.keys(version)).not.toContain(k);
    }
    // Not even as text anywhere in the payload: no reference code, variant data or hidden input.
    for (const needle of [
      'out.append',
      'referenceSolution',
      '"params"',
      'renderedStatement',
      'revision',
      '5 9\\n1 3',
      '1 4\\n5 9',
    ]) {
      expect(text).not.toContain(needle);
    }
  });

  it('FR-103 TC-004 BE-04a: a hidden test case reaches a Recruiter as exactly {id, position, isHidden, weight}', async () => {
    const { body } = await recruiterGet('/v1/questions/q-merge');
    const cases = (body as ReadBody).version.testCases;
    const hidden = cases.filter((c) => c.isHidden === true);
    const visible = cases.filter((c) => c.isHidden === false);
    expect(hidden.length).toBeGreaterThan(0);
    expect(visible).toHaveLength(2);
    for (const c of hidden) expect(Object.keys(c).sort()).toEqual(HIDDEN_ROW_KEYS);
    for (const c of visible) {
      expect(Object.keys(c).sort()).toEqual([...HIDDEN_ROW_KEYS, 'expectedOutput', 'input'].sort());
    }
  });

  it('FR-103 TC-004: a multiple-choice question leaks no key and no accepted answer', async () => {
    const mcq = await recruiterGet('/v1/questions/q-bigo');
    expect(mcq.status).toBe(200);
    for (const needle of ['correctOptionIds', 'answerSpec', '"o2"', 'O(log n)']) {
      expect(mcq.text).not.toContain(needle);
    }
  });

  it('FR-103 TC-004 BE-04a: a draft or never-published question is 404 for a Recruiter, the same as a missing one', async () => {
    const draft = await recruiterGet('/v1/questions/q-http'); // short answer, a draft only
    const rotate = await recruiterGet('/v1/questions/q-rotate');
    const missing = await recruiterGet('/v1/questions/q-nope');
    expect(draft.status).toBe(404);
    expect(rotate.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(draft.body).toEqual(missing.body);
    expect(draft.text).not.toContain('canonical');
    expect(draft.text).not.toContain('201 created');
  });

  it('FR-103 TC-004 BE-04a: a Recruiter reads published versions only; a draft version is 404', async () => {
    // An author edits the published q-merge: version 3 is now a draft (and 2 stays published).
    const send = (method: string, path: string, role: string, body?: unknown) =>
      fetch(`http://localhost:4000${path}`, {
        method,
        headers: {
          authorization: `Bearer mock-access-${role}-direct`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const patched = await send('PATCH', '/v1/questions/q-merge', 'AUTHOR', {
      title: 'Merge intervals, draft',
    });
    expect(patched.status).toBe(200);
    const asRecruiter = async (path: string) => {
      const res = await send('GET', path, 'RECRUITER');
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) as unknown };
    };
    const recruiterGet = asRecruiter;

    const v1 = await recruiterGet('/v1/questions/q-merge?version=1');
    expect(v1.status).toBe(200);
    expect(Object.keys((v1.body as ReadBody).version).sort()).toEqual(
      [...READ_VERSION_FIELDS].sort(),
    );
    expect((await recruiterGet('/v1/questions/q-merge?version=9')).status).toBe(404);
    const draftVersion = await recruiterGet('/v1/questions/q-merge?version=3');
    expect(draftVersion.status).toBe(404);
    const latest = await recruiterGet('/v1/questions/q-merge');
    expect((latest.body as ReadBody).version.title).toBe('Merge intervals'); // still the published one
    expect(latest.text).not.toContain('Merge intervals, draft');
  });

  it('FR-103 TC-004 BE-04a: a published but archived question stays readable for a Recruiter, but is not in their list', async () => {
    const old = await recruiterGet('/v1/questions/q-old');
    expect(old.status).toBe(200);
    expect((old.body as { isArchived: boolean }).isArchived).toBe(true);
    const list = await recruiterGet('/v1/questions?includeArchived=true');
    const ids = (list.body as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).not.toContain('q-old');
    expect(ids).not.toContain('q-rotate'); // a draft is not listed either
    expect(ids).toContain('q-merge');
    expect(list.text).not.toContain('referenceSolution');
  });

  it('FR-103 TC-004: every other question write route stays closed to a Recruiter (403)', async () => {
    renderAsStaff(<div />, MOCK_USERS.recruiter);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const id = { params: { path: { questionId: 'q-merge' } } };
    const v2 = { params: { path: { questionId: 'q-merge', version: 2 } } };
    expect(
      (await api.GET('/v1/questions/{questionId}/versions/{version}/ai-references', v2)).response
        .status,
    ).toBe(403);
    expect(
      (
        await api.POST('/v1/questions/{questionId}/versions/{version}/ai-references', {
          ...v2,
          body: { assistant: 'A', modelLabel: 'm', language: 'python', solutionCode: 'x' },
        })
      ).response.status,
    ).toBe(403);
    expect((await api.POST('/v1/questions/{questionId}/validate', id)).response.status).toBe(403);
    expect((await api.GET('/v1/questions/{questionId}/validation', id)).response.status).toBe(403);
    expect(
      (
        await api.POST('/v1/questions/{questionId}/publish', {
          ...id,
          body: { expectedRevision: 'x' },
        })
      ).response.status,
    ).toBe(403);
    expect(
      (
        await api.PATCH('/v1/questions/{questionId}', {
          ...id,
          body: { title: 'x' },
        })
      ).response.status,
    ).toBe(403);
    expect((await api.POST('/v1/questions/{questionId}/archive', id)).response.status).toBe(403);
  });

  it('FR-103: an author still gets the full detail from the same route, with an opaque revision', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => {
      const { data } = await api.GET('/v1/questions/{questionId}', {
        params: { path: { questionId: 'q-merge' } },
      });
      expect(data && 'revision' in data.version).toBe(true);
      expect((data as { version: { revision: string } }).version.revision).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
  });

  it('BE-04a: the revision changes on every content change and the PATCH echoes the new one', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const path = { params: { path: { questionId: 'q-rotate' } } };
    const r0 = full((await api.GET('/v1/questions/{questionId}', path)).data).version.revision;
    const p1 = full(
      (
        await api.PATCH('/v1/questions/{questionId}', {
          ...path,
          body: { title: 'Rotate by k', expectedRevision: r0 },
        })
      ).data,
    );
    const r1 = p1.version.revision;
    expect(r1).not.toBe(r0);
    // A test case change moves it too.
    const added = await api.POST('/v1/questions/{questionId}/versions/{version}/test-cases', {
      params: { path: { questionId: 'q-rotate', version: p1.version.version } },
      body: { input: '1', expectedOutput: '1', isHidden: true, weight: 1 },
    });
    expect(added.response.status).toBe(201);
    const r2 = full((await api.GET('/v1/questions/{questionId}', path)).data).version.revision;
    expect(r2).not.toBe(r1);
    // The same content hashes the same: reading again does not move it.
    expect(full((await api.GET('/v1/questions/{questionId}', path)).data).version.revision).toBe(
      r2,
    );
  });

  it('BE-04a: a stale expectedRevision is 409 on PATCH and on publish, without a machine code', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const path = { params: { path: { questionId: 'q-mcq-draft' } } };
    const patch = await api.PATCH('/v1/questions/{questionId}', {
      ...path,
      body: { title: 'Changed', expectedRevision: STALE },
    });
    expect(patch.response.status).toBe(409);
    expect(patch.error).not.toHaveProperty('code');
    const publish = await api.POST('/v1/questions/{questionId}/publish', {
      ...path,
      body: { expectedRevision: STALE },
    });
    expect(publish.response.status).toBe(409);
    expect(publish.error).not.toHaveProperty('code');
    // Nothing changed.
    expect(full((await api.GET('/v1/questions/{questionId}', path)).data).version.title).not.toBe(
      'Changed',
    );
  });

  it('BE-04a FR-204: a PATCH on a published question forks the next draft: createdNewVersion true, the published one unchanged', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const path = { params: { path: { questionId: 'q-bigo' } } };
    const before = full((await api.GET('/v1/questions/{questionId}', path)).data);
    expect(before.version.isPublished).toBe(true);
    const forked = full(
      (
        await api.PATCH('/v1/questions/{questionId}', {
          ...path,
          body: { title: 'Big-O, take two', expectedRevision: before.version.revision },
        })
      ).data,
    );
    expect(forked.createdNewVersion).toBe(true);
    expect(forked.version.version).toBe(before.version.version + 1);
    expect(forked.version.isPublished).toBe(false);
    expect(forked.version.validatedAt).toBeNull();
    // A second edit changes the draft in place.
    const again = full(
      (
        await api.PATCH('/v1/questions/{questionId}', {
          ...path,
          body: { title: 'Big-O, take three' },
        })
      ).data,
    );
    expect(again.createdNewVersion).toBe(false);
    expect(again.version.version).toBe(forked.version.version);
    const old = full(
      (
        await api.GET('/v1/questions/{questionId}', {
          params: { ...path.params, query: { version: before.version.version } },
        })
      ).data,
    );
    expect(old.version.title).toBe(before.version.title);
    expect(old.version.isPublished).toBe(true);
  });

  it('FR-103: the allowlist is the only door: a field added to the mock question never reaches the Recruiter', () => {
    const [q] = seedQuestions();
    const v = q!.versions[q!.versions.length - 1]!;
    const withNew = { ...q!, newQuestionField: 'secret-q' } as typeof q;
    const versionWithNew = {
      ...v,
      newVersionField: 'secret-v',
      referenceSolutionV2: { python: 'secret code' },
      revisionHint: 'secret-rev',
    } as typeof v;
    const out = toReadDetail(withNew!, versionWithNew, [versionWithNew]);
    expect(Object.keys(out).sort()).toEqual([...READ_DETAIL_FIELDS].sort());
    expect(Object.keys(out.version).sort()).toEqual([...READ_VERSION_FIELDS].sort());
    const text = JSON.stringify(out);
    for (const secret of [
      'secret-q',
      'secret-v',
      'secret code',
      'secret-rev',
      'newQuestionField',
      'newVersionField',
    ]) {
      expect(text).not.toContain(secret);
    }
    // And a field that IS allowlisted is there: the list is the one place to change.
    expect(out.version.title).toBe(v.title);
  });
});

describe('Recruiter opening a question: a read-only summary (DL-32)', () => {
  async function openAsRecruiter(id: string) {
    nav.pathname = `/admin/questions/${id}`;
    renderAsStaff(
      <main>
        <QuestionEditorRoute id={id} />
      </main>,
      MOCK_USERS.recruiter,
    );
    await screen.findByTestId('summary-statement');
  }

  it('FR-103 TC-004: shows the title, meta, statement and visible samples with a note, and no editor controls', async () => {
    await openAsRecruiter('q-merge');
    expect(screen.getByRole('heading', { name: 'Merge intervals', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/hidden for your role/)).toBeInTheDocument();
    expect(screen.getByTestId('summary-statement')).toHaveTextContent('Given {{count}} intervals');
    const samples = screen.getByRole('table', { name: 'Visible sample test cases' });
    expect(within(samples).getAllByRole('row')).toHaveLength(3); // header + 2 visible
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    for (const name of ['Save', 'Validate', 'Publish']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('FR-103 TC-004: nothing sensitive is in the rendered page', async () => {
    await openAsRecruiter('q-merge');
    const html = document.body.innerHTML;
    for (const needle of [
      'out.append',
      '5 9',
      'renderedStatement',
      'testCaseOverrides',
      'isActive',
      'Validation',
    ]) {
      expect(html).not.toContain(needle);
    }
    expect(screen.queryByText(/Reference solution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI reference/i)).not.toBeInTheDocument();
  });

  it('FR-103 TC-004: a multiple-choice question shows no options or key', async () => {
    await openAsRecruiter('q-bigo');
    expect(document.body.innerHTML).not.toContain('O(log n)');
    expect(screen.getByText('No visible sample cases.')).toBeInTheDocument();
  });

  it('FR-103 TC-004: an older version opens as the same summary', async () => {
    nav.pathname = '/admin/questions/q-merge/versions/1';
    renderAsStaff(
      <main>
        <QuestionVersionRoute id="q-merge" version={1} />
      </main>,
      MOCK_USERS.recruiter,
    );
    await screen.findByTestId('summary-statement');
    expect(screen.getByTestId('summary-statement')).toHaveTextContent('Given some intervals');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('WCAG 2.1 AA: the summary has no axe violations', async () => {
    await openAsRecruiter('q-merge');
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('FR-103 BE-04a: a published archived question still renders for a Recruiter', async () => {
    await openAsRecruiter('q-old');
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('FR-103 BE-04a: a draft is "not available to you" for a Recruiter, with no hint it exists', async () => {
    nav.pathname = '/admin/questions/q-rotate';
    renderAsStaff(
      <main>
        <QuestionEditorRoute id="q-rotate" />
      </main>,
      MOCK_USERS.recruiter,
    );
    expect(await screen.findByText('This question is not available to you')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('Rotate an array');
    expect(screen.queryByTestId('summary-statement')).not.toBeInTheDocument();
  });

  it('FR-103: the summary component renders only what the DTO carries, and never counts hidden cases', () => {
    const ref = {
      id: 'x-v1',
      version: 1,
      isPublished: true,
      title: 'T',
      difficulty: 'EASY' as const,
      validatedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    render(
      <main>
        <QuestionSummary
          data={{
            id: 'x',
            slug: 'x',
            type: 'CODING',
            tags: [],
            isArchived: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            published: ref,
            latest: ref,
            versions: [ref],
            createdNewVersion: false,
            version: {
              ...ref,
              statementMd: 'S',
              starterCode: {},
              limits: { cpuMs: 1000, wallMs: 2000, memoryKb: 65536 },
              allowedLanguages: ['python'],
              testCases: [
                {
                  id: 'a',
                  position: 0,
                  isHidden: false,
                  weight: 1,
                  input: 'in',
                  expectedOutput: 'out',
                },
                { id: 'b', position: 1, isHidden: true, weight: 3 },
                { id: 'c', position: 2, isHidden: true, weight: 3 },
              ],
            },
          }}
        />
      </main>,
    );
    expect(screen.getByText('in')).toBeInTheDocument();
    expect(screen.getByText('out')).toBeInTheDocument();
    const samples = screen.getByRole('table', { name: 'Visible sample test cases' });
    expect(within(samples).getAllByRole('row')).toHaveLength(2); // header + the one visible case
    expect(document.body.textContent).not.toMatch(/\b2 hidden|hidden (test )?cases?: ?\d/i);
  });
});

describe('A role change clears what the old role could see (FR-103, TC-004)', () => {
  function Harness({ id }: { id: string }) {
    return (
      <main>
        <QuestionEditorRoute id={id} />
      </main>
    );
  }
  function renderWithClient(user: { email: string }, id: string) {
    seedMockRefresh(user.email);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Harness id={id} />
        </AuthProvider>
      </QueryClientProvider>,
    );
    return client;
  }
  /** The refresh answers the same person with another role (an admin changed it meanwhile). */
  function nextRefreshAs(role: 'RECRUITER' | 'AUTHOR', userId: string, email: string): void {
    server.use(
      http.post('*/v1/auth/refresh', () =>
        HttpResponse.json({
          accessToken: `mock-access-${role}-changed`,
          user: {
            id: userId,
            email,
            name: 'Same Person',
            role,
            orgName: 'Acme Hiring (demo)',
            totpEnabled: false,
          },
        }),
      ),
    );
  }
  const cachedText = (client: QueryClient) =>
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data ?? null),
    );

  it('FR-103 TC-004: an Author demoted to Recruiter by a refresh loses the cached editor, the code and the hidden tests', async () => {
    const client = renderWithClient(MOCK_USERS.author, 'q-merge');
    await screen.findByRole('tablist', { name: 'Question sections' });
    expect(cachedText(client)).toContain('out.append'); // the reference solution is cached
    expect(cachedText(client)).toContain('mi-t3'); // and a hidden test

    nextRefreshAs('RECRUITER', 'user-author', MOCK_USERS.author.email);
    await act(async () => {
      await refreshSession();
    });

    // The loader refetched and got the redacted view: the summary replaces the editor.
    await screen.findByTestId('summary-statement');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    const html = document.body.innerHTML;
    for (const needle of ['out.append', '5 9', 'renderedStatement', 'revision']) {
      expect(html).not.toContain(needle);
    }
    for (const el of document.querySelectorAll('textarea, input')) {
      expect((el as HTMLInputElement).value).not.toContain('out.append');
    }
    const cached = cachedText(client);
    for (const needle of [
      'out.append',
      '5 9',
      'referenceSolution',
      'revision',
      'correctOptionIds',
    ]) {
      expect(cached).not.toContain(needle);
    }
    expect(disposeModels).toHaveBeenCalledWith('q/');
  });

  it('FR-103: a role change that still allows editing (Super Admin to Author) clears the cache too, as the safe default', async () => {
    const client = renderWithClient(MOCK_USERS.admin, 'q-merge');
    await screen.findByRole('tablist', { name: 'Question sections' });
    const clear = vi.spyOn(client, 'clear');
    nextRefreshAs('AUTHOR', 'user-super_admin', MOCK_USERS.admin.email);
    await act(async () => {
      await refreshSession();
    });
    expect(clear).toHaveBeenCalled();
    // Still allowed to edit: the editor comes back from a fresh fetch.
    await screen.findByRole('tablist', { name: 'Question sections' });
  });

  it('FR-103: a refresh with the same user and the same role keeps the cache (no needless refetch)', async () => {
    let detailGets = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET' && request.url.endsWith('/v1/questions/q-merge'))
        detailGets += 1;
    });
    const client = renderWithClient(MOCK_USERS.author, 'q-merge');
    await screen.findByRole('tablist', { name: 'Question sections' });
    const getsBefore = detailGets;
    const clear = vi.spyOn(client, 'clear');
    await act(async () => {
      await refreshSession();
    });
    expect(clear).not.toHaveBeenCalled();
    expect(detailGets).toBe(getsBefore);
    expect(screen.getByRole('tablist', { name: 'Question sections' })).toBeInTheDocument();
    server.events.removeAllListeners();
  });
});

describe('Work still in flight when the role changes never restores the full view (FR-103, TC-004)', () => {
  function renderWithClient(user: { email: string }, id: string) {
    seedMockRefresh(user.email);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <main>
            <QuestionEditorRoute id={id} pollMs={5} />
          </main>
        </AuthProvider>
      </QueryClientProvider>,
    );
    return client;
  }
  const demote = async (landing: 'summary' | 'unavailable' = 'summary') => {
    server.use(
      http.post('*/v1/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'mock-access-RECRUITER-changed',
          user: {
            id: 'user-author',
            email: MOCK_USERS.author.email,
            name: 'Same Person',
            role: 'RECRUITER',
            orgName: 'Acme Hiring (demo)',
            totpEnabled: false,
          },
        }),
      ),
    );
    await act(async () => {
      await refreshSession();
    });
    if (landing === 'summary') await screen.findByTestId('summary-statement');
    else await screen.findByText('This question is not available to you');
  };
  const oldToken = (request: Request) =>
    (request.headers.get('authorization') ?? '').includes('AUTHOR');
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 80))));
  const cacheText = (client: QueryClient) =>
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data ?? null),
    );
  /** After the late answer: still the summary, and nothing of the full view anywhere. */
  function expectStillRedacted(client: QueryClient): void {
    expect(screen.getByTestId('summary-statement')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    for (const needle of ['referenceSolution', 'revision', 'out.append', '5 9']) {
      expect(cacheText(client)).not.toContain(needle);
      expect(document.body.innerHTML).not.toContain(needle);
    }
  }

  it('FR-103 TC-004: a save sent as Author that resolves LAST, after the demotion, is not written into the cache', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.patch('*/v1/questions/q-merge', async ({ request }) => {
        if (oldToken(request)) await gate;
        return undefined;
      }),
    );
    const client = renderWithClient(MOCK_USERS.author, 'q-merge');
    await screen.findByRole('tablist', { name: 'Question sections' });
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Title'), '!');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await demote();
    release();
    await settle();
    expectStillRedacted(client);
  });

  it('FR-103 TC-004: a publish sent as Author that resolves LAST is not written into the cache either', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let fullDetail: unknown = null;
    server.use(
      http.post('*/v1/questions/q-mcq-draft/publish', async ({ request }) => {
        if (oldToken(request)) {
          await gate;
          return HttpResponse.json(fullDetail as Record<string, unknown>);
        }
        return undefined;
      }),
    );
    const client = renderWithClient(MOCK_USERS.author, 'q-mcq-draft');
    await screen.findByRole('tablist', { name: 'Question sections' });
    fullDetail = client
      .getQueryCache()
      .getAll()
      .find((q) => q.queryKey[1] === 'detail')?.state.data;
    expect(JSON.stringify(fullDetail)).toContain('correctOptionIds');
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Publish' }));
    // The question was never published, so the demoted Recruiter gets the same 404 as for any draft.
    await demote('unavailable');
    release();
    await settle();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByText('This question is not available to you')).toBeInTheDocument();
    for (const needle of ['correctOptionIds', 'answerSpec', 'referenceSolution', 'revision']) {
      expect(cacheText(client)).not.toContain(needle);
      expect(document.body.innerHTML).not.toContain(needle);
    }
  });

  it('FR-103 TC-004: a "reload the latest version" fetched as Author that resolves LAST is dropped', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let fullDetail: unknown = null;
    let lateGets = false;
    server.use(
      http.patch('*/v1/questions/q-merge', () =>
        HttpResponse.json({ detail: 'changed' }, { status: 409 }),
      ),
      http.get('*/v1/questions/q-merge', async ({ request }) => {
        if (lateGets && oldToken(request)) {
          await gate;
          return HttpResponse.json(fullDetail as Record<string, unknown>);
        }
        return undefined;
      }),
    );
    const client = renderWithClient(MOCK_USERS.author, 'q-merge');
    await screen.findByRole('tablist', { name: 'Question sections' });
    fullDetail = client
      .getQueryCache()
      .getAll()
      .find((q) => q.queryKey[1] === 'detail')?.state.data;
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Title'), '!');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    const reload = await screen.findByRole('button', { name: /Reload the latest version/ });
    lateGets = true; // from here on a fetch with the old token is held back
    await u.click(reload);
    await demote();
    release();
    await settle();
    expectStillRedacted(client);
  });
});

describe('Question titles link for every reader (FR-103)', () => {
  it('FR-103: the title is a link to the summary for a Recruiter and to the editor for an Author', async () => {
    const { QuestionsPage } = await import('./questions-page');
    nav.pathname = '/admin/questions';
    renderAsStaff(
      <main>
        <QuestionsPage />
      </main>,
      MOCK_USERS.recruiter,
    );
    const link = await screen.findByRole('link', { name: 'Two sum' });
    expect(link).toHaveAttribute('href', '/admin/questions/q-twosum');
  });
});

describe('The mock PATCH and POST refuse fields no DTO declares (TC-012, BE-04a forbidNonWhitelisted)', () => {
  it('TC-012: a PATCH that sets isPublished, version, validatedAt or revision is a 400 naming each field, and changes nothing', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const path = { params: { path: { questionId: 'q-rotate' } } };
    const before = full((await api.GET('/v1/questions/{questionId}', path)).data).version;
    const refused = await api.PATCH('/v1/questions/{questionId}', {
      ...path,
      body: {
        title: 'Rotate, retitled',
        isPublished: true,
        version: 99,
        validatedAt: '2026-01-01T00:00:00.000Z',
        revision: 'forged',
        validationReport: { passed: true },
      } as never,
    });
    expect(refused.response.status).toBe(400);
    const errors = (refused.error as { errors: string[] }).errors;
    for (const field of ['isPublished', 'version', 'validatedAt', 'revision', 'validationReport']) {
      expect(errors).toContain(`property ${field} should not exist`);
    }
    const after = full((await api.GET('/v1/questions/{questionId}', path)).data).version;
    expect(after.title).toBe(before.title);
    expect(after.revision).toBe(before.revision);
    expect(after.version).toBe(before.version);
    expect(after.isPublished).toBe(false);
  });

  it('TC-012: a POST that sets isPublished or a version is a 400, and creates nothing', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const before = (await api.GET('/v1/questions')).data?.total;
    const created = await api.POST('/v1/questions', {
      body: {
        type: 'CODING',
        title: 'Forged',
        statementMd: 'S',
        difficulty: 'EASY',
        isPublished: true,
        version: 5,
        revision: 'forged',
      } as never,
    });
    expect(created.response.status).toBe(400);
    expect((created.error as { errors: string[] }).errors).toContain(
      'property isPublished should not exist',
    );
    expect((await api.GET('/v1/questions')).data?.total).toBe(before);
  });

  it('TC-012: publish, test-case and variant bodies refuse unknown fields too, and a malformed revision is a 400 before any 409', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const q = { params: { path: { questionId: 'q-mcq-draft' } } };
    const publish = await api.POST('/v1/questions/{questionId}/publish', {
      ...q,
      body: { isPublished: true } as never,
    });
    expect(publish.response.status).toBe(400);
    const patch = await api.PATCH('/v1/questions/{questionId}', {
      ...q,
      body: { title: 'x', expectedRevision: 'stale' },
    });
    expect(patch.response.status).toBe(400);
    const tc = await api.POST('/v1/questions/{questionId}/versions/{version}/test-cases', {
      params: { path: { questionId: 'q-rotate', version: 1 } },
      body: { input: '1', expectedOutput: '1', isHidden: true, weight: 1, extra: 1 } as never,
    });
    expect(tc.response.status).toBe(400);
    const variant = await api.POST('/v1/questions/{questionId}/versions/{version}/variants', {
      params: { path: { questionId: 'q-rotate', version: 1 } },
      body: { params: { size: 3, steps: 1 }, label: 'nope' } as never,
    });
    expect(variant.response.status).toBe(400);
  });
});
