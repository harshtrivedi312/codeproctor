'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, type TabDef } from '@/components/ui/tabs';
import { ApiFailure } from '@/features/admin/queries';
import type { Schemas } from '@/lib/api/client';
import { getGeneration } from '@/lib/auth-session';
import {
  draftSchema,
  emptyDraft,
  toCreate,
  toDraft,
  toUpdate,
  toVariants,
  type DraftValues,
  type Variant,
} from './draft';
import { aiGate, canPublish, publishChecks } from './gate';
import { disposeModels } from './monaco-registry';
import { MonacoScope } from './monaco-field';
import { STATUS_LABEL, TYPE_LABEL } from './labels';
import {
  fetchQuestion,
  fetchVariants,
  isFullQuestion,
  PartialSaveFailure,
  questionKeys,
  type FullQuestion,
  type QuestionView,
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
  /** Required for edit and view: the writer view of one version. */
  detail?: FullQuestion;
  /** The variants of that version (web-only placeholder, BE-04b). */
  variants?: Variant[];
  /** Required for create. */
  type?: Schemas['QuestionType'];
  /** Validation poll interval; tests pass a small value. */
  pollMs?: number;
  /** Most polls of one validation job before giving up. */
  maxPolls?: number;
}

interface Meta {
  questionId: string | null;
  version: number;
  /** The opaque content revision (sha-256): concurrency check and ties a validation to the content. */
  revision: string;
  isPublished: boolean;
  validatedAt: string | null;
  report: Report | null;
}

function metaOf(detail: FullQuestion | undefined): Meta {
  return {
    questionId: detail?.id ?? null,
    version: detail?.version.version ?? 1,
    revision: detail?.version.revision ?? '',
    isPublished: detail?.version.isPublished ?? false,
    validatedAt: detail?.version.validatedAt ?? null,
    report: detail?.version.validationReport ?? null,
  };
}

/** What the AI publish gate assumes until the web-only AI reference list (BE-04c) has loaded. */
const DEFAULT_POLICY: Schemas['AiReferencePolicy'] = { refreshDays: 90, minAssistants: 2 };

/**
 * Why a publish did not happen, from the status alone (409 and 422 carry no machine code):
 * 409 the question changed since (reload), 422 the gate message(s) in errors[], 404/405/501 the
 * server cannot publish yet (permanent until reload), anything else is treated as transient.
 */
type PublishBlock = 'unavailable' | 'refused' | null;

/**
 * FR-201..FR-205 editor. One react-hook-form holds the whole draft; the tabs edit parts of it.
 * Saving is explicit (no autosave); leaving with unsaved edits asks first. Validate and Publish use
 * the saved version, so they are off while there are unsaved edits. The question lives only in this
 * component and in the React Query cache: never in a URL, storage or a log.
 */
