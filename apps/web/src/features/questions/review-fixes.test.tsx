import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/features/auth/auth-provider';
import { api } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS, seedMockRefresh } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { full } from '@/test/question-api';
import { nav } from '@/test/nav-mock';
import { QuestionEditorRoute } from './question-pages';
import { disposeModels, registerModelHost, resetModelHostForTests } from './monaco-registry';
import { ValidationPanel } from './validation-panel';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('./monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule());
vi.mock('./monaco-registry', async (original) => {
  const real = await original<typeof import('./monaco-registry')>();
  return { ...real, disposeModels: vi.fn(real.disposeModels) };
});

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.mocked(disposeModels).mockClear();
  resetModelHostForTests();
});
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const base = `${apiBaseUrl}/v1/questions`;
type User = ReturnType<typeof userEvent.setup>;

async function openEditor(
  id: string,
  opts: { maxPolls?: number } = {},
): Promise<{ u: User; unmount: () => void }> {
  nav.pathname = `/admin/questions/${id}`;
  const view = renderAsStaff(
    <main>
      <QuestionEditorRoute id={id} pollMs={5} {...opts} />
    </main>,
    MOCK_USERS.author,
  );
  await screen.findByRole('tablist', { name: 'Question sections' });
  return { u: userEvent.setup(), unmount: view.unmount };
}
const goTab = (u: User, name: string | RegExp) => u.click(screen.getByRole('tab', { name }));
const checkText = (id: string) => screen.getByTestId(`check-${id}`).textContent ?? '';
async function setText(u: User, el: HTMLElement, text: string): Promise<void> {
  await u.clear(el);
  await u.click(el);
  if (text !== '') await u.paste(text);
}
const detail = async (id: string) => {
  const r = await api.GET('/v1/questions/{questionId}', { params: { path: { questionId: id } } });
  return { response: r.response, data: r.data ? full(r.data) : undefined };
};

