// Every route and body shape the seeder depends on, in one place.
//
// Marker: REAL = checked against apps/api on main (candidate-auth.controller.ts,
// candidate-session.controller.ts, dto/candidate.dto.ts). DOC = pinned by FSD section 4 or an ADR
// but not implemented on main yet. ASSUMED = not pinned anywhere (staff invite body, erasure).
// AVAILABLE says which candidate steps exist on main; a step that is not available fails the seed
// with a named "not available on main yet" error instead of guessing a route.
export const ROUTES = {
  login: '/auth/login', // REAL (apps/api/src/auth); body { email, password } -> { status, session?, challengeToken? }
  verify2fa: '/auth/2fa/verify', // REAL; body { challengeToken, code } -> { accessToken, user }
  invite: (testId) => `/tests/${testId}/invitations`, // DOC path; ASSUMED single-invite body below
  erase: (candidateId) => `/candidates/${encodeURIComponent(candidateId)}/erasure`, // ASSUMED (TC-094, ADR 0004 R-6: no route in fsd 4)
  // REAL, public, no token. Body { invitationToken } -> 200 { state, ... }; sends nothing (TC-021).
  link: '/candidate/session/link',
  // REAL, public. Body { invitationToken } -> 200 { state: 'OTP_SENT', maskedEmail, expiresInSeconds }.
  // 429 OTP_COOLDOWN inside 30 s of the previous code.
  otpRequest: '/candidate/session/otp',
  // REAL, public. Body { invitationToken, otp } -> 200 { sessionToken, sessionTokenExpiresAt, status, serverTime }.
  start: '/candidate/session/start',
  // REAL, bearer. GET -> { consentTextId, version, bodyMd, legalApproved, signed, signedAt }.
  consent: '/candidate/session/consent',
  // REAL, bearer. Body { consentTextId, signedName, confirmedAge18 } -> 200 { status: 'CONSENTED', signedAt }.
  consentSign: '/candidate/session/consent/sign',
  // REAL, bearer. Body {} -> 200 { status, startedAt, deadlineAt, sections[].questions[].sessionQuestionId }.
  startTest: '/candidate/session/test/start',
  // Not on main yet (DOC: ADR 0013 5.4, 5.5).
  systemCheck: '/candidate/session/system-check',
  presign: '/candidate/session/media/presign',
  confirm: '/candidate/session/media/confirm',
};

// Mutable on purpose: the tests switch a step on to exercise the code behind it against the mock.
export const AVAILABLE = {
  systemCheck: false,
  roomScan: false, // presign, upload, confirm; identity is waived by the invitation (C-25, ADR 0015)
  identity: false, // --identity: the identity step with generated synthetic assets (ADR 0013 5.5)
};

export const UNAVAILABLE_MESSAGE = (what) =>
  `${what}: not available on main yet (route missing in apps/api); seeding stops here.`;

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

// REAL: SignConsentDto (FR-401, C-07, C-30).
export function consentBody({ name, consentTextId }) {
  return { consentTextId, signedName: name, confirmedAge18: true };
}

// ADR 0013 5.4 (not on main yet). A clean, synthetic browser report: nothing blocks, no findings.
export function systemCheckBody() {
  return {
    browser: { brand: 'Chrome', majorVersion: 130 },
    network: { downlinkKbps: 20000, rttMs: 40 },
    devices: { camera: true, microphone: true, screenShare: 'MONITOR' },
    findings: [],
    capabilities: [],
  };
}
