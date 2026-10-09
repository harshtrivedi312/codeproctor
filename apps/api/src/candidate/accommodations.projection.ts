// What a candidate may learn about their own accommodations (ADR 0015 section 4, PROVISIONAL web
// projection): two booleans. The reason, notes, tools list and extra-time detail never leave the
// server on this route; only the recruiter route returns them (audited).

export interface AccommodationsProjection {
  readonly identityCheckWaived: boolean;
  readonly faceDetectorsOff: boolean;
}

export const NO_ACCOMMODATIONS: AccommodationsProjection = {
  identityCheckWaived: false,
  faceDetectorsOff: false,
};

/** Reads the stored jsonb leniently: a malformed value means "no accommodation", never an error. */
export function projectAccommodations(raw: unknown): AccommodationsProjection {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return NO_ACCOMMODATIONS;
  const acc = raw as Record<string, unknown>;
  const waiver = acc.identityCheckWaiver;
  const detectors = acc.disabledDetectors;
  return {
    // `identityCheckWaived: true` is the server-only marker left by erasure and R-10.
    identityCheckWaived:
      (typeof waiver === 'object' && waiver !== null && !Array.isArray(waiver)) ||
      acc.identityCheckWaived === true,
    faceDetectorsOff: Array.isArray(detectors) && detectors.includes('FACE'),
  };
}