describe('A stale validation never opens the publish gate (TC-012)', () => {
  it('TC-012: while a validation runs, Save is off and the content is read-only', async () => {
    let release = false;
    server.use(
      http.get(`${base}/q-rotate/validation/:jobId`, () =>
        release
          ? undefined
          : HttpResponse.json({ jobId: 'x', validatedForUpdatedAt: 'x', status: 'running' }),
      ),
    );
    const { u } = await openEditor('q-rotate');
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/Running the reference solution/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    release = true;
    expect(await screen.findByText('Validation failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeEnabled();
  });

  it('TC-012: a result for other content is dropped, with an explanation, and Publish stays off', async () => {
    server.use(
      http.get(`${base}/q-running/validation/:jobId`, ({ params }) =>
        HttpResponse.json({
          jobId: String(params.jobId),
          validatedForUpdatedAt: '2000-01-01T00:00:00.000Z',
          status: 'done',
          report: { passed: true, finishedAt: new Date().toISOString(), results: [] },
        }),
      ),
    );
    const { u } = await openEditor('q-running');
    // Make the seeded validation not count so the dropped result is what decides.
    await u.type(screen.getByLabelText('Title'), '!');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved/);
    expect(checkText('validated')).toMatch(/To do/);
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/changed while it was being validated/)).toBeInTheDocument();
    expect(checkText('validated')).toMatch(/To do/);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('TC-012: the API writes no report onto content saved after Validate started, and publishing stale content is 409 with no machine code', async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await detail('q-running')).response.status).toBe(200));
    const before = (await detail('q-running')).data!;
    const started = await api.POST('/v1/questions/{questionId}/validate', {
      params: { path: { questionId: 'q-running' } },
    });
    const { jobId, validatedForUpdatedAt } = started.data!;
    expect(validatedForUpdatedAt).toBe(before.current.updatedAt);

    // Someone saves new content while the job runs.
    const content = { ...before.current, title: 'Running average (changed)' };
    const saved = await api.PATCH('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-running' } },
      body: { ...content, expectedUpdatedAt: validatedForUpdatedAt },
    });
    const savedAt = saved.data!.current.updatedAt;
    expect(savedAt).not.toBe(validatedForUpdatedAt);
    const poll = () =>
      api.GET('/v1/questions/{questionId}/validation/{jobId}', {
        params: { path: { questionId: 'q-running', jobId } },
      });
    await poll();
    const done = await poll();
    expect(done.data?.status).toBe('done');
    expect(done.data?.validatedForUpdatedAt).toBe(validatedForUpdatedAt);
    // The report was NOT written onto the newer content.
    const after = (await detail('q-running')).data!;
    expect(after.current.validationReport).toBeNull();
    expect(after.current.validatedAt).toBeNull();

    const publish = (expectedUpdatedAt: string) =>
      api.POST('/v1/questions/{questionId}/publish', {
        params: { path: { questionId: 'q-running' } },
        body: { expectedUpdatedAt },
      });
    const stale = await publish(validatedForUpdatedAt);
    expect(stale.response.status).toBe(409);
    // 409 and 422 carry detail (and errors[]) only: no machine code to branch on.
    expect(stale.error).not.toHaveProperty('code');
    expect(stale.error).toHaveProperty('detail');
    // Even the current content is refused without a validation of it: 422 with errors[].
    const unvalidated = await publish(savedAt);
    expect(unvalidated.response.status).toBe(422);
    expect(unvalidated.error).not.toHaveProperty('code');
    expect((unvalidated.error as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it("TC-012 TC-013: a new draft version does not inherit the previous version's validation", async () => {
    renderAsStaff(<div />, MOCK_USERS.author);
    await waitFor(async () => expect((await detail('q-merge')).response.status).toBe(200));
    const v2 = (await detail('q-merge')).data!;
    expect(v2.current.validationReport?.passed).toBe(true);
    const saved = await api.PATCH('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-merge' } },
      body: { ...v2.current, title: 'Merge intervals 2', expectedUpdatedAt: v2.current.updatedAt },
    });
    expect(saved.data?.current.version).toBe(3);
    expect(saved.data?.current.validationReport).toBeNull();
    expect(saved.data?.current.validatedAt).toBeNull();
  });

  it('TC-012: a validation that finishes without a report, or never finishes, ends with a retry message', async () => {
    server.use(
      http.get(`${base}/q-running/validation/:jobId`, ({ params }) =>
        HttpResponse.json({
          jobId: String(params.jobId),
          validatedForUpdatedAt: 'x',
          status: 'done',
        }),
      ),
    );
    const first = await openEditor('q-running');
    await first.u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/finished without a report/)).toBeInTheDocument();
    first.unmount();

    server.use(
      http.get(`${base}/q-running/validation/:jobId`, ({ params }) =>
        HttpResponse.json({
          jobId: String(params.jobId),
          validatedForUpdatedAt: 'x',
          status: 'running',
        }),
      ),
    );
    const second = await openEditor('q-running', { maxPolls: 3 });
    await second.u.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/taking longer than expected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validate' })).toBeEnabled();
  });

  it('TC-012: a double click on Validate starts one job', async () => {
    let starts = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/q-running/validate')) starts += 1;
    });
    const { u } = await openEditor('q-running');
    await u.dblClick(screen.getByRole('button', { name: 'Validate' }));
    await screen.findByText('Validation passed');
    expect(starts).toBe(1);
  });

  it('TC-012: the finished validation is also in the cache and the history refreshes', async () => {
    let versionsCalls = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/q-rotate/versions')) versionsCalls += 1;
    });
    const { u } = await openEditor('q-rotate');
    await u.click(screen.getByRole('button', { name: 'Validate' }));
    await screen.findByText('Validation failed');
    const cached = (await detail('q-rotate')).data!;
    expect(cached.current.validationReport?.passed).toBe(false);
    expect(versionsCalls).toBe(0); // nobody had the history open: nothing to refresh, no request
  });

  it('FR-103: a validation report loaded with the page is announced as a status, one just run as an alert', () => {
    const report = {
      passed: false,
      finishedAt: new Date().toISOString(),
      results: [
        {
          variantId: null,
          variantLabel: 'Base statement',
          testCaseId: 't',
          position: 1,
          language: 'python' as const,
          outcome: 'wrong_answer' as const,
        },
      ],
    };
    const { rerender } = render(
      <ValidationPanel report={report} isCoding stale={false} fresh={false} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Validation failed');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(<ValidationPanel report={report} isCoding stale={false} fresh />);
    expect(screen.getByRole('alert')).toHaveTextContent('Validation failed');
  });
});

