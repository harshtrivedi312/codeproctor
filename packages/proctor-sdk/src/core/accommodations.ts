import { proctorDetectorSchema, type ProctorDetector } from '@codeproctor/shared';

/**
 * What a candidate may learn about their accommodations (ADR 0015 section 4,
 * GET /candidate/session/accommodations): two booleans, plus a detector list when the API adds it.
 * No reason, no notes, no tools.
 */
export interface CandidateAccommodations {
  identityCheckWaived: boolean;
  faceDetectorsOff: boolean;
  /** Optional: detectors the recruiter switched off (when the API returns them). */
  disabledDetectors?: readonly ProctorDetector[];
}

export interface DetectorPolicy {
  /** Pass to `ProctorSessionConfig.disabledDetectors`. */
  disabledDetectors: ProctorDetector[];
  /**
   * Pass to `VisionMonitor.identityRecheckEnabled`. The server refuses the re-check when EITHER the
   * identity check is waived OR the face detectors are off (owner decision C-34).
   */
  identityRecheck: boolean;
}

/** Parses the route's JSON. Anything malformed is `null`: the app decides (see `detectorPolicy`). */
export function parseCandidateAccommodations(json: unknown): CandidateAccommodations | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  if (typeof j['identityCheckWaived'] !== 'boolean' || typeof j['faceDetectorsOff'] !== 'boolean') {
    return null;
  }
  const out: CandidateAccommodations = {
    identityCheckWaived: j['identityCheckWaived'],
    faceDetectorsOff: j['faceDetectorsOff'],
  };
  if (Array.isArray(j['disabledDetectors'])) {
    out.disabledDetectors = j['disabledDetectors'].filter(
      (d): d is ProctorDetector => proctorDetectorSchema.safeParse(d).success,
    );
  }
  return out;
}

/**
 * Maps accommodations to what the SDK does (owner decisions C-25 and C-34, ADR 0015):
 * - `faceDetectorsOff` switches the in-browser FACE detector off and, with it, the server
 *   re-check. GAZE and OBJECT go off only when they are in `disabledDetectors`.
 * - `identityCheckWaived` switches the identity re-check off and nothing else: FACE keeps
 *   running. Neither setting implies the other.
 * - `SCREEN_SHARE` is never disabled (FR-604 makes the full-screen share mandatory).
 * `null` (no or unreadable answer) changes nothing: proctoring is never weakened by a missing
 * answer.
 */
export function detectorPolicy(a: CandidateAccommodations | null): DetectorPolicy {
  if (!a) return { disabledDetectors: [], identityRecheck: true };
  const off = new Set<ProctorDetector>();
  for (const d of a.disabledDetectors ?? []) off.add(d);
  if (a.faceDetectorsOff) off.add('FACE');
  return {
    disabledDetectors: [...off],
    identityRecheck: !a.identityCheckWaived && !a.faceDetectorsOff && !off.has('FACE'),
  };
}
