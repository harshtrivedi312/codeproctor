import { http, HttpResponse } from 'msw';
import { apiBaseUrl } from '@/lib/env';
import type {
  ConsentDocument,
  LinkState,
  SessionStatus,
  SystemCheckBody,
} from '@/features/candidate-flow/wire';

/**
 * PROVISIONAL candidate pre-test mocks (contract not final; see features/candidate-flow/wire.ts).
 * Remove them when BE-07 (link, otp, start, consent, test/start) and BE-08/BE-09 (identity,
 * presign) are merged and the generated client covers the routes (ADR 0012).
 *
 * Scenarios are picked by the invitation token, so a developer can open
 * /t/<token> in mock mode and walk any path. Tokens are fake and have no meaning outside mocks.
 * Nothing here is realistic security: do not copy it into the real API.
 */
export const MOCK_TOKENS = {
  open: 'mock-open-invitation-token-0001',
  used: 'mock-used-invitation-token-0002',
  expired: 'mock-expired-invitation-token-0003',
  declined: 'mock-declined-invitation-token-0004',
  blocked: 'mock-blocked-invitation-token-0005',
  notYetOpen: 'mock-notyet-invitation-token-0006',
  /** The consent text is an unapproved placeholder: the unavailable screen must appear. */
  placeholderConsent: 'mock-placeholder-consent-token-0007',
  /** The API flags the consent text as needing legal approval. */
  approvalRequired: 'mock-approval-required-token-0008',
  /** Identity check waived by the recruiter (ADR 0015). */
  waived: 'mock-waived-identity-token-0009',
  /** First identity attempt asks for one retry. */
  lowConfidence: 'mock-lowconfidence-token-0010',
  /** Test already running: the OTP resumes it (ADR 0002, TC-097). */
  resume: 'mock-resume-invitation-token-0011',
  /** A second code within 30 s is refused (OTP_COOLDOWN). */
  cooldown: 'mock-cooldown-invitation-token-0012',
  /** Already CONSENTED: resumes at the system check. */
  consented: 'mock-consented-invitation-token-0013',
} as const;

export const MOCK_OTP = '123456';
export const MOCK_EXPIRED_OTP = '000000';
export const MOCK_RECRUITER_CONTACT = 'Jordan Lee, recruiting@acme-hiring.test';
export const MOCK_CONSENT_ID = '3f0e2a7c-6a52-4d5b-9a53-7e9b6a1c2d10';

/** An approved-looking text with no placeholders. Long enough to need scrolling. */
export const MOCK_CONSENT_BODY = [
  '# Your consent for this proctored coding assessment',
  '',
  'Please read this document to the end. It explains what we record, how we check your identity, who sees the results and how long we keep your data. At the end you sign by typing your full legal name.',
  '',
  '## 1. What we record',
  '',
  ...Array.from({ length: 6 }, (_, i) => `Section ${i + 1} of the mock text. `.repeat(12) + '\n'),
  '## 2. Your choices',
  '',
  '- You may decline at the end of this document. Nothing will be recorded.',
  '- You may ask for accommodations before you start.',
  '',
  'See the [retention schedule](https://example.org/retention) for details.',
].join('\n');

export const MOCK_PLACEHOLDER_BODY = [
  '# Consent document',
  '',
  'Document version [x.y] · [company name]',
  '',
  'LEGAL PLACEHOLDER: this text has not been approved. '.repeat(6),
].join('\n');

interface SessionRecord {
  scenario: string;
  status: SessionStatus | 'DECLINED';
  identityAttempts: number;
  uploads: number;
}

interface LinkRecord {
  wrongCodes: number;
  lastOtpAt: number;
  lastWrongAt: number;
}

const sessions = new Map<string, SessionRecord>();
const links = new Map<string, LinkRecord>();
let counter = 0;

/** Tests call this between cases. */
export function resetMockCandidateState(): void {
  sessions.clear();
  links.clear();
  counter = 0;
}

function scenarioOf(token: string): string {
  const found = Object.entries(MOCK_TOKENS).find(([, v]) => v === token);
  return found ? found[0] : 'open';
}

