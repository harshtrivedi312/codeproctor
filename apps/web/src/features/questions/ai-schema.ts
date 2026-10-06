import { AI_REFERENCE_LANGUAGES } from '@codeproctor/shared';
import { z } from 'zod';

/**
 * Form for adding or superseding an AI reference solution (ADR 0005, D-20). Web-local [ARC-02].
 * There is no date field: the API stamps `collectedAt` with its own clock.
 */
export const aiReferenceFormSchema = z.object({
  assistant: z
    .string()
    .trim()
    .min(1, 'Enter the assistant, for example ChatGPT or Claude.')
    .max(100, 'Keep it under 100 characters.'),
  modelLabel: z
    .string()
    .trim()
    .min(1, 'Enter the model or version label exactly as the assistant shows it.')
    .max(100, 'Keep it under 100 characters.'),
  language: z.enum(AI_REFERENCE_LANGUAGES as [string, ...string[]], { error: 'Pick a language.' }),
  variantId: z.string(),
  // Not trimmed: the code is stored exactly as pasted (the API only refuses a blank one).
  solutionCode: z
    .string()
    .refine((v) => v.trim() !== '', "Paste the assistant's solution.")
    .max(100_000, 'This solution is too long.'),
  promptText: z.string().max(20_000, 'The prompt is too long.'),
});
export type AiReferenceFormValues = z.infer<typeof aiReferenceFormSchema>;
