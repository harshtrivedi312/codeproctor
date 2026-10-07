import { unservedSlots } from '../tests/feasibility';
import { assignDistinct } from './random-assignment';

const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `q${String(i).padStart(3, '0')}`);

describe('Random question assignment (FR-203, FR-301, TC-020, FU-BE-154)', () => {
  it('FR-203: the nested-rule case the save-time check accepts is always served (no greedy failure)', () => {
    // {tags:[a]} matches q1 and q2; {tags:[a,b]} matches only q2. Greedy can give q2 to the first slot.
    for (let n = 0; n < 200; n++) {
      const options = [['q1', 'q2'], ['q2']];
      expect(unservedSlots(options, new Set())).toEqual([]);
      const got = assignDistinct(options, new Set(), `session-${String(n)}`);
      expect(got).toEqual(['q1', 'q2']);
    }
  });

  it('FR-203: a test that is genuinely unsatisfiable leaves the same slots without a question as the save-time check', () => {
    const cases: Array<[string[][], string[]]> = [
      [[['q1'], ['q1']], []],
      [
        [
          ['q1', 'q2'],
          ['q1', 'q2'],
          ['q1', 'q2'],
        ],
        ['q1'],
      ],
      [[['q1'], ['q1', 'q2']], ['q2']],
      [[[], ['q1']], []],
    ];
    for (const [options, taken] of cases) {
      const takenSet = new Set(taken);
      const unserved = unservedSlots(options, takenSet);
      expect(unserved.length).toBeGreaterThan(0);
      const got = assignDistinct(options, takenSet, 'seed');
      expect(got.filter((g) => g === null)).toHaveLength(unserved.length);
    }
  });

  it('FR-203: fixed questions are never given to a random slot, and no question is given twice', () => {
    const options = [ids(6), ids(6), ids(6)];
    const taken = new Set(['q000', 'q001', 'q002']);
    for (let n = 0; n < 50; n++) {
      const got = assignDistinct(options, taken, `s${String(n)}`);
      expect(got.every((g) => g !== null && !taken.has(g))).toBe(true);
      expect(new Set(got).size).toBe(3);
    }
  });

  it('FR-203: the same session always gets the same questions; other sessions get a mix', () => {
    const options = [ids(40), ids(40)];
    const first = assignDistinct(options, new Set(), 'session-A');
    for (let i = 0; i < 5; i++)
      expect(assignDistinct(options, new Set(), 'session-A')).toEqual(first);
    const seen = new Set<string>();
    for (let n = 0; n < 40; n++)
      seen.add(assignDistinct(options, new Set(), `s${String(n)}`).join());
    expect(seen.size).toBeGreaterThan(10);
    // The option order does not change the result for the same seed.
    expect(
      assignDistinct([[...ids(40)].reverse(), [...ids(40)].reverse()], new Set(), 'session-A'),
    ).toEqual(first);
  });

  it('FR-203: every random assignment is a maximum matching, as the save-time check says (property)', () => {
    let state = 12345;
    const rand = (n: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    for (let round = 0; round < 300; round++) {
      const pool = ids(2 + rand(5));
      const options = Array.from({ length: 1 + rand(4) }, () => pool.filter(() => rand(2) === 0));
      const taken = new Set(pool.filter(() => rand(5) === 0));
      const unserved = unservedSlots(options, taken);
      const got = assignDistinct(options, taken, `r${String(round)}`);
      expect(got.filter((g) => g === null).length).toBe(unserved.length);
      const used = got.filter((g): g is string => g !== null);
      expect(new Set(used).size).toBe(used.length);
      got.forEach((g, i) => {
        if (g !== null) expect(options[i]).toContain(g);
      });
    }
  });
});
