import {
  DEFAULT_EVENT_CAP_PER_TYPE,
  DEFAULT_EVENT_WEIGHT,
  DEFAULT_SEVERITY_POINTS,
  RISK_BAND_MIN_SCORE,
} from '@codeproctor/shared';
import { delay, http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { mockReauth, mockRoleFromToken, problem as problemJson } from './auth-handlers';

/*
 * Mock staff administration API (FE-03: users, org settings, consent texts, candidate erasure).
 * Fake people only. State is in memory: it survives navigation but not a page reload, which is
 * how you reset the demo. Roles come from the fake access token (see auth-handlers.ts) and the
 * mock answers 403 like the real API must (FR-103, TC-004).
 */

type Role = Schemas['StaffRole'];
type StaffUser = Schemas['StaffUser'];
type OrgSettings = Schemas['OrgSettings'];
type ConsentText = Schemas['ConsentText'];
type CandidateSummary = Schemas['CandidateSummary'];

interface MockCandidate extends CandidateSummary {
  /** Internal: an open review or appeal that D-19 waits for. */
  openFlow: 'review' | 'appeal' | null;
}

/** A staff user as the mock keeps it: the public fields plus what the API does not return. */
interface MockStaffUser extends StaffUser {
  /** Internal: false until the person set a password from the invite link (status `invited`). */
  hasPassword: boolean;
}

interface AdminState {
  users: MockStaffUser[];
  /** Invitations sent in this mock hour, for the per-organisation limit (429). */
  invitesSent: number;
  settings: OrgSettings;
  consentTexts: ConsentText[];
  legalApprovalRequired: boolean;
  candidates: MockCandidate[];
}

export function defaultSettings(): OrgSettings {
  return {
    retentionDays: 90,
    erasure: { holdWhileReviewOrAppealOpen: true },
    risk: {
      severityPoints: { ...DEFAULT_SEVERITY_POINTS },
      capPerType: DEFAULT_EVENT_CAP_PER_TYPE,
      bandMinScore: { MEDIUM: RISK_BAND_MIN_SCORE.MEDIUM, HIGH: RISK_BAND_MIN_SCORE.HIGH },
      weights: { ...DEFAULT_EVENT_WEIGHT },
    },
    consentDeclineContact:
      'Email people-team@example.test or call +1 555 0100 to ask about alternatives or accommodations.',
  };
}

const PLACEHOLDER_BODY = `# Consent to proctored assessment (PLACEHOLDER)

This text is a placeholder. It has not been approved by Legal and must not be shown to real candidates.

## What is recorded
Screen, webcam, microphone and keystrokes during the test, plus an ID image and a selfie.

## How it is used
Automated detection flags events; a human reviewer decides. Results are used in the hiring decision.

## Retention and deletion
Recordings are deleted after the retention period. You can ask for erasure at any time.`;

function seedCandidates(): MockCandidate[] {
  const names = [
    'Ada Lovelace',
    'Grace Hopper',
    'Alan Turing',
    'Edsger Dijkstra',
    'Barbara Liskov',
    'Donald Knuth',
    'Margaret Hamilton',
    'Linus Torvalds',
    'Ken Thompson',
    'Radia Perlman',
    'Tim Berners-Lee',
    'Frances Allen',
    'Dennis Ritchie',
    'Shafi Goldwasser',
  ];
  return names.map((name, i) => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
    return {
      id: `cand-${i + 1}`,
      name,
      email: `${slug}@candidates.example.test`,
      lastSessionAt: new Date(Date.UTC(2026, 8, 28 - i, 10, 0)).toISOString(),
      // Grace has an appeal open and Alan a review: erasure waits for them (D-19).
      openFlow: i === 1 ? 'appeal' : i === 2 ? 'review' : null,
      erasure:
        i === 3
          ? { state: 'erased', requestedAt: '2026-09-01T09:00:00.000Z', waitingFor: null }
          : i === 4
            ? { state: 'waiting', requestedAt: '2026-09-29T09:00:00.000Z', waitingFor: 'appeal' }
            : { state: 'none', requestedAt: null, waitingFor: null },
    };
  });
}

function mockUser(
  id: string,
  name: string,
  email: string,
  role: Role,
  extra: Partial<Pick<StaffUser, 'status' | 'totpEnabled' | 'locked' | 'lockedUntil'>> & {
    createdAt: string;
  },
): MockStaffUser {
  const status = extra.status ?? 'active';
  return {
    id,
    email,
    name,
    role,
    status,
    locked: extra.locked ?? false,
    lockedUntil: extra.lockedUntil ?? null,
    totpEnabled: extra.totpEnabled ?? false,
    createdAt: extra.createdAt,
    hasPassword: status !== 'invited',
  };
}