function linkState(scenario: string): LinkState {
  switch (scenario) {
    case 'used':
      return 'ALREADY_USED';
    case 'expired':
      return 'EXPIRED';
    case 'declined':
      return 'DECLINED';
    case 'blocked':
      return 'BLOCKED';
    case 'notYetOpen':
      return 'NOT_YET_OPEN';
    default:
      return 'OTP_REQUIRED';
  }
}

function problem(status: number, code: string, headers?: Record<string, string>): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: code, status, code, detail: 'Mock problem' },
    { status, ...(headers ? { headers } : {}) },
  );
}

function bearer(request: Request): SessionRecord | null {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return sessions.get(token) ?? null;
}

const WINDOW = { windowStart: '2026-10-05T09:00:00.000Z', windowEnd: '2026-10-12T09:00:00.000Z' };

export function createCandidateHandlers() {
  const base = `${apiBaseUrl}/v1/candidate/session`;
  const link = (token: string): LinkRecord => {
    let rec = links.get(token);
    if (!rec) {
      rec = { wrongCodes: 0, lastOtpAt: 0, lastWrongAt: 0 };
      links.set(token, rec);
    }
    return rec;
  };

  return [
    http.post(`${base}/link`, async ({ request }) => {
      const { invitationToken } = (await request.json()) as { invitationToken: string };
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(invitationToken)) return problem(404, 'NOT_FOUND');
      const state = linkState(scenarioOf(invitationToken));
      return HttpResponse.json({
        state,
        orgName: 'Acme Hiring',
        declineContact: state === 'DECLINED' ? MOCK_RECRUITER_CONTACT : null,
        retryAfterSeconds: state === 'BLOCKED' ? 1800 : null,
        ...WINDOW,
      });
    }),

    http.post(`${base}/otp`, async ({ request }) => {
      const { invitationToken } = (await request.json()) as { invitationToken: string };
      const scenario = scenarioOf(invitationToken);
      const state = linkState(scenario);
      if (state !== 'OTP_REQUIRED') {
        return HttpResponse.json({
          state,
          maskedEmail: null,
          expiresInSeconds: 600,
          retryAfterSeconds: state === 'BLOCKED' ? 1800 : null,
          declineContact: state === 'DECLINED' ? MOCK_RECRUITER_CONTACT : null,
        });
      }
      const rec = link(invitationToken);
      const now = Date.now();
      if (scenario === 'cooldown' && now - rec.lastOtpAt < 30_000 && rec.lastOtpAt > 0) {
        return problem(429, 'OTP_COOLDOWN', { 'Retry-After': '30' });
      }
      rec.lastOtpAt = now;
      return HttpResponse.json({
        state: 'OTP_SENT',
        maskedEmail: 'a***@candidate.test',
        expiresInSeconds: 600,
        retryAfterSeconds: null,
        declineContact: null,
      });
    }),

    http.post(`${base}/start`, async ({ request }) => {
      const { invitationToken, otp } = (await request.json()) as {
        invitationToken: string;
        otp: string;
      };
      const scenario = scenarioOf(invitationToken);
      const rec = link(invitationToken);
      const running = scenario === 'resume';
      if (otp !== MOCK_OTP) {
        if (otp === MOCK_EXPIRED_OTP) return problem(400, 'OTP_NOT_REQUESTED');
        if (running) {
          // D-21, TC-097: no block during a test, only a 30 s cooldown after a wrong code.
          if (Date.now() - rec.lastWrongAt < 30_000 && rec.lastWrongAt > 0) {
            return problem(429, 'OTP_COOLDOWN', { 'Retry-After': '30' });
          }
          rec.lastWrongAt = Date.now();
          return problem(400, 'OTP_INVALID');
        }
        rec.wrongCodes += 1;
        if (rec.wrongCodes >= 5) return problem(429, 'LINK_BLOCKED', { 'Retry-After': '1800' });
        return problem(400, 'OTP_INVALID');
      }
      counter += 1;
      const sessionToken = `mock-session-token-${counter}`;
      const status: SessionStatus =
        scenario === 'resume' ? 'IN_PROGRESS' : scenario === 'consented' ? 'CONSENTED' : 'OPENED';
      sessions.set(sessionToken, { scenario, status, identityAttempts: 0, uploads: 0 });
      return HttpResponse.json({
        sessionToken,
        sessionTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        status,
        serverTime: new Date().toISOString(),
      });
    }),

    http.get(`${base}/consent`, ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      const doc: ConsentDocument = {
        consentTextId: MOCK_CONSENT_ID,
        version: s.scenario === 'placeholderConsent' ? '[x.y]' : '1.0',
        bodyMd: s.scenario === 'placeholderConsent' ? MOCK_PLACEHOLDER_BODY : MOCK_CONSENT_BODY,
        legalApproved: s.scenario !== 'placeholderConsent',
        ...(s.scenario === 'approvalRequired' ? { legalApprovalRequired: true } : {}),
        signed: s.status !== 'OPENED',
        signedAt: null,
      };
      return HttpResponse.json(doc);
    }),

    http.post(`${base}/consent/sign`, async ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      const body = (await request.json()) as {
        consentTextId?: string;
        signedName?: string;
        confirmedAge18?: boolean;
      };
      if (
        body.consentTextId !== MOCK_CONSENT_ID ||
        typeof body.signedName !== 'string' ||
        body.signedName.trim().length < 2 ||
        body.confirmedAge18 !== true
      ) {
        return problem(400, 'VALIDATION_FAILED');
      }
      s.status = 'CONSENTED';
      return HttpResponse.json({ status: 'CONSENTED', signedAt: new Date().toISOString() });
    }),

    http.post(`${base}/consent/decline`, ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      s.status = 'DECLINED';
      return HttpResponse.json({ status: 'DECLINED', declineContact: MOCK_RECRUITER_CONTACT });
    }),

    http.get(`${base}/accommodations`, ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      return HttpResponse.json({
        identityCheckWaived: s.scenario === 'waived',
        faceDetectorsOff: false,
      });
    }),

    http.post(`${base}/system-check`, async ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      const body = (await request.json()) as SystemCheckBody;
      const blocking: ('MULTI_MONITOR' | 'DEVICE_MISSING' | 'SCREEN_SHARE_NOT_MONITOR')[] = [];
      if (body.findings.some((f) => f.type === 'MULTI_MONITOR')) blocking.push('MULTI_MONITOR');
      if (!body.devices.camera || !body.devices.microphone) blocking.push('DEVICE_MISSING');
      if (body.devices.screenShare === 'OTHER') blocking.push('SCREEN_SHARE_NOT_MONITOR');
      return HttpResponse.json({ passed: blocking.length === 0, blocking });
    }),

    http.post(`${base}/evidence/presign`, async ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      if (s.scenario === 'waived') return problem(409, 'IDENTITY_CHECK_WAIVED');
      const body = (await request.json()) as { purpose: string };
      s.uploads += 1;
      return HttpResponse.json({
        url: `${apiBaseUrl}/mock-upload/${s.uploads}`,
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        evidenceKey: `${body.purpose.toLowerCase()}-name-${s.uploads}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }),

    http.put(`${apiBaseUrl}/mock-upload/:id`, () => new HttpResponse(null, { status: 200 })),

    http.post(`${base}/identity`, ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      s.identityAttempts += 1;
      // The candidate only ever learns "received". The retry hint carries no score (ADR 0004).
      return HttpResponse.json({
        status: 'RECEIVED',
        attempt: Math.min(2, s.identityAttempts),
        retrySuggested: s.scenario === 'lowConfidence' && s.identityAttempts === 1,
      });
    }),

    http.post(`${base}/test/start`, ({ request }) => {
      const s = bearer(request);
      if (!s) return problem(401, 'UNAUTHENTICATED');
      return HttpResponse.json({ status: 'IN_PROGRESS', serverTime: new Date().toISOString() });
    }),
  ];
}
