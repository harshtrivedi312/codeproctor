import {
  DEFAULT_EVENT_CAP_PER_TYPE,
  DEFAULT_EVENT_WEIGHT,
  DEFAULT_SEVERITY_POINTS,
  RISK_BAND_MIN_SCORE,
} from '@codeproctor/shared';
import { delay, http, HttpResponse } from 'msw';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { mockRoleFromToken } from './auth-handlers';

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

interface AdminState {
  users: StaffUser[];
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

function seed(): AdminState {
  return {
    users: [
      {
        id: 'user-super_admin',
        email: 'admin@example.test',
        name: 'Alex Admin',
        role: 'SUPER_ADMIN',
        status: 'active',
        lastLoginAt: '2026-10-04T08:12:00.000Z',
      },
      {
        id: 'user-recruiter',
        email: 'recruiter@example.test',
        name: 'Riley Recruiter',
        role: 'RECRUITER',
        status: 'active',
        lastLoginAt: '2026-10-03T14:30:00.000Z',
      },
      {
        id: 'user-author',
        email: 'author@example.test',
        name: 'Avery Author',
        role: 'AUTHOR',
        status: 'active',
        lastLoginAt: '2026-10-02T09:05:00.000Z',
      },
      {
        id: 'user-reviewer',
        email: 'reviewer@example.test',
        name: 'Robin Reviewer',
        role: 'REVIEWER',
        status: 'active',
        lastLoginAt: null,
      },
      {
        id: 'user-invited',
        email: 'casey.newhire@example.test',
        name: 'Casey Newhire',
        role: 'RECRUITER',
        status: 'invited',
        lastLoginAt: null,
      },
      {
        id: 'user-gone',
        email: 'dana.departed@example.test',
        name: 'Dana Departed',
        role: 'REVIEWER',
        status: 'deactivated',
        lastLoginAt: '2026-08-11T16:45:00.000Z',
      },
    ],
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
  state.users.push({
    id: `user-${state.users.length + 1}-${Date.now()}`,
    email: email.trim().toLowerCase(),
    name,
    role,
    status: 'invited',
    lastLoginAt: null,
  });
}

/** Resets the in-memory mock (tests call this before each test). */
export function resetMockAdminState(options: { legalApprovalRequired?: boolean } = {}): void {
  state = seed();
  if (options.legalApprovalRequired !== undefined) {
    state.legalApprovalRequired = options.legalApprovalRequired;
  }
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
      return guard(request, SA) ?? HttpResponse.json({ items: state.users });
    }),

    http.post(`${base}/users`, async ({ request }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const body = (await request.json()) as { email: string; name: string; role: Role };
      const email = body.email.trim().toLowerCase();
      if (state.users.some((u) => u.email === email)) {
        return error(409, 'user_exists', 'A user with this email already exists.');
      }
      const user: StaffUser = {
        id: `user-${state.users.length + 1}-${Date.now()}`,
        email,
        name: body.name.trim(),
        role: body.role,
        status: 'invited',
        lastLoginAt: null,
      };
      state.users.push(user);
      return HttpResponse.json(user, { status: 201 });
    }),

    http.patch(`${base}/users/:userId`, async ({ request, params }) => {
      await wait();
      const denied = guard(request, SA);
      if (denied) return denied;
      const user = state.users.find((u) => u.id === params.userId);
      if (!user) return error(404, 'not_found', 'No such user.');
      const body = (await request.json()) as { role?: Role; active?: boolean };
      const actingId = `user-${mockRoleFromToken(request.headers.get('authorization'))?.toLowerCase()}`;
      if (
        user.id === actingId &&
        (body.active === false || (body.role && body.role !== user.role))
      ) {
        return error(409, 'self_change', 'You cannot change your own role or deactivate yourself.');
      }
      if (body.role) user.role = body.role;
      if (body.active === false) user.status = 'deactivated';
      if (body.active === true && user.status === 'deactivated') {
        user.status = user.lastLoginAt ? 'active' : 'invited';
      }
      return HttpResponse.json(user);
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
