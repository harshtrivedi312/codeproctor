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
