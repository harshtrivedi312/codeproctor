import type { PortResult } from './reference-validation.port';
import type { VariantRow } from './question-tx';
import { buildReport, buildRequest, errorReport } from './validation-job';
import type { JobCase, JobVersion } from './validation-job';

const version: JobVersion = {
  id: 'ver',
  statementMd: 'N = {{n}}',
  starterCode: {},
  referenceSolution: { python: 'print({{n}})', javascript: 'log({{n}})' },
  allowedLanguages: ['python', 'javascript'],
  limits: { cpuMs: 1000, wallMs: 3000, memoryKb: 65536 },
};
const cases: JobCase[] = [
  { id: 's2', position: 1, isHidden: true, input: 'H-IN', expectedOutput: 'H-OUT' },
  { id: 's1', position: 0, isHidden: false, input: 'S-IN', expectedOutput: 'S-OUT' },
];
const variant = (over: Partial<VariantRow>): VariantRow => ({
  id: 'v1',
  params: { n: 7 },
  renderedStatement: '',
  isActive: true,
  testCaseOverrides: [],
  ...over,
});
const meta = { revision: 'r'.repeat(64), startedAt: new Date(0), finishedAt: new Date(1000) };

describe('FR-203, TC-012 validate job: what to run', () => {
  it('FR-203: each active variant runs its rendered reference on its own slot data, ordered by position', () => {
    const r = buildRequest(version, cases, [
      variant({
        id: 'v2',
        params: { n: 2 },
        testCaseOverrides: [{ testCaseId: 's2', input: 'V2-IN', expectedOutput: 'V2-OUT' }],
      }),
      variant({ id: 'v1' }),
      variant({ id: 'v3', isActive: false, params: {} }),
    ]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.request.variants.map((v) => v.variantId)).toEqual(['v1', 'v2']);
    expect(r.request.variants[0]?.referenceSources).toEqual({
      python: 'print(7)',
      javascript: 'log(7)',
    });
    expect(
      r.request.variants[1]?.tests.map((t) => [t.testCaseId, t.input, t.expectedOutput]),
    ).toEqual([
      ['s1', 'S-IN', 'S-OUT'],
      ['s2', 'V2-IN', 'V2-OUT'],
    ]);
    expect([...r.hiddenSlots]).toEqual(['s2']);
  });

  it('FR-203: no active variant validates the base content as one implicit variant', () => {
    const r = buildRequest(
      { ...version, statementMd: 'x', referenceSolution: { python: 'p', javascript: 'j' } },
      cases,
      [variant({ isActive: false })],
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.request.variants).toHaveLength(1);
    expect(r.request.variants[0]?.variantId).toBeNull();
    expect(r.request.variants[0]?.referenceSources).toEqual({ python: 'p', javascript: 'j' });
  });

  it('FR-203: an active variant that does not render is a problem, not a run', () => {
    const r = buildRequest(version, cases, [variant({ params: {} })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems[0]).toMatch(/^variants\[v1\]\./);
  });
});

describe('TC-012 validate job: the stored report', () => {
  const built = (() => {
    const r = buildRequest(version, cases, [variant({ id: 'v1' }), variant({ id: 'v2' })]);
    if (!r.ok) throw new Error('expected ok');
    return r;
  })();
  const cell = (
    variantId: string,
    language: string,
    passed = true,
  ): PortResult['cells'][number] => ({
    variantId,
    language,
    passed,
    testsPassed: passed ? 2 : 1,
    testsTotal: 2,
  });
  const allPass: PortResult = {
    passed: true,
    cells: [
      cell('v1', 'python'),
      cell('v1', 'javascript'),
      cell('v2', 'python'),
      cell('v2', 'javascript'),
    ],
    failures: [],
  };

  it('TC-012: passes only when every variant and language has a passing cell', () => {
    const r = buildReport(built, allPass, meta);
    expect(r.passed).toBe(true);
    expect(r.revision).toBe(meta.revision);
    expect(r.perVariant.map((p) => p.variantId)).toEqual(['v1', 'v2']);
    expect(r.finishedAt).toBe('1970-01-01T00:00:01.000Z');
  });

  it('TC-012: a failing variant is reported by variant, slot and verdict; a hidden slot never carries its output', () => {
    const r = buildReport(
      built,
      {
        passed: false,
        cells: [
          cell('v1', 'python'),
          cell('v1', 'javascript'),
          cell('v2', 'python', false),
          cell('v2', 'javascript'),
        ],
        failures: [
          {
            variantId: 'v2',
            language: 'python',
            testCaseId: 's2',
            position: 1,
            verdict: 'FAILED',
            actualOutput: 'LEAK',
          },
          {
            variantId: 'v2',
            language: 'python',
            testCaseId: 's1',
            position: 0,
            verdict: 'FAILED',
            actualOutput: 'shown',
          },
        ],
      },
      meta,
    );
    expect(r.passed).toBe(false);
    expect(r.perVariant[0]?.passed).toBe(true);
    const failures = r.perVariant[1]?.failures;
    expect(failures?.[0]).toEqual({
      language: 'python',
      testCaseId: 's2',
      position: 1,
      verdict: 'FAILED',
    });
    expect(failures?.[1]?.actualOutput).toBe('shown');
    expect(JSON.stringify(r)).not.toContain('LEAK');
  });

  it('FR-203: a port that says passed but leaves a variant or language uncovered does not pass (fail closed)', () => {
    const partial: PortResult = { passed: true, cells: allPass.cells.slice(0, 3), failures: [] };
    expect(buildReport(built, partial, meta).passed).toBe(false);
    expect(buildReport(built, { passed: true, cells: [], failures: [] }, meta).passed).toBe(false);
    const zero: PortResult = {
      passed: true,
      cells: allPass.cells.map((c) => ({ ...c, testsPassed: 0, testsTotal: 0 })),
      failures: [],
    };
    expect(buildReport(built, zero, meta).passed).toBe(false);
    // A port that ran fewer tests than the variant has slots must not pass, even if all of them passed.
    const fewer: PortResult = {
      passed: true,
      cells: allPass.cells.map((c) => ({ ...c, testsPassed: 1, testsTotal: 1 })),
      failures: [],
    };
    expect(buildReport(built, fewer, meta).passed).toBe(false);
  });

  it('FR-203: an execution error report is never passed and has no per-variant rows', () => {
    const r = errorReport('TIMEOUT', meta);
    expect(r).toMatchObject({ passed: false, error: 'TIMEOUT', perVariant: [] });
  });
});
