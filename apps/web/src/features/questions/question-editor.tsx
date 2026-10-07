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
  variantName,
  type DraftValues,
} from './draft';
import { aiGate, canPublish, publishChecks } from './gate';
import { disposeModels } from './monaco-registry';
import { MonacoScope } from './monaco-field';
import { STATUS_LABEL, TYPE_LABEL } from './labels';
import {
  fetchQuestion,
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
  fetchValidation,
  asReport,
  isVariantHasAiRefs,
  VariantBlockedFailure,
  useAiPolicy,
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
  /** Required for create. */
  type?: Schemas['QuestionType'];
  /** Validation poll interval; tests pass a small value. */
  pollMs?: number;
  /** Most polls of one validation run before giving up: with the backoff about the API's 10-minute run limit. */
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
    report: asReport(detail?.version.validationReport),
  };
}

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
  type,
  pollMs = 1000,
  maxPolls = 130,
}: QuestionEditorProps): React.JSX.Element {
  const router = useRouter();
  const qc = useQueryClient();
  const readOnly = mode === 'view';
  const questionType = detail?.type ?? type ?? 'CODING';
  const initial = React.useMemo(
    () => (detail ? toDraft(detail.type, detail.tags, detail.version) : emptyDraft(questionType)),
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
  const loaded = React.useRef<Schemas['QuestionVersion'] | null>(detail?.version ?? null);
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
  const pollTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    revisionRef.current = meta.revision;
  }, [meta.revision]);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // A pending poll must not outlive the page.
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const languages = useWatch({ control: form.control, name: 'allowedLanguages' });
  const title = useWatch({ control: form.control, name: 'title' });
  const isCoding = questionType === 'CODING';
  // AI rows belong to the version being edited; a new version (a fork) starts with none.
  const refs = useAiReferences(
    isCoding && mode !== 'create' ? (meta.questionId ?? '') : '',
    meta.version,
  );
  // The organisation's real policy (Author and Super Admin may read it). Unknown means closed.
  const policyQuery = useAiPolicy(isCoding && mode !== 'create');
  const gates = aiGate(languages, refs.data?.items ?? [], policyQuery.data ?? null);
  const testCases = useWatch({ control: form.control, name: 'testCases' });

  // A passing run counts only for the very content on screen: its revision is the current one.
  // Adding or retiring an AI solution needs no save: a refusal that was about them stops holding
  // as soon as the list or the policy changes (derived, so no effect has to reset it).
  const aiKey = React.useMemo(
    () =>
      JSON.stringify([
        refs.data?.items.map((r) => [r.id, r.supersededAt]) ?? null,
        policyQuery.data?.minAssistants ?? null,
      ]),
    [refs.data, policyQuery.data],
  );
  const [refusedKey, setRefusedKey] = React.useState<string | null>(null);
  const refusalStale = publishBlock === 'refused' && refusedKey !== aiKey;
  const publishBlocked =
    publishBlock === 'unavailable' || (publishBlock === 'refused' && !refusalStale);

  const validationPassed =
    meta.report?.passed === true &&
    meta.validatedAt !== null &&
    meta.report.revision === meta.revision;
  const formVariants = useWatch({ control: form.control, name: 'variants' });
  const variantNames = React.useMemo(
    () => new Map(formVariants.map((v, i) => [v.id, variantName(i)])),
    [formVariants],
  );
  const input = {
    type: questionType,
    isPublished: meta.isPublished,
    dirty: isDirty,
    validationPassed,
    aiGates: gates,
    tests: {
      count: testCases.length,
      hasVisible: testCases.some((t) => !t.isHidden),
      hasHidden: testCases.some((t) => t.isHidden),
      weightsOk: testCases.every((t) => t.weight > 0),
    },
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
      if (error.status === 503 && error.code === 'BUSY')
        return 'The service is busy and nothing was saved. Your edits are still on this page. Wait a moment, then press Save again.';
      if (error.status === 500)
        return 'Something went wrong. Check before trying again: the change may already have happened. Reload the latest version to see what is saved; your edits stay on this page until you do.';
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
      if (!loaded.current) throw new ApiFailure(404, '');
      const result = await save.mutateAsync({
        update: toUpdate(values),
        expectedRevision: meta.revision,
        desiredCases: values.testCases,
        variants: isCoding ? toVariants(values) : null,
        loaded: loaded.current,
        coding: isCoding,
      });
      const saved = result.detail;
      form.reset(toDraft(saved.type, saved.tags, saved.version));
      loaded.current = saved.version;
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
      await explainSaveFailure(e);
    }
  }

  /**
   * What a failed save says and does. Status and step decide; the one machine code is
   * VARIANT_HAS_AI_REFERENCES (a variant with AI rows cannot be deleted): not a conflict, no reload,
   * the edits stay, and the variant that could not be removed is put back, inactive. A save that
   * stopped half way on a draft takes over the server's revision for the retry, but ONLY when the
   * server is exactly where this save left it (`lastRevision`): if anyone else wrote meanwhile the
   * author reloads, and the text stays on the page until then. After a fork (ids changed) or a real
   * concurrent change the author reloads too.
   */
  async function explainSaveFailure(e: unknown): Promise<void> {
    if (isVariantHasAiRefs(e)) {
      const partial = e instanceof PartialSaveFailure;
      const blocked =
        e instanceof PartialSaveFailure
          ? e.blockedVariantId
          : e instanceof VariantBlockedFailure
            ? e.variantId
            : null;
      const name = blocked !== null && !(partial && e.forked) ? restoreVariant(blocked) : null;
      const message = `This variant has AI reference solutions, which are never deleted, so it cannot be removed.${
        name ? ` ${name} was put back, set inactive.` : ' Set it inactive instead.'
      } Everything else you changed is still on this page.`;
      setProblem(partial ? `Some of your changes were saved. ${message}` : message);
      if (partial) await resync(e);
      return;
    }
    if (e instanceof PartialSaveFailure) {
      if (e.step === 'reload') {
        setConflict(true);
        setProblem(
          `Your changes were saved, but we could not load the saved version: ${describe(e)} Reload the latest version to continue.`,
        );
      } else if (e.status === 409) {
        setConflict(true);
        setProblem(
          `Part of your changes were saved, then the ${e.step} step found that the question changed meanwhile. Reload the latest version to see where things stand; your edits on this page stay until you do.`,
        );
      } else if (e.forked) {
        setConflict(true);
        setProblem(
          `Your changes were saved as a new version, but the ${e.step} could not be: ${describe(e)} Reload the latest version to see where things stand.`,
        );
      } else if (e.status >= 500) {
        // A 500 is never retried: the step that failed may have been applied (an audit write can
        // fail after the commit). Look before saving again; the retry is checked by revision.
        setProblem(
          `Part of your changes were saved, and the ${e.step} step may have gone through as well. Something went wrong on the server. Check before pressing Save again: your edits on this page stay, and Save only goes on if nobody else changed the question.`,
        );
        await resync(e);
      } else {
        setProblem(
          `Some of your changes were saved, but the ${e.step} could not be: ${describe(e)} Fix that and press Save again; nothing you typed is lost.`,
        );
        await resync(e);
      }
    } else if (e instanceof ApiFailure && e.status === 409) {
      setConflict(true);
    } else setProblem(describe(e));
  }

  /** Puts a saved variant that could not be removed back into the form, inactive, where it was. */
  function restoreVariant(id: string): string | null {
    const base = loaded.current?.variants.find((v) => v.id === id);
    const at = loaded.current?.variants.findIndex((v) => v.id === id) ?? -1;
    const current = form.getValues('variants');
    if (!base || current.some((v) => v.id === id)) return null;
    const index = Math.min(Math.max(at, 0), current.length);
    const next = [...current];
    next.splice(index, 0, {
      id: base.id,
      paramsText: JSON.stringify(base.params, null, 2),
      active: false,
      overrides: base.testCaseOverrides.map((o) => ({
        testCaseId: o.testCaseId,
        input: o.input,
        expectedOutput: o.expectedOutput,
      })),
    });
    form.setValue('variants', next, { shouldDirty: true });
    return variantName(index);
  }

  /**
   * After a half-done save on a draft: take the server's revision and snapshot so a retry diffs
   * against it, but only if the server is EXACTLY where this save last confirmed it (e.lastRevision).
   * Anything else (another author wrote, or a write could not be confirmed) is a conflict: adopting
   * it would make the next Save overwrite their work with ours. Nothing happens for another session.
   */
  async function resync(e: PartialSaveFailure): Promise<void> {
    if (e.forked) {
      setConflict(true);
      return;
    }
    if (e.step === 'reload' || e.status === 401 || (e.status === 409 && !isVariantHasAiRefs(e))) {
      return;
    }
    const meantime = () => {
      setConflict(true);
      setProblem(
        'Part of your changes were saved, then the question changed or could not be confirmed. Reload the latest version to see where things stand; your edits on this page stay until you do.',
      );
    };
    if (e.lastRevision === null) {
      meantime();
      return;
    }
    // The session of the save is the one that counts: another one never makes this request.
    if (e.generation !== getGeneration() || !alive.current) return;
    try {
      const fresh = await fetchQuestion(meta.questionId ?? '');
      if (e.generation !== getGeneration() || !alive.current || !isFullQuestion(fresh)) return;
      if (fresh.version.version !== meta.version || fresh.version.revision !== e.lastRevision) {
        meantime();
        return;
      }
      loaded.current = fresh.version;
      setMeta(metaOf(fresh));
    } catch {
      // The retry will say what is wrong (a 409 asks for a reload).
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
      qc.setQueryData(questionKeys.detail(latest.id), latest);
      form.reset(toDraft(latest.type, latest.tags, latest.version));
      loaded.current = latest.version;
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
      // The run only counts for the exact saved content it was started on (TC-012).
      const startedFor = revisionRef.current;
      let boundTo: string;
      try {
        boundTo = (await startValidation.mutateAsync(startedFor)).revision;
      } catch (e) {
        if (!(e instanceof ApiFailure) || (e.status !== 409 && e.status !== 422)) throw e;
        if (e.status === 422) {
          setProblem(
            `The question cannot be validated yet: ${[e.message, ...e.errors].filter(Boolean).join(' ')}`,
          );
          return;
        }
        // 409 is either "changed since you loaded it" or "a run is already going": ask which.
        const now = await fetchValidation(questionId);
        if (now.status === 'RUNNING' && now.revision === startedFor) {
          boundTo = startedFor;
        } else if (now.currentRevision !== startedFor) {
          setConflict(true);
          return;
        } else {
          // Same content, so not a stale revision: the question cannot be validated now (archived).
          setProblem(
            `${e.message || 'The question cannot be validated now.'} Reload the page to see its state.`,
          );
          return;
        }
      }
      if (boundTo !== startedFor) {
        setProblem('The question changed on the server. Reload the latest version, then validate.');
        return;
      }
      // Poll with a gentle backoff and a cap; stop quietly if the page was left meanwhile.
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        await new Promise((resolve) => {
          pollTimer.current = setTimeout(
            resolve,
            Math.min(pollMs * (1 + attempt * 0.25), pollMs * 5),
          );
        });
        if (!alive.current) return;
        const state = await fetchValidation(questionId);
        // Right after each answer: another user or role may be signed in by now.
        if (!alive.current || generationAtStart !== getGeneration()) return;
        if (state.status === 'RUNNING') continue;
        if (state.status === 'NONE') {
          setProblem(
            'The validation run was lost (the server may have restarted). Press Validate to try again.',
          );
          return;
        }
        // Whatever the run was bound to, it must be the content on screen and still the current one.
        if (
          state.revision !== startedFor ||
          state.currentRevision !== startedFor ||
          revisionRef.current !== startedFor ||
          state.status === 'STALE'
        ) {
          setProblem(
            'The question changed while it was being validated, so that result was dropped. Press Validate again.',
          );
          return;
        }
        const report = asReport(state.report);
        if (state.status === 'ERROR') {
          // Nothing was recorded; show why when the report says so.
          if (report) setMeta((m) => ({ ...m, report, validatedAt: null }));
          setReportFresh(true);
          setProblem(
            'The validation could not complete. Nothing was recorded. Press Validate to try again.',
          );
          return;
        }
        if (!report) {
          setProblem('The validation finished without a report. Press Validate to try again.');
          return;
        }
        const validatedAt = state.validatedAt;
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
      if (alive.current) setProblem(describe(e));
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
      // The loaded snapshot is the published version now: a later edit forks, it never writes into it.
      loaded.current = done.version;
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
        setRefusedKey(aiKey);
        setPublishProblem(
          `Publishing was refused: ${e.errors.length > 0 ? e.errors.join(' ') : e.message || 'the question does not meet the requirements yet.'}`,
        );
      } else if (e.status === 404) {
        // The real API answers 404 only for a question that is gone (or not yours): say so.
        setPublishProblem(
          'This question no longer exists, so nothing was published. Go back to the list.',
        );
      } else if (e.status === 405 || e.status === 501) {
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
                {isCoding ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isDirty || validating || conflict || meta.isPublished}
                    aria-describedby="publish-checks"
                    onClick={() => void onValidate()}
                  >
                    {validating ? 'Validating…' : 'Validate'}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  disabled={
                    !canPublish(input) ||
                    publish.isPending ||
                    validating ||
                    conflict ||
                    publishBlocked
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
          {publishProblem && !refusalStale ? (
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
          variantNames={variantNames}
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
                return (
                  <VariantsTab
                    {...tabProps}
                    questionId={meta.questionId}
                    version={meta.version}
                    published={meta.isPublished}
                  />
                );
              case 'ai':
                return <AiTab {...tabProps} questionId={meta.questionId} version={meta.version} />;
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
