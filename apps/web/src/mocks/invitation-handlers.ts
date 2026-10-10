import { hasPermission } from '@codeproctor/shared';
import { delay, http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import {
  ensureMockCandidate,
  mockCandidateExists,
  mockCandidateIdByEmail,
  mockCandidateIds,
  setCandidateEnricher,
} from './admin-handlers';
import { mockRoleFromToken } from './auth-handlers';
import { markTestInvited, mockTestExists, mockTestName } from './test-handlers';

/*
 * Mock of the invitations and candidate status routes (FR-303..FR-305). The single invite follows
 * the real API (invitations.service.ts): 400 for a window in the past, 422 only when the test is
 * unsatisfiable, `mail` is queued | failed | disabled. The bulk route, the limits and the candidate
 * timeline are the web's proposal (docs/followups/frontend.md) [BE-06b]. In memory; fake
 * people only. Never logs a row. Status and times only: no scores, flags or verdicts (C-28).
 */

type Status = Schemas['SessionStatus'];
type Step = Schemas['StatusStep'];

export interface InvitationScenario {
  /** ADR 0015: the global flag for the REFUSED_BIOMETRIC_PROCESSING reason; off answers 422 REASON_NOT_ENABLED. */
  biometricRefusalEnabled: boolean;
  /** Invitations one organisation may create per hour (the API will have a limit; its size is unknown). */
  limitPerHour: number;
  /** FR-303: what the API says happened to the email. 'disabled' is what EMAIL_PROVIDER=noop gives. */
  mail: Schemas['MailOutcome'];
  /** Emails (lower case) whose mail is 'failed' whatever `mail` says: a mixed bulk upload. */
  mailFailedEmails: string[];
  /** The test cannot be given right now: the API answers 422 with errors[] naming slots. */
  testUnsatisfiable: boolean;
  /**
   * Whether the API accepts `accommodations` on an invitation. The real DTO does not today, and the
   * ValidationPipe is forbidNonWhitelisted, so it answers 400 "property accommodations should not exist".
   */
  acceptsAccommodations: boolean;
  /** The candidate has asked for erasure: the API answers 409 "This candidate cannot be invited." */
  candidateErased: boolean;
}

interface MockInvitation {
  id: string;
  testId: string;
  candidateId: string;
  status: Status;
  windowStart: string;
  windowEnd: string;
  history: Step[];
  accommodations: Schemas['InvitationAccommodations'] | null;
  createdAt: string;
}
interface State {
  invitations: MockInvitation[];
  seq: number;
  usedThisHour: number;
  scenario: InvitationScenario;
}

const TERMINAL: readonly Status[] = ['EXPIRED', 'DECLINED', 'COMPLETED', 'ERASED'];
const MOCK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const DETECTORS = [
  'FACE',
  'GAZE',
  'OBJECT',
  'VOICE',
  'MULTI_MONITOR',
  'DEVTOOLS',
  'VIRTUAL_CAMERA',
  'EXTENSION',
];
const REASONS = ['REFUSED_BIOMETRIC_PROCESSING', 'CANNOT_COMPLETE_ID_CHECK', 'OTHER'];

/** The statuses a session passes on the way to `status` (ADR 0002), with times counted back from `hoursAgo`. */
function pathTo(status: Status, hoursAgo: number): Step[] {
  const normal: Status[] = [
    'INVITED',
    'OPENED',
    'CONSENTED',
    'VERIFIED',
    'IN_PROGRESS',
    'SUBMITTED',
    'GRADED',
    'UNDER_REVIEW',
    'COMPLETED',
    'APPEALED',
  ];
  let chain: Status[];
  if (status === 'EXPIRED') chain = ['INVITED', 'EXPIRED'];
  else if (status === 'DECLINED') chain = ['INVITED', 'OPENED', 'DECLINED'];
  else if (status === 'ERASED')
    chain = [...normal.slice(0, normal.indexOf('COMPLETED') + 1), 'ERASED'];
  else if (status === 'PAUSED')
    chain = ['INVITED', 'OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS', 'PAUSED'];
  else chain = normal.slice(0, normal.indexOf(status) + 1);
  return chain.map((st, i) => ({
    status: st,
    at: new Date(Date.now() - (hoursAgo - (i * hoursAgo) / chain.length) * 3_600_000).toISOString(),
  }));
}

function seed(): State {
  const statuses: Status[] = [
    'COMPLETED',
    'APPEALED',
    'UNDER_REVIEW',
    'COMPLETED',
    'SUBMITTED',
    'IN_PROGRESS',
    'PAUSED',
    'VERIFIED',
    'CONSENTED',
    'OPENED',
    'INVITED',
    'EXPIRED',
    'DECLINED',
    'GRADED',
  ];
  const ids = mockCandidateIds();
  const now = Date.now();
  return {
    seq: 1,
    usedThisHour: 0,
    scenario: {
      biometricRefusalEnabled: false,
      limitPerHour: 1000,
      mail: 'queued',
      mailFailedEmails: [],
      testUnsatisfiable: false,
      acceptsAccommodations: false,
      candidateErased: false,
    },
    invitations: ids.slice(0, statuses.length).map((candidateId, i) => ({
      id: `inv-${i + 1}`,
      testId: 'test-backend',
      candidateId,
      status: statuses[i] as Status,
      windowStart: new Date(now - (10 + i) * 86_400_000).toISOString(),
      windowEnd: new Date(now + (7 - i) * 86_400_000).toISOString(),
      history: pathTo(statuses[i] as Status, 24 * (i + 2)),
      accommodations: null,
      createdAt: new Date(now - (11 + i) * 86_400_000).toISOString(),
    })),
  };
}

let state: State = seed();
export function resetMockInvitationState(): void {
  state = seed();
}
/** Tests and demos: choose how the API's global switches and limits behave. */
export function setInvitationScenario(scenario: Partial<InvitationScenario>): void {
  state.scenario = { ...state.scenario, ...scenario };
}
export const mockInvitationCount = (): number => state.invitations.length;

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
};
const problem = (
  status: number,
  detail: string,
  errors?: string[],
  code?: string,
  headers?: Record<string, string>,
) =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status,
      detail: errors ? 'Request validation failed' : detail,
      instance: '/mock',
      traceId: 'mock-trace',
      ...(errors ? { errors } : {}),
      ...(code ? { code } : {}),
    },
    { status, ...(headers ? { headers } : {}) },
  );

