import { orderByPosition, planProblems, totalPointsCents } from './test-structure';
import type { Plan } from './test-structure';

const q = (position: number, points = 100): { position: number; points: number } => ({
  position,
  points,
});
const plan = (over: Partial<Plan> = {}): Plan => ({
  durationMinutes: 60,
  passScore: null,
  sections: [
    { position: 1, timeLimitMin: 20, questions: [q(1), q(2)] },
    { position: 2, timeLimitMin: 40, questions: [q(1)] },
  ],
  ...over,
});

describe('FR-301: test structure rules', () => {
  it('FR-301: a valid plan has no problems', () => {
    expect(planProblems(plan({ passScore: 300 }))).toEqual([]);
  });

  it('FR-301 sections sum: limits adding up to the duration pass, one minute over fails', () => {
    expect(planProblems(plan())).toEqual([]);
    const over = plan({
      sections: [
        { position: 1, timeLimitMin: 20, questions: [q(1)] },
        { position: 2, timeLimitMin: 41, questions: [q(1)] },
      ],
    });
    expect(planProblems(over).join()).toMatch(/add up to 61 minutes/);
  });

  it('FR-301: sections without a limit do not count, and no limits at all is fine', () => {
    const p = plan({
      sections: [
        { position: 1, timeLimitMin: null, questions: [q(1)] },
        { position: 2, timeLimitMin: 60, questions: [q(1)] },
      ],
    });
    expect(planProblems(p)).toEqual([]);
  });

  it.each([4, 481, 60.5, Number.NaN])('FR-301: duration %p is refused', (d) => {
    expect(planProblems(plan({ durationMinutes: d })).join()).toMatch(/durationMinutes/);
  });

  it.each([5, 480])('FR-301: duration %p is the edge of the range and allowed', (d) => {
    const p = plan({
      durationMinutes: d,
      sections: [{ position: 1, timeLimitMin: null, questions: [q(1)] }],
    });
    expect(planProblems(p)).toEqual([]);
  });

  it('FR-301: sections need contiguous positions from 1', () => {
    for (const positions of [
      [2, 3],
      [1, 3],
      [1, 1],
      [0, 1],
    ]) {
      const p = plan({
        sections: positions.map((position) => ({
          position,
          timeLimitMin: null,
          questions: [q(1)],
        })),
      });
      expect(planProblems(p).join()).toMatch(/section positions/);
    }
  });

  it('FR-301: every section needs at least one question, with contiguous positions', () => {
    const empty = plan({ sections: [{ position: 1, timeLimitMin: null, questions: [] }] });
    expect(planProblems(empty).join()).toMatch(/needs at least one question/);
    const gap = plan({ sections: [{ position: 1, timeLimitMin: null, questions: [q(2)] }] });
    expect(planProblems(gap).join()).toMatch(/question positions/);
  });

  it('FR-301: no sections is refused', () => {
    expect(planProblems(plan({ sections: [] })).join()).toMatch(/at least one section/);
  });

  it.each([0, -1, 10000, 1.234, Number.NaN])('FR-301: points %p are refused', (points) => {
    const p = plan({ sections: [{ position: 1, timeLimitMin: null, questions: [q(1, points)] }] });
    expect(planProblems(p).join()).toMatch(/points/);
  });

  it('FR-301: pass score 0 and the exact total pass, one cent above the total fails', () => {
    expect(totalPointsCents(plan().sections)).toBe(30000);
    expect(planProblems(plan({ passScore: 0 }))).toEqual([]);
    expect(planProblems(plan({ passScore: 300 }))).toEqual([]);
    expect(planProblems(plan({ passScore: 300.01 })).join()).toMatch(/more than the points/);
    expect(planProblems(plan({ passScore: -1 })).join()).toMatch(/passScore/);
  });

  it('FR-301: sums are exact in hundredths (0.1 + 0.2 = 0.3)', () => {
    const p = plan({
      passScore: 0.3,
      sections: [{ position: 1, timeLimitMin: null, questions: [q(1, 0.1), q(2, 0.2)] }],
    });
    expect(planProblems(p)).toEqual([]);
  });

  it('FR-301: size bounds on sections and questions', () => {
    const many = plan({
      sections: Array.from({ length: 21 }, (_v, i) => ({
        position: i + 1,
        timeLimitMin: null,
        questions: [q(1)],
      })),
    });
    expect(planProblems(many).join()).toMatch(/at most 20 sections/);
    const big = plan({
      sections: [
        {
          position: 1,
          timeLimitMin: null,
          questions: Array.from({ length: 51 }, (_v, i) => q(i + 1)),
        },
      ],
    });
    expect(planProblems(big).join()).toMatch(/at most 50 questions/);
  });

  it('FR-301: orderByPosition sorts by given positions, keeps array order otherwise, refuses a mix', () => {
    expect(orderByPosition([{ position: 2 }, { position: 1 }])?.map((x) => x.position)).toEqual([
      1, 2,
    ]);
    expect(orderByPosition([{}, {}])?.map((x) => x.position)).toEqual([1, 2]);
    expect(orderByPosition([{ position: 1 }, {}])).toBeNull();
  });
});
