// Scoring arithmetic and answer matching (FR-506, FR-205, D-23, ADR 0007 section 5). Pure functions:
// no database, no clock. Money-like values are whole hundredths in BigInt, so 100 x 7 / 10 is exactly
// 70.00 and no float ever touches a score.
import { mcqAnswerSchema, shortAnswerAnswerSchema } from './answer-shapes';
import { normalizeShortAnswer } from '../questions/answer-spec';
import type { McqAnswerSpec, ShortAnswerSpec } from '../questions/answer-spec';

const DECIMAL = /^(\d{1,8})(?:\.(\d{1,2}))?$/;

/** "100", "100.00" or "7.5" to hundredths (10000, 10000, 750). Throws on anything else. */
export function toHundredths(value: string): bigint {
  const m = DECIMAL.exec(value);
  if (m === null) throw new Error('Not a decimal with at most two places');
  return BigInt(m[1] as string) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

export function formatHundredths(value: bigint): string {
  const whole = value / 100n;
  const frac = (value % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${frac}`;
}

/**
 * points x passedWeight / totalWeight, rounded half up to hundredths (FR-506). All three are in
 * hundredths. A question with no hidden weight scores 0 (a data error the caller logs).
 */
export function weightedScore(points: bigint, passedWeight: bigint, totalWeight: bigint): bigint {
  if (totalWeight <= 0n || passedWeight <= 0n || points <= 0n) return 0n;
  const numerator = points * passedWeight;
  return (numerator * 2n + totalWeight) / (2n * totalWeight);
}

export interface Weighted {
  readonly passed: boolean;
  readonly weight: bigint;
}

export function codingScore(points: bigint, tests: readonly Weighted[]): bigint {
  const total = tests.reduce((sum, t) => sum + t.weight, 0n);
  const passed = tests.reduce((sum, t) => (t.passed ? sum + t.weight : sum), 0n);
  return weightedScore(points, passed, total);
}

/** MCQ by key: the selected set must equal the correct set. No answer, or a malformed one, is wrong. */
export function mcqCorrect(
  spec: McqAnswerSpec,
  answer: unknown,
  /** author option id -> the id this session's candidate was shown (OptionIdService.of). */
  candidateId: (optionId: string) => string,
): boolean {
  const parsed = mcqAnswerSchema.safeParse(answer);
  if (!parsed.success) return false;
  const selected = new Set(parsed.data.optionIds);
  const correct = new Set(spec.correctOptionIds.map((id) => candidateId(id)));
  if (selected.size !== correct.size) return false;
  for (const id of correct) if (!selected.has(id)) return false;
  return true;
}

export type ShortAnswerOutcome = 'CORRECT' | 'UNANSWERED' | 'NEEDS_MANUAL';

/**
 * D-23: a match after normalization (NFKC, trim, collapse whitespace, lower-case) with the canonical
 * answer or an accepted variant is full points. An empty answer is plain zero. Anything else is
 * never scored wrong by the machine: it waits for a reviewer.
 */
export function classifyShortAnswer(spec: ShortAnswerSpec, answer: unknown): ShortAnswerOutcome {
  const parsed = shortAnswerAnswerSchema.safeParse(answer);
  if (!parsed.success) return 'UNANSWERED';
  const given = normalizeShortAnswer(parsed.data.text);
  if (given === '') return 'UNANSWERED';
  const accepted = [spec.canonical, ...spec.acceptedVariants].map(normalizeShortAnswer);
  return accepted.includes(given) ? 'CORRECT' : 'NEEDS_MANUAL';
}
