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
import { RECRUITER_QUESTION_FIELDS, redactQuestion } from '@/mocks/question-redaction';
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
  'validatedAt',
  'variants',
  'params',
  'overrides',
  'testCases',
  'isHidden',
  'aiReferencePolicy',
  'aiReferences',
  'current',
];

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

describe('Recruiter detail routes: 200 with an allowlisted view (DL-32)', () => {
  it('FR-103 TC-004: a coding question comes back redacted, with no sensitive field in the payload', async () => {
    const { status, body, text } = await recruiterGet('/v1/questions/q-merge');
    expect(status).toBe(200);
    const keys = Object.keys(body as object);
    expect(keys.every((k) => (RECRUITER_QUESTION_FIELDS as readonly string[]).includes(k))).toBe(
      true,
    );
    for (const k of SENSITIVE_KEYS) expect(keys).not.toContain(k);
    // Not even as text anywhere in the payload: no hidden case, reference code, or variant data.
    for (const needle of [
      '"mi-t3"',
      '"mi-t4"',
      'isHidden',
      'out.append',
      'referenceSolution',
      '"params"',
      'Three intervals',
    ]) {
      expect(text).not.toContain(needle);
    }
    const sample = (body as { sampleTestCases: { input: string; expectedOutput: string }[] })
      .sampleTestCases;
    expect(sample).toHaveLength(2); // only the visible cases
    for (const c of sample) expect(Object.keys(c).sort()).toEqual(['expectedOutput', 'input']);
    expect(text).not.toContain('5 9\\n1 3'); // the hidden case input
  });

  it('FR-103 TC-004: a multiple-choice and a short-answer question leak no key and no accepted answer', async () => {
    const mcq = await recruiterGet('/v1/questions/q-bigo');
    for (const needle of ['correctOptionIds', 'answerSpec', '"o2"', 'O(log n)']) {
      expect(mcq.text).not.toContain(needle);
    }
    const short = await recruiterGet('/v1/questions/q-http');
    for (const needle of ['canonical', 'acceptedVariants', '201 created', 'http 201']) {
      expect(short.text).not.toContain(needle);
    }
  });

  it('FR-103 TC-004: an older version is redacted the same way, and a missing one is 404', async () => {
    const v1 = await recruiterGet('/v1/questions/q-merge/versions/1');
    expect(v1.status).toBe(200);
    expect(
      Object.keys(v1.body as object).every((k) =>
        (RECRUITER_QUESTION_FIELDS as readonly string[]).includes(k),
      ),
    ).toBe(true);
    expect((await recruiterGet('/v1/questions/q-merge/versions/9')).status).toBe(404);
  });

  it('FR-103 TC-004: every other question route stays closed to a Recruiter (403)', async () => {
    renderAsStaff(<div />, MOCK_USERS.recruiter);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const id = { params: { path: { questionId: 'q-merge' } } };
    expect((await api.GET('/v1/questions/{questionId}/versions', id)).response.status).toBe(403);
    expect((await api.GET('/v1/questions/{questionId}/ai-references', id)).response.status).toBe(
      403,
    );
    expect((await api.POST('/v1/questions/{questionId}/validate', id)).response.status).toBe(403);
    expect(
      (
        await api.POST('/v1/questions/{questionId}/publish', {
          ...id,
          body: { expectedUpdatedAt: 'x' },
        })
      ).response.status,
    ).toBe(403);
  });

  it('FR-103: an author still gets the full detail from the same route', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => {
      const { data } = await api.GET('/v1/questions/{questionId}', {
        params: { path: { questionId: 'q-merge' } },
      });
      expect(data && 'current' in data).toBe(true);
    });
  });

  it('FR-103: the allowlist is the only door: a field added to the mock question never reaches the Recruiter', () => {
    const [q] = seedQuestions();
    const v = q!.versions[q!.versions.length - 1]!;
    const withNew = {
      ...q!,
      newQuestionField: 'secret-q',
      versions: q!.versions,
    } as typeof q;
    const versionWithNew = {
      ...v,
      newVersionField: 'secret-v',
      referenceSolutionV2: { python: 'secret code' },
    } as typeof v;
    const out = redactQuestion(withNew!, versionWithNew, 'PUBLISHED');
    expect(
      Object.keys(out).every((k) => (RECRUITER_QUESTION_FIELDS as readonly string[]).includes(k)),
    ).toBe(true);
    const text = JSON.stringify(out);
    for (const secret of [
      'secret-q',
      'secret-v',
      'secret code',
      'newQuestionField',
      'newVersionField',
    ]) {
      expect(text).not.toContain(secret);
    }
    // And a field that IS allowlisted is there: the list is the one place to change.
    expect(out.title).toBe(v.title);
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
      'Three intervals',
      'Four intervals',
      'Rotate by',
      'Validation',
    ]) {
      expect(html).not.toContain(needle);
    }
    expect(screen.queryByText(/Reference solution/i)).toBeInTheDocument(); // only inside the note
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

  it('FR-103: the summary component renders only what the DTO carries', () => {
    render(
      <main>
        <QuestionSummary
          data={{
            id: 'x',
            slug: 'x',
            title: 'T',
            type: 'CODING',
            status: 'DRAFT',
            difficulty: 'EASY',
            tags: [],
            statementMd: 'S',
            version: 1,
            updatedAt: '2026-01-01T00:00:00.000Z',
            starterCode: {},
            limits: { cpuMs: 1000, wallMs: 2000, memoryKb: 65536 },
            allowedLanguages: ['python'],
            sampleTestCases: [{ input: 'in', expectedOutput: 'out' }],
          }}
        />
      </main>,
    );
    expect(screen.getByText('in')).toBeInTheDocument();
    expect(screen.getByText('out')).toBeInTheDocument();
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
    for (const needle of ['out.append', 'mi-t3', '5 9', 'Three intervals']) {
      expect(html).not.toContain(needle);
    }
    for (const el of document.querySelectorAll('textarea, input')) {
      expect((el as HTMLInputElement).value).not.toContain('out.append');
    }
    const cached = cachedText(client);
    for (const needle of [
      'out.append',
      'mi-t3',
      'referenceSolution',
      'isHidden',
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
  const demote = async () => {
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
    await screen.findByTestId('summary-statement');
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
    for (const needle of ['referenceSolution', 'isHidden', 'out.append', 'mi-t3']) {
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
      http.post('*/v1/questions/q-publish-unavailable/publish', async ({ request }) => {
        if (oldToken(request)) {
          await gate;
          return HttpResponse.json(fullDetail as Record<string, unknown>);
        }
        return undefined;
      }),
    );
    const client = renderWithClient(MOCK_USERS.author, 'q-publish-unavailable');
    await screen.findByRole('tablist', { name: 'Question sections' });
    fullDetail = client
      .getQueryCache()
      .getAll()
      .find((q) => q.queryKey[1] === 'detail')?.state.data;
    expect(JSON.stringify(fullDetail)).toContain('correctOptionIds');
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Publish' }));
    await demote();
    release();
    await settle();
    expectStillRedacted(client);
    expect(cacheText(client)).not.toContain('correctOptionIds');
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

describe('The mock PATCH keeps to the editable content (TC-012)', () => {
  it('TC-012: a PATCH that sets isPublished or a version leaves a draft a draft', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const got = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-rotate' } },
    });
    const detail = full(got.data);
    const saved = await api.PATCH('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-rotate' } },
      body: {
        ...detail.current,
        isPublished: true,
        version: 99,
        validatedAt: '2026-01-01T00:00:00.000Z',
        expectedUpdatedAt: detail.current.updatedAt,
      } as never,
    });
    const after = full(saved.data).current;
    expect(after.isPublished).toBe(false);
    expect(after.version).toBe(1);
    // Whatever the client says about validation or the token itself, the server ignores it.
    expect(after.validatedAt).toBeNull();
    expect(after.updatedAt).not.toBe('forged');
  });

  it('TC-012: a POST that sets isPublished or a version creates version 1 as a draft', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await api.GET('/v1/questions')).response.status).toBe(200));
    const got = await api.GET('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-twosum' } },
    });
    const { current } = full(got.data);
    const created = await api.POST('/v1/questions', {
      body: {
        ...current,
        title: 'Forged',
        type: 'CODING',
        isPublished: true,
        version: 5,
        updatedAt: 'forged',
      } as never,
    });
    expect(created.response.status).toBe(201);
    const after = full(created.data).current;
    expect(after.isPublished).toBe(false);
    expect(after.version).toBe(1);
    expect(after.updatedAt).not.toBe('forged');
  });
});
