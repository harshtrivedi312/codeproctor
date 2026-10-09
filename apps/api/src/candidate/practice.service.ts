// GET /candidate/session/practice and POST /candidate/session/practice/run (FR-406).
// Fixed content, run through the same execution path as a real Run (the stub in local dev), and
// nothing is stored: no submission row, no autosave, no audit. Only CONSENTED and VERIFIED
// sessions may use it, because the practice step sits before the timed test.
import { Injectable } from '@nestjs/common';
import type { CodeLanguage } from '@codeproctor/shared';
import { ExecutionService } from '../execution/execution.service';
import type { TestRunResult } from '../execution/execution.types';
import { sessionNotActive } from '../session/session-write-gate';
import type { CandidateContext } from './candidate.types';
import {
  PRACTICE_LANGUAGES,
  PRACTICE_LIMITS,
  PRACTICE_SAMPLES,
  PRACTICE_STARTER_CODE,
  PRACTICE_STATEMENT,
  PRACTICE_TITLE,
} from './practice.content';

export type PracticeOutcome =
  'completed' | 'compile_error' | 'runtime_error' | 'time_limit_exceeded';

export interface PracticeQuestionView {
  readonly title: string;
  readonly statementMarkdown: string;
  readonly languages: readonly CodeLanguage[];
  readonly starterCode: Readonly<Record<CodeLanguage, string>>;
  readonly sampleTests: readonly {
    id: string;
    name: string;
    input: string;
    expectedOutput: string;
  }[];
}

export interface PracticeRunView {
  readonly outcome: PracticeOutcome;
  readonly tests: readonly {
    id: string;
    name: string;
    status: 'passed' | 'failed';
    input?: string;
    expectedOutput?: string;
    actualOutput?: string;
    durationMs?: number;
  }[];
  readonly stdout: string;
  readonly stderr: string;
}

const OUTCOME_OF: Partial<Record<TestRunResult['verdict'], PracticeOutcome>> = {
  COMPILE_ERROR: 'compile_error',
  RUNTIME_ERROR: 'runtime_error',
  INTERNAL_ERROR: 'runtime_error',
  TIME_LIMIT: 'time_limit_exceeded',
  MEMORY_LIMIT: 'time_limit_exceeded',
  OUTPUT_LIMIT: 'time_limit_exceeded',
};

function assertBeforeStart(ctx: CandidateContext): void {
  if (ctx.status !== 'CONSENTED' && ctx.status !== 'VERIFIED') throw sessionNotActive(ctx.status);
}

@Injectable()
export class PracticeService {
  constructor(private readonly execution: ExecutionService) {}

  question(ctx: CandidateContext): PracticeQuestionView {
    assertBeforeStart(ctx);
    return {
      title: PRACTICE_TITLE,
      statementMarkdown: PRACTICE_STATEMENT,
      languages: PRACTICE_LANGUAGES,
      starterCode: PRACTICE_STARTER_CODE,
      sampleTests: PRACTICE_SAMPLES.map((s) => ({ ...s })),
    };
  }

  async run(ctx: CandidateContext, language: CodeLanguage, code: string): Promise<PracticeRunView> {
    assertBeforeStart(ctx);
    const { results } = await this.execution.run({
      language,
      sourceCode: code,
      limits: PRACTICE_LIMITS,
      tests: PRACTICE_SAMPLES.map((s) => ({
        id: s.id,
        input: s.input,
        expectedOutput: s.expectedOutput,
        reveal: true,
      })),
    });
    const byId = new Map(results.map((r) => [r.testId, r]));
    const worst = results.find((r) => OUTCOME_OF[r.verdict] !== undefined);
    const firstNote = results.find((r) => !r.passed && r.message !== undefined);
    return {
      outcome: (worst && OUTCOME_OF[worst.verdict]) ?? 'completed',
      tests: PRACTICE_SAMPLES.map((s) => {
        const r = byId.get(s.id);
        return {
          id: s.id,
          name: s.name,
          status: r?.passed === true ? ('passed' as const) : ('failed' as const),
          input: s.input,
          expectedOutput: s.expectedOutput,
          ...(r?.stdout === undefined ? {} : { actualOutput: r.stdout }),
          ...(r?.timeMs === null || r?.timeMs === undefined ? {} : { durationMs: r.timeMs }),
        };
      }),
      stdout: results.find((r) => r.stdout !== undefined && r.stdout !== '')?.stdout ?? '',
      // The runner's own sentence (capped, sanitised by ExecutionService); for the local stub it says
      // that nothing ran.
      stderr: firstNote?.message ?? '',
    };
  }
}
