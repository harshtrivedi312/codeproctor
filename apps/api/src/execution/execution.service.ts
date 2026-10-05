import { Inject, Injectable, Logger } from '@nestjs/common';
import { JUDGE0_CLIENT, JUDGE0_STATUS } from '../judge0/judge0.types';
import type { Judge0Client, Judge0RawResult, Judge0Submission } from '../judge0/judge0.types';
import { judge0LanguageId } from '../judge0/language-map';
import { InvalidLimitsError, resolveLimits } from './limits';
import { outputsMatch, truncate } from './normalize';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionTest,
  TestRunResult,
  TestVerdict,
} from './execution.types';

/** Never trust candidate output size: cap what is read from the runner and what is returned. */
export const MAX_RUNNER_OUTPUT_BYTES = 64 * 1024;
export const MAX_RETURNED_OUTPUT_CHARS = 4 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2 * 1024;

const MESSAGES: Record<Exclude<TestVerdict, 'PASSED' | 'FAILED'>, string> = {
  COMPILE_ERROR: 'The code did not compile.',
  TIME_LIMIT: 'Time limit exceeded.',
  MEMORY_LIMIT: 'Memory limit exceeded.',
  RUNTIME_ERROR: 'The program crashed while running.',
  INTERNAL_ERROR: 'The code could not be run. Try again.',
};

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(@Inject(JUDGE0_CLIENT) private readonly judge0: Judge0Client) {}

  /** Runs one program against many tests (FR-502, FR-503). Never throws for runner failures. */
  async run(
    request: ExecutionRequest,
    options: { readonly captureActualOutput?: boolean } = {},
  ): Promise<ExecutionResult> {
    // Invalid limits are a data error in the question, not a candidate error: let it throw.
    const limits = resolveLimits(request.limits);
    if (request.tests.length === 0) return { results: [], clampedLimits: limits.clamped };

    const submissions: Judge0Submission[] = request.tests.map((t) => ({
      languageId: judge0LanguageId(request.language),
      sourceCode: request.sourceCode,
      stdin: t.input,
      limits,
      maxOutputBytes: MAX_RUNNER_OUTPUT_BYTES,
    }));

    let raws: Judge0RawResult[];
    try {
      raws = await this.judge0.runBatch(submissions);
      if (raws.length !== request.tests.length) throw new Error('result count mismatch');
    } catch (error) {
      // Class name only: the message of a lower-level error may carry URLs.
      this.logger.error(`Judge0 batch failed (${error instanceof Error ? error.name : 'unknown'})`);
      return {
        clampedLimits: limits.clamped,
        results: request.tests.map((t) => ({
          testId: t.id,
          verdict: 'INTERNAL_ERROR',
          passed: false,
          timeMs: null,
          memoryKb: null,
          message: MESSAGES.INTERNAL_ERROR,
        })),
      };
    }

    const results = request.tests.map((test, i) =>
      this.toResult(
        test,
        raws[i] as Judge0RawResult,
        limits.memoryKb,
        options.captureActualOutput === true,
      ),
    );
    return { results, clampedLimits: limits.clamped };
  }

  private toResult(
    test: ExecutionTest,
    raw: Judge0RawResult,
    memoryLimitKb: number,
    capture: boolean,
  ): TestRunResult {
    const base = { testId: test.id, timeMs: raw.timeMs, memoryKb: raw.memoryKb };
    const verdict = this.classify(test, raw, memoryLimitKb);
    const stdout = truncate(raw.stdout ?? '', MAX_RETURNED_OUTPUT_CHARS);

    if (verdict === 'PASSED' || verdict === 'FAILED') {
      return {
        ...base,
        verdict,
        passed: verdict === 'PASSED',
        ...(test.reveal ? { stdout: stdout.text, stdoutTruncated: stdout.truncated } : {}),
        ...(capture ? { rawActualOutput: stdout.text } : {}),
      };
    }

    let message: string = MESSAGES[verdict];
    if (test.reveal && (verdict === 'COMPILE_ERROR' || verdict === 'RUNTIME_ERROR')) {
      const detail = truncate(
        (verdict === 'COMPILE_ERROR' ? raw.compileOutput : raw.stderr) ?? '',
        MAX_DIAGNOSTIC_CHARS,
      ).text.trim();
      if (detail) message = `${message}\n${detail}`;
    }
    return { ...base, verdict, passed: false, message };
  }

  private classify(test: ExecutionTest, raw: Judge0RawResult, memoryLimitKb: number): TestVerdict {
    const id = raw.statusId;
    if (id === JUDGE0_STATUS.COMPILATION_ERROR) return 'COMPILE_ERROR';
    if (id === JUDGE0_STATUS.TIME_LIMIT_EXCEEDED) return 'TIME_LIMIT';
    if (id >= JUDGE0_STATUS.RUNTIME_ERROR_SIGSEGV && id <= JUDGE0_STATUS.RUNTIME_ERROR_OTHER) {
      // Judge0 has no memory-limit status: an allocation past the limit shows up as a crash
      // (SIGSEGV, SIGABRT, non-zero exit) with peak memory at or near the limit.
      if (raw.memoryKb !== null && raw.memoryKb >= memoryLimitKb * 0.95) return 'MEMORY_LIMIT';
      return 'RUNTIME_ERROR';
    }
    if (id === JUDGE0_STATUS.ACCEPTED || id === JUDGE0_STATUS.WRONG_ANSWER) {
      // We compare ourselves (normalized); Judge0's own verdict is only a "ran to completion".
      return outputsMatch(raw.stdout ?? '', test.expectedOutput) ? 'PASSED' : 'FAILED';
    }
    return 'INTERNAL_ERROR';
  }
}

export { InvalidLimitsError };
