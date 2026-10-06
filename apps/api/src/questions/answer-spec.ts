// answer_spec shapes (ADR 0007 section 5, D-23, FR-205). One zod schema per question type; the
// column is null for CODING. answer_spec is never sent to candidates (see candidate-view.ts).
import { z } from 'zod';
import { isStorableText } from './text-rules';

const text = (min: number, max: number): z.ZodString => z.string().min(min).max(max);
const storable = { message: 'contains a NUL byte or a lone surrogate' };

const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/;

export const mcqAnswerSpecSchema = z
  .object({
    options: z
      .array(
        z.object({
          id: z.string().regex(OPTION_ID),
          text: text(1, 1000).refine(isStorableText, storable),
        }),
      )
      .min(2)
      .max(10),
    correctOptionIds: z.array(z.string().regex(OPTION_ID)).min(1).max(10),
    multiple: z.boolean(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const ids = spec.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'option ids must be unique' });
    }
    if (new Set(spec.correctOptionIds).size !== spec.correctOptionIds.length) {
      ctx.addIssue({ code: 'custom', message: 'correctOptionIds must be unique' });
    }
    if (!spec.correctOptionIds.every((id) => ids.includes(id))) {
      ctx.addIssue({ code: 'custom', message: 'correctOptionIds must name existing options' });
    }
    if (!spec.multiple && spec.correctOptionIds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'a single-choice question has exactly one correct option',
      });
    }
  });
export type McqAnswerSpec = z.infer<typeof mcqAnswerSpecSchema>;

/** D-23: normalization is Unicode NFKC, trim, collapse inner whitespace, lower-case. */
export function normalizeShortAnswer(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export const shortAnswerSpecSchema = z
  .object({
    canonical: text(1, 500).refine(isStorableText, storable),
    acceptedVariants: z.array(text(1, 500).refine(isStorableText, storable)).max(20),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (normalizeShortAnswer(spec.canonical) === '') {
      ctx.addIssue({ code: 'custom', message: 'canonical answer is empty after normalization' });
    }
    if (spec.acceptedVariants.some((v) => normalizeShortAnswer(v) === '')) {
      ctx.addIssue({ code: 'custom', message: 'an accepted variant is empty after normalization' });
    }
  });
export type ShortAnswerSpec = z.infer<typeof shortAnswerSpecSchema>;

export function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map(
    (i) => `${prefix}${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`,
  );
}
