'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { CheckCircle2, Clock, Loader2, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import * as React from 'react';
import type { CodeLanguage } from '@codeproctor/shared';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, type Schemas } from '@/lib/api/client';
import { cooldownRemainingMs, cooldownSeconds } from './cooldown';
import { LANGUAGE_LABELS } from './keywords';
import { initialLockState, isEditorReadOnly, lockReducer } from './lock-state';
import { Markdown } from './markdown';
import { OutputPanel } from './output-panel';
import { FinishSectionDialog, FullscreenLockOverlay, StartGate } from './overlays';
import { formatClock, timerWarning } from './timer';
import { useAutosave } from './use-autosave';
import { useServerClock } from './use-clock';

/**
 * Demo-only controls (simulate fullscreen exit, continue without fullscreen, demo banner). The
 * mock-mode check reads process.env.NEXT_PUBLIC_* inline so the bundler replaces it with a
 * constant and drops the dynamic import, and with it demo-controls.tsx, from a production build.
 * Do not move this check behind a helper or a variable.
 */
const IS_DEMO = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';
const DemoBanner =
  process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
    ? React.lazy(() => import('./demo-controls').then((m) => ({ default: m.DemoBanner })))
    : null;
const DemoFooterControl =
  process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
    ? React.lazy(() => import('./demo-controls').then((m) => ({ default: m.DemoFooterControl })))
    : null;
const DemoContinueWithoutFullscreen =
  process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'
    ? React.lazy(() =>
        import('./demo-controls').then((m) => ({ default: m.DemoContinueWithoutFullscreen })),
      )
    : null;

const CodeEditor = dynamic(() => import('./code-editor'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-neutral-200">Loading the editor…</p>,
});

interface Drafts {
  code: Record<string, string>;
  mcq: Record<string, string>;
}

