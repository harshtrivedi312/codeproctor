// What `session_questions.answer` holds (ADR 0007 section 5): selected option ids for a multiple
// choice question, the typed text for a short answer. `.strict()` so no extra member is stored.
import { z } from 'zod';
import { isStorableText } from '../questions/text-rules';

const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/;

export const MAX_SHORT_ANSWER_CHARS = 2000;

export const mcqAnswerSchema = z
  .object({ optionIds: z.array(z.string().regex(OPTION_ID)).max(10) })
  .strict();
export type McqAnswer = z.infer<typeof mcqAnswerSchema>;

export const shortAnswerAnswerSchema = z
  .object({ text: z.string().max(MAX_SHORT_ANSWER_CHARS).refine(isStorableText) })
  .strict();
export type ShortAnswerAnswer = z.infer<typeof shortAnswerAnswerSchema>;
