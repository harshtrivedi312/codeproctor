import { render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { api } from '@/lib/api/client';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { RECRUITER_QUESTION_FIELDS, redactQuestion } from '@/mocks/question-redaction';
import { seedQuestions } from '@/mocks/question-seed';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { QuestionEditorRoute, QuestionVersionRoute } from './question-pages';
import { QuestionSummary } from './question-summary';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('./monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
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
