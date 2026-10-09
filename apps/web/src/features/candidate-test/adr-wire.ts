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

/**
 * States in which the test is over (ADR 0002 section 3). Only these mean "submitted" to the screen;
 * a status that is in neither list is treated as "could not read" (never as over), so a renamed or
 * lower-case value cannot show the submitted page and clear the candidate's credentials.
 * ERASED comes from ADR 0004 section 9.5 (a proposed amendment, not yet in database.md).
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

/** GET /candidate/session (BE-07). The server clock and the deadlines the timers run on. */
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

/**
 * The local execution stub (DL-54, DL-58, API verdict LOCAL_STUB): nothing ran, so it is never a
 * pass or a fail. The panel says so in these words.
 */
export const LOCAL_STUB_LABEL = 'local stub, not real execution';

/** The shape the screen shows for a run (FR-502), sample tests only. */
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
  /** Local stub only: nothing ran. Never set on a real run. */
  stub: z.literal(true).optional(),
  message: z.string().optional(),
});

/**
 * POST /candidate/session/answers/:questionId/run, the real response (apps/api submissions
 * RunResultDto): one result per sample with a verdict. Mapped to the shape above by
 * `toRunView`. LOCAL_STUB is a verdict like the others and is never a pass or a fail.
 */
export const runResultDtoSchema = z.object({
  serverTime: z.string(),
  passed: z.number().int().min(0),
  total: z.number().int().min(0),
  results: z.array(
    z.object({
      index: z.number().int().min(1),
      verdict: z.string(),
      passed: z.boolean(),
      timeMs: z.number().nullable().optional(),
      memoryKb: z.number().nullable().optional(),
      stdout: z.string().optional(),
      stdoutTruncated: z.boolean().optional(),
      message: z.string().optional(),
      stub: z.literal(true).optional(),
    }),
  ),
});
type RunDto = z.infer<typeof runResultDtoSchema>;

/**
 * Maps the real run response to what the output panel shows. Pure; tested.
 *
 * Every sample that ran gets its own row, so the count is never smaller than what the API ran: a
 * sample that timed out or crashed is a FAILED row carrying its message, not a missing one. A
 * LOCAL_STUB sample did not run and is never a pass or a fail: it gets no row, and the result is
 * marked `stub` (the panel then shows only the stub notice). A compile error is the same on every
 * sample, so it is also the top-level message.
 */
export function toRunView(dto: RunDto): z.infer<typeof runResultSchema> {
  const rs = dto.results;
  const isStub = (r: RunDto['results'][number]): boolean =>
    r.verdict === 'LOCAL_STUB' || r.stub === true;
  const ran = rs.filter((r) => !isStub(r));
  const anyStub = rs.some(isStub);
  if (rs.length > 0 && ran.length === 0) {
    return {
      outcome: 'completed',
      tests: [],
      stdout: '',
      stderr: '',
      stub: true,
      message: rs[0]?.message ?? LOCAL_STUB_LABEL,
    };
  }
  const NOT_A_PASS_TEXT: Record<string, string> = {
    COMPILE_ERROR: 'The code did not compile.',
    RUNTIME_ERROR: 'The program crashed.',
    TIME_LIMIT: 'Time limit exceeded.',
    MEMORY_LIMIT: 'Memory limit exceeded.',
    OUTPUT_LIMIT: 'Output limit exceeded.',
    INTERNAL_ERROR: 'The run could not be completed. Try again.',
  };
  const tests = ran.map((r) => {
    // The verdict decides, never the `passed` flag alone: only PASSED is a pass.
    const status = r.verdict === 'PASSED' ? ('passed' as const) : ('failed' as const);
    const detail =
      status === 'failed' && r.verdict !== 'FAILED'
        ? (r.message ?? NOT_A_PASS_TEXT[r.verdict] ?? 'This sample did not complete.')
        : undefined;
    const printed =
      r.stdout === undefined
        ? undefined
        : r.stdoutTruncated
          ? `${r.stdout}\n(output cut short)`
          : r.stdout;
    return {
      id: `sample-${r.index}`,
      name: `Sample ${r.index}`,
      status,
      ...(status === 'failed' && (detail !== undefined || printed !== undefined)
        ? { actualOutput: detail ?? printed }
        : {}),
      ...(r.timeMs != null ? { durationMs: r.timeMs } : {}),
    };
  });
  const compile = ran.find((r) => r.verdict === 'COMPILE_ERROR');
  const printedPassing = ran
    .filter((r) => r.verdict === 'PASSED' && r.stdout)
    .map((r) => (ran.length > 1 ? `Sample ${r.index}:\n${r.stdout}` : (r.stdout ?? '')))
    .join('\n');
  const view: z.infer<typeof runResultSchema> = compile
    ? {
        outcome: 'compile_error',
        tests: [],
        stdout: '',
        stderr: compile.message ?? NOT_A_PASS_TEXT.COMPILE_ERROR ?? '',
      }
    : { outcome: 'completed', tests, stdout: printedPassing, stderr: '' };
  // Some samples did not run on the local stub: say so, and never count them.
  return anyStub ? { ...view, stub: true, message: LOCAL_STUB_LABEL } : view;
}

/** Either the real response (mapped) or the screen's own shape (demo and tests). */
export const runResponseSchema = z.union([
  runResultDtoSchema.transform(toRunView),
  runResultSchema,
]);

/**
 * `POST /candidate/session/section/finish` (ADR 0013 section 5.11; BE-11, documented, not yet
 * implemented on main). Body `{ position }`: the position of the section the candidate is looking
 * at, never an id. It only enqueues the close and is idempotent: 202 `{ accepted: true }` for the
 * open section and for an already closing or closed one (the no-op repeat), 409 SECTION_NOT_OPEN
 * for a section that has not opened, 404 for an unknown position, 400 for a bad body. It says
 * nothing about the next section: that opens when the close job runs, so the client re-reads.
 */
export const sectionFinishAcceptedSchema = z.object({ accepted: z.literal(true) });
