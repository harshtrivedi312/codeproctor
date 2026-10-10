import type { CodeLanguage } from '@codeproctor/shared';
import type { Schemas } from '@/lib/api/client';
import { savedWorkSchema, type SavedWork } from './adr-wire';

/** A question as the screen holds it: the generated shape plus the candidate's own saved work. */
export type TestQuestion = Schemas['Question'] & {
  saved?: SavedWork;
  /**
   * `short`: a typed-text answer (the generated shape has no such type). `unsupported`: a question
   * this page cannot show; it gets a notice instead of failing the whole test.
   */
  format?: 'short' | 'unsupported';
};

export type QuestionKind = 'coding' | 'mcq' | 'short' | 'unsupported';

export function kindOf(q: Schemas['Question']): QuestionKind {
  if ('format' in q && (q.format === 'short' || q.format === 'unsupported')) return q.format;
  return q.type;
}

/** The API's limit for a short answer (MAX_SHORT_ANSWER_CHARS). */
export const MAX_SHORT_ANSWER_CHARS = 2000;

/** The saved work carried on a question (null when none, or when the source has none). */
export function savedWorkOf(q: Schemas['Question']): SavedWork {
  return 'saved' in q ? savedWorkSchema.parse(q.saved) : null;
}

/**
 * Where the test screen gets its data and sends its writes. Two adapters implement it: the demo
 * source (the placeholder OpenAPI routes, used by the /t/demo/test preview and the QA specs) and the
 * candidate source on the ADR 0013 routes (`adr-source.ts`, PROVISIONAL, used by the real flow).
 * The screen never talks to the network itself, so it stays one component for both.
 */
/**
 * What the output panel shows for a run: the generated shape plus the local-stub marker (DL-58,
 * verdict LOCAL_STUB). When `stub` is true nothing ran and nothing was graded.
 */
export type RunResultView = Schemas['RunResult'] & { stub?: true; message?: string };

export type DraftBody =
  | { kind: 'code'; language: CodeLanguage; code: string }
  | { kind: 'text'; text: string }
  | { kind: 'mcq'; selectedOptionId: string };

export type DraftResult =
  | { ok: true; savedAt: string }
  /** `paused` is a 409 SESSION_PAUSED: keep the draft and retry after resume (DL-17). */
  | { ok: false; paused: boolean };

export type RunOutcome =
  | { kind: 'result'; result: RunResultView }
  | { kind: 'rate-limited'; retryAfterSeconds: number | null }
  | { kind: 'paused' }
  | { kind: 'error' };

export type FinishOutcome =
  | {
      kind: 'finished';
      nextSectionId: string | null;
      submitted: boolean;
      /**
       * The server only accepted the close (202): it does not say what comes next, so the screen
       * re-reads to find the next open section or the end of the test.
       */
      acceptedOnly?: boolean;
    }
  /** A 409: not trusted by itself (paused, inactive, or already finished); the screen re-reads. */
  | { kind: 'conflict' }
  | { kind: 'failed' }
  /** The request never got an answer (network). */
  | { kind: 'unreachable' };

export interface TestSource {
  /** True for the placeholder routes and mock data: the screen then shows its demo wording. */
  readonly isDemo: boolean;
  /** The running session with the open section and its questions. Rejects when it cannot be read. */
  loadSession(): Promise<Schemas['CandidateSession']>;
  /**
   * A plain re-read that never touches the cache (used to verify a finish). `{ submitted: true }`
   * when the server says the test is over (a status in OVER_STATUSES, or 409 SESSION_NOT_ACTIVE).
   * Null when it fails, and for an unknown status (never treated as over).
   */
  readSession(opts?: {
    /**
     * The last section's close was accepted and the session is not over yet: read the state only.
     * The section's questions are closed and would answer 409, so none are fetched (null then).
     */
    stateOnly?: boolean;
  }): Promise<Schemas['CandidateSession'] | { submitted: true } | null>;
  /** The server's current time, ISO. Rejects when it cannot be read (FR-505). */
  serverNow(): Promise<string>;
  saveDraft(questionId: string, body: DraftBody): Promise<DraftResult>;
  run(questionId: string, language: CodeLanguage, code: string): Promise<RunOutcome>;
  finishSection(sectionId: string): Promise<FinishOutcome>;
}
