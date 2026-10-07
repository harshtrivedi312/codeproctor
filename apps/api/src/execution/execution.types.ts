import type { ExecLanguage } from '../judge0/language-map';

export type TestVerdict =
  | 'PASSED'
  | 'FAILED'
  | 'COMPILE_ERROR'
  | 'TIME_LIMIT'
  | 'MEMORY_LIMIT'
  | 'OUTPUT_LIMIT'
  | 'RUNTIME_ERROR'
  | 'INTERNAL_ERROR'
  /**
   * Local development stub only (DL-54, DL-58). A verdict-free marker: nothing ran, so it is never
   * a pass or a fail. `passed` is always false and downstream code must never count it as right or
   * wrong in a score, nor treat it as accepted. Real Judge0 modes never produce it.
   */
  | 'LOCAL_STUB';

export interface ExecutionTest {
  readonly id: string;
  readonly input: string;
  readonly expectedOutput: string;
  /**
   * Sample tests may show the candidate their output and diagnostics. Hidden tests never do
   * (candidate-facing responses never carry hidden test data).
   */
  readonly reveal: boolean;
}

export interface ExecutionRequest {
  readonly language: ExecLanguage;
  readonly sourceCode: string;
  /** question_versions.limits, validated here. */
  readonly limits: unknown;
  readonly tests: readonly ExecutionTest[];
  /** 'submit' makes a stub result say it was not graded. Defaults to 'run'. */
  readonly mode?: 'run' | 'submit';
}

export interface TestRunResult {
  readonly testId: string;
  readonly verdict: TestVerdict;
  readonly passed: boolean;
  readonly timeMs: number | null;
  readonly memoryKb: number | null;
  /** Present only when the test is revealed. Capped. */
  readonly stdout?: string;
  readonly stdoutTruncated?: boolean;
  /** Sanitized: a fixed sentence, plus capped compiler or runtime output when revealed. */
  readonly message?: string;
  /** True only for a local-stub result: not executed, not graded, never a pass or fail. */
  readonly stub?: true;
}

export interface ExecutionResult {
  readonly results: readonly TestRunResult[];
  readonly clampedLimits: boolean;
}

/** Author-side only (reference validation). Never serialize to a candidate. */
export interface CapturedTestRunResult extends TestRunResult {
  /** Capped actual stdout of a run that finished (PASSED or FAILED). */
  readonly rawActualOutput?: string;
  /** Capped compiler output or stderr for COMPILE_ERROR and RUNTIME_ERROR. */
  readonly diagnostic?: string;
}

export interface CapturedExecutionResult {
  readonly results: readonly CapturedTestRunResult[];
  readonly clampedLimits: boolean;
}
