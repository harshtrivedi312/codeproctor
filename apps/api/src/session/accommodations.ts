// The part of `invitations.accommodations` the session start needs (FR-305, ADR 0002 S-3, TC-024).
// The full schema belongs to BE-06; this reader is tolerant on purpose: an unknown or malformed
// value means "no accommodation", never a crash at the moment a candidate starts.
import { z } from 'zod';

const MAX_EXTRA_TIME_PCT = 300;

const schema = z.object({
  extraTimePct: z.number().finite().min(0).max(MAX_EXTRA_TIME_PCT).catch(0).default(0),
});

export function extraTimePct(accommodations: unknown): number {
  const parsed = schema.safeParse(
    typeof accommodations === 'object' && accommodations !== null ? accommodations : {},
  );
  return parsed.success ? parsed.data.extraTimePct : 0;
}

/** Minutes scaled by the same factor for the total and for every section (ADR 0002 S-3). */
export function scaledMs(minutes: number, extraPct: number): number {
  return Math.round(minutes * 60_000 * (1 + extraPct / 100));
}