interface DraftResponse {
  response: Response;
  data?: { savedAt: string };
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

const codeKey = (questionId: string, language: CodeLanguage) => `${questionId}:${language}`;

export function TestScreen(): React.JSX.Element {
  const session = useQuery({
    queryKey: ['candidate-session'],
    staleTime: Infinity,
    queryFn: async () => {
      const { data } = await api.GET('/v1/candidate/session');
      if (!data) throw new Error('session');
      return data;
    },
  });

  if (session.isPending) {
    return <p className="p-8 text-center text-muted-foreground">Loading your test…</p>;
  }
  if (session.isError) {
    return (
      <div role="alert" className="mx-auto my-24 max-w-md text-center">
        <h1 className="text-lg font-semibold">We could not load your test</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Check your internet connection, then try again. Your time is not affected by this screen.
        </p>
        <Button className="mt-4" onClick={() => void session.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return <TestScreenInner session={session.data} />;
}

function TestScreenInner({ session }: { session: Schemas['CandidateSession'] }): React.JSX.Element {
  const { questions, section } = session;
  const [activeId, setActiveId] = React.useState(questions[0]?.id ?? '');
  const [languages, setLanguages] = React.useState<Record<string, CodeLanguage>>({});
  const [drafts, setDrafts] = React.useState<Drafts>({ code: {}, mcq: {} });
  const [lock, dispatchLock] = React.useReducer(lockReducer, initialLockState);
  const [fsFailed, setFsFailed] = React.useState(false);
  const [finishOpen, setFinishOpen] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [finishError, setFinishError] = React.useState<string | null>(null);
  const [finished, setFinished] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);

  const [running, setRunning] = React.useState(false);
  const [lastRunAt, setLastRunAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(0);
  // Run output is kept per question, so a slow run never shows under another question.
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, Schemas['RunResult']>>({});
  const [runErrors, setRunErrors] = React.useState<Record<string, string>>({});

  const queryClient = useQueryClient();
  const clock = useServerClock();
  const testLeft = clock.remaining(session.testDeadlineAt);
  const sectionLeft = clock.remaining(section.deadlineAt);
  const expired =
    (testLeft !== null && testLeft <= 0) || (sectionLeft !== null && sectionLeft <= 0);

  const question = questions.find((q) => q.id === activeId) ?? questions[0];
  const language: CodeLanguage =
    (question && languages[question.id]) ?? question?.languages?.[0] ?? 'python';
  const readOnly = isEditorReadOnly(lock, expired) || finished || clock.unavailable;

  // Autosave every 10 s (FR-504). Compared by identity: any edit creates a new Drafts object.
  const lastSaved = React.useRef<Drafts>({ code: {}, mcq: {} });
  const [savedSnapshot, setSavedSnapshot] = React.useState<Drafts>({ code: {}, mcq: {} });
  const autosave = useAutosave(drafts, async (snapshot) => {
    const previous = lastSaved.current;
    const jobs: Promise<DraftResponse>[] = [];
    const requestStart = performance.now();
    for (const [key, code] of Object.entries(snapshot.code)) {
      if (previous.code[key] === code) continue;
      const [questionId, lang] = key.split(':') as [string, CodeLanguage];
      jobs.push(
        api.PUT('/v1/candidate/questions/{questionId}/draft', {
          params: { path: { questionId } },
          body: { kind: 'code', language: lang, code },
        }),
      );
    }
    for (const [questionId, selectedOptionId] of Object.entries(snapshot.mcq)) {
      if (previous.mcq[questionId] === selectedOptionId) continue;
      jobs.push(
        api.PUT('/v1/candidate/questions/{questionId}/draft', {
          params: { path: { questionId } },
          body: { kind: 'mcq', selectedOptionId },
        }),
      );
    }
    const responses = await Promise.all(jobs);
    const responseEnd = performance.now();
    if (responses.some((r) => !r.response.ok || r.data === undefined)) throw new Error('save');
    // The save response carries the server time: re-sync the countdown offset (FR-505, TC-047).
    const serverTimes = responses.flatMap((r) => (r.data ? [r.data.savedAt] : []));
    const latestServerTime = serverTimes[serverTimes.length - 1];
    if (latestServerTime) clock.syncFromServer(latestServerTime, requestStart, responseEnd);
    lastSaved.current = snapshot;
    setSavedSnapshot(snapshot);
  });

  // Cooldown tick: only while a cooldown is active.
  const cooldownMs = cooldownRemainingMs(lastRunAt, now);
  const cooling = cooldownMs > 0;
  React.useEffect(() => {
    if (!cooling) return;
    const id = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(id);
  }, [cooling]);

  // Fullscreen events.
  React.useEffect(() => {
    const onChange = () =>
      dispatchLock(
        document.fullscreenElement
          ? { type: 'fullscreen-restored' }
          : { type: 'fullscreen-exited' },
      );
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const requestFullscreen = async (): Promise<boolean> => {
    try {
      await document.documentElement.requestFullscreen();
      return true;
    } catch {
      return false;
    }
  };

  if (!question) return <p className="p-8">This section has no questions.</p>;

  const starter = question.starterCode?.[language] ?? '';
  const value = drafts.code[codeKey(question.id, language)] ?? starter;
  const isAnswered = (q: Schemas['Question']): boolean => {
    if (q.type === 'mcq') return drafts.mcq[q.id] !== undefined;
    return Object.keys(drafts.code).some((k) => k.startsWith(`${q.id}:`));
  };

  const isSaved = (q: Schemas['Question']): boolean => {
    if (q.type === 'mcq') return savedSnapshot.mcq[q.id] === drafts.mcq[q.id];
    return Object.entries(drafts.code)
      .filter(([k]) => k.startsWith(`${q.id}:`))
      .every(([k, code]) => savedSnapshot.code[k] === code);
  };

  const run = async () => {
    const questionId = question.id;
    const started = performance.now(); // monotonic: the OS clock cannot shorten the cooldown
    setLastRunAt(started);
    setNow(started);
    setRunning(true);
    setRunningId(questionId);
    setResults((r) => omit(r, questionId));
    setRunErrors((e) => omit(e, questionId));
    const fail = (message: string) => setRunErrors((e) => ({ ...e, [questionId]: message }));
    try {
      await autosave.flush(); // FR-504: autosave on every run; a failed save does not block Run
      const { data, response } = await api.POST('/v1/candidate/questions/{questionId}/run', {
        params: { path: { questionId } },
        body: { language, code: value },
      });
      if (response.ok && data) setResults((r) => ({ ...r, [questionId]: data }));
      else if (response.status === 429)
        fail('You can run once every 5 seconds. Wait a moment and press Run again.');
      else fail('The run could not finish. Check your connection and press Run again.');
    } catch {
      fail('The run could not finish. Check your connection and press Run again.');
    } finally {
      setRunning(false);
      setRunningId(null);
    }
  };

  const finishSection = async () => {
    setFinishing(true);
    setFinishError(null);
    const markFinished = () => {
      setFinished(true);
      setFinishOpen(false);
    };
    // After a failure we cannot tell whether the server finished the section. Re-read the session:
    // if it now reports another section, the finish went through (ADR 0002: finishing is final).
    const confirmOrExplain = async (fallback: string) => {
      try {
        const fresh = await queryClient.fetchQuery({
          queryKey: ['candidate-session'],
          staleTime: 0,
          queryFn: async () => {
            const { data } = await api.GET('/v1/candidate/session');
            if (!data) throw new Error('session');
            return data;
          },
        });
        if (fresh.section.id !== section.id) {
          markFinished();
          return;
        }
        setFinishError(fallback);
      } catch {
        setFinishError(
          'We could not confirm whether the section was finished. Check your connection and try again; if it was already finished, the screen will say so.',
        );
      }
    };
    try {
      const saved = await autosave.flush();
      if (!saved) {
        setFinishError(
          'We could not save your latest answers, so the section is not finished. Check your connection and try again.',
        );
        return;
      }
      const { data, response } = await api.POST('/v1/candidate/sections/{sectionId}/finish', {
        params: { path: { sectionId: section.id } },
      });
      // ADR 0002: finishing is final. 409 means it was already finished; only that or an OK
      // response with a body marks the section finished.
      if (response.status === 409 || (response.ok && data)) {
        markFinished();
        return;
      }
      await confirmOrExplain(
        'We could not finish the section, so nothing changed and you can keep working. Check your connection and try again.',
      );
    } catch {
      await confirmOrExplain(
        'We could not reach the server, so the section is not finished. Check your connection and try again.',
      );
    } finally {
      setFinishing(false);
    }
  };

  const testWarning = testLeft === null ? 'none' : timerWarning(testLeft);
  const sectionWarning = sectionLeft === null ? 'none' : timerWarning(sectionLeft);
  const announcement = [
    sectionWarning === 'five-minutes' && 'Five minutes left in this section.',
    sectionWarning === 'one-minute' && 'One minute left in this section.',
    testWarning === 'five-minutes' && 'Five minutes left in the test.',
    testWarning === 'one-minute' && 'One minute left in the test.',
    // Expiry is announced once, by the role="alert" banner below.
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex h-dvh flex-col">
      {DemoBanner && (
        <React.Suspense fallback={null}>
          <DemoBanner />
        </React.Suspense>
      )}

      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b bg-card px-4 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{session.testTitle}</h1>
          <p className="text-xs text-muted-foreground">
            Section {section.position} of {section.totalSections}: {section.title}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-4">
          <Countdown label="Section time left" ms={sectionLeft} />
          <Countdown label="Test time left" ms={testLeft} />
          <SavedIndicator status={autosave.status} savedAt={autosave.savedAt} />
          {lock.warnings > 0 && (
            <span
              className="rounded-full bg-warning-soft px-3 py-1 text-xs font-medium text-warning"
              data-testid="warning-pill"
            >
              Warnings: {lock.warnings} — this was recorded
            </span>
          )}
          <ThemeToggle />
        </div>
      </header>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      {clock.unavailable && (
        <div role="alert" className="bg-destructive-soft px-4 py-2 text-sm text-destructive">
          We cannot check the time with the server, so the editor is paused. Check your internet
          connection, then{' '}
          <button type="button" className="underline" onClick={clock.retry}>
            try again
          </button>
          . Your time is not affected.
        </div>
      )}

      {expired && (
        <p role="alert" className="bg-destructive-soft px-4 py-2 text-sm text-destructive">
          Time is up. {IS_DEMO ? 'In the real test your' : 'Your'} latest saved work is submitted
          automatically.
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <aside
          className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r"
          aria-label="Question"
        >
          <nav aria-label="Questions in this section" className="flex flex-wrap gap-2 border-b p-3">
            {questions.map((q, i) => (
              <button
                key={q.id}
                type="button"
                aria-current={q.id === question.id ? 'true' : undefined}
                onClick={() => setActiveId(q.id)}
                className="rounded-md border px-3 py-1.5 text-sm aria-[current=true]:border-primary aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
              >
                Question {i + 1}
                <span className="ml-1 text-xs text-muted-foreground">
                  {!isAnswered(q) ? '(not started)' : isSaved(q) ? '(saved)' : '(not saved yet)'}
                </span>
              </button>
            ))}
          </nav>
          <div
            role="region"
            aria-label="Question statement"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users must be able to scroll this region (axe: scrollable-region-focusable)
            tabIndex={0}
            className="min-h-0 flex-1 overflow-auto p-4"
          >
            <p className="mb-2 text-xs text-muted-foreground">
              {question.title} · {question.points} points
            </p>
            <Markdown>{question.statementMarkdown}</Markdown>
            {question.type === 'coding' && question.sampleTests && (
              <section className="mt-6" aria-label="Sample tests">
                <h2 className="text-base font-semibold">Sample tests</h2>
                <p className="text-sm text-muted-foreground">
                  Run checks your code against these. Hidden tests run when you submit.
                </p>
                <ul className="mt-2 space-y-1 text-sm">
                  {question.sampleTests.map((t) => (
                    <li key={t.id}>{t.name}</li>
                  ))}
                </ul>
              </section>
            )}
            {question.type === 'mcq' && question.options && (
              <fieldset className="mt-4 space-y-2" disabled={readOnly}>
                <legend className="sr-only">Answer options</legend>
                {question.options.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent"
                  >
                    <input
                      type="radio"
                      name={`mcq-${question.id}`}
                      className="h-4 w-4"
                      checked={drafts.mcq[question.id] === o.id}
                      onChange={() =>
                        setDrafts((d) => ({ ...d, mcq: { ...d.mcq, [question.id]: o.id } }))
                      }
                    />
                    {o.label}
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        </aside>

        <section className="flex min-h-[420px] min-w-0 flex-col" aria-label="Your answer">
          {question.type === 'coding' ? (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
                <label className="flex items-center gap-2 text-sm">
                  Language
                  <select
                    className="h-9 rounded-md border bg-card px-2 text-sm"
                    value={language}
                    disabled={readOnly}
                    onChange={(e) =>
                      setLanguages((l) => ({ ...l, [question.id]: e.target.value as CodeLanguage }))
                    }
                  >
                    {(question.languages ?? []).map((l) => (
                      <option key={l} value={l}>
                        {LANGUAGE_LABELS[l]}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => setResetOpen(true)}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden /> Reset to starter code
                </Button>
                <p className="text-xs text-muted-foreground">
                  Tab inserts an indent. To move focus out of the editor, press Ctrl+M, then Tab.
                </p>
                <Button
                  className="ml-auto"
                  onClick={() => void run()}
                  aria-disabled={running || cooling || readOnly}
                  onClickCapture={(e) => {
                    if (running || cooling || readOnly) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                >
                  {running ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Play className="h-4 w-4" aria-hidden />
                  )}
                  {running
                    ? 'Running…'
                    : cooling
                      ? `Run again in ${cooldownSeconds(cooldownMs)}s`
                      : 'Run sample tests'}
                </Button>
              </div>
              <div
                className="min-h-0 flex-[3] bg-[#1e1e1e]"
                data-testid="editor-region"
                data-readonly={readOnly}
              >
                <CodeEditor
                  questionId={question.id}
                  language={language}
                  value={value}
                  readOnly={readOnly}
                  ariaLabel={`Code editor, ${LANGUAGE_LABELS[language]}`}
                  onChange={(next) =>
                    setDrafts((d) => ({
                      ...d,
                      code: { ...d.code, [codeKey(question.id, language)]: next },
                    }))
                  }
                  onBlocked={(kind) =>
                    toast.message(
                      kind === 'paste'
                        ? 'Pasting is turned off during this test. Please type your answer.'
                        : 'Dropping text is turned off during this test. Please type your answer.',
                      { id: 'blocked' },
                    )
                  }
                />
              </div>
              <div className="min-h-0 flex-[2] border-t">
                <OutputPanel
                  running={runningId === question.id}
                  result={results[question.id] ?? null}
                  errorMessage={runErrors[question.id] ?? null}
                />
              </div>
            </>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              Pick one answer on the left. It is saved automatically, and you can change it until
              you finish the section.
            </p>
          )}
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t bg-card px-4 py-2">
        <Button
          variant="outline"
          onClick={() => {
            setFinishError(null);
            setFinishOpen(true);
          }}
          disabled={finished}
        >
          Finish section
        </Button>
        <span className="text-xs text-muted-foreground">Finishing a section is final.</span>
        {DemoFooterControl && (
          <React.Suspense fallback={null}>
            <DemoFooterControl dispatchLock={dispatchLock} />
          </React.Suspense>
        )}
      </footer>

      {lock.phase === 'gate' && (
        <StartGate
          fullscreenFailed={fsFailed}
          onEnter={() =>
            void requestFullscreen().then((ok) => {
              if (ok) dispatchLock({ type: 'start', fullscreen: true });
              else setFsFailed(true);
            })
          }
          demoAction={
            DemoContinueWithoutFullscreen && (
              <React.Suspense fallback={null}>
                <DemoContinueWithoutFullscreen dispatchLock={dispatchLock} />
              </React.Suspense>
            )
          }
        />
      )}
      {lock.phase === 'running' && lock.locked && (
        <FullscreenLockOverlay
          warnings={lock.warnings}
          onReenter={() =>
            void requestFullscreen().then((ok) => {
              if (ok || lock.simulated) dispatchLock({ type: 'fullscreen-restored' });
              else
                toast.error(
                  'Fullscreen did not start. Click the button again, or allow fullscreen for this site.',
                );
            })
          }
        />
      )}

      <FinishSectionDialog
        open={finishOpen}
        onOpenChange={setFinishOpen}
        onConfirm={() => void finishSection()}
        busy={finishing}
        error={finishError}
        sectionTitle={section.title}
      />

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogTitle>Reset to starter code?</DialogTitle>
          <DialogDescription>
            Your {LANGUAGE_LABELS[language]} code for this question is replaced with the starter
            code. This cannot be undone.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Keep my code
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDrafts((d) => ({
                  ...d,
                  code: { ...d.code, [codeKey(question.id, language)]: starter },
                }));
                setResetOpen(false);
              }}
            >
              Reset
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {finished && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-16 z-40 mx-auto w-fit rounded-lg border bg-card p-4 shadow-lg"
        >
          <p className="font-medium">
            <CheckCircle2 className="mr-2 inline h-5 w-5 text-success" aria-hidden />
            The {section.title} section is finished and cannot be reopened.
          </p>
          {IS_DEMO && (
            <p className="mt-1 text-sm text-muted-foreground">
              Demo: the next section is not part of this preview.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Countdown({ label, ms }: { label: string; ms: number | null }): React.JSX.Element {
  const urgent = ms !== null && ms <= 300_000;
  return (
    <div className="flex items-center gap-2" role="timer" aria-label={label}>
      <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
      <div>
        <div className="text-[11px] leading-none text-muted-foreground">{label}</div>
        <div
          className={`font-mono text-lg font-semibold tabular-nums ${urgent ? 'text-warning' : ''}`}
        >
          {ms === null ? '--:--' : formatClock(ms)}
        </div>
      </div>
    </div>
  );
}

function SavedIndicator({
  status,
  savedAt,
}: {
  status: 'saved' | 'unsaved' | 'saving' | 'error';
  savedAt: Date | null;
}): React.JSX.Element {
  const text = {
    saved: savedAt ? `Saved at ${savedAt.toLocaleTimeString()}` : 'All changes saved',
    unsaved: 'Changes not saved yet (saves every 10 seconds)',
    saving: 'Saving…',
    error: 'Could not save. Check your connection; we will retry in 10 seconds.',
  }[status];
  return (
    // No live region for routine states (they change every 10 s); only a failed save is announced.
    <p
      role={status === 'error' ? 'alert' : undefined}
      className="flex items-center gap-1.5 text-sm"
      data-testid="saved-indicator"
    >
      {status === 'error' ? (
        <TriangleAlert className="h-4 w-4 text-destructive" aria-hidden />
      ) : status === 'saving' ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <CheckCircle2
          className={`h-4 w-4 ${status === 'saved' ? 'text-success' : 'text-muted-foreground'}`}
          aria-hidden
        />
      )}
      {text}
    </p>
  );
}
