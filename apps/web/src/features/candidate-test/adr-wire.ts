import { codeLanguageSchema } from '@codeproctor/shared';
import { z } from 'zod';

/**
 * PROVISIONAL wire contract of the real test screen (contract not final).
 *
 * Sources: BE-07 `SessionStateDto` and `TestStartedDto` (backend-cand/be-07-session), ADR 0013
 * section 5.10 CS-4.6 (the candidate-safe question projection and the open-section rule) and 5.11
 * (submit and the section close), fsd.md section 4. Routes that no document pins are marked.
 * Replace with the generated types when the API publishes them (ADR 0012).
 */

/** GET /candidate/session (BE-07). The server clock and the deadlines the timers run on. */
/**
 * States in which the test is over (ADR 0002 section 3). Only these mean "submitted" to the screen;
 * a status that is in neither list is treated as "could not read" (never as over), so a renamed or
 * lower-case value cannot show the submitted page and clear the candidate's credentials.
 */
export const RUNNING_STATUSES = ['IN_PROGRESS', 'PAUSED'] as const;
export const OVER_STATUSES = [
  'SUBMITTED',
  'GRADED',
  'UNDER_REVIEW',
  'COMPLETED',
  'APPEALED',
  'EXPIRED',
  'ERASED',
] as const;

export function isOverStatus(status: string): boolean {
  return (OVER_STATUSES as readonly string[]).includes(status);
}

export const sessionStateSchema = z.object({
  serverTime: z.string(),
  status: z.string(),
  startedAt: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  sectionDeadlineAt: z.string().nullable(),
  pauseReasons: z.array(z.string()),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

const sectionSchema = z.object({
  position: z.number().int(),
  title: z.string(),
  timeLimitMs: z.number().nullable(),
  startedAt: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  questions: z.array(
    z.object({
      sessionQuestionId: z.string(),
      position: z.number().int(),
      /** A decimal string (BE-07). */
      points: z.string(),
    }),
  ),
});

/**
 * The test layout. `POST /candidate/session/test/start` (BE-07) returns it once; a resumed session
 * has no route for it in any document, so `GET /candidate/session/test` is PROVISIONAL and returns
 * the same shape.
 */
export const testLayoutSchema = z.object({
  status: z.enum(['IN_PROGRESS', 'PAUSED']),
  serverTime: z.string(),
  startedAt: z.string(),
  deadlineAt: z.string(),
  sections: z.array(sectionSchema).min(1),
});
export type TestLayout = z.infer<typeof testLayoutSchema>;

/** ADR 0013 CS-4.6: `render-question`, candidate-safe (no hidden tests, no answer key). */
export const questionViewSchema = z.object({
  sessionQuestionId: z.string(),
  type: z.enum(['CODING', 'MCQ', 'SHORT_ANSWER']),
  title: z.string(),
  statementMd: z.string(),
  languages: z.array(codeLanguageSchema).default([]),
  starterCode: z.record(z.string(), z.string()).default({}),
  samples: z.array(z.object({ input: z.string(), expectedOutput: z.string() })).default([]),
  mcq: z
    .object({
      multiple: z.boolean(),
      options: z.array(z.object({ id: z.string(), text: z.string() })),
    })
    .optional(),
});
export type QuestionView = z.infer<typeof questionViewSchema>;

/** PROVISIONAL: the draft save answers with the server time (the screen re-syncs its clock). */
export const draftSavedSchema = z.object({ savedAt: z.string() });

/** PROVISIONAL shape for Run (FR-502), sample tests only. */
export const runResultSchema = z.object({
  outcome: z.enum(['completed', 'compile_error', 'runtime_error', 'time_limit_exceeded']),
  tests: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(['passed', 'failed']),
      input: z.string().optional(),
      expectedOutput: z.string().optional(),
      actualOutput: z.string().optional(),
      durationMs: z.number().optional(),
    }),
  ),
  stdout: z.string(),
  stderr: z.string(),
});

/**
 * PROVISIONAL path (ADR 0013 5.11 names "the section-finish route" without a path). Finishing the
 * last section submits the session (ADR 0002 S-5), so `submitted` is true then.
 */
export const sectionFinishedSchema = z.object({
  finishedAt: z.string(),
  nextSectionId: z.string().nullable(),
  submitted: z.boolean().default(false),
});
