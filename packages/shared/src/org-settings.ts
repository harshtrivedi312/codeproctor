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

/**
 * The effective settings values: every allowed key present, defaults applied. `OrgSettings` here is
 * the current allowlist; database.md and ADR 0007 section 6 use the name for the full stored jsonb
 * shape, which grows as keys are approved.
 */
export const orgSettingsSchema = z.strictObject({
  aiReferences: z.strictObject({ minAssistants: minAssistantsSchema }),
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

/**
 * The GET and PATCH response (api-contract section 2): the effective values, plus `isDefault` per
 * setting, true when no valid value is stored and the default applies. Parse responses with this
 * schema, not with `orgSettingsSchema`.
 */
export const orgSettingsViewSchema = z.strictObject({
  aiReferences: z.strictObject({ minAssistants: minAssistantsSchema, isDefault: z.boolean() }),
});
export type OrgSettingsView = z.infer<typeof orgSettingsViewSchema>;

/** The settings part of a PATCH body: partial and strict; null and unknown keys are refused. */
export const orgSettingsPatchSchema = z.strictObject({
  aiReferences: z.strictObject({ minAssistants: minAssistantsSchema.optional() }).optional(),
});
export type OrgSettingsPatch = z.infer<typeof orgSettingsPatchSchema>;

/**
 * True when the patch sets no key (`{}`, `{ aiReferences: {} }`): the route answers 400. Generic:
 * any leaf that is not undefined counts, so a key added to the allowlist needs no change here.
 */
export function isEmptyOrgSettingsPatch(patch: unknown): boolean {
  if (typeof patch !== 'object' || patch === null) return patch === undefined;
  return Object.values(patch).every((v) => isEmptyOrgSettingsPatch(v));
}

/**
 * The full PATCH body: step-up `currentPassword` (validated and discarded, never stored, logged or
 * audited; same bound as login) plus the settings patch, strict, with at least one settings key.
 */
export const orgSettingsPatchBodySchema = z
  .strictObject({
    ...orgSettingsPatchSchema.shape,
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .refine(
    (body) => {
      const settings: Record<string, unknown> = { ...body };
      delete settings['currentPassword'];
      return !isEmptyOrgSettingsPatch(settings);
    },
    { message: 'Send at least one setting.', path: ['aiReferences'] },
  );
export type OrgSettingsPatchBody = z.infer<typeof orgSettingsPatchBodySchema>;
