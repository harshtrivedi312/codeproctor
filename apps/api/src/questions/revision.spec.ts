import { computeRevision } from './revision';

const v = {
  title: 'T',
  statementMd: 'S',
  difficulty: 'EASY',
  allowedLanguages: ['python'],
  limits: { cpu_ms: 1, wall_ms: 2, memory_kb: 3 },
  starterCode: { python: 'a' },
  referenceSolution: { python: 'b' },
  answerSpec: null,
};
const tc = { id: 'a', position: 0, isHidden: true, weight: 1, input: 'i', expectedOutput: 'o' };

describe('computeRevision (FR-203, FR-204)', () => {
  it('FR-204: stable across key order and row order, 64 hex characters', () => {
    const a = computeRevision(v, [tc, { ...tc, id: 'b', position: 1 }]);
    const b = computeRevision({ ...v, limits: { memory_kb: 3, wall_ms: 2, cpu_ms: 1 } }, [
      { ...tc, id: 'b', position: 1 },
      tc,
    ]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('FR-204: any content or test case change changes it', () => {
    const base = computeRevision(v, [tc]);
    for (const other of [
      computeRevision({ ...v, title: 'T2' }, [tc]),
      computeRevision({ ...v, referenceSolution: { python: 'c' } }, [tc]),
      computeRevision({ ...v, answerSpec: { canonical: 'x' } }, [tc]),
      computeRevision(v, [{ ...tc, expectedOutput: 'p' }]),
      computeRevision(v, [{ ...tc, isHidden: false }]),
      computeRevision(v, [{ ...tc, weight: 2 }]),
      computeRevision(v, []),
    ]) {
      expect(other).not.toBe(base);
    }
  });
});

describe('computeRevision with variants (FR-203, TC-012)', () => {
  const variant = {
    id: 'v1',
    params: { n: 1 },
    isActive: true,
    testCaseOverrides: [{ testCaseId: 'a', input: 'i2', expectedOutput: 'o2' }],
  };

  it('FR-203: no variants hashes as in slice 4a', () => {
    expect(computeRevision(v, [tc], [])).toBe(computeRevision(v, [tc]));
  });

  it('FR-203: any variant, params, active flag or override change changes it; order does not', () => {
    const base = computeRevision(v, [tc], [variant]);
    expect(base).not.toBe(computeRevision(v, [tc]));
    for (const other of [
      computeRevision(v, [tc], [{ ...variant, params: { n: 2 } }]),
      computeRevision(v, [tc], [{ ...variant, isActive: false }]),
      computeRevision(v, [tc], [{ ...variant, testCaseOverrides: [] }]),
      computeRevision(
        v,
        [tc],
        [
          {
            ...variant,
            testCaseOverrides: [{ testCaseId: 'a', input: 'i2', expectedOutput: 'o3' }],
          },
        ],
      ),
      computeRevision(v, [tc], [variant, { ...variant, id: 'v2' }]),
    ]) {
      expect(other).not.toBe(base);
    }
    expect(computeRevision(v, [tc], [{ ...variant, params: { n: 1 } }])).toBe(base);
    const two = [variant, { ...variant, id: 'v2' }];
    expect(computeRevision(v, [tc], two)).toBe(computeRevision(v, [tc], [...two].reverse()));
  });
});
