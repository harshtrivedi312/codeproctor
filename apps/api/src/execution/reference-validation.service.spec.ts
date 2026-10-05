import { FakeJudge0Client, fakeResult } from '../judge0/fake-judge0.client';
import type { Judge0Submission } from '../judge0/judge0.types';
import { ExecutionService } from './execution.service';
import { ReferenceValidationService } from './reference-validation.service';
import type { ValidationInput, ValidationReport } from './reference-validation.types';

const limits = { cpu_ms: 2000, wall_ms: 5000, memory_kb: 131072 };

/** A fake "interpreter": the source is `const K` and the program prints stdin * K. */
function constantProgram(sub: Judge0Submission) {
  const k = Number(/K=(\d+)/.exec(sub.sourceCode)?.[1] ?? 0);
  return fakeResult({ stdout: String(Number(sub.stdin) * k) });
}

function input(overrides: Partial<ValidationInput> = {}): ValidationInput {
  const tests = (mult: number) =>
    [1, 2, 3].map((n, i) => ({
      testCaseId: `tc${i}`,
      position: i + 1,
      input: String(n),
      expectedOutput: String(n * mult),
    }));
  return {
    questionVersionId: 'qv1',
    limits,
    languages: ['python', 'java'],
    variants: [
      { variantId: 'v1', referenceSources: { python: 'K=2', java: 'K=2' }, tests: tests(2) },
      { variantId: 'v2', referenceSources: { python: 'K=5', java: 'K=5' }, tests: tests(5) },
    ],
    ...overrides,
  };
}

function setup() {
  const fake = new FakeJudge0Client(constantProgram);
  const service = new ReferenceValidationService(new ExecutionService(fake));
  service.clock = () => new Date('2026-10-05T00:00:00.000Z');
  return { fake, service };
}

describe('ReferenceValidationService (FR-203, TC-012)', () => {
  it('FR-203: passes when the reference passes every variant in every language', async () => {
    const { service, fake } = setup();
    const report = await service.validate(input());
    expect(report.passed).toBe(true);
    expect(report.cells).toHaveLength(4);
    expect(report.failures).toEqual([]);
    expect(report.validatedAt).toBe('2026-10-05T00:00:00.000Z');
    expect(fake.submissions).toHaveLength(12);
  });

  it('TC-012 (FR-203): a constant that only one variant changes blocks publish and names the variant and test', async () => {
    const { service } = setup();
    // Reference hard-codes K=2 for both variants; variant v2 expects x5.
    const base = input();
    const bad: ValidationInput = {
      ...base,
      variants: [
        base.variants[0]!,
        { ...base.variants[1]!, referenceSources: { python: 'K=2', java: 'K=2' } },
      ],
    };
    const report = await service.validate(bad);
    expect(report.passed).toBe(false);
    expect(report.failures.length).toBe(6);
    expect(report.failures.every((f) => f.variantId === 'v2' && f.verdict === 'FAILED')).toBe(true);
    expect(report.failures[0]).toMatchObject({
      variantId: 'v2',
      testCaseId: 'tc0',
      position: 1,
      language: 'python',
    });
    expect(report.cells.find((c) => c.variantId === 'v1' && c.language === 'python')?.passed).toBe(
      true,
    );
  });

  it('TC-012 (FR-203): a missing reference for an allowed language fails validation', async () => {
    const { service } = setup();
    const base = input();
    const report = await service.validate({
      ...base,
      variants: [{ ...base.variants[0]!, referenceSources: { python: 'K=2' } }],
    });
    expect(report.passed).toBe(false);
    expect(report.failures).toEqual([
      expect.objectContaining({ language: 'java', verdict: 'MISSING_REFERENCE', variantId: 'v1' }),
    ]);
  });

  it('FR-203: no variants, or no tests, never passes', async () => {
    const { service } = setup();
    expect((await service.validate(input({ variants: [] }))).passed).toBe(false);
    const base = input();
    expect(
      (await service.validate(input({ variants: [{ ...base.variants[0]!, tests: [] }] }))).passed,
    ).toBe(false);
  });

  it('FR-203: a reference that times out is reported with its verdict', async () => {
    const { service, fake } = setup();
    fake.when('SLOW', fakeResult({ statusId: 5, stdout: null }));
    const base = input();
    const report = await service.validate({
      ...base,
      languages: ['python'],
      variants: [{ ...base.variants[0]!, referenceSources: { python: 'SLOW' } }],
    });
    expect(report.failures.map((f) => f.verdict)).toEqual([
      'TIME_LIMIT',
      'TIME_LIMIT',
      'TIME_LIMIT',
    ]);
  });

  it('FR-203: validateAndRecord hands the report to the sink; without one it throws', async () => {
    const { service } = setup();
    await expect(service.validateAndRecord(input())).rejects.toThrow('ValidationReportSink');
    const saved: ValidationReport[] = [];
    const withSink = new ReferenceValidationService(
      new ExecutionService(new FakeJudge0Client(constantProgram)),
      {
        save: (r) => {
          saved.push(r);
          return Promise.resolve();
        },
      },
    );
    await withSink.validateAndRecord(input());
    expect(saved).toHaveLength(1);
    expect(saved[0]?.passed).toBe(true);
  });

  it('FR-203 (R-11, PA-05): seeded summary counts 6 questions x 3 languages and fails if any fails', async () => {
    const { service } = setup();
    const six = Array.from({ length: 6 }, (_, i) =>
      input({
        questionVersionId: `qv${i}`,
        label: `q${i}`,
        languages: ['python', 'javascript', 'java'],
        variants: [
          {
            variantId: 'v',
            referenceSources: { python: 'K=2', javascript: 'K=2', java: 'K=2' },
            tests: [{ testCaseId: 't', position: 1, input: '3', expectedOutput: '6' }],
          },
        ],
      }),
    );
    const ok = await service.validateSeeded(six);
    expect(ok).toMatchObject({ passed: true, questionCount: 6, questionLanguagePairs: 18 });
    const broken = [...six];
    broken[3] = {
      ...six[3]!,
      variants: [
        {
          ...six[3]!.variants[0]!,
          referenceSources: { python: 'K=9', javascript: 'K=2', java: 'K=2' },
        },
      ],
    };
    const bad = await service.validateSeeded(broken);
    expect(bad.passed).toBe(false);
    expect(bad.reports.filter((r) => !r.report.passed).map((r) => r.label)).toEqual(['q3']);
  });
});
