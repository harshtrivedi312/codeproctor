// What a candidate may learn about their own accommodations (ADR 0013 CS-4.4, ADR 0015 section 4,
// ADR 0018 sections 2 and 4). Two booleans, the disabled detector names and a `gate` object of
// booleans. The reason, notes, tools list, assistive input and extra-time detail never leave the
// server on this route; only the recruiter route returns them (audited).
import { PROCTOR_DETECTORS } from '@codeproctor/shared';

// TODO: swap for ACCOMMODATION_DETECTORS from @codeproctor/shared when the hub adds it (ADR 0015
// section 5 / ADR 0018). Until then the allow-list is the full PROCTOR_DETECTORS set.
const KNOWN_DETECTORS: readonly string[] = PROCTOR_DETECTORS;

export interface AccommodationsGate {
  readonly idPhotoUpload: boolean;
  readonly roomScanAlternative: boolean;
  readonly microphoneNotRequired: boolean;
}

export interface AccommodationsProjection {
  readonly identityCheckWaived: boolean;
  readonly faceDetectorsOff: boolean;
  readonly disabledDetectors: string[];
  readonly gate: AccommodationsGate;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A fresh empty projection per call, so no caller can mutate a shared one. */
export function emptyAccommodations(): AccommodationsProjection {
  return {
    identityCheckWaived: false,
    faceDetectorsOff: false,
    disabledDetectors: [],
    gate: { idPhotoUpload: false, roomScanAlternative: false, microphoneNotRequired: false },
  };
}

/** Reads the stored jsonb leniently: a malformed value means "no accommodation", never an error. */
export function projectAccommodations(raw: unknown): AccommodationsProjection {
  if (!isObject(raw)) return emptyAccommodations();
  const stored: unknown[] = Array.isArray(raw.disabledDetectors) ? raw.disabledDetectors : [];
  const names = new Set<string>(
    stored.filter((d): d is string => typeof d === 'string' && KNOWN_DETECTORS.includes(d)),
  );
  const microphoneNotRequired = raw.microphoneNotRequired === true;
  // ADR 0018 section 2: microphoneNotRequired forces VOICE off even if the array lacks it.
  if (microphoneNotRequired) names.add('VOICE');
  return {
    // `identityCheckWaived: true` is the server-only marker left by erasure and R-10.
    identityCheckWaived: isObject(raw.identityCheckWaiver) || raw.identityCheckWaived === true,
    faceDetectorsOff: names.has('FACE'),
    disabledDetectors: [...names].sort(),
    gate: {
      idPhotoUpload: raw.idPhotoUpload === true,
      // Lenient stored object { reasonCode, reasonNote? } (ADR 0018 section 2, row 5); `true` too.
      roomScanAlternative: isObject(raw.roomScanAlternative) || raw.roomScanAlternative === true,
      microphoneNotRequired,
    },
  };
}
