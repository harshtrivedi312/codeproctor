// Practice run (FR-406). Goes through the same ExecutionService as a real run, but writes nothing:
// no submission row, no draft, no session change. Never logs the code or the outputs.
import { BadRequestException, Injectable } from '@nestjs/common';
import { DEFAULT_LIMITS } from '../execution/limits';
import { ExecutionService } from '../execution/execution.service';
import type { CapturedTestRunResult } from '../execution/execution.types';
import { isExecLanguage } from '../judge0/language-map';
import type { PracticeRunResultDto } from './practice.dto';
import { PRACTICE_QUESTION } from './practice.content';

type Outcome = PracticeRunResultDto['outcome'];

/** The text the real run route also shows for a stub result (STUB_LABEL, DL-58). */
export const PRACTICE_STUB_MESSAGE = 'local stub, not real execution';

function outcomeOf(results: readonly CapturedTestRunResult[]): Outcome {
  const has = (...v: string[]): boolean => results.some((r) => v.includes(r.verdict));
  if (has('COMPILE_ERROR')) return 'compile_error';
  if (has('TIME_LIMIT')) return 'time_limit_exceeded';
  if (has('RUNTIME_ERROR', 'MEMORY_LIMIT', 'OUTPUT_LIMIT', 'INTERNAL_ERROR')) {
    return 'runtime_error';
  }
  return 'completed';
}

@Injectable()
export class PracticeService {
  constructor(private readonly execution: ExecutionService) {}

  async run(input: { language: string; code: string }): Promise<PracticeRunResultDto> {
    const language = input.language;
    if (
      !isExecLanguage(language) ||
      !(PRACTICE_QUESTION.languages as readonly string[]).includes(language)
    ) {
      throw new BadRequestException('That language is not available for the practice question.');
    }
    const samples = PRACTICE_QUESTION.sampleTests;
    const { results } = await this.execution.runCaptured({
      language,
      sourceCode: input.code,
      limits: DEFAULT_LIMITS,
      tests: samples.map((s) => ({
        id: s.id,
        input: s.input,
        expectedOutput: s.expectedOutput,
        reveal: true,
      })),
    });

    if (results.some((r) => r.stub === true)) {
      // DL-58: never a pass and never a fail. The web schema has no place for this, so the run says
      // so in extra fields and returns no per-test status.
      return {
        outcome: 'completed',
        tests: [],
        stdout: '',
        stderr: PRACTICE_STUB_MESSAGE,
        stub: true,
        message: PRACTICE_STUB_MESSAGE,
      };
    }

    const outcome = outcomeOf(results);
    const tests = samples.map((s, i) => {
      const r = results[i];
      return {
        id: s.id,
        name: s.name,
        status: r?.passed === true ? ('passed' as const) : ('failed' as const),
        input: s.input,
        expectedOutput: s.expectedOutput,
        ...(r?.rawActualOutput !== undefined ? { actualOutput: r.rawActualOutput } : {}),
        ...(r?.timeMs != null ? { durationMs: r.timeMs } : {}),
      };
    });
    const first = results[0];
    const failing = results.find((r) => r.diagnostic !== undefined || r.message !== undefined);
    return {
      outcome,
      tests,
      stdout: first?.rawActualOutput ?? first?.stdout ?? '',
      stderr: outcome === 'completed' ? '' : (failing?.diagnostic ?? failing?.message ?? ''),
    };
  }
}
