import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from './auth';

/**
 * Organisation settings contract for GET and PATCH /admin/org-settings (docs/api-contract.md
 * section 2; ADR 0007 section 6, database.md `organizations.settings`).
 *
 * The allowlist is strict at every nesting level and grows only by its owner's decision. Today it
 * holds `aiReferences.minAssistants` (ADR 0005 AI-5). A request schema is for request bodies only:
 * reading stored settings uses a narrow reader that looks at one path and never fails on a stored
 * key outside the allowlist (api-contract section 2, "One reader, parsed narrowly").
 */

/** Default of `aiReferences.minAssistants` (ADR 0005 AI-5, D-20). */
export const DEFAULT_MIN_ASSISTANTS = 2;
/** Largest accepted or honoured `aiReferences.minAssistants` (architect detail; ADR 0005 gives none). */
export const MAX_MIN_ASSISTANTS = 5;

const minAssistantsSchema = z.int().min(0).max(MAX_MIN_ASSISTANTS);

/** The effective settings (GET response, and the PATCH response): every allowed key present. */
export const orgSettingsSchema = z.strictObject({
  aiReferences: z.strictObject({ minAssistants: minAssistantsSchema }),
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

/** The settings part of a PATCH body: partial and strict; null and unknown keys are refused. */
export const orgSettingsPatchSchema = z.strictObject({
  aiReferences: z.strictObject({ minAssistants: minAssistantsSchema.optional() }).optional(),
});
export type OrgSettingsPatch = z.infer<typeof orgSettingsPatchSchema>;

/** True when the patch changes no key (`{}`, `{ aiReferences: {} }`): the route answers 400. */
export function isEmptyOrgSettingsPatch(patch: OrgSettingsPatch): boolean {
  return patch.aiReferences?.minAssistants === undefined;
}

/**
 * The full PATCH body: step-up `currentPassword` (validated and discarded, never stored, logged or
 * audited; same bound as login) plus the settings patch, strict, with at least one settings key.
 */
export const orgSettingsPatchBodySchema = z
  .strictObject({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    aiReferences: orgSettingsPatchSchema.shape.aiReferences,
  })
  .refine((body) => !isEmptyOrgSettingsPatch({ aiReferences: body.aiReferences }), {
    message: 'Send at least one setting.',
    path: ['aiReferences'],
  });
export type OrgSettingsPatchBody = z.infer<typeof orgSettingsPatchBodySchema>;
