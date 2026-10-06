import type { ExecutionService } from '../execution/execution.service';
import type { CapturedExecutionResult } from '../execution/execution.types';
import { ReferenceValidationService } from '../execution/reference-validation.service';
import { ExecutionValidationAdapter } from './execution-validation.adapter';
import type { PortRequest } from './reference-validation.port';

const request = (over: Partial<PortRequest> = {}): PortRequest => ({
  questionVersionId: 'ver',
  limits: {},
  languages: ['python'],
  variants: [
    {
      variantId: 'v1',
      referenceSources: { python: 'print(1)' },
      tests: [{ testCaseId: 't1', position: 0, isHidden: false, input: 'i', expectedOutput: 'o' }],
    },
  ],
  ...over,
});

function adapter(run: (tests: number) => CapturedExecutionResult | Error): {
  adapter: ExecutionValidationAdapter;
  seen: string[];
} {
  const seen: string[] = [];
  const execution = {
    runCaptured: (r: { language: string; tests: unknown[] }) => {
      seen.push(r.language);
      const out = run(r.tests.length);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  } as unknown as ExecutionService;
  return {
    adapter: new ExecutionValidationAdapter(new ReferenceValidationService(execution)),
    seen,
  };
}

describe('FR-203 execution adapter of the validate port', () => {
  it('FR-203: maps a passing run to passing cells', async () => {
    const { adapter: a, seen } = adapter(() => ({
      clampedLimits: false,
      results: [{ testId: 't1', verdict: 'PASSED', passed: true, timeMs: 1, memoryKb: 1 }],
    }));
    const r = await a.validate(request());
    expect(seen).toEqual(['python']);
    expect(r.passed).toBe(true);
    expect(r.cells).toEqual([
      { variantId: 'v1', language: 'python', passed: true, testsPassed: 1, testsTotal: 1 },
    ]);
  });

  it('FR-203: a wrong answer fails and a language the executor cannot run rejects (fail closed)', async () => {
    const { adapter: a } = adapter(() => ({
      clampedLimits: false,
      results: [
        {
          testId: 't1',
          verdict: 'FAILED',
          passed: false,
          timeMs: 1,
          memoryKb: 1,
          rawActualOutput: 'x',
        },
      ],
    }));
    const r = await a.validate(request());
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatchObject({ variantId: 'v1', testCaseId: 't1', verdict: 'FAILED' });
    await expect(a.validate(request({ languages: ['cobol'] }))).rejects.toThrow();
  });

  it('FR-203: an executor error rejects', async () => {
    const { adapter: a } = adapter(() => new Error('judge0 down'));
    await expect(a.validate(request())).rejects.toThrow('judge0 down');
  });
});
