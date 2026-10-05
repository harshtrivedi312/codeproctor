// The BE-03 route list in ONE place (method, path, permission, audit action, sample body), used by
// tc-004-rbac.int.test.ts and tc-006-audit.int.test.ts. Source: docs/fsd.md section 4, ADR 0010
// (permission matrix, packages/shared ROLE_PERMISSIONS) and the FINAL BE-03 contract from the Backend
// session (docs/followups/backend.md, "Contract changes from BE-03", plus the 2026-10-05 change that
// POST /admin/users, PATCH /admin/users/:userId and POST /admin/users/:userId/unlock need the acting
// admin's own `currentPassword`).
//
// Final BE-03 contract (all permission `user:manage`, SUPER_ADMIN only, own org only):
//   GET   /admin/users?page&pageSize            200 {items,page,pageSize,total}
//   GET   /admin/users/lock-events?page&pageSize 200 {items:[{id,userId,email,name,lockedAt}],page,pageSize,total}
//   POST  /admin/users {email,name,role,currentPassword}            201, 409 duplicate email
//   PATCH /admin/users/:userId {role?,active?,currentPassword}      200, 409 own change / last SUPER_ADMIN
//   POST  /admin/users/:userId/unlock {currentPassword}             204 (self-unlock allowed)
// There is no by-id GET and no /deactivate route. Missing currentPassword is 400; a wrong, locked or
// changed-mid-request password is 403 problem+json code REAUTH_FAILED with identical bodies; a
// cross-org or missing id is the same 404, and only AFTER a correct password. Failed requests
// (400/401/403/404) write no audit row.
//
// Switches: the BE-03 tests are written but switched off until the routes exist. Turn them on with
// `BE03_READY = true` below (the ONE-LINE switch), or `BE03_READY=1` in the environment for a trial
// run. Same for the review routes (BE-13) with BE13_READY. The BE-13 entries are still ASSUMED.
import { hasPermission, PRINCIPALS, USER_ROLES } from '../../../../packages/shared/src/permissions';
import type { Permission, Principal } from '../../../../packages/shared/src/permissions';
import { UserRole } from '../../src/generated/prisma/client';
import { Harness, PASSWORD } from './harness';

// TODO(QA-04b): when BE-03 is merged flip this to true; the staged tests then run on every PR.
const BE03_DEFAULT = false; // flip to true when BE-03 is merged
const BE13_DEFAULT = false; // flip to true when BE-13 is merged
export const BE03_READY: boolean = BE03_DEFAULT || process.env.BE03_READY === '1';
export const BE13_READY: boolean = BE13_DEFAULT || process.env.BE13_READY === '1';

export { PRINCIPALS, USER_ROLES };
export type { Permission, Principal };
export const allowedRoles = (permission: Permission): UserRole[] =>
  USER_ROLES.filter((r) => hasPermission(r, permission)).map((r) => UserRole[r]);

/** Prefix of the staff user admin routes (under /api/v1). */
export const ADMIN_USERS = '/admin/users';
export const lockEventsPath = `${ADMIN_USERS}/lock-events`;

/**
 * The backend route registry, loaded lazily so this file compiles and the always-run tests pass on
 * a branch where apps/api/src/common/auth/route-permissions.ts and route-registry.ts do not exist
 * yet (they arrive with BE-03). Only called from tests that run behind BE03_READY.
 * `audited` means the route carries @Audited (the interceptor writes its row); routes that write
 * their audit row inside their own transaction (invite, role, unlock) do not carry it.
 * `candidateData` marks a route that reads or changes candidate data, which must be audited.
 */
export interface MatrixEntry {
  roles: readonly string[];
  permission: string;
  audited?: true;
  candidateData?: true;
}
export interface RegistryApi {
  ROUTE_PERMISSIONS: Readonly<Record<string, 'public' | MatrixEntry>>;
  listRoutes: (modules: unknown) => { key: string; handler: string }[];
  matrixProblems: (routes: { key: string; handler: string }[]) => string[];
}
export function loadBackendRegistry(): RegistryApi {
  const perms = jest.requireActual<Pick<RegistryApi, 'ROUTE_PERMISSIONS'>>(
    '../../src/common/auth/route-permissions',
  );
  const reg = jest.requireActual<Pick<RegistryApi, 'listRoutes' | 'matrixProblems'>>(
    '../../src/common/auth/route-registry',
  );
  return { ROUTE_PERMISSIONS: perms.ROUTE_PERMISSIONS, ...reg };
}

/**
 * Registry routes that QA covers in other files (tc-003: re-auth and 2FA routes). Every other
 * non-public route in the registry must be in BE03_ROUTES, or the matrix test fails.
 */
