'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, type TabDef } from '@/components/ui/tabs';
import { ApiFailure } from '@/features/admin/queries';
import type { Schemas } from '@/lib/api/client';
import {
  draftSchema,
  emptyDraft,
  toContent,
  toDraft,
  type DraftValues,
  type QuestionDetail,
} from './draft';
import { aiGate, canPublish, publishChecks } from './gate';
import { STATUS_LABEL, TYPE_LABEL } from './labels';
import {
  useAiReferences,
  useCreateQuestion,
  usePublishQuestion,
  useSaveQuestion,
  useStartValidation,
  fetchValidationJob,
} from './queries';
import { AiTab } from './tabs/ai-tab';
import { AnswerTab } from './tabs/answer-tab';
import { LanguagesTab } from './tabs/languages-tab';
import { LimitsTab } from './tabs/limits-tab';
import { ReferenceTab } from './tabs/reference-tab';
import { StatementTab } from './tabs/statement-tab';
import { TestsTab } from './tabs/tests-tab';
import { VariantsTab } from './tabs/variants-tab';
import { useUnsavedGuard } from './unsaved-guard';
import { ValidationPanel } from './validation-panel';

type Report = Schemas['ValidationReport'];

const TAB_OF: Record<string, string> = {
  title: 'statement',
  difficulty: 'statement',
  tagsText: 'statement',
  statementMd: 'statement',
  allowedLanguages: 'languages',
  starterCode: 'languages',
  referenceSolution: 'reference',
  testCases: 'tests',
  paramSchema: 'variants',
  variants: 'variants',
  limits: 'limits',
  mcq: 'answer',
  short: 'answer',
};

const CODING_TABS: TabDef[] = [
  { id: 'statement', label: 'Statement' },
  { id: 'languages', label: 'Languages and starter code' },
  { id: 'reference', label: 'Reference solution' },
  { id: 'tests', label: 'Test cases' },
  { id: 'variants', label: 'Variants' },
  { id: 'ai', label: 'AI reference solutions' },
  { id: 'limits', label: 'Limits' },
];
const OTHER_TABS: TabDef[] = [
  { id: 'statement', label: 'Statement' },
  { id: 'answer', label: 'Answer' },
];

/** The tabs that hold an error, from a failed submit. */
function errorTabs(errors: FieldErrors<DraftValues>): Set<string> {
  const tabs = new Set<string>();
  for (const key of Object.keys(errors)) {
    const tab = TAB_OF[key];
    if (tab) tabs.add(tab);
  }
  return tabs;
}

export interface QuestionEditorProps {
  mode: 'create' | 'edit' | 'view';
  /** Required for edit and view. */
  detail?: QuestionDetail;
  /** Required for create. */
  type?: Schemas['QuestionType'];
  /** Validation poll interval; tests pass a small value. */
  pollMs?: number;
}

interface Meta {
  questionId: string | null;
  status: Schemas['QuestionStatus'];
  version: number;
  isPublished: boolean;
  validatedAt: string | null;
  report: Report | null;
}

function metaOf(detail: QuestionDetail | undefined): Meta {
  return {
    questionId: detail?.id ?? null,
    status: detail?.status ?? 'DRAFT',
    version: detail?.current.version ?? 1,
    isPublished: detail?.current.isPublished ?? false,
    validatedAt: detail?.current.validatedAt ?? null,
    report: detail?.current.validationReport ?? null,
  };
}

const PUBLISH_REFUSAL: Record<string, string> = {
  validation_required:
    'The saved version has no passing validation. Press Validate and fix every failing test.',
  ai_references_missing: 'AI reference solutions are missing.',
  already_published: 'This version is already published.',
};

/**
 * FR-201..FR-205 editor. One react-hook-form holds the whole draft; the tabs edit parts of it.
 * Saving is explicit (no autosave); leaving with unsaved edits asks first. Validate and Publish use
 * the saved version, so they are off while there are unsaved edits. The question lives only in this
 * component and in the React Query cache: never in a URL, storage or a log.
 */
