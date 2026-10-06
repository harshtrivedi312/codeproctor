// Every route and body shape the seeder depends on, in one place.
//
// Marker: DOC = pinned by FSD section 4 or an ADR (ADR 0013 is still Proposed, so DOC from it is
// 'DOC (Proposed ADR 0013)': re-check when it is accepted); ASSUMED = not pinned anywhere on main (BE-07 is
// not merged at the time of writing), chosen to match the closest doc text. When BE-07/BE-09 land,
// re-check each ASSUMED line against apps/api and packages/shared and edit only this file.
export const ROUTES = {
  login: '/auth/login', // DOC fsd 4; body { email, password } -> { status, session?, challengeToken? }
  verify2fa: '/auth/2fa/verify', // DOC; body { challengeToken, code } -> { accessToken, user }
  invite: (testId) => `/tests/${testId}/invitations`, // DOC path; ASSUMED single-invite body below
  erase: (candidateId) => `/candidates/${candidateId}/erasure`, // ASSUMED (TC-094, ADR 0004 R-6: no route in fsd 4)
  otpRequest: '/candidate/session/otp', // ASSUMED: fsd 4 has no route that sends the OTP email
  start: '/candidate/session/start', // DOC path; ASSUMED body { token, otp } -> { sessionToken, sessionTokenExpiresAt? }
  consent: '/candidate/session/consent', // DOC; GET -> { version?, text }
  consentSign: '/candidate/session/consent/sign', // DOC path; ASSUMED body below (C-30 age confirmation)
  systemCheck: '/candidate/session/system-check', // DOC (Proposed ADR 0013) 5.4
  presign: '/candidate/session/media/presign', // DOC (Proposed ADR 0013) 5.5 (ROOM_SCAN in CONSENTED)
  confirm: '/candidate/session/media/confirm', // DOC (Proposed ADR 0013) 5.5
  startTest: '/candidate/session/test/start', // ASSUMED: ADR 0013 names "the start-test call" without a path
};

// ASSUMED shape; ADR 0015 (Proposed) puts the waiver under accommodations.identityCheckWaiver.
export function inviteBody({ name, email, runId, now = new Date() }) {
  return {
    candidateName: name,
    candidateEmail: email,
    windowStart: new Date(now.getTime() - 60_000).toISOString(),
    windowEnd: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    accommodations: {
      identityCheckWaiver: {
        reasonCode: 'OTHER',
        reasonNote: `Synthetic load-test candidate (${runId}). No real person.`,
      },
    },
  };
}

// ASSUMED: field names of the consent signature (FR-401, C-07, C-30).
export function consentBody({ name, version }) {
  return { fullName: name, ageConfirmed: true, ...(version ? { documentVersion: version } : {}) };
}

// ADR 0013 5.4. A clean, synthetic browser report: nothing blocks, no findings.
export function systemCheckBody() {
  return {
    browser: { brand: 'Chrome', majorVersion: 130 },
    network: { downlinkKbps: 20000, rttMs: 40 },
    devices: { camera: true, microphone: true, screenShare: 'MONITOR' },
    findings: [],
    capabilities: [],
  };
}