function publicUser(u: MockStaffUser): StaffUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    locked: u.locked,
    lockedUntil: u.lockedUntil,
    totpEnabled: u.totpEnabled,
    createdAt: u.createdAt,
  };
}

function seed(): AdminState {
  return {
    users: [
      mockUser('user-super_admin', 'Alex Admin', 'admin@example.test', 'SUPER_ADMIN', {
        createdAt: '2026-06-01T09:00:00.000Z',
        totpEnabled: true,
      }),
      mockUser('user-recruiter', 'Riley Recruiter', 'recruiter@example.test', 'RECRUITER', {
        createdAt: '2026-06-02T09:00:00.000Z',
      }),
      mockUser('user-author', 'Avery Author', 'author@example.test', 'AUTHOR', {
        createdAt: '2026-06-03T09:00:00.000Z',
      }),
      mockUser('user-reviewer', 'Robin Reviewer', 'reviewer@example.test', 'REVIEWER', {
        createdAt: '2026-06-04T09:00:00.000Z',
      }),
      mockUser('user-invited', 'Casey Newhire', 'casey.newhire@example.test', 'RECRUITER', {
        status: 'invited',
        createdAt: '2026-10-01T09:00:00.000Z',
      }),
      mockUser('user-gone', 'Dana Departed', 'dana.departed@example.test', 'REVIEWER', {
        status: 'deactivated',
        createdAt: '2026-05-01T09:00:00.000Z',
      }),
    ],
    invitesSent: 0,
    settings: defaultSettings(),
    consentTexts: [
      {
        id: 'ct-1',
        version: 'v0.1-placeholder',
        bodyMd: PLACEHOLDER_BODY,
        createdAt: '2026-09-20T09:00:00.000Z',
        legalApprovedAt: null,
        legalApprovedBy: null,
        isCurrent: true,
      },
      {
        id: 'ct-2',
        version: 'v0.2-mock-approved',
        bodyMd: PLACEHOLDER_BODY.replace(' (PLACEHOLDER)', '').replace(
          /This text is a placeholder.*\n/,
          'MOCK DATA: shown as approved only to demonstrate the approved state.\n',
        ),
        createdAt: '2026-09-25T09:00:00.000Z',
        legalApprovedAt: '2026-09-27T12:00:00.000Z',
        legalApprovedBy: 'MOCK-LEGAL-REF-0001',
        isCurrent: false,
      },
    ],
    legalApprovalRequired: false,
    candidates: seedCandidates(),
  };
}

let state: AdminState = seed();

/** The invitations mock adds what a candidate row shows about their invitations (WEB-ONLY, BE-06b). */
type CandidateEnricher = (id: string) => Partial<CandidateSummary>;
let enrich: CandidateEnricher = () => ({});
export function setCandidateEnricher(fn: CandidateEnricher): void {
  enrich = fn;
}
/** Finds a candidate by email (case-insensitive) or creates one, like an invitation does. */
export function ensureMockCandidate(email: string, name: string): { id: string; created: boolean } {
  const found = state.candidates.find((c) => c.email.toLowerCase() === email.toLowerCase());
  if (found) return { id: found.id, created: false };
  const id = `cand-${state.candidates.length + 1}-new`;
  state.candidates.push({
    id,
    name,
    email,
    lastSessionAt: null,
    openFlow: null,
    erasure: { state: 'none', requestedAt: null, waitingFor: null },
  });
  return { id, created: true };
}
export const mockCandidateIdByEmail = (email: string): string | null =>
  state.candidates.find((c) => c.email.toLowerCase() === email.toLowerCase())?.id ?? null;
export const mockCandidateExists = (id: string): boolean =>
  state.candidates.some((c) => c.id === id);
export const mockCandidateIds = (): string[] => state.candidates.map((c) => c.id);

/** Tests: what a landed staff invite leaves behind (the user row), for the unknown-outcome 500 fault. */
export function addMockInvitedUser(email: string, name: string, role: Role): void {
  state.users.push(
    mockUser(
      `user-${state.users.length + 1}-${Date.now()}`,
      name,
      email.trim().toLowerCase(),
      role,
      { status: 'invited', createdAt: new Date().toISOString() },
    ),
  );
}

