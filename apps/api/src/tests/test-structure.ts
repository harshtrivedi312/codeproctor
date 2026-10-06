// Structural rules of a test template (FR-301, FR-302, ADR 0002 S-6). Pure: no database. The
// service resolves question references separately (fixed versions, random-rule satisfiability).
// Money-like values (points, pass score) are compared in hundredths so sums are exact.

export const MIN_DURATION_MIN = 5;
export const MAX_DURATION_MIN = 480;
export const MAX_SECTIONS = 20;
export const MAX_QUESTIONS_PER_SECTION = 50;
export const MAX_QUESTIONS_PER_TEST = 100;
export const MAX_POINTS = 9999.99;
export const DEFAULT_POINTS = 100;
export const PROFILES_OFFERED = ['STANDARD', 'STRICT'] as const;

export interface PlanQuestion {
  position: number;
  points: number;
}
export interface PlanSection {
  position: number;
  timeLimitMin: number | null;
  questions: PlanQuestion[];
}
export interface Plan {
  durationMinutes: number;
  passScore: number | null;
  sections: PlanSection[];
}

const cents = (n: number): number => Math.round(n * 100);
const isTwoDecimals = (n: number): boolean => Number.isFinite(n) && cents(n) / 100 === n;

/** Sum of the points of every question, in hundredths. */
export function totalPointsCents(sections: readonly PlanSection[]): number {
  return sections.reduce((a, s) => a + s.questions.reduce((b, q) => b + cents(q.points), 0), 0);
}

function contiguous(positions: readonly number[]): boolean {
  const sorted = [...positions].sort((a, b) => a - b);
  return sorted.every((p, i) => p === i + 1);
}

/** Every problem found, human readable and free of content; empty means the plan is valid. */
export function planProblems(plan: Plan): string[] {
  const out: string[] = [];
  const { durationMinutes, sections } = plan;
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < MIN_DURATION_MIN ||
    durationMinutes > MAX_DURATION_MIN
  ) {
    out.push(
      `durationMinutes must be a whole number from ${MIN_DURATION_MIN} to ${MAX_DURATION_MIN}`,
    );
  }
  if (sections.length < 1) out.push('a test needs at least one section');
  if (sections.length > MAX_SECTIONS) out.push(`a test has at most ${MAX_SECTIONS} sections`);
  if (!contiguous(sections.map((s) => s.position))) {
    out.push('section positions must be 1, 2, 3, ... without gaps or repeats');
  }
  let limitSum = 0;
  let questionCount = 0;
  sections.forEach((s, i) => {
    const at = `sections[${i}]`;
    if (s.timeLimitMin !== null) {
      if (!Number.isInteger(s.timeLimitMin) || s.timeLimitMin < 1) {
        out.push(`${at}.timeLimitMin must be a whole number of at least 1`);
      } else {
        limitSum += s.timeLimitMin;
      }
    }
    if (s.questions.length < 1) out.push(`${at} needs at least one question`);
    if (s.questions.length > MAX_QUESTIONS_PER_SECTION) {
      out.push(`${at} has at most ${MAX_QUESTIONS_PER_SECTION} questions`);
    }
    if (!contiguous(s.questions.map((q) => q.position))) {
      out.push(`${at} question positions must be 1, 2, 3, ... without gaps or repeats`);
    }
    questionCount += s.questions.length;
    s.questions.forEach((q, j) => {
      if (!isTwoDecimals(q.points) || q.points <= 0 || q.points > MAX_POINTS) {
        out.push(`${at}.questions[${j}].points must be above 0, at most ${MAX_POINTS}, 2 decimals`);
      }
    });
  });
  if (questionCount > MAX_QUESTIONS_PER_TEST) {
    out.push(`a test has at most ${MAX_QUESTIONS_PER_TEST} questions`);
  }
  if (limitSum > durationMinutes) {
    out.push(
      `the section time limits add up to ${limitSum} minutes, more than the ${durationMinutes} minute duration`,
    );
  }
  if (plan.passScore !== null) {
    if (!isTwoDecimals(plan.passScore) || plan.passScore < 0 || plan.passScore > MAX_POINTS) {
      out.push(`passScore must be from 0 to ${MAX_POINTS}, 2 decimals`);
    } else if (cents(plan.passScore) > totalPointsCents(sections)) {
      out.push('passScore is more than the points of all questions together');
    }
  }
  return out;
}

export interface Positioned {
  position?: number;
}

/**
 * Orders items by their given positions, or by array order when none has one. Giving some and not
 * others is refused (returns null) because the intent is unclear.
 */
export function orderByPosition<T extends Positioned>(
  items: readonly T[],
): { item: T; position: number }[] | null {
  const given = items.filter((i) => i.position !== undefined).length;
  if (given !== 0 && given !== items.length) return null;
  const withPos = items.map((item, i) => ({ item, position: item.position ?? i + 1 }));
  return withPos.sort((a, b) => a.position - b.position);
}
