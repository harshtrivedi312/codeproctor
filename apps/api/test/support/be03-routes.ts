// The BE-03 route list in ONE place (method, path, permission, audit action, sample body), used by
// tc-004-rbac.int.test.ts and tc-006-audit.int.test.ts. Source: docs/fsd.md section 4, ADR 0010
// (permission matrix, packages/shared ROLE_PERMISSIONS) and the Backend session's reply of
// 2026-10-05: BE-03 = global deny-by-default guard (FR-103), @Audited interceptor (FR-105) and the
// SUPER_ADMIN staff user routes. Names are NOT frozen: every guess is marked `// ASSUMED`. When the
// Backend session sends the final list (or exports a route registry), edit this file only.
//
// Switches: the BE-03 tests are written but switched off until the routes exist. Turn them on with
// `BE03_READY = true` below, or `BE03_READY=1` in the environment for a trial run. Same for the
// review routes (BE-13) with BE13_READY.
import { hasPermission, PRINCIPALS, USER_ROLES } from '../../../../packages/shared/src/permissions';
import type { Permission, Principal } from '../../../../packages/shared/src/permissions';
import { UserRole } from '../../src/generated/prisma/client';
import { Harness } from './harness';

const BE03_DEFAULT = false; // flip to true when BE-03 is merged
const BE13_DEFAULT = false; // flip to true when BE-13 is merged
export const BE03_READY: boolean = BE03_DEFAULT || process.env.BE03_READY === '1';
export const BE13_READY: boolean = BE13_DEFAULT || process.env.BE13_READY === '1';

export { PRINCIPALS, USER_ROLES };
export type { Permission, Principal };
export const allowedRoles = (permission: Permission): UserRole[] =>
  USER_ROLES.filter((r) => hasPermission(r, permission)).map((r) => UserRole[r]);

/** What a route needs before a call: a path with real ids and a body, built per call. */
export interface Target {
  path: string;
  body?: unknown;
  /** Id of the entity the audit row must name (entity_id), when the route acts on one. */
  entityId?: string;
  /** Secrets that this call involves; none may appear in any audit column. */
  secrets: string[];
  /** Looks the entity id up after the call, for routes that create it. */
  resolveEntityId?: () => Promise<string | undefined>;
  /** Returns true when the call left the target unchanged (used after 403/404). */
  unchanged: () => Promise<boolean>;
}

export interface Be03Route {
  id: string;
  step: 'BE-03' | 'BE-13';
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path template from docs/fsd.md section 4 (or ASSUMED), under /api/v1. */
  template: string;
  permission: Permission;
  /** null: not audited. Reads of candidate data are audited (FR-105). */
  audit: { action: string; entityType: string } | null;
  mutating: boolean;
  /** false: the route takes no body, so the invalid-body (400) test does not apply. Default true. */
  takesBody?: boolean;
  /** Status codes accepted as success. */
  ok: number[];
  /** Builds a fresh target in `orgId` (each call may consume or change its target). */
  prepare(h: Harness, orgId: string): Promise<Target>;
}

let n = 0;
const uniq = (): string => `${Date.now().toString(36)}${++n}`;

async function userTarget(h: Harness, orgId: string): Promise<{ id: string; email: string }> {
  const email = `qa-target-${uniq()}@example.com`;
  const u = await h.owner.user.create({
    data: { orgId, email, fullName: 'QA Target', role: UserRole.RECRUITER },
  });
  return { id: u.id, email };
}

