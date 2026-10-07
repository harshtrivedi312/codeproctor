'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { ApiFailure } from '@/features/admin/queries';
import {
  answerBody,
  canScoreManually,
  formatDateTime,
  formatScore,
  scoringState,
  TYPE_LABEL,
  type ReviewAnswer,
} from './model';
import { useScoreAnswer } from './queries';

const SCORING_TEXT = {
  auto: 'Scored automatically',
  pending: 'Waiting for a reviewer',
  manual: 'Scored by a reviewer',
} as const;

/** The 409 codes of the scoring route (docs/api-contract.md section 7), each with a next step. */
export function scoringErrorMessage(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.code === 'ANSWER_NOT_MANUAL') {
      return 'This answer is scored automatically, so it cannot be marked by hand. Reload the page to see its score.';
    }
    if (e.code === 'SESSION_NOT_UNDER_REVIEW') {
      return 'This session is not under review right now, so answers cannot be scored. Reload the page to see its current status.';
    }
    if (e.code === 'VERDICT_ALREADY_SET') {
      return 'A verdict is already set for this session, so scores can no longer change.';
    }
    if (e.status === 403) return 'Your role cannot score answers.';
  }
  return 'The decision was not saved. Check your connection and try again.';
}

export function AnswersPanel({
  sessionId,
  answers,
}: {
  sessionId: string;
  answers: readonly ReviewAnswer[];
}): React.JSX.Element {
  return (
    <section aria-labelledby="answers-h" className="space-y-3">
      <h2 id="answers-h" className="text-lg font-semibold">
        Answers
      </h2>
      {answers.length === 0 ? (
        <p className="text-sm text-muted-foreground">This session has no answers.</p>
      ) : (
        <ol className="space-y-4">
          {answers.map((a, i) => (
            <AnswerCard key={a.sessionQuestionId} sessionId={sessionId} answer={a} index={i + 1} />
          ))}
        </ol>
      )}
    </section>
  );
}

function AnswerCard({
  sessionId,
  answer,
  index,
}: {
  sessionId: string;
  answer: ReviewAnswer;
  index: number;
}): React.JSX.Element {
  const state = scoringState(answer);
  const headId = `ans-${answer.sessionQuestionId}`;
  return (
    <li className="rounded-md border bg-card p-4" aria-labelledby={headId}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headId} className="font-medium">
          {index}. {answer.title}
        </h3>
        <Badge>{TYPE_LABEL[answer.type]}</Badge>
        <Badge tone={state === 'pending' ? 'warning' : state === 'manual' ? 'success' : 'neutral'}>
          {SCORING_TEXT[state]}
        </Badge>
        <span className="ml-auto text-sm">
          Score {formatScore(answer.score)} / {answer.points}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{answer.statement}</p>
      <AnswerBody answer={answer} />
      {answer.scoringNote ? (
        <p className="mt-2 text-sm">
          <span className="font-medium">Reviewer note: </span>
          {answer.scoringNote}
        </p>
      ) : null}
      {answer.runResults && answer.runResults.length > 0 ? (
        <RunResults results={answer.runResults} />
      ) : null}
      {canScoreManually(answer) ? <ManualScore sessionId={sessionId} answer={answer} /> : null}
    </li>
  );
}

function AnswerBody({ answer }: { answer: ReviewAnswer }): React.JSX.Element {
  const body = answerBody(answer);
  if (body.kind === 'code') {
    return (
      <div className="mt-3">
        <p className="text-xs text-muted-foreground">Submitted code ({body.language})</p>
        <pre
          role="region"
          // A scrollable region must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          aria-label={`Submitted code for ${answer.title}`}
          className="mt-1 max-h-72 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs"
        >
          {body.code}
        </pre>
      </div>
    );
  }
  if (body.kind === 'options') {
    const text = (id: string): string => answer.options?.find((o) => o.id === id)?.text ?? id;
    return (
      <div className="mt-3">
        <p className="text-xs text-muted-foreground">Selected options</p>
        {body.ids.length === 0 ? (
          <p className="text-sm">No option selected.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {body.ids.map((id) => (
              <li key={id}>{text(id)}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="mt-3">
      <p className="text-xs text-muted-foreground">Candidate answer</p>
      <p className="mt-1 whitespace-pre-wrap rounded-md border bg-muted p-3 text-sm">
        {body.text === '' ? 'No answer given.' : body.text}
      </p>
    </div>
  );
}

function RunResults({ results }: { results: NonNullable<ReviewAnswer['runResults']> }) {
  const last = results[results.length - 1];
  if (!last) return null;
  return (
    <div className="mt-3">
      <p className="text-sm font-medium">
        Last run: {last.passed} of {last.total} tests passed
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {formatDateTime(last.at)}; {results.length} run{results.length === 1 ? '' : 's'} in total
        </span>
      </p>
      <ul className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
        {last.tests.map((t) => (
          <li key={t.name} className="flex items-center gap-2">
            <Badge tone={t.status === 'passed' ? 'success' : 'error'}>
              {t.status === 'passed' ? 'Passed' : 'Failed'}
            </Badge>
            {t.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ManualScore({
  sessionId,
  answer,
}: {
  sessionId: string;
  answer: ReviewAnswer;
}): React.JSX.Element {
  const score = useScoreAnswer(sessionId);
  const [note, setNote] = React.useState('');
  const noteId = `note-${answer.sessionQuestionId}`;
  const decide = (correct: boolean): void =>
    score.mutate({
      sessionQuestionId: answer.sessionQuestionId,
      body: { correct, ...(note.trim() ? { note: note.trim() } : {}) },
    });
  return (
    <div className="mt-3 rounded-md border border-dashed p-3">
      <p className="text-sm font-medium">
        {answer.scoring === 'MANUAL_PENDING'
          ? 'This answer needs your decision'
          : 'Change your decision'}
      </p>
      <div className="mt-2 max-w-xl">
        <Field id={noteId} label="Note (optional)" hint="Up to 1000 characters.">
          {(aria) => (
            <Textarea
              {...aria}
              className="min-h-16"
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={score.isPending} onClick={() => decide(true)}>
          Correct<span className="sr-only">: {answer.title}</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={score.isPending}
          onClick={() => decide(false)}
        >
          Incorrect<span className="sr-only">: {answer.title}</span>
        </Button>
      </div>
      {score.isError ? (
        <Alert tone="error" role="alert" className="mt-2">
          {scoringErrorMessage(score.error)}
        </Alert>
      ) : null}
      {score.isSuccess ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Decision saved.
        </p>
      ) : null}
    </div>
  );
}