/** Resets the in-memory mock (tests call this before each test). */
export function resetMockAdminState(options: { legalApprovalRequired?: boolean } = {}): void {
  state = seed();
  if (options.legalApprovalRequired !== undefined) {
    state.legalApprovalRequired = options.legalApprovalRequired;
  }
}

/** The API's default limit of invitations per organisation and hour (INVITE_RATE_LIMIT_PER_ORG_HOUR). */
const INVITE_LIMIT_PER_HOUR = 20;
const ROLES: readonly string[] = ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'];
const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && ROLES.includes(value);

/** Unknown fields are a 400 (forbidNonWhitelisted); `check` adds the field rules of the DTO. */
function invalidFields(
  body: Record<string, unknown>,
  known: readonly string[],
  check: (errors: string[]) => void,
): string[] {
  const errors = Object.keys(body)
    .filter((key) => !known.includes(key))
    .map((key) => `property ${key} should not exist`);
  check(errors);
  return errors;
}

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ code, message }, { status });
const forbidden = () => error(403, 'forbidden', 'Your role does not allow this.');
const unauthenticated = () => error(401, 'unauthenticated', 'Sign in again.');

/** Returns an error response, or null when the caller's role is in `allowed`. */
function guard(request: Request, allowed: readonly Role[]): Response | null {
  const role = mockRoleFromToken(request.headers.get('authorization'));
  if (!role) return unauthenticated();
  return allowed.includes(role) ? null : forbidden();
}

function publicCandidate(c: MockCandidate): CandidateSummary {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    lastSessionAt: c.lastSessionAt,
    erasure: c.erasure,
  };
}

function validateSettingsPatch(patch: Schemas['OrgSettingsPatch']): string | null {
  if (patch.retentionDays !== undefined && (patch.retentionDays < 7 || patch.retentionDays > 730)) {
    return 'Retention must be between 7 and 730 days.';
  }
  const bands = patch.risk?.bandMinScore;
  if (bands && !(bands.MEDIUM >= 1 && bands.MEDIUM < bands.HIGH && bands.HIGH <= 100)) {
    return 'The MEDIUM threshold must be lower than the HIGH threshold, and both within 1 to 100.';
  }
  return null;
}

