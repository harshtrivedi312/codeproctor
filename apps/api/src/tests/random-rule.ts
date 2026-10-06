// The random-pick rule stored in test_questions.random_rule (FR-301, TC-020). It is exactly
// { tags?: string[], difficulty?, type? }: unknown keys are refused (strict), so a rule the
// start-of-test code (candidate TestStartService, PR #98) does not understand can never be stored.
// There is no `count`: one test_questions row picks one question. This module is pure.
import { z } from 'zod';
import { Difficulty, QuestionType } from '../generated/prisma/enums';
import { isStorableText } from './text-rules';

export const MAX_RULE_TAGS = 20;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _.+#-]{0,39}$/;

const tag = z
  .string()
  .max(64)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => isStorableText(s) && TAG_PATTERN.test(s), { message: 'not a valid tag' });

const ruleSchema = z.strictObject({
  tags: z
    .array(tag)
    .min(1)
    .max(MAX_RULE_TAGS)
    .refine((a) => new Set(a).size === a.length, { message: 'tags must be unique' })
    .optional(),
  difficulty: z.enum(Difficulty).optional(),
  type: z.enum(QuestionType).optional(),
});

export interface RandomRule {
  tags?: string[];
  difficulty?: Difficulty;
  type?: QuestionType;
}

export type RuleParse = { ok: true; rule: RandomRule } | { ok: false; problems: string[] };

/** Parses and normalizes (lower-case tags). Only keys that were sent appear in the result. */
export function parseRandomRule(raw: unknown): RuleParse {
  const r = ruleSchema.safeParse(raw);
  if (!r.success) {
    return {
      ok: false,
      problems: r.error.issues.map(
        (i) => `randomRule${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`,
      ),
    };
  }
  const rule: RandomRule = {};
  if (r.data.tags !== undefined) rule.tags = r.data.tags;
  if (r.data.difficulty !== undefined) rule.difficulty = r.data.difficulty;
  if (r.data.type !== undefined) rule.type = r.data.type;
  return { ok: true, rule };
}

/** A stable key: two rules with the same key match the same questions. */
export function ruleKey(rule: RandomRule): string {
  return JSON.stringify([
    [...(rule.tags ?? [])].sort(),
    rule.difficulty ?? null,
    rule.type ?? null,
  ]);
}