/** Session fixture through the owner role (needs only the schema, not any route). */
export async function sessionFixture(
  h: Harness,
  orgId: string,
): Promise<{ sessionId: string; eventId: string }> {
  const t = uniq();
  const test = await h.owner.test.create({
    data: { orgId, name: `QA test ${t}`, durationMinutes: 60 },
  });
  const candidate = await h.owner.candidate.create({
    data: { orgId, email: `qa-cand-${t}@example.com`, fullName: 'QA Candidate' },
  });
  const invitation = await h.owner.invitation.create({
    data: {
      orgId,
      testId: test.id,
      candidateId: candidate.id,
      tokenHash: `qa-token-hash-${t}`,
      windowStart: new Date(Date.now() - 3_600_000),
      windowEnd: new Date(Date.now() + 3_600_000),
    },
  });
  const session = await h.owner.session.create({
    data: { orgId, invitationId: invitation.id, status: 'UNDER_REVIEW' },
  });
  const event = await h.owner.proctorEvent.create({
    data: {
      sessionId: session.id,
      type: 'TAB_SWITCH',
      severity: 'MEDIUM',
      occurredAt: new Date(),
    },
  });
  return { sessionId: session.id, eventId: String(event.id) };
}

export const BE03_ROUTES: Be03Route[] = [
  {
    id: 'users-list',
    step: 'BE-03',
    method: 'GET',
    template: '/users', // ASSUMED path
    permission: 'user:manage',
    audit: null, // ASSUMED: a staff list is not candidate data, so no audit row
    mutating: false,
    ok: [200],
    prepare: () =>
      Promise.resolve({ path: '/users', secrets: [], unchanged: () => Promise.resolve(true) }),
  },
  {
    id: 'users-invite',
    step: 'BE-03',
    method: 'POST',
    template: '/users/invite', // ASSUMED path
    permission: 'user:manage',
    audit: { action: 'USER_INVITED', entityType: 'user' }, // ASSUMED action and entity type
    mutating: true,
    ok: [200, 201], // ASSUMED
    prepare: (h, orgId) => {
      const email = `qa-invitee-${uniq()}@example.com`;
      const lookup = (): Promise<{ id: string } | null> =>
        h.owner.user.findFirst({ where: { orgId, email }, select: { id: true } });
      return Promise.resolve({
        path: '/users/invite',
        body: { email, fullName: 'QA Invitee', role: 'RECRUITER' }, // ASSUMED body
        secrets: [], // the 72 h set-password token is read from the captured mail by the test
        resolveEntityId: async () => (await lookup())?.id,
        unchanged: async () => (await lookup()) === null,
      });
    },
  },
  {
    id: 'users-role',
    step: 'BE-03',
    method: 'PATCH',
    template: '/users/:id/role', // ASSUMED path
    permission: 'user:manage',
    audit: { action: 'USER_ROLE_CHANGED', entityType: 'user' }, // ASSUMED
    mutating: true,
    ok: [200, 204], // ASSUMED
    prepare: async (h, orgId) => {
      const u = await userTarget(h, orgId);
      return {
        path: `/users/${u.id}/role`,
        body: { role: 'AUTHOR' }, // ASSUMED body
        entityId: u.id,
        secrets: [],
        unchanged: async () =>
          (await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).role ===
          UserRole.RECRUITER,
      };
    },
  },
  {
    id: 'users-deactivate',
    step: 'BE-03',
    method: 'POST',
    template: '/users/:id/deactivate', // ASSUMED path
    takesBody: false,
    permission: 'user:manage',
    audit: { action: 'USER_DEACTIVATED', entityType: 'user' }, // ASSUMED
    mutating: true,
    ok: [200, 204], // ASSUMED
    prepare: async (h, orgId) => {
      const u = await userTarget(h, orgId);
      return {
        path: `/users/${u.id}/deactivate`,
        body: {},
        entityId: u.id,
        secrets: [],
        unchanged: async () =>
          (await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).isActive,
      };
    },
  },
  {
    // Added to BE-03 by the owner (P-03): audited admin unlock of a locked staff account.
    id: 'users-unlock',
    step: 'BE-03',
    method: 'POST',
    template: '/users/:id/unlock', // ASSUMED path
    takesBody: false,
    permission: 'user:manage', // ASSUMED: SUPER_ADMIN only (the matrix has no separate unlock permission)
    audit: { action: 'USER_UNLOCKED', entityType: 'user' }, // ASSUMED action name
    mutating: true,
    ok: [200, 204], // ASSUMED
    prepare: async (h, orgId) => {
      const u = await userTarget(h, orgId);
      await h.owner.user.update({
        where: { id: u.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) },
      });
      return {
        path: `/users/${u.id}/unlock`,
        entityId: u.id,
        secrets: [],
        unchanged: async () =>
          (await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).lockedUntil !== null,
      };
    },
  },
  // Review routes: BE-13, from docs/fsd.md section 4. Kept here so TC-004 (reviewer opens a review)
  // and TC-006 use one list. Switched on by BE13_READY.
  {
    id: 'review-queue',
    step: 'BE-13',
    method: 'GET',
    template: '/review/queue',
    permission: 'review_queue:read',
    audit: null, // ASSUMED: the queue lists sessions but opens none
    mutating: false,
    ok: [200],
    prepare: () =>
      Promise.resolve({
        path: '/review/queue',
        secrets: [],
        unchanged: () => Promise.resolve(true),
      }),
  },
  {
    id: 'review-session',
    step: 'BE-13',
    method: 'GET',
    template: '/review/sessions/:id',
    permission: 'review_session:read',
    // TC-006 expected result: a row with actor, entity, IP when a reviewer opens a review. FR-105.
    audit: { action: 'REVIEW_SESSION_VIEWED', entityType: 'session' }, // ASSUMED action name
    mutating: false, // a read, but audited: the audit test treats `audit !== null` as the rule
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await sessionFixture(h, orgId);
      return {
        path: `/review/sessions/${f.sessionId}`,
        entityId: f.sessionId,
        secrets: [],
        unchanged: () => Promise.resolve(true),
      };
    },
  },
  {
    id: 'review-flag',
    step: 'BE-13',
    method: 'PATCH',
    template: '/review/flags/:id',
    permission: 'review_flag:decide',
    audit: { action: 'REVIEW_FLAG_DECIDED', entityType: 'proctor_event' }, // ASSUMED
    mutating: true,
    ok: [200, 204],
    prepare: async (h, orgId) => {
      const f = await sessionFixture(h, orgId);
      return {
        path: `/review/flags/${f.eventId}`, // ASSUMED: the flag id is the proctor event id
        body: { decision: 'DISMISSED', note: 'QA note' }, // ASSUMED body
        entityId: f.eventId,
        secrets: [],
        unchanged: async () =>
          (await h.owner.flagDecision.count({ where: { eventId: BigInt(f.eventId) } })) === 0,
      };
    },
  },
  {
    id: 'review-verdict',
    step: 'BE-13',
    method: 'POST',
    template: '/review/sessions/:id/verdict',
    permission: 'review_verdict:set',
    audit: { action: 'REVIEW_VERDICT_SET', entityType: 'session' }, // ASSUMED
    mutating: true,
    ok: [200, 201],
    prepare: async (h, orgId) => {
      const f = await sessionFixture(h, orgId);
      return {
        path: `/review/sessions/${f.sessionId}/verdict`,
        body: { verdict: 'CLEAN', note: 'QA note' }, // ASSUMED body
        entityId: f.sessionId,
        secrets: [],
        unchanged: async () =>
          (await h.owner.sessionReview.count({ where: { sessionId: f.sessionId } })) === 0,
      };
    },
  },
];

export const routesFor = (step: Be03Route['step']): Be03Route[] =>
  BE03_ROUTES.filter((r) => r.step === step);

/**
 * How the admin alert on account lock (P-03) is observed. ASSUMED: the alert is an audit row
 * `ADMIN_ALERT_ACCOUNT_LOCKED` in the locked user's org. If Backend uses MailPort or a notification
 * table instead, change this one function (the TC-002 test only calls it).
 */
export async function lockAlertsFor(h: Harness, orgId: string, userId: string): Promise<unknown[]> {
  return h.owner.auditLog.findMany({
    where: { orgId, action: 'ADMIN_ALERT_ACCOUNT_LOCKED', entityId: userId }, // ASSUMED
  });
}
