import { z } from 'zod';

/**
 * Languages a coding question can offer (FR-501). The single source for every language list:
 * `codeLanguageSchema` and `AI_REFERENCE_LANGUAGES` derive from it (ADR 0010). The placeholder
 * OpenAPI enum in apps/web/openapi/openapi.yaml must match until the code-first spec replaces it.
 */
export const CODE_LANGUAGES = ['python', 'javascript', 'java'] as const;
export const codeLanguageSchema = z.enum(CODE_LANGUAGES);
export type CodeLanguage = z.infer<typeof codeLanguageSchema>;

/**
 * Languages that get AI reference solutions (ADR 0005 §6, D-20). Today every code language; when a
 * language is added for a role, decide here whether it also needs AI references. BE-04 rejects others.
 */
export const AI_REFERENCE_LANGUAGES: readonly CodeLanguage[] = CODE_LANGUAGES;

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
