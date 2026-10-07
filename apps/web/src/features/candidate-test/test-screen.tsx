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
import type { Schemas } from '@/lib/api/client';
import { TestLoadError } from './adr-source';
import { demoSource } from './demo-source';
import type { DraftBody, DraftResult, TestSource } from './source';
import type { ProctorBridge } from './proctor/bridge';
import { cooldownRemainingMs, cooldownSeconds } from './cooldown';
import { LANGUAGE_LABELS } from './keywords';
import {
  initialLockState,
  isEditorReadOnly,
  lockReducer,
  type LockEvent,
  type LockState,
} from './lock-state';
import { Markdown } from './markdown';
import { OutputPanel } from './output-panel';
import {
  FinishSectionDialog,
  FullscreenLockOverlay,
  ProctorGate,
  ProctorPausedOverlay,
  ScreenShareLostOverlay,
  StartGate,
} from './overlays';
import { formatClock, timerWarning } from './timer';
import { useAutosave } from './use-autosave';
import { useServerClock } from './use-clock';

/**
 * Demo-only controls (simulate fullscreen exit, continue without fullscreen, demo banner). The
 * mock-mode check reads process.env.NEXT_PUBLIC_* inline so the bundler replaces it with a
 * constant and drops the dynamic import, and with it demo-controls.tsx, from a production build.
 * Do not move this check behind a helper or a variable.
 */
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

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

const codeKey = (questionId: string, language: CodeLanguage) => `${questionId}:${language}`;

/** A section the server has finished. Kept outside the per-section screen (ADR 0002). */
interface FinishedSection {
  sectionId: string;
  title: string;
  nextSectionId: string | null;
  /** The server submitted the whole test with this finish (it was the last section). */
  submitted: boolean;
  /** The close was accepted but the next section is not open yet: the candidate re-checks. */
  pending?: boolean;
  /** The session as re-read from the server, when the finish was confirmed that way. */
  next?: Schemas['CandidateSession'];
}

