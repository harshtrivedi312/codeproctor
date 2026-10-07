// Port for the code runner (FR-503). The HTTP implementation talks to Judge0 CE; tests use the
// in-memory fake. Implementations must never log source code, stdin, stdout or tokens.

export interface Judge0Limits {
  readonly cpuMs: number;
  readonly wallMs: number;
  readonly memoryKb: number;
}

export interface Judge0Submission {
  readonly languageId: number;
  readonly sourceCode: string;
  readonly stdin: string;
  readonly limits: Judge0Limits;
  /** Upper bound on bytes kept from stdout, stderr and compiler output. */
  readonly maxOutputBytes: number;
}

/** Judge0 CE status ids (https://ce.judge0.com/#statuses-and-languages-status-get). */
export const JUDGE0_STATUS = {
  IN_QUEUE: 1,
  PROCESSING: 2,
  ACCEPTED: 3,
  WRONG_ANSWER: 4,
  TIME_LIMIT_EXCEEDED: 5,
  COMPILATION_ERROR: 6,
  RUNTIME_ERROR_SIGSEGV: 7,
  RUNTIME_ERROR_SIGXFSZ: 8,
  RUNTIME_ERROR_SIGFPE: 9,
  RUNTIME_ERROR_SIGABRT: 10,
  RUNTIME_ERROR_NZEC: 11,
  RUNTIME_ERROR_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14,
} as const;

/** Decoded (not base64) result of one finished submission. */
export interface Judge0RawResult {
  readonly statusId: number;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly compileOutput: string | null;
  readonly message: string | null;
  readonly timeMs: number | null;
  readonly wallTimeMs: number | null;
  readonly memoryKb: number | null;
  readonly exitCode: number | null;
}

export interface Judge0Client {
  /**
   * Typed signal that this client runs nothing (the local development stub, DL-54, DL-58). Absent
   * or false for every real client. ExecutionService uses it, never the label text, to decide.
   */
  readonly isStub?: boolean;
  /** Runs the submissions and resolves, in input order, once every one has finished. */
  runBatch(submissions: readonly Judge0Submission[]): Promise<Judge0RawResult[]>;
}

export const JUDGE0_CLIENT = Symbol('JUDGE0_CLIENT');

/** The runner could not be reached, rejected the request or timed out. Message is generic. */
export class Judge0UnavailableError extends Error {
  constructor(message = 'Code runner unavailable') {
    super(message);
    this.name = 'Judge0UnavailableError';
  }
}