export function QuestionEditor({
  mode,
  detail,
  variants: loadedVariants = [],
  type,
  pollMs = 1000,
  maxPolls = 90,
}: QuestionEditorProps): React.JSX.Element {
  const router = useRouter();
  const qc = useQueryClient();
  const readOnly = mode === 'view';
  const questionType = detail?.type ?? type ?? 'CODING';
  const initial = React.useMemo(
    () =>
      detail
        ? toDraft(detail.type, detail.tags, detail.version, loadedVariants)
        : emptyDraft(questionType),
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
  // What the server has, to work out what a save has to change (test cases, variants).
  const loaded = React.useRef({
    cases: (detail?.version.testCases ?? []).map((t) => ({ id: t.id, position: t.position })),
    variants: loadedVariants,
  });
  const [tab, setTab] = React.useState('statement');
  const [badTabs, setBadTabs] = React.useState<Set<string>>(new Set());
  const [notice, setNotice] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [publishProblem, setPublishProblem] = React.useState<string | null>(null);
  const [publishBlock, setPublishBlock] = React.useState<PublishBlock>(null);
  /** The server has newer content than this editor started from (409 on a call that sent expectedRevision). */
  const [conflict, setConflict] = React.useState(false);
  /** True only for a report that just came back from a job (an alert), not one loaded with the page. */
  const [reportFresh, setReportFresh] = React.useState(false);
  const revisionRef = React.useRef(meta.revision);
  // Double clicks on Validate or Publish start one action, not two.
  const busy = React.useRef(false);
  // Every Monaco model of this editor lives under this prefix and is disposed with the editor.
  const [scope] = React.useState(
    () => `q/${detail?.id ?? 'new'}/${Math.random().toString(36).slice(2, 10)}`,
  );
  React.useEffect(() => () => void disposeModels(`${scope}/`), [scope]);

  const create = useCreateQuestion();
  const save = useSaveQuestion(meta.questionId ?? '');
  const publish = usePublishQuestion(meta.questionId ?? '');
  const startValidation = useStartValidation(meta.questionId ?? '');
  const [validating, setValidating] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    revisionRef.current = meta.revision;
  }, [meta.revision]);
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
  const policy = refs.data?.policy ?? DEFAULT_POLICY;
  const gates = aiGate(languages, refs.data?.items ?? [], policy);

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
      if (error.status === 400 || error.status === 422) {
        const detail = [error.message, ...error.errors].filter(Boolean).join(' ');
        return detail || 'The server did not accept this content. Check the highlighted fields.';
      }
      if (error.status === 403)
        return 'Your role cannot do this. Ask a Super Admin if you think this is a mistake.';
      if (error.status === 404) return 'This question no longer exists. Go back to the list.';
      if (error.status === 401)
        return 'Your session ended before this could be saved. You will be asked to sign in again, and the edits on this page will be lost. Copy anything you need first.';
    }
    return 'We could not reach the server. Your edits are still on this page. Check your connection and try again.';
  }

  async function onValid(values: DraftValues): Promise<void> {
    setProblem(null);
    setNotice(null);
    setBadTabs(new Set());
    try {
      if (mode === 'create') {
        const created = await create.mutateAsync(toCreate(values));
        // Not dirty any more, so leaving the page for the saved question does not ask.
        form.reset(toDraft(created.type, created.tags, created.version));
        router.replace(`/admin/questions/${created.id}`);
        return;
      }
      const result = await save.mutateAsync({
        update: toUpdate(values),
        expectedRevision: meta.revision,
        desiredCases: values.testCases,
        loadedCases: loaded.current.cases,
        variants: isCoding ? toVariants(values) : null,
        loadedVariants: loaded.current.variants,
        coding: isCoding,
      });
      const saved = result.detail;
      form.reset(toDraft(saved.type, saved.tags, saved.version, result.variants));
      loaded.current = {
        cases: saved.version.testCases.map((t) => ({ id: t.id, position: t.position })),
        variants: result.variants,
      };
      setMeta(metaOf(saved));
      setPublishProblem(null);
      setPublishBlock((b) => (b === 'refused' ? null : b));
      setConflict(false);
      setReportFresh(false);
      setNotice(
        result.createdNewVersion
          ? `Saved as version ${saved.version.version} (draft). The published version ${meta.version} is unchanged.`
          : 'Saved. Validate again before publishing.',
      );
    } catch (e) {
      // A 409 on the save that sent expectedRevision means the content changed since it was loaded.
      if (e instanceof PartialSaveFailure) {
        setConflict(true);
        if (e.status !== 409) {
          setProblem(
            `Some of your changes were saved, but the ${e.step} could not be: ${describe(e)} Reload the latest version to see where things stand.`,
          );
        }
      } else if (e instanceof ApiFailure && e.status === 409) {
        setConflict(true);
      } else setProblem(describe(e));
    }
  }

  /** Throws the edits away and loads what is saved now. Only after the author chose to. */
  async function reloadLatest(): Promise<void> {
    const startedIn = getGeneration();
    try {
      const latest = await fetchQuestion(meta.questionId ?? '');
      // The user or the role changed while this was in flight: what came back is not theirs to see.
      if (startedIn !== getGeneration()) return;
      if (!isFullQuestion(latest)) throw new ApiFailure(403, '');
      const variants = isCoding ? await fetchVariants(latest.id, latest.version.version) : [];
      if (startedIn !== getGeneration()) return;
      qc.setQueryData(questionKeys.detail(latest.id), latest);
      form.reset(toDraft(latest.type, latest.tags, latest.version, variants));
      loaded.current = {
        cases: latest.version.testCases.map((t) => ({ id: t.id, position: t.position })),
        variants,
      };
      setMeta(metaOf(latest));
      setConflict(false);
      setProblem(null);
      setPublishProblem(null);
      setPublishBlock(null);
      setReportFresh(false);
      setNotice('Loaded the latest saved version.');
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
    if (busy.current) return;
    busy.current = true;
    setProblem(null);
    setPublishProblem(null);
    setPublishBlock((b) => (b === 'refused' ? null : b));
    setValidating(true);
    try {
      const questionId = meta.questionId ?? '';
      const generationAtStart = getGeneration();
      // The result only counts for the exact saved content it was started on (TC-012).
      const started = await startValidation.mutateAsync();
      const startedFor = revisionRef.current;
      if (started.revision !== startedFor) {
        setProblem('The question changed on the server. Reload the latest version, then validate.');
        return;
      }
      // Poll with a gentle backoff and a cap; stop quietly if the page was left meanwhile.
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(pollMs * (1 + attempt * 0.25), pollMs * 5)),
        );
        if (!alive.current) return;
        const state = await fetchValidationJob(questionId, started.jobId);
        if (!alive.current) return;
        if (state.status === 'failed') {
          setProblem(state.error ?? 'The validation job failed. Try again in a moment.');
          return;
        }
        if (state.status !== 'done') continue;
        const report = state.report;
        if (!report) {
          setProblem('The validation finished without a report. Press Validate to try again.');
          return;
        }
        if (state.revision !== startedFor || revisionRef.current !== startedFor) {
          setProblem(
            'The question changed while it was being validated, so that result was dropped. Press Validate again.',
          );
          return;
        }
        const validatedAt = report.passed ? (report.finishedAt ?? new Date().toISOString()) : null;
        setMeta((m) => ({ ...m, report, validatedAt }));
        setReportFresh(true);
        // Keep the cache in step with what the editor shows, and the history's "validated" column.
        qc.setQueryData<QuestionView>(questionKeys.detail(questionId), (old) =>
          generationAtStart === getGeneration() &&
          old &&
          isFullQuestion(old) &&
          old.version.revision === startedFor
            ? { ...old, version: { ...old.version, validatedAt, validationReport: report } }
            : old,
        );
        void qc.invalidateQueries({ queryKey: ['questions', 'list'] });
        return;
      }
      setProblem('Validation is taking longer than expected. Press Validate to try again.');
    } catch (e) {
      // A 409 on validate: the content changed on the server since it was loaded.
      if (e instanceof ApiFailure && e.status === 409) setConflict(true);
      else if (alive.current) setProblem(describe(e));
    } finally {
      busy.current = false;
      if (alive.current) setValidating(false);
    }
  }

  async function onPublish(): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPublishProblem(null);
    setNotice(null);
    try {
      const done = await publish.mutateAsync(meta.revision);
      // Only a 200 from the server marks the question published here, never anything earlier.
      setMeta(metaOf(done));
      setNotice(
        `Version ${done.version.version} is published. Editing it later creates a new version.`,
      );
    } catch (e) {
      if (!(e instanceof ApiFailure)) {
        setPublishProblem(
          'We could not reach the server, so nothing was published. Check your connection and try again.',
        );
      } else if (e.status === 409) {
        setConflict(true);
      } else if (e.status === 422) {
        setPublishBlock('refused');
        setPublishProblem(
          `Publishing was refused: ${e.errors.length > 0 ? e.errors.join(' ') : e.message || 'the question does not meet the requirements yet.'}`,
        );
      } else if (e.status === 404 || e.status === 405 || e.status === 501) {
        setPublishBlock('unavailable');
        setPublishProblem(
          'Publishing is not available yet. Nothing was published; your question is saved as a draft.',
        );
      } else if (e.status === 401 || e.status === 403) {
        setPublishProblem(describe(e));
      } else {
        // 5xx and the like: probably temporary, so Publish stays available for another try.
        setPublishProblem(
          'The server could not publish this right now. Nothing was published. Try again in a moment.',
        );
      }
    } finally {
      busy.current = false;
    }
  }

  const tabs: TabDef[] = (isCoding ? CODING_TABS : OTHER_TABS).map((t) =>
    badTabs.has(t.id) ? { ...t, badge: 'needs attention' } : t,
  );
  // While a validation runs the content is frozen: the result must be about what is on screen.
  const tabProps = { form, readOnly: readOnly || validating };

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
            <Badge tone={meta.isPublished ? 'success' : 'warning'}>
              {meta.isPublished ? STATUS_LABEL.PUBLISHED : STATUS_LABEL.DRAFT}
            </Badge>
            {isDirty && !readOnly ? <Badge tone="warning">Unsaved changes</Badge> : null}
          </p>
        </div>
        {readOnly ? null : (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!isDirty || form.formState.isSubmitting || validating}>
              {form.formState.isSubmitting ? 'Saving…' : 'Save'}
            </Button>
            {mode === 'edit' ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isDirty || validating || conflict}
                  aria-describedby="publish-checks"
                  onClick={() => void onValidate()}
                >
                  {validating ? 'Validating…' : 'Validate'}
                </Button>
                <Button
                  type="button"
                  disabled={
                    !canPublish(input) ||
                    publish.isPending ||
                    validating ||
                    conflict ||
                    publishBlock !== null
                  }
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
      {conflict ? (
        <Alert tone="warning" role="alert" title="This question changed since you opened it">
          Someone saved a newer version. Your edits are still on this page, but they cannot be saved
          on top of it. Copy what you need, then reload to continue.
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void reloadLatest()}
          >
            Reload the latest version (discards my edits)
          </Button>
        </Alert>
      ) : null}
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
        <ValidationPanel
          report={meta.report}
          isCoding={isCoding}
          stale={isDirty}
          fresh={reportFresh}
        />
      ) : null}

      <MonacoScope.Provider value={scope}>
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
      </MonacoScope.Provider>
    </form>
  );
}