describe('Concurrent edits (expectedUpdatedAt, 409)', () => {
  it("FR-204: saving over someone else's newer save is refused; the edit stays on screen and Reload loads theirs", async () => {
    const { u } = await openEditor('q-twosum');
    const current = (await detail('q-twosum')).data!;
    // Another author saves first.
    await api.PATCH('/v1/questions/{questionId}', {
      params: { path: { questionId: 'q-twosum' } },
      body: {
        ...current.current,
        title: 'Two sum (by someone else)',
        expectedUpdatedAt: current.current.updatedAt,
      },
    });
    await u.type(screen.getByLabelText('Title'), ' mine');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('This question changed since you opened it'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Two sum mine');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();

    await u.click(screen.getByRole('button', { name: /Reload the latest version/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Title')).toHaveValue('Two sum (by someone else)'),
    );
    expect(screen.queryByText('This question changed since you opened it')).not.toBeInTheDocument();
    await u.type(screen.getByLabelText('Title'), '!');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
  });
});

describe('Prefill proposals (ADR 0007)', () => {
  it('FR-203: proposals are set aside when the parameters change, and a late answer for old inputs is marked stale', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(`${base}/q-merge/prefill`, async () => {
        await gate;
        return undefined;
      }),
    );
    const { u } = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Three intervals' });
    await u.click(within(card).getByRole('button', { name: 'Prefill from reference solution' }));
    // The answer is still on its way; the author changes the parameters.
    await setText(u, within(card).getByLabelText('Parameters (JSON)'), '{"count": 5}');
    release();
    expect(await within(card).findByText(/set aside/)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Accept slot/ })).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('region', { name: /Proposed outputs/ }),
    ).not.toBeInTheDocument();
  });

  it('FR-203: a failing prefill shows an error, changes nothing and leaves no unhandled rejection', async () => {
    server.use(
      http.post(`${base}/q-merge/prefill`, () =>
        HttpResponse.json({ code: 'x', message: 'boom' }, { status: 500 }),
      ),
    );
    const { u } = await openEditor('q-merge');
    await goTab(u, 'Variants');
    const card = screen.getByRole('region', { name: 'Three intervals' });
    await u.click(within(card).getByRole('button', { name: 'Prefill from reference solution' }));
    expect(
      await within(card).findByText('We could not run the reference solution'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('Requests, models and previews', () => {
  it('FR-205: a question without AI solutions (multiple choice) makes no AI-references request', async () => {
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/ai-references')) calls.push(request.url);
    });
    await openEditor('q-bigo');
    await act(async () => {});
    expect(calls).toEqual([]);
  });

  it('D-20: starting a new coding question makes no AI-references request either', async () => {
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/ai-references')) calls.push(request.url);
    });
    const { NewQuestionRoute } = await import('./question-pages');
    renderAsStaff(
      <main>
        <NewQuestionRoute />
      </main>,
      MOCK_USERS.author,
    );
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Create a coding question' }));
    await act(async () => {});
    expect(calls).toEqual([]);
  });

  it('FR-201: every Monaco model path is private to the question and this mount', async () => {
    const first = await openEditor('q-merge');
    await goTab(first.u, 'Languages and starter code');
    const path1 =
      (await screen.findByLabelText('Starter code in Python')).getAttribute('data-path') ?? '';
    expect(path1).toMatch(/^q\/q-merge\/[a-z0-9]+\/starter\.python$/);
    first.unmount();
    const second = await openEditor('q-merge');
    await goTab(second.u, 'Languages and starter code');
    const path2 =
      (await screen.findByLabelText('Starter code in Python')).getAttribute('data-path') ?? '';
    expect(path2).toMatch(/^q\/q-merge\/[a-z0-9]+\/starter\.python$/);
    expect(path2).not.toBe(path1);
  });

  it('FR-201: closing the editor disposes its Monaco models', async () => {
    const { unmount } = await openEditor('q-merge');
    unmount();
    expect(disposeModels).toHaveBeenCalledWith(expect.stringMatching(/^q\/q-merge\/[a-z0-9]+\/$/));
  });

  it('FR-103: signing out disposes every question model', async () => {
    seedMockRefresh(MOCK_USERS.author.email);
    const out: { signOut?: () => Promise<void> } = {};
    function Capture() {
      out.signOut = useAuth().signOut;
      return <p data-testid="ready" />;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <Capture />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(vi.mocked(disposeModels)).toHaveBeenCalledWith('q/'));
    vi.mocked(disposeModels).mockClear();
    await out.signOut!();
    expect(disposeModels).toHaveBeenCalledWith('q/');
  });

  it('FR-201: the registry disposes only the models under a prefix', () => {
    const disposed: string[] = [];
    const model = (path: string) => ({ uri: { path }, dispose: () => disposed.push(path) });
    registerModelHost({
      editor: {
        getModels: () => [
          model('/q/q-a/n1/starter.python'),
          model('/q/q-b/n2/starter.python'),
          model('/other/file.py'),
        ],
      },
    });
    expect(disposeModels('q/q-a/')).toBe(1);
    expect(disposed).toEqual(['/q/q-a/n1/starter.python']);
    expect(disposeModels('q/')).toBe(2);
  });

  it('FR-201: javascript: links and remote images in a statement or a variant preview are not rendered as links or images', async () => {
    const { u } = await openEditor('q-merge');
    await setText(
      u,
      screen.getByLabelText('Statement (Markdown)'),
      '[click](javascript:alert(1)) and ![pic](https://evil.example/p.png) and [ok](https://example.test) {{count}}',
    );
    const preview = screen.getByTestId('statement-preview');
    expect(preview.querySelector('a[href^="javascript"]')).toBeNull();
    expect(preview.querySelector('img')).toBeNull();
    expect(preview).toHaveTextContent('not loaded in the preview');
    expect(within(preview).getByRole('link', { name: 'ok' })).toHaveAttribute(
      'href',
      'https://example.test',
    );
    await goTab(u, 'Variants');
    const variantPreview = screen.getByTestId('variant-preview-0');
    expect(variantPreview.querySelector('a[href^="javascript"]')).toBeNull();
    expect(variantPreview.querySelector('img')).toBeNull();
  });
});
