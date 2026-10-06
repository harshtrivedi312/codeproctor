import { candidateCap, unservedSlots } from './feasibility';
import { MAX_QUESTIONS_PER_TEST } from './test-structure';

const ids = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('TC-020 (FR-301): random slots need different questions (FU-BE-116)', () => {
  it('TC-020: no slots is satisfiable', () => {
    expect(unservedSlots([])).toEqual([]);
  });

  it('TC-020: disjoint rules are satisfied independently', () => {
    expect(unservedSlots([['a'], ['b'], ['c', 'd']])).toEqual([]);
  });

  it('TC-020: exactly enough questions for identical rules passes, one short fails', () => {
    expect(
      unservedSlots([
        ['a', 'b'],
        ['a', 'b'],
      ]),
    ).toEqual([]);
    expect(
      unservedSlots([
        ['a', 'b'],
        ['a', 'b'],
        ['a', 'b'],
      ]),
    ).toHaveLength(1);
  });

  it('TC-020: overlapping rules pass per rule but fail together (two {a} slots plus one {a,b})', () => {
    // {tags:[a]} matches q1,q2; {tags:[a,b]} matches q1: a per-key check says 2>=2 and 1>=1.
    const a = ['q1', 'q2'];
    const ab = ['q1'];
    expect(unservedSlots([a, a, ab])).toHaveLength(1);
    // with a third question matching {a} the three slots fit
    expect(unservedSlots([[...a, 'q3'], [...a, 'q3'], ab])).toEqual([]);
  });

  it('TC-020: nested rules are served by re-routing (augmenting path)', () => {
    // slot0 may use x or y, slot1 only x: a greedy pick of x for slot0 must be undone.
    expect(unservedSlots([['x', 'y'], ['x']])).toEqual([]);
    expect(unservedSlots([['x'], ['x', 'y'], ['y', 'z'], ['z', 'w']])).toEqual([]);
  });

  it('TC-020: a slot without matches is the unserved one and is reported by index', () => {
    expect(unservedSlots([['a'], [], ['b']])).toEqual([1]);
  });

  it('TC-020: fixed slots consume their questions, so random slots cannot reuse them', () => {
    expect(unservedSlots([['a', 'b']], new Set(['a']))).toEqual([]);
    expect(unservedSlots([['a', 'b']], new Set(['a', 'b']))).toEqual([0]);
    expect(
      unservedSlots(
        [
          ['a', 'b'],
          ['a', 'b'],
        ],
        new Set(['a']),
      ),
    ).toHaveLength(1);
  });

  it('TC-020: repeated ids in one list count once', () => {
    expect(unservedSlots([['a', 'a'], ['a']])).toHaveLength(1);
  });

  it('TC-020: more slots than the test limit is refused', () => {
    const many = Array.from({ length: MAX_QUESTIONS_PER_TEST + 1 }, () => ['a']);
    expect(() => unservedSlots(many)).toThrow(RangeError);
  });

  it('TC-020: a full test of 100 overlapping slots over 100 questions is solved fast', () => {
    const pool = ids('q', MAX_QUESTIONS_PER_TEST);
    // slot i accepts questions i..99: a staircase, the worst case for a greedy pick
    const staircase = pool.map((_, i) => pool.slice(i));
    const started = Date.now();
    expect(unservedSlots(staircase)).toEqual([]);
    expect(unservedSlots([...staircase.slice(0, 99), pool.slice(0, 1)])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('TC-020: cutting each rule to candidateCap ids never changes the answer', () => {
    // 3 random slots, 2 fixed: a rule with 50 matches is cut to 5 and stays satisfiable
    const cap = candidateCap(3, 2);
    expect(cap).toBe(5);
    const fixed = new Set(['q0', 'q1']);
    const cut = ids('q', 50).slice(0, cap);
    expect(unservedSlots([cut, cut, cut], fixed)).toEqual([]);
    expect(unservedSlots([cut, cut, cut, cut], fixed)).toHaveLength(1);
  });
});