export const COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  'POST /auth/2fa/setup/start': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/setup/confirm': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/disable': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/recovery-codes/regenerate': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/reset/:userId': 'apps/api/test/integration/tc-003.int.test.ts',
};

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
  /** Returns true when the call left the target unchanged (used after 403/404/409). */
  unchanged: () => Promise<boolean>;
}

export interface Be03Route {
  id: string;
  step: 'BE-03' | 'BE-13';
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path template as the backend registry writes it (no query string), under /api/v1. */
  template: string;
  /** Distinguishes routes that share one method and template (PATCH role / deactivate / reactivate). */
  variant?: string;
  permission: Permission;
  /** null: not audited. Reads of candidate data are audited (FR-105). */
  audit: { action: string; entityType: string } | null;
  /**
   * true: the row is written by the AuditInterceptor, so metadata is exactly {method, route
   * template} and there is no entity id (a list read has no single target).
   */
  interceptor?: boolean;
  mutating: boolean;
  /** true: a successful call sends a mail whose URL carries a token (checked for leaks). */
  sendsMail?: boolean;
  /** false: the route takes no body, so the invalid-body (400) test does not apply. Default true. */
  takesBody?: boolean;
  /** true: the body carries the acting admin's `currentPassword` (missing 400, wrong 403 REAUTH_FAILED). */
  reauth?: boolean;
  /** Kind of the path id, for the existence-oracle test. Default 'uuid'. */
  idKind?: 'uuid' | 'bigint';
  /** Status codes accepted as success. */
  ok: number[];
  /** Builds a fresh target in `orgId` (each call may consume or change its target). */
  prepare(h: Harness, orgId: string): Promise<Target>;
}

export const routeKey = (r: Pick<Be03Route, 'method' | 'template'>): string =>
  `${r.method} ${r.template}`;
export const hasPathId = (r: Pick<Be03Route, 'template'>): boolean => /:\w+/.test(r.template);
export const routeLabel = (r: Be03Route): string =>
  `${routeKey(r)}${r.variant ? ` (${r.variant})` : ''}`;

let n = 0;
const uniq = (): string => `${Date.now().toString(36)}${++n}`;

