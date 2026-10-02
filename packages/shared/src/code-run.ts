import { z } from 'zod';

/** Languages a coding question can offer (FR-501). */
export const codeLanguageSchema = z.enum(['python', 'javascript', 'java']);
export type CodeLanguage = z.infer<typeof codeLanguageSchema>;

/** Body of a sample-test run (FR-502). */
export const runRequestSchema = z.object({
  language: codeLanguageSchema,
  code: z.string().max(100_000),
});
export type RunRequest = z.infer<typeof runRequestSchema>;
