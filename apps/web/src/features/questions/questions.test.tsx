import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { QuestionsPage } from './questions-page';
import { QuestionEditorRoute } from './question-pages';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());
vi.mock('./monaco-inner', async () => (await import('@/test/monaco-stub')).monacoModule());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

function Main({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}

async function openList(user: { email: string } = MOCK_USERS.author) {
  nav.pathname = '/admin/questions';
  renderAsStaff(
    <Main>
      <QuestionsPage />
    </Main>,
    user,
  );
  await screen.findByRole('link', { name: 'Merge intervals' }).catch(() => undefined);
}

async function openEditor(id: string, user = MOCK_USERS.author) {
  nav.pathname = `/admin/questions/${id}`;
  renderAsStaff(
    <Main>
      <QuestionEditorRoute id={id} pollMs={5} />
    </Main>,
    user,
  );
  await screen.findByRole('tablist', { name: 'Question sections' });
  return userEvent.setup();
}

const goTab = (u: ReturnType<typeof userEvent.setup>, name: string | RegExp) =>
  u.click(screen.getByRole('tab', { name }));

describe('Question list (FR-201..FR-205)', () => {
  it('FR-201: lists the questions with type, difficulty, status and version', async () => {
    await openList();
    const row = screen.getByRole('row', { name: /Merge intervals/ });
    expect(within(row).getByText('Coding')).toBeInTheDocument();
    expect(within(row).getByText('Medium')).toBeInTheDocument();
    expect(within(row).getByText('Published')).toBeInTheDocument();
    expect(within(row).getByText('v2')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Cost of binary search/ })).toHaveTextContent(
      'Multiple choice',
    );
    expect(
      screen.getByRole('row', { name: /Status code for a created resource/ }),
    ).toHaveTextContent('Short answer');
  });

  it('FR-201: filters by type, difficulty and status, and searches by title or tag', async () => {
    const u = userEvent.setup();
    await openList();
    await u.selectOptions(screen.getByLabelText('Type'), 'MCQ');
    expect(screen.queryByRole('row', { name: /Merge intervals/ })).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Cost of binary search/ })).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Type'), '');

    await u.selectOptions(screen.getByLabelText('Difficulty'), 'MEDIUM');
    expect(screen.getByRole('row', { name: /Merge intervals/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Two sum/ })).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Difficulty'), '');

    await u.selectOptions(screen.getByLabelText('Status'), 'DRAFT');
    expect(screen.getByRole('row', { name: /Rotate an array/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Two sum/ })).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Status'), '');

    await u.type(
      screen.getByRole('searchbox', { name: 'Search by title, slug or tag' }),
      'hash-map',
    );
    expect(screen.getByRole('row', { name: /Two sum/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Merge intervals/ })).not.toBeInTheDocument();
  });

  it('FR-201: filters by tag', async () => {
    const u = userEvent.setup();
    await openList();
    await u.selectOptions(screen.getByLabelText('Filter by tag'), 'sorting');
    expect(screen.getByRole('row', { name: /Merge intervals/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Rotate an array/ })).not.toBeInTheDocument();
  });

  it('FR-103 TC-004: a recruiter can read the list but has no links into the editor and no New button', async () => {
    await openList(MOCK_USERS.recruiter);
    await screen.findByRole('row', { name: /Merge intervals/ });
    expect(screen.queryByRole('link', { name: 'Merge intervals' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New question' })).not.toBeInTheDocument();
  });

  it('FR-103 TC-004: a reviewer gets an explanation, not the list', async () => {
    renderAsStaff(
      <Main>
        <QuestionsPage />
      </Main>,
      MOCK_USERS.reviewer,
    );
    expect(await screen.findByText(/Your role does not have access/)).toBeInTheDocument();
  });

  it('FR-103 TC-004: the mock refuses the detail routes to a recruiter, so reference solutions never reach other roles', async () => {
    renderAsStaff(<div />, MOCK_USERS.recruiter);
    const { api } = await import('@/lib/api/client');
    await waitFor(async () => {
      const { response } = await api.GET('/v1/questions/{questionId}', {
        params: { path: { questionId: 'q-merge' } },
      });
      expect(response.status).toBe(403);
    });
  });

  it('WCAG 2.1 AA: the list has no axe violations', async () => {
    await openList();
    await screen.findByRole('row', { name: /Merge intervals/ });
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('Question editor: tabs and statement (FR-201)', () => {
  it('FR-201: tabs follow the WAI-ARIA pattern: roles, one tab stop, arrows, Home and End', async () => {
    const u = await openEditor('q-merge');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Statement',
      'Languages and starter code',
      'Reference solution',
      'Test cases',
      'Variants',
      'AI reference solutions',
      'Limits',
    ]);
    expect(screen.getByRole('tab', { name: 'Statement' })).toHaveAttribute('aria-selected', 'true');
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute(
      'aria-labelledby',
      screen.getByRole('tab', { name: 'Statement' }).id,
    );

    screen.getByRole('tab', { name: 'Statement' }).focus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Languages and starter code' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Languages and starter code' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await u.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Limits' })).toHaveFocus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Statement' })).toHaveFocus();
    await u.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Limits' })).toHaveFocus();
    await u.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Statement' })).toHaveFocus();
  });

  it("FR-201 FR-203: the statement preview renders markdown and fills a variant's placeholders", async () => {
    const u = await openEditor('q-merge');
    const preview = screen.getByTestId('statement-preview');
    expect(within(preview).getByText('Input')).toBeInTheDocument();
    expect(within(preview).queryByRole('heading')).not.toBeInTheDocument();
    expect(preview).toHaveTextContent('{{count}} intervals');
    await u.selectOptions(
      screen.getByLabelText('Show as'),
      screen.getByRole('option', { name: 'Four intervals' }),
    );
    expect(preview).toHaveTextContent('Given 4 intervals');
    expect(preview).not.toHaveTextContent('{{count}}');
  });

  it('FR-201: raw HTML in a statement is shown as text and never becomes an element', async () => {
    const u = await openEditor('q-merge');
    const box = screen.getByLabelText('Statement (Markdown)');
    await u.clear(box);
    await u.click(box);
    await u.paste(
      '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned=1"> hello',
    );
    const preview = screen.getByTestId('statement-preview');
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.querySelector('img')).toBeNull();
    expect(preview).toHaveTextContent('hello');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('WCAG 2.1 AA: the editor has no axe violations on the statement, tests and variants tabs', async () => {
    const u = await openEditor('q-merge');
    expect(await axe(document.body)).toHaveNoViolations();
    await goTab(u, 'Test cases');
    expect(await axe(document.body)).toHaveNoViolations();
    await goTab(u, 'Variants');
    expect(await axe(document.body)).toHaveNoViolations();
    await goTab(u, 'AI reference solutions');
    await screen.findByText('Collected solutions');
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('FR-201: the editor keeps the question out of the URL and out of storage', async () => {
    const u = await openEditor('q-merge');
    await u.type(screen.getByLabelText('Title'), ' (edited)');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain('Merge');
    expect(window.location.href).not.toContain('referenceSolution');
  });
});