export function TestScreen({
  source = demoSource,
  proctor,
  registerClockSync,
  onSectionFinishedChange,
  onSubmitted,
}: {
  source?: TestSource;
  /** The proctoring wiring (real flow only). Without it the screen is the demo. */
  proctor?: ProctorBridge;
  /** Hands the clock's re-sync function to the owner, so a heartbeat can correct the countdown. */
  registerClockSync?: (sync: (serverNowIso: string, start: number, end: number) => void) => void;
  /** Tells the owner when the section on screen is finished (until the candidate moves on). */
  onSectionFinishedChange?: (finished: boolean) => void;
  /** Called once when the test is submitted (the last section was finished). */
  onSubmitted?: () => void;
} = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['candidate-session'],
    staleTime: Infinity,
    gcTime: source.isDemo ? 5 * 60_000 : 0,
    queryFn: () => source.loadSession(),
  });
  // The lock state (fullscreen, warnings) belongs to the whole test, not to one section.
  const [lock, dispatchLock] = React.useReducer(lockReducer, initialLockState);
  const [finishedSection, setFinishedSection] = React.useState<FinishedSection | null>(null);
  const [advancing, setAdvancing] = React.useState(false);
  const [advanceNote, setAdvanceNote] = React.useState<string | null>(null);

  const finishedNow =
    finishedSection !== null && finishedSection.sectionId === session.data?.section.id;
  React.useEffect(
    () => onSectionFinishedChange?.(finishedNow),
    [onSectionFinishedChange, finishedNow],
  );

  // Show the load error only when there is nothing to show: a failed background refetch must
  // never replace a running test (it would drop unsaved drafts and the lock state).
  if (session.isPending) {
    return <p className="p-8 text-center text-muted-foreground">Loading your test…</p>;
  }
  if (!session.data) {
    return (
      <div role="alert" className="mx-auto my-24 max-w-md text-center">
        <h1 className="text-lg font-semibold">We could not load your test</h1>
        {session.error instanceof TestLoadError && session.error.reason === 'unsupported' ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="load-unsupported">
            This test has a question type this page cannot show yet. Your time keeps running. Please
            tell the person running the test, and do not close this page.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Check your internet connection, then try again. Your time keeps running while this
            screen is not working; the server decides when time is up.
          </p>
        )}
        <Button className="mt-4" onClick={() => void session.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const current = session.data;
  if (finishedSection?.submitted) return <SubmittedPanel onShown={onSubmitted} />;
  const finishedHere = finishedSection?.sectionId === current.section.id ? finishedSection : null;

  const advance = async () => {
    if (!finishedSection) return;
    setAdvancing(true);
    setAdvanceNote(null);
    try {
      if (finishedSection.next) {
        queryClient.setQueryData(['candidate-session'], finishedSection.next);
      } else if (finishedSection.pending) {
        // The close was accepted; the next section opens when the server's job runs.
        const fresh = await source.readSession();
        if (fresh && 'submitted' in fresh) {
          setFinishedSection({ ...finishedSection, submitted: true, pending: false });
        } else if (fresh && fresh.section.id !== finishedSection.sectionId) {
          queryClient.setQueryData(['candidate-session'], fresh);
        } else {
          setAdvanceNote(
            'The next section is not open yet. Wait a moment and press the button again. Your time keeps running.',
          );
        }
      } else await session.refetch();
    } finally {
      setAdvancing(false);
    }
  };

  return (
    <>
      <TestScreenInner
        key={current.section.id}
        source={source}
        proctor={proctor}
        registerClockSync={registerClockSync}
        session={current}
        lock={lock}
        dispatchLock={dispatchLock}
        finished={finishedHere !== null}
        onFinished={setFinishedSection}
      />
      {finishedHere && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-16 z-40 mx-auto w-fit rounded-lg border bg-card p-4 shadow-lg"
        >
          <p className="font-medium">
            <CheckCircle2 className="mr-2 inline h-5 w-5 text-success" aria-hidden />
            The {finishedHere.title} section is finished and cannot be reopened.
          </p>
          {finishedHere.nextSectionId || finishedHere.next || finishedHere.pending ? (
            <>
              <Button className="mt-3" onClick={() => void advance()} disabled={advancing}>
                Continue to the next section
              </Button>
              {advanceNote ? <p className="mt-2 text-sm">{advanceNote}</p> : null}
            </>
          ) : (
            source.isDemo && (
              <p className="mt-1 text-sm text-muted-foreground">
                Demo: the next section is not part of this preview.
              </p>
            )
          )}
        </div>
      )}
    </>
  );
}

