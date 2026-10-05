import { JUDGE0_STATUS } from './judge0.types';
import type { Judge0Client, Judge0RawResult, Judge0Submission } from './judge0.types';

export type FakeBehaviour = (
  submission: Judge0Submission,
) => Judge0RawResult | Promise<Judge0RawResult>;

const BASE: Judge0RawResult = {
  statusId: JUDGE0_STATUS.ACCEPTED,
  stdout: '',
  stderr: null,
  compileOutput: null,
  message: null,
  timeMs: 10,
  wallTimeMs: 12,
  memoryKb: 4096,
  exitCode: 0,
};

/** Builds a raw result from a partial one. */
export function fakeResult(partial: Partial<Judge0RawResult> = {}): Judge0RawResult {
  return { ...BASE, ...partial };
}

/**
 * In-memory Judge0Client for unit tests. Register behaviours by a substring of the source code;
 * the first match wins, else the default behaviour runs (an accepted run with empty stdout).
 * It records every submission so tests can assert on the limits and flags that were sent.
 */
export class FakeJudge0Client implements Judge0Client {
  readonly submissions: Judge0Submission[] = [];
  readonly batches: number[] = [];
  private readonly rules: { marker: string; behaviour: FakeBehaviour }[] = [];
  failWith: Error | null = null;

  constructor(private defaultBehaviour: FakeBehaviour = () => fakeResult()) {}

  when(marker: string, behaviour: FakeBehaviour | Judge0RawResult): this {
    this.rules.push({
      marker,
      behaviour: typeof behaviour === 'function' ? behaviour : () => behaviour,
    });
    return this;
  }

  setDefault(behaviour: FakeBehaviour): this {
    this.defaultBehaviour = behaviour;
    return this;
  }

  async runBatch(submissions: readonly Judge0Submission[]): Promise<Judge0RawResult[]> {
    if (this.failWith) throw this.failWith;
    this.batches.push(submissions.length);
    const out: Judge0RawResult[] = [];
    for (const submission of submissions) {
      this.submissions.push(submission);
      const rule = this.rules.find((r) => submission.sourceCode.includes(r.marker));
      out.push(await (rule ? rule.behaviour : this.defaultBehaviour)(submission));
    }
    return out;
  }
}