export function createAdminHandlers(options: { latencyMs: number }) {
  const base = `${apiBaseUrl}/v1/admin`;
  const SA: Role[] = ['SUPER_ADMIN'];
  const wait = () => (options.latencyMs > 0 ? delay(options.latencyMs) : undefined);

  return [
    http.get(`${base}/users`, async ({ request }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 50);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      ) {
        return problemJson(request, 400, 'Request validation failed', undefined, [
          'page must be an integer of at least 1, pageSize an integer from 1 to 100',
        ]);
      }
      const items = state.users.slice((page - 1) * pageSize, page * pageSize).map(publicUser);
      return HttpResponse.json({ items, page, pageSize, total: state.users.length });
    }),

    // Step-up (docs/api-contract.md section 6): role guard, then body validation (400, unknown
    // fields included: the real API runs forbidNonWhitelisted), then the admin's own password
    // (403 REAUTH_FAILED, same lockout counters as the 2FA routes), then limit, lookup, state.
    http.post(`${base}/users`, async ({ request }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const checked = await mockReauth(request, (b) =>
        invalidFields(b, ['currentPassword', 'email', 'name', 'role'], (errors) => {
          const email = typeof b.email === 'string' ? b.email.trim() : '';
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            errors.push('email must be an email');
          }
          const name = typeof b.name === 'string' ? b.name.trim() : '';
          if (name.length < 1 || name.length > 200) {
            errors.push('name must be longer than or equal to 1 and shorter than 200 characters');
          }
          if (!isRole(b.role)) errors.push('role must be a valid enum value');
        }),
      );
      if (checked instanceof Response) return checked;
      if (state.invitesSent >= INVITE_LIMIT_PER_HOUR) {
        return problemJson(request, 429, 'Too many invitations. Try again later.');
      }
      state.invitesSent += 1;
      const body = checked.body as { email: string; name: string; role: Role };
      const email = body.email.trim().toLowerCase();
      if (state.users.some((u) => u.email === email)) {
        return problemJson(request, 409, 'A user with this email already exists.');
      }
      const user = mockUser(
        `user-${state.users.length + 1}-${Date.now()}`,
        body.name.trim(),
        email,
        body.role,
        { status: 'invited', createdAt: new Date().toISOString() },
      );
      state.users.push(user);
      return HttpResponse.json(publicUser(user), { status: 201 });
    }),

    http.patch(`${base}/users/:userId`, async ({ request, params }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const checked = await mockReauth(request, (b) =>
        invalidFields(b, ['currentPassword', 'role', 'active'], (errors) => {
          if (b.role !== undefined && !isRole(b.role))
            errors.push('role must be a valid enum value');
          if (b.active !== undefined && typeof b.active !== 'boolean') {
            errors.push('active must be a boolean value');
          }
          if (b.role === undefined && b.active === undefined) {
            errors.push('send at least one of role and active');
          }
        }),
      );
      if (checked instanceof Response) return checked;
      const user = state.users.find((u) => u.id === params.userId);
      if (!user) return problemJson(request, 404, 'No such user.');
      const body = checked.body as { role?: Role; active?: boolean };
      const actingId = `user-${mockRoleFromToken(request.headers.get('authorization'))?.toLowerCase()}`;
      if (
        user.id === actingId &&
        (body.active === false || (body.role && body.role !== user.role))
      ) {
        return problemJson(request, 409, 'You cannot change your own role or deactivate yourself.');
      }
      if (body.role) user.role = body.role;
      if (body.active === false) user.status = 'deactivated';
      if (body.active === true && user.status === 'deactivated') {
        user.status = user.hasPassword ? 'active' : 'invited';
      }
      return HttpResponse.json(publicUser(user));
    }),

    http.get(`${base}/settings`, async ({ request }) => {
      await wait();
      return guard(request, SA) ?? HttpResponse.json(state.settings);
    }),

    http.patch(`${base}/settings`, async ({ request }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const patch = (await request.json()) as Schemas['OrgSettingsPatch'];
      const problem = validateSettingsPatch(patch);
      if (problem) return error(400, 'invalid_settings', problem);
      state.settings = {
        ...state.settings,
        ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
        ...(patch.erasure ? { erasure: { ...state.settings.erasure, ...patch.erasure } } : {}),
        ...(patch.risk ? { risk: patch.risk } : {}),
        ...(patch.consentDeclineContact !== undefined
          ? { consentDeclineContact: patch.consentDeclineContact }
          : {}),
      };
      return HttpResponse.json(state.settings);
    }),

    http.get(`${base}/consent-texts`, async ({ request }) => {
      await wait();
      return (
        guard(request, SA) ??
        HttpResponse.json({
          legalApprovalRequired: state.legalApprovalRequired,
          items: [...state.consentTexts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        })
      );
    }),

    http.post(`${base}/consent-texts`, async ({ request }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const body = (await request.json()) as { version: string; bodyMd: string };
      const version = body.version.trim();
      if (state.consentTexts.some((t) => t.version === version)) {
        return error(409, 'version_exists', 'This version name is already used.');
      }
      const text: ConsentText = {
        id: `ct-${state.consentTexts.length + 1}-${Date.now()}`,
        version,
        bodyMd: body.bodyMd,
        createdAt: new Date().toISOString(),
        legalApprovedAt: null,
        legalApprovedBy: null,
        isCurrent: false,
      };
      state.consentTexts.push(text);
      return HttpResponse.json(text, { status: 201 });
    }),

    http.put(`${base}/consent-texts/:id/current`, async ({ request, params }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const text = state.consentTexts.find((t) => t.id === params.id);
      if (!text) return error(404, 'not_found', 'No such consent text.');
      if (state.legalApprovalRequired && !text.legalApprovedAt) {
        return error(
          409,
          'not_legal_approved',
          'This text is not approved by Legal, and this environment requires approval.',
        );
      }
      for (const t of state.consentTexts) t.isCurrent = t.id === text.id;
      return HttpResponse.json(text);
    }),

    http.get(`${base}/candidates`, async ({ request }) => {
      await wait();
      return (
        guard(request, ['SUPER_ADMIN', 'RECRUITER']) ??
        HttpResponse.json({
          items: state.candidates.map((c) => ({ ...publicCandidate(c), ...enrich(c.id) })),
        })
      );
    }),

    http.post(`${base}/candidates/:id/erasure`, async ({ request, params }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const candidate = state.candidates.find((c) => c.id === params.id);
      if (!candidate) return error(404, 'not_found', 'No such candidate.');
      if (candidate.erasure.state === 'none') {
        const requestedAt = new Date().toISOString();
        candidate.erasure =
          state.settings.erasure.holdWhileReviewOrAppealOpen && candidate.openFlow
            ? { state: 'waiting', requestedAt, waitingFor: candidate.openFlow }
            : { state: 'queued', requestedAt, waitingFor: null };
      }
      return HttpResponse.json(publicCandidate(candidate), { status: 202 });
    }),
  ];
}
