// What retention does to `invitations.accommodations` (ADR 0015 section 7, ADR 0004 9.4 and 9.5,
// OQ-12). The value is health-adjacent: free-text `notes`, and the identity-check waiver's reason,
// whose `reasonNote` can hold health details. Pure functions on plain JSON; the caller does the
// compare-and-set write. Stored shape (ADR 0015 section 7): extraTimePct, disabledDetectors,
// allowedAssistiveTools, notes, identityCheckWaiver { reasonCode, reasonNote?, reasonNoteRemoved? },
// and the server-only identityCheckWaived: true.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The settings that say which accommodations were used: kept through erasure and R-10 (OQ-12). */
const KEPT_SETTINGS = ['extraTimePct', 'disabledDetectors', 'allowedAssistiveTools'] as const;

/**
 * R-4 (media tier): drop `identityCheckWaiver.reasonNote` and set `reasonNoteRemoved: true`, the
 * marker ADR 0015 uses for a redaction. Returns null when there is nothing to remove, so no write
 * happens (and a note a person has redacted already stays as it is).
 */
export function redactReasonNote(accommodations: unknown): Obj | null {
  if (!isObject(accommodations)) return null;
  const waiver = accommodations['identityCheckWaiver'];
  if (!isObject(waiver) || !('reasonNote' in waiver)) return null;
  const { reasonNote: _removed, ...rest } = waiver;
  void _removed;
  return { ...accommodations, identityCheckWaiver: { ...rest, reasonNoteRemoved: true } };
}

/**
 * Erasure and R-10 (OQ-12): keep which settings were used, remove `notes` and the whole waiver
 * (reason code and note), and keep the fact of the waiver as the server-only `identityCheckWaived:
 * true`. Returns null when the value is already reduced (no write).
 */
export function reduceAccommodations(accommodations: unknown): Obj | null {
  if (!isObject(accommodations)) return null;
  const reduced: Obj = {};
  for (const key of KEPT_SETTINGS) {
    const value = accommodations[key];
    if (value !== undefined) reduced[key] = value;
  }
  if (hasWaiver(accommodations)) reduced['identityCheckWaived'] = true;
  return JSON.stringify(sorted(reduced)) === JSON.stringify(sorted(accommodations))
    ? null
    : reduced;
}

/**
 * R-10 with the OQ-12 switch off: the free-text `notes` and other keys stay, but the waiver is always
 * reduced to the fact of it (ADR 0015 section 7: R-10 replaces `identityCheckWaiver` with
 * `identityCheckWaived: true` whatever OQ-12 decides). Its reason code and note are health-adjacent.
 */
export function reduceWaiverOnly(accommodations: unknown): Obj | null {
  if (!isObject(accommodations) || !isObject(accommodations['identityCheckWaiver'])) return null;
  const { identityCheckWaiver: _waiver, ...rest } = accommodations;
  void _waiver;
  return { ...rest, identityCheckWaived: true };
}

/** A stored waiver is an object (or the server-only flag): `null` or a string is not a valid shape. */
function hasWaiver(accommodations: Obj): boolean {
  return (
    isObject(accommodations['identityCheckWaiver']) ||
    accommodations['identityCheckWaived'] === true
  );
}

function sorted(value: Obj): Obj {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