function allowed(request: Request): Response | null {
  const role = mockRoleFromToken(request.headers.get('authorization'));
  if (!role) return problem(401, 'Sign in again.');
  return hasPermission(role, 'invitation:create')
    ? null
    : problem(403, 'Your role does not allow this.');
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const EMAIL = /^[^\s@"(),:;<>[\\\]]+@[^\s@"(),:;<>[\\\]]+\.[^\s@"(),:;<>[\\\]]{2,}$/;
const validEmail = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 254 && EMAIL.test(v) && !v.includes('..');
const unknownKeys = (b: Record<string, unknown>, keys: readonly string[], at = ''): string[] =>
  Object.keys(b)
    .filter((k) => !keys.includes(k))
    .map((k) => `property ${at}${k} should not exist`);

function candidateProblems(raw: unknown, at: string): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return [`${at} must be an object`];
  const c = raw as Record<string, unknown>;
  const out = unknownKeys(c, ['email', 'name'], `${at}.`);
  if (!validEmail(typeof c.email === 'string' ? c.email.trim() : c.email))
    out.push(`${at}.email must be an email`);
  if (typeof c.name !== 'string' || c.name.trim().length < 1 || c.name.trim().length > 200)
    out.push(`${at}.name must be 1 to 200 characters`);
  return out;
}

function accommodationProblems(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return ['accommodations must be an object'];
  const a = raw as Record<string, unknown>;
  const out = unknownKeys(
    a,
    ['extraTimePct', 'disabledDetectors', 'allowedAssistiveTools', 'notes', 'identityCheckWaiver'],
    'accommodations.',
  );
  if (
    a.extraTimePct !== undefined &&
    (!isInt(a.extraTimePct) || a.extraTimePct < 0 || a.extraTimePct > 200)
  )
    out.push('accommodations.extraTimePct must be an integer from 0 to 200');
  if (a.disabledDetectors !== undefined) {
    const d = a.disabledDetectors;
    if (
      !Array.isArray(d) ||
      d.some((x) => !DETECTORS.includes(String(x))) ||
      new Set(d).size !== d.length
    )
      out.push('accommodations.disabledDetectors must be unique detector names');
  }
  if (a.allowedAssistiveTools !== undefined) {
    const t = a.allowedAssistiveTools;
    if (
      !Array.isArray(t) ||
      t.length > 10 ||
      t.some((x) => typeof x !== 'string' || x.length < 1 || x.length > 80)
    )
      out.push(
        'accommodations.allowedAssistiveTools must be at most 10 names of 1 to 80 characters',
      );
  }
  if (a.notes !== undefined && (typeof a.notes !== 'string' || a.notes.length > 1000))
    out.push('accommodations.notes must be at most 1000 characters');
  if (a.identityCheckWaiver !== undefined) {
    const w = a.identityCheckWaiver;
    if (typeof w !== 'object' || w === null)
      out.push('accommodations.identityCheckWaiver must be an object');
    else {
      const r = w as Record<string, unknown>;
      out.push(
        ...unknownKeys(r, ['reasonCode', 'reasonNote'], 'accommodations.identityCheckWaiver.'),
      );
      if (!REASONS.includes(str(r.reasonCode)))
        out.push(
          'accommodations.identityCheckWaiver.reasonCode must be one of the following values: ' +
            REASONS.join(', '),
        );
      if (r.reasonCode === 'OTHER') {
        if (
          typeof r.reasonNote !== 'string' ||
          r.reasonNote.trim().length < 1 ||
          r.reasonNote.length > 500
        )
          out.push(
            'accommodations.identityCheckWaiver.reasonNote is required for OTHER: 1 to 500 characters',
          );
      } else if (r.reasonNote !== undefined)
        out.push('accommodations.identityCheckWaiver.reasonNote is allowed only with OTHER');
    }
  }
  return out;
}

/** The ValidationPipe part: both values are ISO 8601 instants. */
function windowFormatProblems(b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['windowStart', 'windowEnd'] as const) {
    if (typeof b[k] !== 'string' || Number.isNaN(Date.parse(b[k])))
      out.push(`${k} must be an ISO 8601 date string`);
  }
  return out;
}

