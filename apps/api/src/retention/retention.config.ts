// Retention switches for the owner's open questions (decisions.md OQ-10, OQ-11, OQ-12, OQ-18, OQ-19,
// OQ-20 and C-17). Each default is the behaviour ADR 0004 section 9 describes (the owner's
// suggested answer where the ADR is silent), and each can be changed without code. Parsed from the
// environment here, not in config/env.ts, so the module stays self-contained.
import { z } from 'zod';

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const retentionConfigSchema = z.object({
  // OQ-10: a SUPER_ADMIN legal hold per candidate pauses all deletion. Off until Legal decides; when
  // on, RetentionService asks LegalHoldPort before touching a candidate's sessions.
  RETENTION_LEGAL_HOLD: flag.default(false),
  // OQ-11: declined consents follow the same 3-year clock from `declined_at`. When false they are
  // kept without a limit (not recommended).
  RETENTION_DECLINED_CONSENTS_EXPIRE: flag.default(true),
  // OQ-12: erasure and R-10 reduce invitations.accommodations to which settings were used, removing
  // free-text notes and the waiver reason. When false the notes are kept.
  RETENTION_REDUCE_ACCOMMODATIONS: flag.default(true),
  // OQ-18: cap on the media tier. Unset: media follows `retention_days` (7..730). Set to 90 for
  // LEAST(retention_days, 90), the owner's suggested answer.
  RETENTION_MEDIA_CAP_DAYS: z.coerce.number().int().min(1).max(730).optional(),
  // OQ-19: evidence frames (events with a face) follow the face tier (90-day cap, no hold). When
  // false they stay with the media tier.
  RETENTION_EVIDENCE_IN_FACE_TIER: flag.default(true),
  // OQ-20: the results clock starts at the retention anchor (after review and appeal), or at
  // `submitted_at`.
  RETENTION_RESULTS_CLOCK: z.enum(['anchor', 'submitted']).default('anchor'),
  // C-17: the consent proof is kept through an erasure request until 3 years after signing. The only
  // other value deletes it at erasure, which Legal has not approved.
  RETENTION_CONSENT_THROUGH_ERASURE: z.enum(['keep', 'delete']).default('keep'),
  // ADR 0004 9.2 versioning gate: pilot and production fail closed unless the bucket can never keep
  // noncurrent versions; staging (Cloudflare R2, synthetic data) may skip the check.
  RETENTION_VERSIONING_CHECK: z.enum(['enforce', 'skip']).default('enforce'),
  // How many sessions one tier visits per run, so a backlog cannot hold a transaction or a run for hours.
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(200),
});

export type RetentionConfig = z.infer<typeof retentionConfigSchema>;

export function loadRetentionConfig(env: Record<string, string | undefined>): RetentionConfig {
  return retentionConfigSchema.parse(env);
}