function TestScreenInner({
  source,
  proctor,
  registerClockSync,
  session,
  lock,
  dispatchLock,
  finished,
  onFinished,
}: {
  source: TestSource;
  proctor: ProctorBridge | undefined;
  registerClockSync:
    ((sync: (iso: string, start: number, end: number) => void) => void) | undefined;
  session: Schemas['CandidateSession'];
  lock: LockState;
  dispatchLock: React.Dispatch<LockEvent>;
  finished: boolean;
  onFinished: (info: FinishedSection) => void;
}): React.JSX.Element {
  const { questions, section } = session;
  const [activeId, setActiveId] = React.useState(questions[0]?.id ?? '');
  const [languages, setLanguages] = React.useState<Record<string, CodeLanguage>>({});
  const [drafts, setDrafts] = React.useState<Drafts>({ code: {}, mcq: {} });
  const [fsFailed, setFsFailed] = React.useState(false);
  const [finishOpen, setFinishOpen] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [finishError, setFinishError] = React.useState<string | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);

  const [running, setRunning] = React.useState(false);
  const [lastRunAt, setLastRunAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(0);
  // Run output is kept per question, so a slow run never shows under another question.
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, Schemas['RunResult']>>({});
  const [runErrors, setRunErrors] = React.useState<Record<string, string>>({});

  const clock = useServerClock(() => source.serverNow(), source.isDemo ? 'demo' : 'candidate');
  const syncClock = clock.syncFromServer;
  React.useEffect(() => registerClockSync?.(syncClock), [registerClockSync, syncClock]);

  // A proctor pause stops the clock (ADR 0002 P-2, P-3): show the time frozen at the pause. The
  // server adds the pause to the deadlines on resume and the heartbeat brings them here.
  const proctorPaused = proctor?.state.pauseReasons.includes('PROCTOR') ?? false;
  const rawTestLeft = clock.remaining(session.testDeadlineAt);
  const rawSectionLeft = clock.remaining(section.deadlineAt);
  const [frozen, setFrozen] = React.useState<{
    test: number | null;
    section: number | null;
  } | null>(null);
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrozen(proctorPaused ? { test: rawTestLeft, section: rawSectionLeft } : null);
    // Only when the pause starts or ends: the frozen values must not follow the ticking clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proctorPaused]);
  const testLeft = frozen ? frozen.test : rawTestLeft;
  const sectionLeft = frozen ? frozen.section : rawSectionLeft;
  const expired =
    (testLeft !== null && testLeft <= 0) || (sectionLeft !== null && sectionLeft <= 0);

  const question = questions.find((q) => q.id === activeId) ?? questions[0];
  const language: CodeLanguage =
    (question && languages[question.id]) ?? question?.languages?.[0] ?? 'python';
  // The editor is also off while the screen share is lost or a proctor paused the test (ADR 0002 P-2).
  const proctorLocked =
    proctor !== undefined &&
    lock.phase === 'running' &&
    (proctor.state.locks.screenShare || proctorPaused);
  const readOnly =
    isEditorReadOnly(lock, expired) || finished || clock.unavailable || proctorLocked;

  // Autosave every 10 s (FR-504). Compared by identity: any edit creates a new Drafts object.
  const lastSaved = React.useRef<Drafts>({ code: {}, mcq: {} });
  const [savedSnapshot, setSavedSnapshot] = React.useState<Drafts>({ code: {}, mcq: {} });
  const autosave = useAutosave(drafts, async (snapshot) => {
    const previous = lastSaved.current;
    const jobs: Promise<DraftResult>[] = [];
    const requestStart = performance.now();
    for (const [key, code] of Object.entries(snapshot.code)) {
      if (previous.code[key] === code) continue;
      const [questionId, lang] = key.split(':') as [string, CodeLanguage];
      jobs.push(source.saveDraft(questionId, { kind: 'code', language: lang, code }));
    }
    for (const [questionId, selectedOptionId] of Object.entries(snapshot.mcq)) {
      if (previous.mcq[questionId] === selectedOptionId) continue;
      jobs.push(
        source.saveDraft(questionId, { kind: 'mcq', selectedOptionId } satisfies DraftBody),
      );
    }
    const responses = await Promise.all(jobs);
    const responseEnd = performance.now();
    // A failed or paused save keeps the draft: nothing is marked saved, and the next tick retries
    // (DL-17: a 409 SESSION_PAUSED never drops code).
    if (responses.some((r) => !r.ok)) throw new Error('save');
    // The save response carries the server time: re-sync the countdown offset (FR-505, TC-047).
    const serverTimes = responses.flatMap((r) => (r.ok ? [r.savedAt] : []));
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
  }, [dispatchLock]);

  const requestFullscreen = async (): Promise<boolean> => {
    try {
      await document.documentElement.requestFullscreen();
      return true;
    } catch {
      return false;
    }
  };

  // Proctoring gate state (real flow): two clicks, share the screen, then enter fullscreen.
  const [gateFailure, setGateFailure] = React.useState<string | null>(null);
  const [gateBusy, setGateBusy] = React.useState(false);
  const shareFailureText = (reason: string): string =>
    reason === 'WRONG_SURFACE'
      ? 'You shared a window or a tab. Press the button again and choose "Entire Screen".'
      : reason === 'UNSUPPORTED'
        ? 'This browser cannot share the screen. Open the link in the latest Chrome or Edge.'
        : 'Screen sharing was cancelled or blocked. Press the button again, choose "Entire Screen" and press Share.';
  const shareScreen = async (): Promise<void> => {
    if (!proctor || gateBusy) return;
    setGateBusy(true);
    setGateFailure(null);
    const result = await proctor.shareScreen();
    if (!result.ok) setGateFailure(shareFailureText(result.reason));
    setGateBusy(false);
  };
  const enterFromGate = async (): Promise<void> => {
    if (!proctor || gateBusy) return;
    setGateBusy(true);
    setGateFailure(null);
    const ok = await proctor.enterFullscreen();
    if (ok) {
      await proctor.startRecorders();
      dispatchLock({ type: 'start', fullscreen: true });
    } else {
      setGateFailure(
        'Your browser did not allow fullscreen. Press the button again, or check that fullscreen is not blocked for this site.',
      );
    }
    setGateBusy(false);
  };

  // A blocked paste, drop or shortcut was logged by the proctoring monitors: tell the candidate.
  const notice = proctor?.state.notice ?? null;
  const clearNotice = proctor?.clearNotice;
  React.useEffect(() => {
    if (!notice) return;
    toast.message(
      notice.kind === 'paste' || notice.kind === 'copy'
        ? 'Copy and paste are turned off during this test. Please type your answer.'
        : notice.kind === 'drop'
          ? 'Dropping text is turned off during this test. Please type your answer.'
          : 'That key combination is turned off during this test.',
      { id: 'blocked' },
    );
    clearNotice?.();
  }, [notice, clearNotice]);

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
      const outcome = await source.run(questionId, language, value);
      if (outcome.kind === 'result') setResults((r) => ({ ...r, [questionId]: outcome.result }));
      else if (outcome.kind === 'rate-limited')
        fail('You can run once every 5 seconds. Wait a moment and press Run again.');
      else if (outcome.kind === 'paused')
        fail('The test is paused, so Run is off. Your code is kept. Run again when it resumes.');
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
    const markFinished = (
      nextSectionId: string | null,
      next?: Schemas['CandidateSession'],
      submitted = false,
      pending = false,
    ) => {
      onFinished({
        sectionId: section.id,
        title: section.title,
        nextSectionId,
        next,
        submitted,
        pending,
      });
      setFinishOpen(false);
    };
    // After a failure, or a 409 (which can also mean a paused or inactive session), we cannot tell
    // whether the server finished the section. Re-read the session with a plain request that does
    // not touch the query cache: if it now reports another section, the finish went through
    // (ADR 0002: finishing is final). The cache is only updated when the candidate continues.
    const confirmOrExplain = async (fallback: string) => {
      try {
        const fresh = await source.readSession();
        if (!fresh) throw new Error('session');
        if ('submitted' in fresh) {
          // The server submitted the test (the last section, or time ran out): say so.
          markFinished(null, undefined, true);
          return;
        }
        if (fresh.section.id !== section.id) {
          markFinished(fresh.section.id, fresh);
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
      const outcome = await source.finishSection(section.id);
      // ADR 0002: finishing is final. Only a confirmed finish marks it finished. A 409 is not
      // trusted by itself (the contract does not say which conflict it is); it goes through the
      // verified re-read below.
      if (outcome.kind === 'finished') {
        if (outcome.acceptedOnly) {
          // Accepted (202): finished for good. The server does not say what is next, so look: the
          // next open section, the end of the test, or "not open yet" (the candidate re-checks).
          const fresh = await source.readSession();
          if (fresh && 'submitted' in fresh) markFinished(null, undefined, true);
          else if (fresh && fresh.section.id !== section.id) markFinished(fresh.section.id, fresh);
          else markFinished(null, undefined, false, true);
          return;
        }
        markFinished(outcome.nextSectionId, undefined, outcome.submitted);
        return;
      }
      if (outcome.kind === 'conflict') {
        await confirmOrExplain(
          'The server could not finish the section right now (your session may be paused). Nothing changed and you can keep working. Try again in a moment, or tell the person running the test.',
        );
        return;
      }
      if (outcome.kind === 'unreachable') {
        await confirmOrExplain(
          'We could not reach the server, so the section is not finished. Check your connection and try again.',
        );
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
      {source.isDemo && DemoBanner && (
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

      {proctor && !proctor.state.online && (
        <p
          role="status"
          className="bg-warning-soft px-4 py-2 text-sm text-warning"
          data-testid="offline-banner"
        >
          We cannot reach the server right now. Keep this page open: your answers and recordings are
          kept and sent again when the connection is back. The server decides when time is up.
        </p>
      )}

      {proctor && proctor.state.unavailable.length > 0 && (
        <p
          role="status"
          className="bg-warning-soft px-4 py-2 text-sm text-warning"
          data-testid="devices-banner"
        >
          Some of your recording could not start ({proctor.state.unavailable.join(', ')}). The test
          goes on, and a reviewer will see this. If it is a camera or microphone, check its
          permission in your browser.
        </p>
      )}

      {expired && (
        <p role="alert" className="bg-destructive-soft px-4 py-2 text-sm text-destructive">
          Time is up. {source.isDemo ? 'In the real test your' : 'Your'} latest saved work is
          submitted automatically.
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
          disabled={finished || proctorPaused}
        >
          Finish section
        </Button>
        <span className="text-xs text-muted-foreground">Finishing a section is final.</span>
        {source.isDemo && DemoFooterControl && (
          <React.Suspense fallback={null}>
            <DemoFooterControl dispatchLock={dispatchLock} />
          </React.Suspense>
        )}
      </footer>

      {lock.phase === 'gate' && proctor && (
        <ProctorGate
          ready={proctor.state.phase === 'running'}
          shared={proctor.state.shared}
          failure={gateFailure}
          busy={gateBusy}
          onShare={() => void shareScreen()}
          onEnter={() => void enterFromGate()}
        />
      )}
      {lock.phase === 'gate' && !proctor && (
        <StartGate
          fullscreenFailed={fsFailed}
          timerRunning={!source.isDemo}
          onEnter={() =>
            void requestFullscreen().then((ok) => {
              if (ok) dispatchLock({ type: 'start', fullscreen: true });
              else setFsFailed(true);
            })
          }
          demoAction={
            source.isDemo &&
            DemoContinueWithoutFullscreen && (
              <React.Suspense fallback={null}>
                <DemoContinueWithoutFullscreen dispatchLock={dispatchLock} />
              </React.Suspense>
            )
          }
        />
      )}
      {lock.phase === 'running' && proctor && proctorPaused && <ProctorPausedOverlay />}
      {lock.phase === 'running' && proctor && !proctorPaused && proctor.state.locks.screenShare && (
        <ScreenShareLostOverlay failed={gateFailure} onShare={() => void shareScreen()} />
      )}
      {lock.phase === 'running' &&
        lock.locked &&
        !(proctor && (proctorPaused || proctor.state.locks.screenShare)) && (
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
        last={section.position === section.totalSections}
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

/**
 * The last section was finished, so the server submitted the test (ADR 0013 section 5.11). The
 * candidate sees that and nothing else: no score and no hidden results (Q17: no FR shows scores).
 */
function SubmittedPanel({ onShown }: { onShown?: (() => void) | undefined }): React.JSX.Element {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    headingRef.current?.focus();
    // Leave fullscreen: the test is over.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onShown?.();
    // Once, when the panel appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="mx-auto my-24 max-w-md px-4 text-center" data-testid="test-submitted">
      <CheckCircle2 className="mx-auto h-10 w-10 text-success" aria-hidden />
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-3 text-2xl font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Your test is submitted
      </h1>
      <p className="mt-3">
        Thank you. Your answers were received and the recording has stopped. You can close this
        window now.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        A person reviews every assessment. The hiring team will contact you about next steps.
      </p>
    </div>
  );
}
