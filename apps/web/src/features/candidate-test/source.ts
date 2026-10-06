import type { CodeLanguage } from '@codeproctor/shared';
import type { Schemas } from '@/lib/api/client';

/**
 * Where the test screen gets its data and sends its writes. Two adapters implement it: the demo
 * source (the placeholder OpenAPI routes, used by the /t/demo/test preview and the QA specs) and the
 * candidate source on the ADR 0013 routes (`adr-source.ts`, PROVISIONAL, used by the real flow).
 * The screen never talks to the network itself, so it stays one component for both.
 */
export type DraftBody =
  | { kind: 'code'; language: CodeLanguage; code: string }
  | { kind: 'mcq'; selectedOptionId: string };

export type DraftResult =
  | { ok: true; savedAt: string }
  /** `paused` is a 409 SESSION_PAUSED: keep the draft and retry after resume (DL-17). */
  | { ok: false; paused: boolean };

export type RunOutcome =
  | { kind: 'result'; result: Schemas['RunResult'] }
  | { kind: 'rate-limited'; retryAfterSeconds: number | null }
  | { kind: 'paused' }
  | { kind: 'error' };

export type FinishOutcome =
  | { kind: 'finished'; nextSectionId: string | null; submitted: boolean }
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
  readSession(): Promise<Schemas['CandidateSession'] | { submitted: true } | null>;
  /** The server's current time, ISO. Rejects when it cannot be read (FR-505). */
  serverNow(): Promise<string>;
  saveDraft(questionId: string, body: DraftBody): Promise<DraftResult>;
  run(questionId: string, language: CodeLanguage, code: string): Promise<RunOutcome>;
  finishSection(sectionId: string): Promise<FinishOutcome>;
}
