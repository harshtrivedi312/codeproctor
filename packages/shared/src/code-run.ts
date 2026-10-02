import { z } from 'zod';

/** Languages a coding question can offer (FR-501). */
export const codeLanguageSchema = z.enum(['python', 'javascript', 'java']);
export type CodeLanguage = z.infer<typeof codeLanguageSchema>;

/**
 * Upper bound on candidate source code in any request body (run, draft, submit).
 * Mirrored as `maxLength` on RunRequest.code and DraftRequest.code in apps/web/openapi/openapi.yaml.
 */
export const MAX_SOURCE_CODE_LENGTH = 100_000;

/** Body of a sample-test run (FR-502). */
export const runRequestSchema = z.object({
  language: codeLanguageSchema,
  code: z.string().max(MAX_SOURCE_CODE_LENGTH),
});
export type RunRequest = z.infer<typeof runRequestSchema>;
