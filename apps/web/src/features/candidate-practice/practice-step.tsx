'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import * as React from 'react';
import type { CodeLanguage } from '@codeproctor/shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { candidateApi } from '@/features/candidate-flow/api';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import {
  cooldownRemainingMs,
  cooldownSeconds,
  RUN_COOLDOWN_MS,
} from '@/features/candidate-test/cooldown';
import { LANGUAGE_LABELS } from '@/features/candidate-test/keywords';
import { Markdown } from '@/features/candidate-test/markdown';
import { OutputPanel } from '@/features/candidate-test/output-panel';

// Same editor as the test (no AI completions, paste and drop blocked). Monaco needs a browser.
const CodeEditor = dynamic(() => import('@/features/candidate-test/code-editor'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-neutral-200">Loading the editor...</p>,
});

/**
 * FR-406 practice question. Untimed, not scored, and nothing the candidate types or runs is saved
 * as an answer: there is no autosave, no keystroke capture and no draft route here (PROVISIONAL
 * routes GET /candidate/session/practice and POST /candidate/session/practice/run; the server must
 * not store them either). The step can be skipped.
 */
export function PracticeStep({
  onDone,
  onSessionEnded,
}: {
  onDone: () => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const question = useQuery({
    queryKey: ['candidate', 'practice'],
    queryFn: () => candidateApi.getPractice(),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const loaded = question.data?.ok ? question.data.data : null;

  React.useEffect(() => {
    const r = question.data;
    if (r && !r.ok && r.kind === 'problem' && r.status === 401) onSessionEnded();
  }, [question.data, onSessionEnded]);

  const [language, setLanguage] = React.useState<CodeLanguage | null>(null);
  const [codes, setCodes] = React.useState<Record<string, string>>({});
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [lastRun, setLastRun] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (lastRun === null) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [lastRun]);

  const run = useMutation({
    mutationFn: (v: { language: string; code: string }) => candidateApi.runPractice(v),
  });

  React.useEffect(() => {
    const r = run.data;
    if (r && !r.ok && r.kind === 'problem' && r.status === 401) onSessionEnded();
  }, [run.data, onSessionEnded]);

  if (question.isPending) {
    return (
      <StepFrame title="Practice question">
        <p role="status">Loading the practice question...</p>
      </StepFrame>
    );
  }
  if (!loaded) {
    return (
      <StepFrame title="The practice question is not available">
        <Alert tone="info">
          You can skip the practice and start the test, or press &quot;Try again&quot;. The practice
          is optional.
        </Alert>
        <div className="flex flex-wrap gap-3">
          <Button
            size="lg"
            className="min-h-11"
            variant="outline"
            onClick={() => void question.refetch()}
          >
            Try again
          </Button>
          <Button size="lg" className="min-h-11" onClick={onDone}>
            Skip the practice
          </Button>
        </div>
      </StepFrame>
    );
  }

  const active: CodeLanguage = language ?? loaded.languages[0] ?? 'python';
  const code = codes[active] ?? loaded.starterCode[active] ?? '';
  const wait = cooldownRemainingMs(lastRun, now, RUN_COOLDOWN_MS);
  const result = run.data?.ok ? run.data.data : null;
  let runError: string | null = null;
  if (run.isError || (run.data && !run.data.ok && run.data.kind !== 'problem')) {
    runError = 'We could not run your code. Check your internet connection and press Run again.';
  } else if (run.data && !run.data.ok) {
    if (run.data.status === 401) {
      runError = null;
    } else if (run.data.status === 429) {
      runError = `Please wait ${run.data.retryAfterSeconds ?? 5} seconds before running again.`;
    } else {
      runError = 'The service had a problem running your code. Wait a moment and press Run again.';
    }
  }
  return (
    <StepFrame
      title="Try the editor first"
      intro="This practice question is not timed, not scored and nothing here is saved or sent to reviewers as an answer. Use it to get used to the editor and the Run button."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Practice question" className="space-y-2">
          <h2 className="text-lg font-semibold">{loaded.title}</h2>
          <Markdown>{loaded.statementMarkdown}</Markdown>
        </section>
        <section aria-label="Practice editor" className="space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor="practice-language" className="text-sm font-medium">
              Language
            </label>
            <select
              id="practice-language"
              className="h-11 rounded-md border border-input bg-card px-2 text-sm"
              value={active}
              onChange={(e) => setLanguage(e.target.value as CodeLanguage)}
            >
              {loaded.languages.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          <div className="h-72 overflow-hidden rounded-md border">
            <CodeEditor
              questionId="practice"
              language={active}
              value={code}
              readOnly={false}
              onChange={(v) => setCodes((c) => ({ ...c, [active]: v }))}
              onBlocked={(kind) =>
                setBlocked(
                  kind === 'paste'
                    ? 'Pasting is switched off, in the practice and in the test. Type your code instead.'
                    : 'Dropping text into the editor is switched off. Type your code instead.',
                )
              }
              ariaLabel="Practice code editor"
            />
          </div>
          {blocked ? (
            <p role="status" className="text-sm" data-testid="practice-blocked">
              {blocked}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              className="min-h-11"
              disabled={run.isPending || wait > 0}
              onClick={() => {
                setLastRun(Date.now());
                setNow(Date.now());
                run.mutate({ language: active, code });
              }}
            >
              {run.isPending
                ? 'Running...'
                : wait > 0
                  ? `Run again in ${cooldownSeconds(wait)} s`
                  : 'Run'}
            </Button>
          </div>
          <div className="h-56 rounded-md border">
            <OutputPanel running={run.isPending} result={result} errorMessage={runError} />
          </div>
        </section>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button size="lg" className="min-h-11" onClick={onDone}>
          I am ready: continue
        </Button>
      </div>
    </StepFrame>
  );
}
