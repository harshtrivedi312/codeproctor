import { AI_REFERENCE_LANGUAGES } from '@codeproctor/shared';
import { z } from 'zod';

/** Form for adding or superseding an AI reference solution (ADR 0005, D-20). Web-local [ARC-02]. */
export const aiReferenceFormSchema = z.object({
  assistant: z
    .string()
    .trim()
    .min(1, 'Enter the assistant, for example ChatGPT or Claude.')
    .max(80, 'Keep it under 80 characters.'),
  modelLabel: z
    .string()
    .trim()
    .min(1, 'Enter the model or version label exactly as the assistant shows it.')
    .max(80, 'Keep it under 80 characters.'),
  language: z.enum(AI_REFERENCE_LANGUAGES as [string, ...string[]], { error: 'Pick a language.' }),
  variantId: z.string(),
  collectedAt: z
    .string()
    .min(1, 'Enter the date you collected this solution.')
    .refine(
      (v) => new Date(`${v}T00:00:00`).getTime() <= Date.now() + 86_400_000,
      'The date cannot be in the future.',
    ),
  solutionCode: z
    .string()
    .trim()
    .min(1, "Paste the assistant's solution.")
    .max(100_000, 'This solution is too long.'),
  promptText: z.string().max(20_000, 'The prompt is too long.'),
});
export type AiReferenceFormValues = z.infer<typeof aiReferenceFormSchema>;
