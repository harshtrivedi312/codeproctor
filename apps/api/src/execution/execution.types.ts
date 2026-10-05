import type { ExecLanguage } from '../judge0/language-map';

export type TestVerdict =
  | 'PASSED'
  | 'FAILED'
  | 'COMPILE_ERROR'
  | 'TIME_LIMIT'
  | 'MEMORY_LIMIT'
  | 'RUNTIME_ERROR'
  | 'INTERNAL_ERROR';

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
  /** Only set when run() is called with captureActualOutput (author-side validation); never serialize to candidates. */
  readonly rawActualOutput?: string;
}

export interface ExecutionResult {
  readonly results: readonly TestRunResult[];
  readonly clampedLimits: boolean;
}
