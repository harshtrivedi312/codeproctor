// Local-development Judge0 stub (DL-56). Runs nothing. Selected only by JUDGE0_MODE=stub read from
// process env at boot, which config refuses unless APP_ENV is exactly development. Deterministic.
//
// It must never look like grading: every result carries STUB_LABEL in the message and stderr, uses
// the INTERNAL_ERROR status (ExecutionService classifies that as INTERNAL_ERROR, never PASSED or
// FAILED) and has empty stdout, so no stub result can be mistaken for an accepted run.
import { JUDGE0_STATUS } from './judge0.types';
import type { Judge0Client, Judge0RawResult, Judge0Submission } from './judge0.types';

export const STUB_LABEL = 'local stub, not real execution';

export class StubJudge0Client implements Judge0Client {
  readonly isStub = true;

  runBatch(submissions: readonly Judge0Submission[]): Promise<Judge0RawResult[]> {
    return Promise.resolve(
      submissions.map((): Judge0RawResult => ({
        statusId: JUDGE0_STATUS.INTERNAL_ERROR,
        stdout: '',
        stderr: STUB_LABEL,
        compileOutput: null,
        message: STUB_LABEL,
        timeMs: 0,
        wallTimeMs: 0,
        memoryKb: 0,
        exitCode: null,
      })),
    );
  }
}