async function userTarget(
  h: Harness,
  orgId: string,
  opts: { active?: boolean; role?: UserRole } = {},
): Promise<{ id: string; email: string }> {
  const email = `qa-target-${uniq()}@example.com`;
  const u = await h.owner.user.create({
    data: {
      orgId,
      email,
      fullName: 'QA Target',
      role: opts.role ?? UserRole.RECRUITER,
      isActive: opts.active ?? true,
      passwordHash: 'not-a-real-hash', // the users_check constraint needs a hash or a set-password token
    },
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

const noop = (): Promise<boolean> => Promise.resolve(true);
// Routes built with withPassword() list PASSWORD in `secrets`: the acting admin's password must
// never reach an audit column (TC-006).
const withPassword = <T extends object>(body: T): T & { currentPassword: string } => ({
  ...body,
  currentPassword: PASSWORD,
});

export const BE03_ROUTES: Be03Route[] = [
  {
    id: 'users-list',
    step: 'BE-03',
    method: 'GET',
    template: ADMIN_USERS,
    permission: 'user:manage',
    audit: { action: 'USER_LIST', entityType: 'user' },
    interceptor: true,
    mutating: false,
    ok: [200],
    prepare: () =>
      Promise.resolve({
        path: `${ADMIN_USERS}?page=1&pageSize=50`,
        secrets: [],
        unchanged: noop,
      }),
  },
  {
    id: 'users-lock-events',
    step: 'BE-03',
    method: 'GET',
    template: lockEventsPath,
    permission: 'user:manage',
    audit: { action: 'USER_LOCK_EVENTS_LIST', entityType: 'user' },
    interceptor: true,
    mutating: false,
    ok: [200],
    prepare: () =>
      Promise.resolve({
        path: `${lockEventsPath}?page=1&pageSize=50`,
        secrets: [],
        unchanged: noop,
      }),
  },
  {
    id: 'users-invite',
    step: 'BE-03',
    method: 'POST',
    template: ADMIN_USERS,
    variant: 'invite',
    permission: 'user:manage',
    audit: { action: 'USER_INVITED', entityType: 'user' },
    mutating: true,
    sendsMail: true,
    reauth: true,
    ok: [201],
    prepare: (h, orgId) => {
      const email = `qa-invitee-${uniq()}@example.com`;
      const lookup = (): Promise<{ id: string } | null> =>
        h.owner.user.findFirst({ where: { orgId, email }, select: { id: true } });
      return Promise.resolve({
        path: ADMIN_USERS,
        body: withPassword({ email, name: 'QA Invitee', role: 'RECRUITER' }),
        secrets: [PASSWORD], // the 72 h set-password token is read from the captured mail by the test
        resolveEntityId: async () => (await lookup())?.id,
        unchanged: async () => (await lookup()) === null,
      });
    },
  },
  {
    id: 'users-role',
    step: 'BE-03',
    method: 'PATCH',
    template: `${ADMIN_USERS}/:userId`,
    variant: 'role change',
    permission: 'user:manage',
    audit: { action: 'USER_ROLE_CHANGED', entityType: 'user' },
    mutating: true,
    reauth: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const u = await userTarget(h, orgId);
      return {
        path: `${ADMIN_USERS}/${u.id}`,
        body: withPassword({ role: 'AUTHOR' }),
        entityId: u.id,
        secrets: [PASSWORD],
        unchanged: async () =>
          (await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).role ===
          UserRole.RECRUITER,
      };
    },
  },
  {
    id: 'users-deactivate',
    step: 'BE-03',
    method: 'PATCH',
    template: `${ADMIN_USERS}/:userId`,
    variant: 'deactivate',
    permission: 'user:manage',
    audit: { action: 'USER_DEACTIVATED', entityType: 'user' },
    mutating: true,
    reauth: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const u = await userTarget(h, orgId);
      return {
        path: `${ADMIN_USERS}/${u.id}`,
        body: withPassword({ active: false }),
        entityId: u.id,
        secrets: [PASSWORD],
        unchanged: async () =>
          (await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).isActive,
      };
    },
  },
  {
    id: 'users-reactivate',
    step: 'BE-03',
    method: 'PATCH',
    template: `${ADMIN_USERS}/:userId`,
    variant: 'reactivate',
    permission: 'user:manage',
    audit: { action: 'USER_REACTIVATED', entityType: 'user' },
    mutating: true,
    reauth: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const u = await userTarget(h, orgId, { active: false });
      return {
        path: `${ADMIN_USERS}/${u.id}`,
        body: withPassword({ active: true }),
        entityId: u.id,
        secrets: [PASSWORD],
        unchanged: async () =>
          !(await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).isActive,
      };
    },
  },
  {
    // Added to BE-03 by the owner (P-03): audited admin unlock of a locked staff account.
    id: 'users-unlock',
    step: 'BE-03',
    method: 'POST',
    template: `${ADMIN_USERS}/:userId/unlock`,
    permission: 'user:manage',
    audit: { action: 'USER_UNLOCKED', entityType: 'user' },
    mutating: true,
    reauth: true,
    ok: [204],
    prepare: async (h, orgId) => {
      const u = await userTarget(h, orgId);
      await h.owner.user.update({
        where: { id: u.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) },
      });
      return {
        path: `${ADMIN_USERS}/${u.id}/unlock`,
        body: withPassword({}),
        entityId: u.id,
        secrets: [PASSWORD],
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
    idKind: 'bigint',
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

/**
 * How the admin alert on account lock (P-03) is observed. Backend (final): no ADMIN_ALERT audit row.
 * The lock itself is the existing AUTH_ACCOUNT_LOCKED row (written at lock); the in-app alert is
 * GET /admin/users/lock-events (SUPER_ADMIN only, org scoped, reads those rows) plus `locked` and
 * `lockedUntil` on GET /admin/users; e-mail goes through MailPort sendStaffAccountLocked
 * (template 'staff-account-locked') to every active SUPER_ADMIN of the org.
 */
export async function lockAlertsFor(h: Harness, orgId: string, userId: string): Promise<unknown[]> {
  return h.owner.auditLog.findMany({
    where: {
      orgId,
      action: 'AUTH_ACCOUNT_LOCKED',
      OR: [{ actorId: userId }, { entityId: userId }],
    },
  });
}

/** A random id of the right kind that no row has: a UUID, or a large unused bigint (events). */
export function randomIdOf(kind: 'uuid' | 'bigint'): string {
  if (kind === 'uuid') return crypto.randomUUID();
  return String(8_000_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 2 ** 31)));
}

/** `path` with ONLY the path segment equal to `id` replaced (never a substring match, never the query). */
export function withReplacedId(path: string, id: string, replacement: string): string {
  const [pathname = '', query] = path.split('?');
  const segments = pathname.split('/').map((seg) => (seg === id ? replacement : seg));
  return query === undefined ? segments.join('/') : `${segments.join('/')}?${query}`;
}

export const routesFor = (step: Be03Route['step']): Be03Route[] =>
  BE03_ROUTES.filter((r) => r.step === step);