const DAY = 86_400_000;
const MAX_WINDOW_DAYS = 7;
const MAX_START_AHEAD_DAYS = 366;

/** The service part (invitations.service.ts window()): all rules, reported together as the API does. */
function windowRuleProblems(b: Record<string, unknown>): string[] {
  const start = Date.parse(b.windowStart as string);
  const end = Date.parse(b.windowEnd as string);
  const now = Date.now();
  const out: string[] = [];
  if (end <= start) out.push('windowEnd must be after windowStart');
  if (end <= now) out.push('windowEnd must be in the future');
  if (end - start > MAX_WINDOW_DAYS * DAY)
    out.push(`the window may be at most ${MAX_WINDOW_DAYS} day(s) long`);
  if (now - start > 5 * 60_000) out.push('windowStart may be at most 5 minutes in the past');
  if (start - now > MAX_START_AHEAD_DAYS * DAY)
    out.push(`windowStart may be at most ${MAX_START_AHEAD_DAYS} days ahead`);
  return out;
}

const mailFor = (email: string): Schemas['MailOutcome'] =>
  state.scenario.mailFailedEmails.includes(email.trim().toLowerCase())
    ? 'failed'
    : state.scenario.mail;

/** The real answer when the test cannot be given: detail "Request validation failed", errors[] by slot. */
const unsatisfiable = () =>
  problem(422, 'x', [
    'sections[0].questions[0].randomRule matches 0 question(s) not already used; 1 needed',
  ]);

const openFor = (testId: string, candidateId: string): boolean =>
  state.invitations.some(
    (i) => i.testId === testId && i.candidateId === candidateId && !TERMINAL.includes(i.status),
  );

