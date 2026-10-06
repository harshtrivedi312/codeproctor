'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm, useWatch, type FieldErrors, type UseFormReturn } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiFailure } from '@/features/admin/queries';
import { PageHeader } from '@/features/admin/page-header';
import { DIFFICULTY_LABEL, TYPE_LABEL } from '@/features/questions/labels';
import { useQuestions } from '@/features/questions/queries';
import { useUnsavedGuard } from '@/features/questions/unsaved-guard';
import {
  DEFAULT_POINTS,
  MAX_QUESTIONS_PER_SECTION,
  MAX_SECTIONS,
  emptyDraft,
  emptyQuestion,
  emptySection,
  fromDetail,
  limitsTotal,
  moveItem,
  parseTags,
  questionCount,
  testDraftSchema,
  toBody,
  totalPoints,
  type QuestionRow,
  type SectionRow,
  type TestDraft,
} from './draft';
import { PROFILE_EXPLANATION, PROFILE_LABEL, SECTION_RULES } from './labels';
import { InviteButton } from '@/features/invitations/invite-button';
import { QuestionPicker, pickRows, type PickRow } from './question-picker';
import {
  TestChangedFailure,
  fetchTest,
  testKeys,
  useCreateTest,
  useSaveTest,
  type TestDetail,
} from './queries';
import { useQueryClient } from '@tanstack/react-query';

export interface TestBuilderProps {
  /** create: a new test (optionally from a template draft); edit: a test nobody was invited to; view: a test in use. */
  mode: 'create' | 'edit' | 'view';
  detail?: TestDetail;
  /** A draft to start from (use as template). */
  template?: TestDraft;
  /** Extra buttons next to Save (the invite button, phase 2). */
  actions?: React.ReactNode;
}

function useSections(form: UseFormReturn<TestDraft>) {
  const sections = useWatch({ control: form.control, name: 'sections' });
  const set = React.useCallback(
    (next: SectionRow[]) =>
      form.setValue('sections', next, {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      }),
    [form],
  );
  return [sections, set] as const;
}

const sectionError = (
  errors: FieldErrors<TestDraft>,
  i: number,
  field: 'title' | 'timeLimit' | 'questions',
): string | undefined => {
  const e = errors.sections?.[i]?.[field];
  return e && typeof e === 'object' && 'message' in e && typeof e.message === 'string'
    ? e.message
    : undefined;
};
const rowError = (
  errors: FieldErrors<TestDraft>,
  i: number,
  j: number,
  field: string,
): string | undefined => {
  const row = errors.sections?.[i]?.questions?.[j] as
    Record<string, { message?: unknown } | undefined> | undefined;
  const m = row?.[field]?.message;
  return typeof m === 'string' ? m : undefined;
};

