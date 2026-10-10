// Every route and body shape the seeder depends on, in one place.
//
// Marker: REAL = checked against apps/api on main (candidate-auth.controller.ts,
// candidate-session.controller.ts, dto/candidate.dto.ts). DOC = pinned by FSD section 4 or an ADR
// but not implemented on main yet. ASSUMED = not pinned anywhere (erasure).
// AVAILABLE says which candidate steps exist on main; a step that is not available fails the seed
// with a named "not available on main yet" error instead of guessing a route.
export const ROUTES = {
  login: '/auth/login', // REAL (apps/api/src/auth); body { email, password } -> { status, session?, challengeToken? }
  verify2fa: '/auth/2fa/verify', // REAL; body { challengeToken, code } -> { accessToken, user }
  invite: (testId) => `/tests/${testId}/invitations`, // REAL path and body (inviteBody below)
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
  roomScan: false, // presign, upload, confirm; identity is a separate step (not waivable through the invitation API)
  identity: false, // --identity: the identity step with generated synthetic assets (ADR 0013 5.5)
};

export const UNAVAILABLE_MESSAGE = (what) =>
  `${what}: not available on main yet (route missing in apps/api); seeding stops here.`;

// REAL (apps/api/src/invitations/dto/invitations.dto.ts): exactly { candidate: { email, name }, windowStart,
// windowEnd }. Any other field is a 400 (whitelist plus forbidNonWhitelisted). windowStart may be at most
// 5 minutes before the server time, the window at most INVITATION_MAX_WINDOW_DAYS (7) long, both ISO 8601
// with a UTC offset. One invitation per request: there is no bulk route. The response is
// { id, testId, candidateId, status, windowStart, windowEnd, createdAt, mail: { outcome } } with outcome
// 'queued' | 'failed' | 'disabled'; there is no session id (the session is created with the invitation).
export function inviteBody({ name, email, now = new Date() }) {
  const start = new Date(now.getTime() - 60_000);
  return {
    candidate: { email, name },
    windowStart: start.toISOString(),
    windowEnd: new Date(start.getTime() + 24 * 3600_000).toISOString(),
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