export function QuestionEditor({
  mode,
  detail,
  type,
  pollMs = 1000,
}: QuestionEditorProps): React.JSX.Element {
  const router = useRouter();
  const readOnly = mode === 'view';
  const questionType = detail?.type ?? type ?? 'CODING';
  const initial = React.useMemo(
    () =>
      detail ? toDraft(detail.type, detail.current.tags, detail.current) : emptyDraft(questionType),
    // The editor mounts once per version of the question; later server data must not overwrite edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const form = useForm<DraftValues>({
    defaultValues: initial,
    resolver: zodResolver(draftSchema),
    mode: 'onSubmit',
  });
  const { isDirty } = form.formState;
  const guard = useUnsavedGuard(isDirty && !readOnly);

  const [meta, setMeta] = React.useState<Meta>(() => metaOf(detail));
  const [policy, setPolicy] = React.useState<Schemas['AiReferencePolicy']>(
    detail?.aiReferencePolicy ?? { refreshDays: 90, minAssistants: 2 },
  );
  const [tab, setTab] = React.useState('statement');
  const [badTabs, setBadTabs] = React.useState<Set<string>>(new Set());
  const [notice, setNotice] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [publishProblem, setPublishProblem] = React.useState<string | null>(null);

  const create = useCreateQuestion();
  const save = useSaveQuestion(meta.questionId ?? '');
  const publish = usePublishQuestion(meta.questionId ?? '');
  const startValidation = useStartValidation(meta.questionId ?? '');
  const [validating, setValidating] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const languages = useWatch({ control: form.control, name: 'allowedLanguages' });
  const title = useWatch({ control: form.control, name: 'title' });
  const isCoding = questionType === 'CODING';
  const refs = useAiReferences(isCoding && mode !== 'create' ? (meta.questionId ?? '') : '');
  const gates = aiGate(languages, refs.data ?? [], policy);

  const validationPassed = meta.report?.passed === true && meta.validatedAt !== null;
  const input = {
    type: questionType,
    isPublished: meta.isPublished,
    dirty: isDirty,
    validationPassed,
    aiGates: gates,
  };
  const checks = publishChecks(input);

  function describe(error: unknown): string {
    if (error instanceof ApiFailure) {
      if (error.status === 400)
        return (
          error.message || 'The server did not accept this content. Check the highlighted fields.'
        );
      if (error.status === 403)
        return 'Your role cannot do this. Ask a Super Admin if you think this is a mistake.';
      if (error.status === 404) return 'This question no longer exists. Go back to the list.';
      if (error.status === 401)
        return 'Your session expired. Sign in again; your edits on this page are still here until then.';
    }
    return 'We could not reach the server. Your edits are still here. Check your connection and try again.';
  }

  async function onValid(values: DraftValues): Promise<void> {
    setProblem(null);
    setNotice(null);
    setBadTabs(new Set());
    const content = toContent(values);
    try {
      if (mode === 'create') {
        const created = await create.mutateAsync({ ...content, type: questionType });
        // Not dirty any more, so leaving the page for the saved question does not ask.
        form.reset(toDraft(created.type, created.current.tags, created.current));
        router.replace(`/admin/questions/${created.id}`);
        return;
      }
      const saved = await save.mutateAsync(content);
      form.reset(toDraft(saved.type, saved.current.tags, saved.current));
      const newVersion = saved.current.version !== meta.version;
      setMeta(metaOf(saved));
      setPolicy(saved.aiReferencePolicy);
      setPublishProblem(null);
      setNotice(
        newVersion
          ? `Saved as version ${saved.current.version} (draft). The published version ${meta.version} is unchanged.`
          : 'Saved. Validate again before publishing.',
      );
    } catch (e) {
      setProblem(describe(e));
    }
  }

  function onInvalid(errors: FieldErrors<DraftValues>): void {
    const tabs = errorTabs(errors);
    setBadTabs(tabs);
    setNotice(null);
    const order = (isCoding ? CODING_TABS : OTHER_TABS).map((t) => t.id);
    const first = order.find((id) => tabs.has(id));
    if (first) setTab(first);
    setProblem(
      `Some fields need attention: ${[...tabs]
        .map((id) => (isCoding ? CODING_TABS : OTHER_TABS).find((t) => t.id === id)?.label ?? id)
        .join(', ')}. Nothing was saved.`,
    );
  }

  async function onValidate(): Promise<void> {
    setProblem(null);
    setPublishProblem(null);
    setValidating(true);
    try {
      const questionId = meta.questionId ?? '';
      const jobId = await startValidation.mutateAsync();
      // Poll the job until it is done; stop quietly if the page was left meanwhile.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (!alive.current) return;
        const state = await fetchValidationJob(questionId, jobId);
        if (!alive.current) return;
        if (state.status === 'failed') {
          setProblem(state.error ?? 'The validation job failed. Try again in a moment.');
          return;
        }
        if (state.status === 'done' && state.report) {
          const report = state.report;
          setMeta((m) => ({ ...m, report, validatedAt: report.passed ? report.finishedAt : null }));
          return;
        }
      }
    } catch (e) {
      if (alive.current) setProblem(describe(e));
    } finally {
      if (alive.current) setValidating(false);
    }
  }

  async function onPublish(): Promise<void> {
    setPublishProblem(null);
    setNotice(null);
    try {
      const done = await publish.mutateAsync();
      setMeta(metaOf(done));
      setNotice(
        `Version ${done.current.version} is published. Editing it later creates a new version.`,
      );
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) {
        setPublishProblem(
          `${PUBLISH_REFUSAL[e.code] ?? 'Publishing was refused.'}${e.code === 'ai_references_missing' && e.message ? ` ${e.message}` : ''}`,
        );
      } else setPublishProblem(describe(e));
    }
  }

  const tabs: TabDef[] = (isCoding ? CODING_TABS : OTHER_TABS).map((t) =>
    badTabs.has(t.id) ? { ...t, badge: 'needs attention' } : t,
  );
  const tabProps = { form, readOnly };

  return (
    <form
      onSubmit={(e) => void form.handleSubmit(onValid, onInvalid)(e)}
      noValidate
      className="space-y-4"
    >
      {guard}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {title.trim() || (mode === 'create' ? 'New question' : 'Untitled question')}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{TYPE_LABEL[questionType]}</span>
            <span>Version {meta.version}</span>
            <Badge tone={meta.status === 'PUBLISHED' ? 'success' : 'warning'}>
              {meta.isPublished ? STATUS_LABEL.PUBLISHED : STATUS_LABEL.DRAFT}
            </Badge>
            {isDirty && !readOnly ? <Badge tone="warning">Unsaved changes</Badge> : null}
          </p>
        </div>
        {readOnly ? null : (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!isDirty || form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Saving…' : 'Save'}
            </Button>
            {mode === 'edit' ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isDirty || validating}
                  aria-describedby="publish-checks"
                  onClick={() => void onValidate()}
                >
                  {validating ? 'Validating…' : 'Validate'}
                </Button>
                <Button
                  type="button"
                  disabled={!canPublish(input) || publish.isPending}
                  aria-describedby="publish-checks"
                  onClick={() => void onPublish()}
                >
                  {publish.isPending ? 'Publishing…' : 'Publish'}
                </Button>
              </>
            ) : null}
          </div>
        )}
      </div>

      {readOnly ? (
        <Alert tone="info" role="status">
          You are looking at version {meta.version}. It is read-only: past attempts keep using it.
        </Alert>
      ) : null}
      {mode === 'edit' && meta.isPublished && !readOnly ? (
        <Alert tone="info" role="status">
          Version {meta.version} is published and cannot change. Saving your edits creates version{' '}
          {meta.version + 1} as a draft.
        </Alert>
      ) : null}
      <div aria-live="polite">
        {notice ? (
          <Alert tone="success" role="status">
            {notice}
          </Alert>
        ) : null}
      </div>
      {problem ? (
        <Alert tone="error" role="alert" title="That did not work">
          {problem}
        </Alert>
      ) : null}

      {mode === 'edit' && !readOnly ? (
        <section aria-labelledby="publish-checks" className="rounded-md border bg-card p-3">
          <h2 id="publish-checks" className="text-sm font-medium">
            Before you can publish
          </h2>
          <ul className="mt-1 space-y-0.5 text-sm">
            {checks.map((c) => (
              <li key={c.id} data-testid={`check-${c.id}`}>
                <span className={c.ok ? 'text-foreground' : 'text-muted-foreground'}>
                  {c.ok ? 'Done: ' : 'To do: '}
                  {c.label}
                </span>
                {c.ok ? null : <span className="text-muted-foreground"> ({c.hint})</span>}
              </li>
            ))}
          </ul>
          {publishProblem ? (
            <Alert tone="error" role="alert" className="mt-2">
              {publishProblem}
            </Alert>
          ) : null}
        </section>
      ) : null}

      {validating ? (
        <p role="status" className="text-sm text-muted-foreground">
          Running the reference solution on every variant and test…
        </p>
      ) : null}
      {meta.report && !readOnly ? (
        <ValidationPanel report={meta.report} isCoding={isCoding} stale={isDirty} />
      ) : null}

      <Tabs label="Question sections" tabs={tabs} value={tab} onValueChange={setTab}>
        {(id) => {
          switch (id) {
            case 'statement':
              return <StatementTab {...tabProps} />;
            case 'languages':
              return <LanguagesTab {...tabProps} />;
            case 'reference':
              return <ReferenceTab {...tabProps} />;
            case 'tests':
              return <TestsTab {...tabProps} />;
            case 'variants':
              return <VariantsTab {...tabProps} questionId={meta.questionId} />;
            case 'ai':
              return <AiTab {...tabProps} questionId={meta.questionId} policy={policy} />;
            case 'limits':
              return <LimitsTab {...tabProps} />;
            default:
              return <AnswerTab {...tabProps} />;
          }
        }}
      </Tabs>
    </form>
  );
}