export function TestBuilder({
  mode,
  detail,
  template,
  actions,
}: TestBuilderProps): React.JSX.Element {
  const router = useRouter();
  const qc = useQueryClient();
  const readOnly = mode === 'view';
  const questions = useQuestions(false);
  const rows = React.useMemo(() => pickRows(questions.data), [questions.data]);
  const pickable = React.useMemo(
    () =>
      questions.data
        ? rows.map((r) => ({ type: r.type, tags: r.tags, difficulty: r.difficulty }))
        : null,
    [questions.data, rows],
  );
  const initial = React.useMemo(
    () => (detail ? fromDetail(detail) : (template ?? emptyDraft())),
    // The builder mounts once per test: later server data must not overwrite edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Once a pass score is set (loaded or saved here) the API cannot clear it.
  const [passScoreHad, setPassScoreHad] = React.useState(
    detail?.passScore !== null && detail?.passScore !== undefined,
  );
  const schema = React.useMemo(
    () => testDraftSchema(pickable, mode === 'edit' && passScoreHad),
    [pickable, mode, passScoreHad],
  );
  const form = useForm<TestDraft>({
    defaultValues: initial,
    resolver: zodResolver(schema),
    mode: 'onSubmit',
  });
  const { errors, isDirty } = form.formState;
  const guard = useUnsavedGuard(isDirty && !readOnly);
  const loaded = React.useRef<TestDetail | null>(detail ?? null);
  const [sections, setSections] = useSections(form);
  const durationMinutes = useWatch({ control: form.control, name: 'durationMinutes' });
  const profile = useWatch({ control: form.control, name: 'profile' });

  const [problem, setProblem] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [announce, setAnnounce] = React.useState('');
  const [picking, setPicking] = React.useState<number | null>(null);
  const [dragFrom, setDragFrom] = React.useState<number | null>(null);
  const create = useCreateTest();
  const save = useSaveTest(detail?.id ?? '');

  const total = totalPoints(sections);
  const limits = limitsTotal(sections);
  const count = questionCount(sections);
  const taken = React.useMemo(
    () =>
      new Set(
        sections.flatMap((s) => s.questions.flatMap((q) => (q.versionId ? [q.versionId] : []))),
      ),
    [sections],
  );

  function describe(error: unknown): string {
    if (error instanceof ApiFailure) {
      if (error.status === 400 || error.status === 422) {
        return (
          [error.message, ...error.errors].filter(Boolean).join(' ') ||
          'The server did not accept this test. Check the highlighted fields.'
        );
      }
      if (error.status === 404) {
        return /question/i.test(error.message)
          ? 'A question you picked is no longer available (it may have been unpublished or archived). Remove it and pick it again.'
          : 'This test is no longer available. It may have been removed. Go back to the tests list and check.';
      }
      if (error.status === 403)
        return 'Your role cannot do this. Ask a Super Admin if you think this is a mistake.';
      if (error.status === 401)
        return 'Your session ended before this could be saved. You will be asked to sign in again; copy anything you need first.';
    }
    return 'We could not reach the server. Your edits are still on this page. Check your connection and try again.';
  }

  async function onValid(values: TestDraft): Promise<void> {
    setProblem(null);
    setNotice(null);
    try {
      if (mode === 'create') {
        const created = await create.mutateAsync(toBody(values));
        form.reset(fromDetail(created));
        router.push(`/admin/tests/${created.id}`);
        return;
      }
      if (!loaded.current) throw new ApiFailure(404, '');
      const saved = await save.mutateAsync({ loaded: loaded.current, body: toBody(values, true) });
      loaded.current = saved;
      setPassScoreHad(saved.passScore !== null);
      form.reset(fromDetail(saved));
      setConflict(false);
      setNotice('Saved.');
    } catch (e) {
      if (e instanceof TestChangedFailure) {
        setConflict(true);
        setProblem(
          e.reason === 'used'
            ? 'Someone invited candidates to this test while you were editing, so it can no longer be changed. Nothing was saved. Reload to see it, then build a new test from it.'
            : 'Someone else changed this test since you opened it. Nothing was saved. Reload the latest version to continue; your edits on this page stay until you do.',
        );
      } else if (e instanceof ApiFailure && e.status === 409) {
        setConflict(true);
        setProblem(
          'This test already has invitations or sessions and cannot be edited. Nothing was saved. Reload, then build a new test from it.',
        );
      } else setProblem(describe(e));
    }
  }

  async function reload(): Promise<void> {
    if (!detail) return;
    try {
      const fresh = await fetchTest(detail.id);
      qc.setQueryData(testKeys.detail(detail.id), fresh);
      loaded.current = fresh;
      setPassScoreHad(fresh.passScore !== null);
      form.reset(fromDetail(fresh));
      setConflict(false);
      setProblem(null);
      setNotice('Loaded the latest saved version.');
    } catch (e) {
      setProblem(describe(e));
    }
  }

  function onInvalid(): void {
    setNotice(null);
    setProblem('Some fields need attention. Nothing was saved.');
  }

  const moveSection = (from: number, to: number): void => {
    if (to < 0 || to >= sections.length) return;
    setSections(moveItem(sections, from, to));
    setAnnounce(
      `Section ${sections[from]?.title || from + 1} moved to position ${to + 1} of ${sections.length}.`,
    );
  };
  const patchSection = (i: number, patch: Partial<SectionRow>): void =>
    setSections(sections.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const patchQuestion = (i: number, j: number, patch: Partial<QuestionRow>): void =>
    patchSection(i, {
      questions: sections[i]!.questions.map((q, k) => (k === j ? { ...q, ...patch } : q)),
    });
  const moveQuestion = (i: number, from: number, to: number): void => {
    const s = sections[i]!;
    if (to < 0 || to >= s.questions.length) return;
    patchSection(i, { questions: moveItem(s.questions, from, to) });
    setAnnounce(
      `Question moved to position ${to + 1} of ${s.questions.length} in ${s.title || `section ${i + 1}`}.`,
    );
  };
  const addFixed = (i: number, row: PickRow): void => {
    const s = sections[i]!;
    if (s.questions.length >= MAX_QUESTIONS_PER_SECTION) return;
    patchSection(i, {
      questions: [
        ...s.questions,
        {
          ...emptyQuestion('fixed'),
          versionId: row.versionId,
          title: row.title,
          difficulty: row.difficulty,
        },
      ],
    });
    setAnnounce(`${row.title} added.`);
  };
  const addRandom = (i: number, n: number): void => {
    const s = sections[i]!;
    const room = MAX_QUESTIONS_PER_SECTION - s.questions.length;
    patchSection(i, {
      questions: [
        ...s.questions,
        ...Array.from({ length: Math.max(0, Math.min(n, room)) }, () => emptyQuestion('random')),
      ],
    });
  };

  const errList = sectionError;

  return (
    <form
      onSubmit={(e) => void form.handleSubmit(onValid, onInvalid)(e)}
      noValidate
      className="space-y-5"
    >
      {guard}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={mode === 'create' ? 'New test' : form.getValues('name') || 'Test'}
          description="A test is an ordered list of sections. Each section has fixed questions from the bank or random picks."
        />
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {detail ? <InviteButton testId={detail.id} disabled={isDirty && !readOnly} /> : null}
          {readOnly ? null : (
            <Button
              type="submit"
              disabled={form.formState.isSubmitting || (mode === 'edit' && !isDirty)}
            >
              {form.formState.isSubmitting ? 'Saving…' : mode === 'create' ? 'Create test' : 'Save'}
            </Button>
          )}
        </div>
      </div>

      {readOnly ? (
        <Alert tone="info" role="status" title="This test is in use">
          It already has invitations or sessions, so it cannot be changed: candidates must all get
          the same test.{' '}
          {detail ? (
            <Link
              href={`/admin/tests/new?from=${detail.id}`}
              className="font-medium text-primary underline underline-offset-4"
            >
              Build a new test from this one
            </Link>
          ) : null}
          .
        </Alert>
      ) : null}
      {problem ? (
        <Alert tone="error" role="alert" title="That did not work">
          {problem}
          {conflict ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void reload()}
            >
              Reload the latest version
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" role="status">
          {notice}
        </Alert>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      <section aria-labelledby="test-basics" className="space-y-4 rounded-md border bg-card p-4">
        <h2 id="test-basics" className="font-medium">
          Basics
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="test-name" label="Name" error={errors.name?.message}>
            {(aria) => (
              <Input {...aria} disabled={readOnly} maxLength={200} {...form.register('name')} />
            )}
          </Field>
          <Field
            id="test-duration"
            label="Total duration (minutes)"
            hint="From 5 to 480. This is the whole test; section limits below must fit inside it."
            error={errors.durationMinutes?.message}
          >
            {(aria) => (
              <Input
                {...aria}
                type="number"
                min={5}
                max={480}
                disabled={readOnly}
                {...form.register('durationMinutes', { valueAsNumber: true })}
              />
            )}
          </Field>
        </div>
        <Field
          id="test-description"
          label="Description (optional)"
          error={errors.description?.message}
        >
          {(aria) => (
            <Textarea
              {...aria}
              disabled={readOnly}
              className="min-h-20"
              {...form.register('description')}
            />
          )}
        </Field>
        <Field
          id="test-pass"
          label="Pass score (optional)"
          hint={`Points needed to pass, from 0 to ${total}, the points of all questions together${
            passScoreHad && !readOnly
              ? '. A pass score that is set cannot be removed, only changed'
              : ''
          }.`}
          error={errors.passScore?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              min={0}
              max={total}
              step="any"
              disabled={readOnly}
              className="max-w-40"
              {...form.register('passScore')}
            />
          )}
        </Field>

        <fieldset className="space-y-2" aria-describedby="profile-help">
          <legend className="text-sm font-medium">Proctoring profile</legend>
          <p id="profile-help" className="text-sm text-muted-foreground">
            What is recorded while a candidate takes this test. Candidates are told before they
            start.
          </p>
          {(['STANDARD', 'STRICT'] as const).map((p) => (
            <label
              key={p}
              className="flex gap-3 rounded-md border p-3 has-[:checked]:border-primary"
            >
              <input
                type="radio"
                value={p}
                disabled={readOnly}
                className="mt-1 size-4"
                {...form.register('profile')}
              />
              <span>
                <span className="block font-medium">{PROFILE_LABEL[p]}</span>
                <span className="block text-sm">{PROFILE_EXPLANATION[p].summary}</span>
                <span className="block text-sm text-muted-foreground">
                  {PROFILE_EXPLANATION[p].records}
                </span>
              </span>
            </label>
          ))}
          <p className="text-sm text-muted-foreground" data-testid="profile-selected">
            Selected: {PROFILE_LABEL[profile]}.
          </p>
        </fieldset>
      </section>

      <section aria-labelledby="test-sections" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="test-sections" className="font-medium">
            Sections
          </h2>
          <p className="text-sm text-muted-foreground" data-testid="test-summary">
            {sections.length} section{sections.length === 1 ? '' : 's'} · {count} question
            {count === 1 ? '' : 's'} · {total} points
            {limits > 0
              ? ` · section limits ${limits} of ${Number.isFinite(durationMinutes) ? durationMinutes : '?'} minutes`
              : ''}
          </p>
        </div>
        <Alert tone="info">{SECTION_RULES}</Alert>
        {errors.sections?.message ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.sections.message}
          </p>
        ) : null}

        <ol className="space-y-3">
          {sections.map((s, i) => (
            <li
              key={s.key}
              data-testid={`section-${i}`}
              className="rounded-md border bg-card p-4"
              onDragOver={(e) => {
                if (dragFrom !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) moveSection(dragFrom, i);
                setDragFrom(null);
              }}
            >
              <div className="flex flex-wrap items-start gap-3">
                {readOnly ? null : (
                  <span
                    draggable
                    aria-hidden="true"
                    title="Drag to reorder (keyboard: use the Move buttons)"
                    className="mt-8 cursor-grab text-muted-foreground"
                    onDragStart={() => setDragFrom(i)}
                    onDragEnd={() => setDragFrom(null)}
                  >
                    <GripVertical className="size-5" />
                  </span>
                )}
                <span className="mt-8 w-6 text-sm font-medium" aria-hidden="true">
                  {i + 1}.
                </span>
                <div className="min-w-48 flex-1">
                  <Field
                    id={`section-${i}-title`}
                    label={`Section ${i + 1} name`}
                    error={errList(errors, i, 'title')}
                  >
                    {(aria) => (
                      <Input
                        {...aria}
                        disabled={readOnly}
                        value={s.title}
                        onChange={(e) => patchSection(i, { title: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
                <div className="w-48">
                  <Field
                    id={`section-${i}-limit`}
                    label={`Section ${i + 1} time limit (minutes)`}
                    hint="Optional."
                    error={errList(errors, i, 'timeLimit')}
                  >
                    {(aria) => (
                      <Input
                        {...aria}
                        type="number"
                        min={1}
                        disabled={readOnly}
                        value={s.timeLimit}
                        onChange={(e) => patchSection(i, { timeLimit: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
                {readOnly ? null : (
                  <div className="mt-7 flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === 0}
                      onClick={() => moveSection(i, i - 1)}
                    >
                      <ArrowUp className="size-4" aria-hidden="true" />
                      <span className="sr-only">Move section {i + 1} up</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === sections.length - 1}
                      onClick={() => moveSection(i, i + 1)}
                    >
                      <ArrowDown className="size-4" aria-hidden="true" />
                      <span className="sr-only">Move section {i + 1} down</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={sections.length === 1}
                      onClick={() => setSections(sections.filter((_, k) => k !== i))}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      <span className="sr-only">Remove section {i + 1}</span>
                    </Button>
                  </div>
                )}
              </div>

              <ul className="mt-3 space-y-2" aria-label={`Questions of section ${i + 1}`}>
                {s.questions.map((q, j) => (
                  <li
                    key={q.key}
                    className="rounded-md border bg-background p-3"
                    data-testid={`question-${i}-${j}`}
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <span className="mt-2 w-6 text-sm" aria-hidden="true">
                        {j + 1}.
                      </span>
                      {q.kind === 'fixed' ? (
                        <div className="min-w-48 flex-1">
                          <p className="font-medium">{q.title || 'A question'}</p>
                          <p className="text-sm text-muted-foreground">
                            Fixed question
                            {q.difficulty ? ` · ${DIFFICULTY_LABEL[q.difficulty]}` : ''}
                          </p>
                          {rowError(errors, i, j, 'versionId') ? (
                            <p role="alert" className="text-sm text-destructive">
                              {rowError(errors, i, j, 'versionId')}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <div className="grid min-w-64 flex-1 gap-2 md:grid-cols-3">
                          <div className="md:col-span-3">
                            <Badge tone="neutral">Random pick</Badge>{' '}
                            <span className="text-sm text-muted-foreground">
                              Draws one published question that matches; never the same one twice in
                              a test.
                            </span>
                          </div>
                          <Field
                            id={`q-${i}-${j}-tags`}
                            label="Tags (all must match)"
                            hint="Comma separated, for example arrays, sorting."
                            error={rowError(errors, i, j, 'tagsText')}
                          >
                            {(aria) => (
                              <Input
                                {...aria}
                                disabled={readOnly}
                                value={q.tagsText}
                                onChange={(e) => patchQuestion(i, j, { tagsText: e.target.value })}
                              />
                            )}
                          </Field>
                          <Field id={`q-${i}-${j}-difficulty`} label="Difficulty">
                            {(aria) => (
                              <Select
                                {...aria}
                                disabled={readOnly}
                                className="w-full"
                                value={q.ruleDifficulty}
                                onChange={(e) =>
                                  patchQuestion(i, j, {
                                    ruleDifficulty: e.target.value as QuestionRow['ruleDifficulty'],
                                  })
                                }
                              >
                                <option value="">Any</option>
                                {Object.entries(DIFFICULTY_LABEL).map(([v, l]) => (
                                  <option key={v} value={v}>
                                    {l}
                                  </option>
                                ))}
                              </Select>
                            )}
                          </Field>
                          <Field id={`q-${i}-${j}-type`} label="Type">
                            {(aria) => (
                              <Select
                                {...aria}
                                disabled={readOnly}
                                className="w-full"
                                value={q.ruleType}
                                onChange={(e) =>
                                  patchQuestion(i, j, {
                                    ruleType: e.target.value as QuestionRow['ruleType'],
                                  })
                                }
                              >
                                <option value="">Any</option>
                                {Object.entries(TYPE_LABEL).map(([v, l]) => (
                                  <option key={v} value={v}>
                                    {l}
                                  </option>
                                ))}
                              </Select>
                            )}
                          </Field>
                          {pickable ? (
                            <p className="text-sm text-muted-foreground md:col-span-3">
                              {
                                rows.filter((r) => {
                                  const tags = parseTags(q.tagsText);
                                  return (
                                    (q.ruleType === '' || r.type === q.ruleType) &&
                                    (q.ruleDifficulty === '' ||
                                      r.difficulty === q.ruleDifficulty) &&
                                    tags.every((t) => r.tags.includes(t))
                                  );
                                }).length
                              }{' '}
                              published question(s) match now.
                            </p>
                          ) : null}
                        </div>
                      )}
                      <div className="w-28">
                        <Field
                          id={`q-${i}-${j}-points`}
                          label="Points"
                          error={rowError(errors, i, j, 'points')}
                        >
                          {(aria) => (
                            <Input
                              {...aria}
                              type="number"
                              min={0.01}
                              step="any"
                              disabled={readOnly}
                              value={Number.isNaN(q.points) ? '' : q.points}
                              onChange={(e) =>
                                patchQuestion(i, j, {
                                  points:
                                    e.target.value === '' ? Number.NaN : Number(e.target.value),
                                })
                              }
                            />
                          )}
                        </Field>
                      </div>
                      {readOnly ? null : (
                        <div className="mt-7 flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={j === 0}
                            onClick={() => moveQuestion(i, j, j - 1)}
                          >
                            <ArrowUp className="size-4" aria-hidden="true" />
                            <span className="sr-only">
                              Move question {j + 1} of section {i + 1} up
                            </span>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={j === s.questions.length - 1}
                            onClick={() => moveQuestion(i, j, j + 1)}
                          >
                            <ArrowDown className="size-4" aria-hidden="true" />
                            <span className="sr-only">
                              Move question {j + 1} of section {i + 1} down
                            </span>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              patchSection(i, { questions: s.questions.filter((_, k) => k !== j) })
                            }
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                            <span className="sr-only">
                              Remove question {j + 1} of section {i + 1}
                            </span>
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {errList(errors, i, 'questions') ? (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {errList(errors, i, 'questions')}
                </p>
              ) : null}
              {readOnly ? null : (
                <SectionAdders
                  index={i}
                  onFixed={() => setPicking(i)}
                  onRandom={(n) => addRandom(i, n)}
                />
              )}
            </li>
          ))}
        </ol>
        {readOnly || sections.length >= MAX_SECTIONS ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setSections([...sections, emptySection(`Section ${sections.length + 1}`)])
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add section
          </Button>
        )}
      </section>

      <QuestionPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        rows={rows}
        taken={taken}
        loading={questions.isPending}
        onPick={(row) => {
          if (picking !== null) addFixed(picking, row);
        }}
      />
      <p className="text-sm text-muted-foreground">
        Default points per question are {DEFAULT_POINTS}.
      </p>
    </form>
  );
}

function SectionAdders({
  index,
  onFixed,
  onRandom,
}: {
  index: number;
  onFixed: () => void;
  onRandom: (n: number) => void;
}): React.JSX.Element {
  const [n, setN] = React.useState(1);
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <Button type="button" variant="outline" size="sm" onClick={onFixed}>
        <Plus className="size-4" aria-hidden="true" />
        Add a question from the bank<span className="sr-only"> to section {index + 1}</span>
      </Button>
      <div className="flex items-end gap-2">
        <div className="text-sm">
          <label htmlFor={`random-count-${index}`} className="block">
            Random picks<span className="sr-only"> for section {index + 1}</span>
          </label>
          <Input
            id={`random-count-${index}`}
            type="number"
            min={1}
            max={MAX_QUESTIONS_PER_SECTION}
            className="w-20"
            value={n}
            onChange={(e) =>
              setN(Math.max(1, Math.min(MAX_QUESTIONS_PER_SECTION, Number(e.target.value) || 1)))
            }
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onRandom(n)}>
          <Plus className="size-4" aria-hidden="true" />
          Add random question{n === 1 ? '' : 's'}
          <span className="sr-only"> to section {index + 1}</span>
        </Button>
      </div>
    </div>
  );
}