function create(
  testId: string,
  c: { email: string; name: string },
  windowStart: string,
  windowEnd: string,
  accommodations: Schemas['InvitationAccommodations'] | null,
): MockInvitation {
  const { id: candidateId } = ensureMockCandidate(c.email.trim(), c.name.trim());
  state.seq += 1;
  const now = new Date().toISOString();
  const inv: MockInvitation = {
    id: `inv-new-${state.seq}`,
    testId,
    candidateId,
    status: 'INVITED',
    windowStart,
    windowEnd,
    history: [{ status: 'INVITED', at: now }],
    accommodations,
    createdAt: now,
  };
  state.invitations.push(inv);
  markTestInvited(testId);
  return inv;
}

export function createInvitationHandlers(options: { latencyMs: number }) {
  const wait = () => (options.latencyMs > 0 ? delay(options.latencyMs) : undefined);
  setCandidateEnricher((id) => {
    const mine = state.invitations
      .filter((i) => i.candidateId === id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { invitationCount: mine.length, latestStatus: mine[0]?.status ?? null };
  });
  const tests = `${apiBaseUrl}/v1/tests`;
  return [
    http.post(`${tests}/:testId/invitations`, async ({ request, params }) => {
      const denied = allowed(request);
      if (denied) return denied;
      const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const dto = [
        ...unknownKeys(b, ['candidate', 'windowStart', 'windowEnd', 'accommodations']),
        ...candidateProblems(b.candidate, 'candidate'),
        ...windowFormatProblems(b),
        ...(b.accommodations === undefined
          ? []
          : state.scenario.acceptsAccommodations
            ? accommodationProblems(b.accommodations)
            : ['property accommodations should not exist']),
        ...(MOCK_ID.test(String(params.testId)) ? [] : ['testId must be a UUID']),
      ];
      if (dto.length) return problem(400, 'x', dto);
      const rules = windowRuleProblems(b);
      if (rules.length) return problem(400, 'x', rules);
      await wait();
      // The real order (invitations.service.ts): the hourly slot is taken BEFORE the test lookup,
      // the 409 and the 422, and those keep their slot. The answer has no Retry-After header.
      if (state.usedThisHour + 1 > state.scenario.limitPerHour)
        return problem(429, 'Too many invitations. Try again later.');
      state.usedThisHour += 1;
      const testId = String(params.testId);
      if (!mockTestExists(testId)) return problem(404, 'Test not found.');
      const acc = (b.accommodations as Schemas['InvitationAccommodations'] | undefined) ?? null;
      if (
        acc?.identityCheckWaiver?.reasonCode === 'REFUSED_BIOMETRIC_PROCESSING' &&
        !state.scenario.biometricRefusalEnabled
      ) {
        return problem(
          422,
          'This waiver reason is not enabled yet.',
          undefined,
          'REASON_NOT_ENABLED',
        );
      }
      const cand = b.candidate as { email: string; name: string };
      const existing = mockCandidateIdByEmail(cand.email.trim());
      if (state.scenario.candidateErased) return problem(409, 'This candidate cannot be invited.');
      if (existing && openFor(testId, existing))
        return problem(409, 'This candidate already has an active invitation for this test.');
      if (state.scenario.testUnsatisfiable) return unsatisfiable();
      const inv = create(testId, cand, b.windowStart as string, b.windowEnd as string, acc);
      return HttpResponse.json(
        {
          id: inv.id,
          testId,
          candidateId: inv.candidateId,
          status: inv.status,
          windowStart: inv.windowStart,
          windowEnd: inv.windowEnd,
          createdAt: inv.createdAt,
          mail: mailFor(cand.email),
        },
        { status: 201 },
      );
    }),

    http.get(
      `${apiBaseUrl}/v1/admin/candidates/:candidateId/invitations`,
      async ({ request, params }) => {
        const denied = allowed(request);
        if (denied) return denied;
        await wait();
        const id = String(params.candidateId);
        if (!mockCandidateExists(id)) return problem(404, 'Candidate not found.');
        const items = state.invitations
          .filter((i) => i.candidateId === id)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map((i) => ({
            id: i.id,
            testId: i.testId,
            testName: mockTestName(i.testId) ?? 'A test',
            status: i.status,
            windowStart: i.windowStart,
            windowEnd: i.windowEnd,
            history: i.history,
          }));
        return HttpResponse.json({ items });
      },
    ),
  ];
}
