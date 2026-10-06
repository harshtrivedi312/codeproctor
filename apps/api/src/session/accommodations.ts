// The part of `invitations.accommodations` the session start needs (FR-305, ADR 0002 S-3, TC-024).
// The full schema belongs to BE-06; this reader is tolerant on purpose: an unknown or malformed
// value means "no accommodation", never a crash at the moment a candidate starts.
import { z } from 'zod';

// The same cap BE-06 puts on the recruiter's input (300 per cent). A value beyond it means a row
// BE-06 would not have written, so it is treated as no accommodation, with a warning.
export const MAX_EXTRA_TIME_PCT = 300;

const schema = z.object({
  extraTimePct: z.number().finite().min(0).max(MAX_EXTRA_TIME_PCT).catch(0).default(0),
});

/** The percentage and whether the stored value had to be ignored (present but malformed or over the cap). */
export function readExtraTime(accommodations: unknown): { pct: number; ignored: boolean } {
  const obj =
    typeof accommodations === 'object' && accommodations !== null
      ? (accommodations as Record<string, unknown>)
      : {};
  const raw = obj.extraTimePct;
  if (raw === undefined || raw === null) return { pct: 0, ignored: false };
  const ok =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= MAX_EXTRA_TIME_PCT;
  return ok ? { pct: raw, ignored: false } : { pct: 0, ignored: true };
}

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
