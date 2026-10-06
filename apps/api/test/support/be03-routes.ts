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
//   POST  /admin/users/:userId/invite {currentPassword}  200 StaffUserDto (status 'invited', no token
//         fields); re-issue of a pending invite (Backend A, branch backend/invite-reissue). Same step-up
//         rules; 409 when the user has a password or is deactivated; shares the per-org invite limit
//         (429); 503 Redis down; audit USER_INVITE_REISSUED written in the rotation's transaction with
//         metadata ONLY {method, route '/api/v1/admin/users/:userId/invite'}, NOT @Audited (no `audited`
//         flag in the matrix). Listed ONLY when the backend's ROUTE_PERMISSIONS has the key (see below).
//
// BE-04 (question bank): 23 routes (4a: 11 under /questions, 4b: 7 variant routes, 4c: validate, validation status and 3 AI reference routes), listed below in the same table so the
// generic 401, 403, cross-org 404, effect and audit tests drive them. The audit rows are written by
// the service in the mutation's own transaction (NOT @Audited, so no `audited` flag in the matrix):
// entity `question`, entity id the question, metadata of ids and changed field NAMES only (never
// content), listed per route in `metadataKeys`. Reads are not audited (a question is not candidate
// data). Question reads: SUPER_ADMIN, RECRUITER, AUTHOR; writes: SUPER_ADMIN, AUTHOR. The variant
// list GET is question:update (author data); only the variant preview is question:read.
//
// BE-06 (slice 6a, test builder): 4 routes under /tests (GET list, POST, GET by id, PATCH) in the same
// table. Permissions test:read, test:create, test:update; SUPER_ADMIN and RECRUITER only (AUTHOR and
// REVIEWER get 403). The audit rows TEST_CREATED and TEST_UPDATED are written by the service in the
// mutation's transaction (NOT @Audited, no `audited` flag): entity `test`, metadata ids and field names
// only, never names, titles or descriptions. Reads are not audited. There is one PATCH entry because
// the matrix test requires one audit action per entry.
//
// Switches: the BE-03, BE-04 and BE-06 tests run by default (BE03_DEFAULT, BE04_DEFAULT, BE06_DEFAULT = true). The
// review routes (BE-13) stay off until BE13_DEFAULT is flipped, or `BE13_READY=1` in the environment for a trial run. The BE-13
// entries are still ASSUMED.
import {
  hasPermission,
  PERMISSIONS,
  PRINCIPALS,
  USER_ROLES,
} from '../../../../packages/shared/src/permissions';
import type { Permission, Principal } from '../../../../packages/shared/src/permissions';
import { UserRole } from '../../src/generated/prisma/client';
import { computeRevision } from '../../src/questions/revision';
import { Harness, PASSWORD } from './harness';

// BE-03 is merged (PR #84): the BE-03 tests run on every PR. BE-13 stays staged.
const BE03_DEFAULT = true;
// BE-04 (slice 4a) is always on: the registry test fails when a backend route is missing from the QA
// list, so these tests must run whenever the routes exist. There is no environment switch.
const BE04_DEFAULT = true;
// BE-06 (slice 6a) is always on for the same reason as BE-04.
const BE06_DEFAULT = true;
const BE13_DEFAULT = false; // flip to true when BE-13 is merged
export const BE03_READY: boolean = BE03_DEFAULT || process.env.BE03_READY === '1';
export const BE04_READY: boolean = BE04_DEFAULT;
export const BE06_READY: boolean = BE06_DEFAULT;
export const BE13_READY: boolean = BE13_DEFAULT || process.env.BE13_READY === '1';

export { PRINCIPALS, USER_ROLES };
export type { Permission, Principal };
export const allowedRoles = (permission: Permission): UserRole[] =>
  USER_ROLES.filter((r) => hasPermission(r, permission)).map((r) => UserRole[r]);

/** Prefix of the staff user admin routes (under /api/v1). */
export const ADMIN_USERS = '/admin/users';
export const lockEventsPath = `${ADMIN_USERS}/lock-events`;

/**
 * The backend route registry (apps/api/src/common/auth/route-permissions.ts and route-registry.ts),
 * loaded lazily with jest.requireActual after the test app has reset the module registry.
 * Only called from tests that run behind BE03_READY.
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
/** A candidate-session route (FU-BE-91): no roles, never audited; the permission is candidate_*. */
export interface CandidateMatrixEntry {
  principal: 'CANDIDATE';
  permission: string;
}
export type AnyMatrixEntry = 'public' | MatrixEntry | CandidateMatrixEntry;
/** The route facts the registry exposes (RegisteredRoute in route-registry.ts), as far as QA reads them. */
export interface ListedRoute {
  key: string;
  handler: string;
  isPublic?: boolean;
  roles?: readonly string[];
  audited?: boolean;
  candidatePermission?: string | null;
}
export interface RegistryApi {
  ROUTE_PERMISSIONS: Readonly<Record<string, AnyMatrixEntry>>;
  CANDIDATE_BOOTSTRAP_ROUTES?: readonly string[];
  listRoutes: (modules: unknown) => ListedRoute[];
  matrixProblems: (routes: ListedRoute[]) => string[];
}
// Order matters for readers: a candidate entry has `principal` and no `roles`, a staff entry has
// `roles`; an entry with both is reported by candidateRegistryProblems as an extra key.
export const isCandidateEntry = (e: AnyMatrixEntry | undefined): e is CandidateMatrixEntry =>
  typeof e === 'object' && 'principal' in e;
export const isStaffEntry = (e: AnyMatrixEntry | undefined): e is MatrixEntry =>
  typeof e === 'object' && 'roles' in e;
export function loadBackendRegistry(): RegistryApi {
  const perms = jest.requireActual<
    Pick<RegistryApi, 'ROUTE_PERMISSIONS' | 'CANDIDATE_BOOTSTRAP_ROUTES'>
  >('../../src/common/auth/route-permissions');
  const reg = jest.requireActual<Pick<RegistryApi, 'listRoutes' | 'matrixProblems'>>(
    '../../src/common/auth/route-registry',
  );
  return {
    ROUTE_PERMISSIONS: perms.ROUTE_PERMISSIONS,
    CANDIDATE_BOOTSTRAP_ROUTES: perms.CANDIDATE_BOOTSTRAP_ROUTES,
    ...reg,
  };
}

/**
 * Registry routes that QA covers in other files (tc-003: re-auth and 2FA routes; org settings: apps/api/src/org-settings/org-settings.e2e-spec.ts). Every other
 * non-public route in the registry must be in BE03_ROUTES, or the matrix test fails.
 */
export const COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  'POST /auth/2fa/setup/start': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/setup/confirm': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/disable': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/recovery-codes/regenerate': 'apps/api/test/integration/tc-003.int.test.ts',
  'POST /auth/2fa/reset/:userId': 'apps/api/test/integration/tc-003.int.test.ts',
  // Org settings (FU-BE-133): role matrix, isolation, step-up (PATCH needs currentPassword) and audit in apps/api/src/org-settings/org-settings.e2e-spec.ts.
  'GET /admin/org-settings': 'apps/api/src/org-settings/org-settings.e2e-spec.ts',
  'PATCH /admin/org-settings': 'apps/api/src/org-settings/org-settings.e2e-spec.ts',
  // Invitations (FR-303, BE-06 slice 6c): role matrix, isolation, audit and races in apps/api/src/invitations/invitations.e2e-spec.ts.
  'POST /tests/:id/invitations': 'apps/api/src/invitations/invitations.e2e-spec.ts',
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
  step: 'BE-03' | 'BE-04' | 'BE-06' | 'BE-13';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
  /**
   * true: a service-written row (not @Audited) whose metadata is exactly {method, route} with the
   * route being '/api/v1' + template, and which names the target entity.
   */
  routeMetadata?: boolean;
  /**
   * A service-written row (in the mutation's transaction) whose metadata has exactly these keys
   * (sorted): ids and changed field names, never content (BE-04).
   */
  metadataKeys?: readonly string[];
  /** Value check per metadata key (types and formats, not just names). */
  metadataShape?: Readonly<Record<string, (v: unknown) => boolean>>;
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

/** True when the backend's route matrix already has `key`; false when the file is absent or lacks it. */
export function backendHasRoute(key: string): boolean {
  try {
    const perms = jest.requireActual<Pick<RegistryApi, 'ROUTE_PERMISSIONS'>>(
      '../../src/common/auth/route-permissions',
    );
    return Object.hasOwn(perms.ROUTE_PERMISSIONS, key);
  } catch (e) {
    // Only a missing registry file means "not there"; any other error (a syntax or import error in
    // the backend file) must surface, not hide the route.
    if ((e as { code?: string }).code === 'MODULE_NOT_FOUND') return false;
    throw e;
  }
}

/** A pending invite: no password, a live set-password token. */
async function pendingInvitee(
  h: Harness,
  orgId: string,
): Promise<{ id: string; tokenHash: string }> {
  const t = uniq();
  const tokenHash = `qa-invite-token-hash-${t}`;
  const u = await h.owner.user.create({
    data: {
      orgId,
      email: `qa-pending-${t}@example.com`,
      fullName: 'QA Pending',
      role: UserRole.RECRUITER,
      isActive: true,
      setPasswordTokenHash: tokenHash,
      setPasswordExpiresAt: new Date(Date.now() + 72 * 3_600_000),
    },
  });
  return { id: u.id, tokenHash };
}

// Backend A's invite re-issue route (contract confirmed). Included only when the backend serves it, so TC-004's
// "the backend matrix agrees with the controllers" check is green before and after it lands.
const reissueRoutes: Be03Route[] = backendHasRoute('POST /admin/users/:userId/invite')
  ? [
      {
        id: 'users-invite-reissue',
        step: 'BE-03',
        method: 'POST',
        template: `${ADMIN_USERS}/:userId/invite`,
        permission: 'user:manage',
        audit: { action: 'USER_INVITE_REISSUED', entityType: 'user' },
        routeMetadata: true,
        mutating: true,
        sendsMail: true,
        reauth: true,
        ok: [200],
        prepare: async (h, orgId) => {
          const u = await pendingInvitee(h, orgId);
          return {
            path: `${ADMIN_USERS}/${u.id}/invite`,
            body: withPassword({}),
            entityId: u.id,
            secrets: [PASSWORD],
            unchanged: async () =>
              (await h.owner.user.findUniqueOrThrow({ where: { id: u.id } }))
                .setPasswordTokenHash === u.tokenHash,
          };
        },
      },
    ]
  : [];

// ---- BE-04 question fixtures (owner role: need only the schema, not any route) ----------------------
/** Secrets that must never reach an audit row, a log line or a candidate view. */
export const REF_SECRET = 'QA-REFERENCE-SOLUTION-SECRET';
export const HIDDEN_IN = 'QA-HIDDEN-INPUT-7';
export const HIDDEN_OUT = 'QA-HIDDEN-OUTPUT-7';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_NAMES = [
  'title',
  'statementMd',
  'difficulty',
  'allowedLanguages',
  'limits',
  'starterCode',
  'referenceSolution',
  'answerSpec',
  'tags',
  'input',
  'expectedOutput',
  'isHidden',
  'weight',
  'position',
  'params',
  'isActive',
];
const isInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v);
const isBool = (v: unknown): boolean => typeof v === 'boolean';
const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
const isType = (v: unknown): boolean => ['CODING', 'MCQ', 'SHORT_ANSWER'].includes(v as string);
/** `fields`: a non-empty array of DTO field NAMES, never values. */
const isFieldList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => typeof x === 'string' && FIELD_NAMES.includes(x));

export interface QuestionFix {
  id: string;
  title: string;
  /** Version rows by number. */
  versionIds: Record<number, string>;
  sampleId: string;
  hiddenId: string;
}

/**
 * A CODING question in `orgId`: version 1 with python, a reference solution, one sample and one
 * hidden test. `published` makes version 1 the current published version; `archived` archives it;
 * `testCases: false` leaves the version without tests (an incomplete draft).
 */
export async function questionFixture(
  h: Harness,
  orgId: string,
  opts: { published?: boolean; archived?: boolean; testCases?: boolean } = {},
): Promise<QuestionFix> {
  const t = uniq();
  const title = `QA question ${t}`;
  const q = await h.owner.question.create({
    data: {
      orgId,
      slug: `qa-q-${t}`,
      type: 'CODING',
      tags: ['qa'],
      isArchived: opts.archived ?? false,
    },
  });
  const v = await h.owner.questionVersion.create({
    data: {
      questionId: q.id,
      version: 1,
      title,
      statementMd: 'Add two numbers.',
      difficulty: 'EASY',
      allowedLanguages: ['python'],
      starterCode: { python: 'def solve(): ...' },
      referenceSolution: { python: REF_SECRET },
      isPublished: opts.published ?? false,
    },
  });
  let sampleId = '';
  let hiddenId = '';
  if (opts.testCases !== false) {
    sampleId = (
      await h.owner.testCase.create({
        data: {
          questionVersionId: v.id,
          input: '1 2',
          expectedOutput: '3',
          isHidden: false,
          position: 0,
        },
      })
    ).id;
    hiddenId = (
      await h.owner.testCase.create({
        data: {
          questionVersionId: v.id,
          input: HIDDEN_IN,
          expectedOutput: HIDDEN_OUT,
          isHidden: true,
          weight: 2,
          position: 1,
        },
      })
    ).id;
  }
  if (opts.published) {
    await h.owner.question.update({ where: { id: q.id }, data: { currentVersionId: v.id } });
  }
  return { id: q.id, title, versionIds: { 1: v.id }, sampleId, hiddenId };
}

/**
 * Stands in for a PASSED validate run (BE-04 slice 4c): records a passing validation of the
 * CURRENT content of the latest version of a question, directly in the database, bound to the
 * revision the backend computes. Publish of a coding question needs it (FR-203, fails closed).
 */
export async function markValidated(h: Harness, questionId: string): Promise<void> {
  // These tests are about other rules than the AI reference gate (ADR 0005 AI-5, BE-04c): switch
  // it off for the question's org so a publish needs only the validation result.
  const { orgId } = await h.owner.question.findUniqueOrThrow({ where: { id: questionId } });
  const org = await h.owner.organization.findUniqueOrThrow({ where: { id: orgId } });
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const aiReferences = (settings.aiReferences ?? {}) as Record<string, unknown>;
  await h.owner.organization.update({
    where: { id: orgId },
    data: { settings: { ...settings, aiReferences: { ...aiReferences, minAssistants: 0 } } },
  });
  const head = await h.owner.questionVersion.findFirstOrThrow({
    where: { questionId },
    orderBy: { version: 'desc' },
  });
  const cases = await h.owner.testCase.findMany({ where: { questionVersionId: head.id } });
  const variants = await h.owner.questionVariant.findMany({
    where: { questionVersionId: head.id },
    include: { testCaseOverrides: true },
  });
  await h.owner.questionVersion.update({
    where: { id: head.id },
    data: {
      validatedAt: new Date(),
      validationReport: { passed: true, revision: computeRevision(head, cases, variants) },
    },
  });
}

const questionRow = (h: Harness, id: string) =>
  h.owner.question.findUniqueOrThrow({ where: { id } });
const versionCount = (h: Harness, id: string): Promise<number> =>
  h.owner.questionVersion.count({ where: { questionId: id } });

/** The create body: a complete coding question with one sample and one hidden test. */
const createBody = (slug: string): Record<string, unknown> => ({
  slug,
  title: 'QA created question',
  statementMd: 'Add two numbers.',
  difficulty: 'EASY',
  tags: ['qa'],
  allowedLanguages: ['python'],
  starterCode: { python: 'def solve(): ...' },
  referenceSolution: { python: REF_SECRET },
  testCases: [
    { input: '1 2', expectedOutput: '3', isHidden: false },
    { input: HIDDEN_IN, expectedOutput: HIDDEN_OUT, isHidden: true, weight: 2 },
  ],
});

const QUESTIONS = '/questions';
const VARIANT_SECRET = 'QA-VARIANT-PARAM';
const AI_SECRET = 'QA-AI-SOLUTION-SECRET';
const AI_PROMPT = 'QA-AI-PROMPT-SECRET';
const OVERRIDE_IN = 'QA-OVERRIDE-IN';
const OVERRIDE_OUT = 'QA-OVERRIDE-OUT';

/** A coding question (see questionFixture) with one active variant, optionally with an override on the hidden slot. */
async function variantFixture(
  h: Harness,
  orgId: string,
  opts: { published?: boolean; override?: boolean } = {},
): Promise<QuestionFix & { variantId: string }> {
  const f = await questionFixture(h, orgId, { published: opts.published ?? false });
  const variant = await h.owner.questionVariant.create({
    data: {
      questionVersionId: f.versionIds[1] as string,
      params: { secret: VARIANT_SECRET },
      renderedStatement: 'Add two numbers.',
    },
  });
  if (opts.override) {
    await h.owner.variantTestCase.create({
      data: {
        variantId: variant.id,
        testCaseId: f.hiddenId,
        input: OVERRIDE_IN,
        expectedOutput: OVERRIDE_OUT,
      },
    });
  }
  return { ...f, variantId: variant.id };
}
const variantCount = (h: Harness, versionId: string): Promise<number> =>
  h.owner.questionVariant.count({ where: { questionVersionId: versionId } });
// Content that must never reach an audit row: the fixture and request body values too.
const qSecrets = [
  REF_SECRET,
  HIDDEN_IN,
  HIDDEN_OUT,
  'QA-CHANGED-OUTPUT',
  'QA edited title',
  'QA created question',
  'Add two numbers.',
  VARIANT_SECRET,
  OVERRIDE_IN,
  OVERRIDE_OUT,
];

/** A question-route entry with the shared BE-04 defaults; each route overrides what differs. */
function q04(
  r: Omit<Be03Route, 'step' | 'prepare'> & { prepare: Be03Route['prepare'] },
): Be03Route {
  return { step: 'BE-04', ...r };
}

const BE04_ROUTES: Be03Route[] = [
  q04({
    id: 'questions-list',
    method: 'GET',
    template: QUESTIONS,
    permission: 'question:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: () =>
      Promise.resolve({ path: `${QUESTIONS}?page=1&pageSize=50`, secrets: [], unchanged: noop }),
  }),
  q04({
    id: 'ai-policy-read',
    method: 'GET',
    template: `${QUESTIONS}/ai-policy`,
    permission: 'ai_reference:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: () =>
      Promise.resolve({ path: `${QUESTIONS}/ai-policy`, secrets: [], unchanged: noop }),
  }),
  q04({
    id: 'questions-create',
    method: 'POST',
    template: QUESTIONS,
    permission: 'question:create',
    audit: { action: 'QUESTION_CREATED', entityType: 'question' },
    metadataKeys: ['testCases', 'type', 'version'],
    metadataShape: { testCases: isCount, type: isType, version: isInt },
    mutating: true,
    ok: [201],
    prepare: (h, orgId) => {
      const slug = `qa-create-${uniq()}`;
      const lookup = (): Promise<{ id: string } | null> =>
        h.owner.question.findFirst({ where: { orgId, slug }, select: { id: true } });
      return Promise.resolve({
        path: QUESTIONS,
        body: createBody(slug),
        secrets: qSecrets,
        resolveEntityId: async () => (await lookup())?.id,
        unchanged: async () => (await lookup()) === null,
      });
    },
  }),
  q04({
    id: 'questions-get',
    method: 'GET',
    template: `${QUESTIONS}/:id`,
    permission: 'question:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId, { published: true }); // recruiters read published versions only
      return { path: `${QUESTIONS}/${f.id}`, entityId: f.id, secrets: [], unchanged: noop };
    },
  }),
  q04({
    id: 'questions-preview',
    method: 'GET',
    template: `${QUESTIONS}/:id/preview`,
    permission: 'question:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId, { published: true });
      return {
        path: `${QUESTIONS}/${f.id}/preview`,
        entityId: f.id,
        secrets: [],
        unchanged: noop,
      };
    },
  }),
  q04({
    id: 'questions-update-draft',
    method: 'PATCH',
    template: `${QUESTIONS}/:id`,
    variant: 'edit draft in place',
    permission: 'question:update',
    audit: { action: 'QUESTION_UPDATED', entityType: 'question' },
    metadataKeys: ['fields', 'version'],
    metadataShape: { fields: isFieldList, version: isInt },
    mutating: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}`,
        body: { title: 'QA edited title' },
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (
            await h.owner.questionVersion.findUniqueOrThrow({
              where: { id: f.versionIds[1] as string },
            })
          ).title === f.title,
      };
    },
  }),
  q04({
    id: 'questions-update-published',
    method: 'PATCH',
    template: `${QUESTIONS}/:id`,
    variant: 'edit published creates a version',
    permission: 'question:update',
    audit: { action: 'QUESTION_VERSION_CREATED', entityType: 'question' },
    metadataKeys: ['fields', 'fromVersion', 'version'],
    metadataShape: { fields: isFieldList, fromVersion: isInt, version: isInt },
    mutating: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId, { published: true });
      return {
        path: `${QUESTIONS}/${f.id}`,
        body: { title: 'QA edited title' },
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () => (await versionCount(h, f.id)) === 1,
      };
    },
  }),
  q04({
    id: 'questions-publish',
    method: 'POST',
    template: `${QUESTIONS}/:id/publish`,
    permission: 'question:update',
    audit: { action: 'QUESTION_PUBLISHED', entityType: 'question' },
    metadataKeys: ['version'],
    metadataShape: { version: isInt },
    mutating: true,
    takesBody: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      await markValidated(h, f.id);
      return {
        path: `${QUESTIONS}/${f.id}/publish`,
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (await questionRow(h, f.id)).currentVersionId === null &&
          !(
            await h.owner.questionVersion.findUniqueOrThrow({
              where: { id: f.versionIds[1] as string },
            })
          ).isPublished,
      };
    },
  }),
  q04({
    id: 'questions-archive',
    method: 'POST',
    template: `${QUESTIONS}/:id/archive`,
    permission: 'question:update',
    audit: { action: 'QUESTION_ARCHIVED', entityType: 'question' },
    metadataKeys: [],
    mutating: true,
    takesBody: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/archive`,
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () => !(await questionRow(h, f.id)).isArchived,
      };
    },
  }),
  q04({
    id: 'questions-unarchive',
    method: 'POST',
    template: `${QUESTIONS}/:id/unarchive`,
    permission: 'question:update',
    audit: { action: 'QUESTION_UNARCHIVED', entityType: 'question' },
    metadataKeys: [],
    mutating: true,
    takesBody: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId, { archived: true });
      return {
        path: `${QUESTIONS}/${f.id}/unarchive`,
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () => (await questionRow(h, f.id)).isArchived,
      };
    },
  }),
  q04({
    id: 'questions-testcase-add',
    method: 'POST',
    template: `${QUESTIONS}/:id/versions/:version/test-cases`,
    permission: 'question:update',
    audit: { action: 'QUESTION_TEST_CASE_ADDED', entityType: 'question' },
    metadataKeys: ['isHidden', 'testCaseId', 'version'],
    metadataShape: { isHidden: isBool, testCaseId: isUuid, version: isInt },
    mutating: true,
    ok: [201],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      const before = await h.owner.testCase.count({
        where: { questionVersionId: f.versionIds[1] as string },
      });
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/test-cases`,
        body: { input: HIDDEN_IN, expectedOutput: HIDDEN_OUT, isHidden: true },
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (await h.owner.testCase.count({
            where: { questionVersionId: f.versionIds[1] as string },
          })) === before,
      };
    },
  }),
  q04({
    id: 'questions-testcase-update',
    method: 'PATCH',
    template: `${QUESTIONS}/:id/versions/:version/test-cases/:testCaseId`,
    permission: 'question:update',
    audit: { action: 'QUESTION_TEST_CASE_UPDATED', entityType: 'question' },
    metadataKeys: ['fields', 'testCaseId', 'version'],
    metadataShape: { fields: isFieldList, testCaseId: isUuid, version: isInt },
    mutating: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/test-cases/${f.hiddenId}`,
        body: { expectedOutput: 'QA-CHANGED-OUTPUT' },
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (await h.owner.testCase.findUniqueOrThrow({ where: { id: f.hiddenId } }))
            .expectedOutput === HIDDEN_OUT,
      };
    },
  }),
  q04({
    id: 'questions-testcase-remove',
    method: 'DELETE',
    template: `${QUESTIONS}/:id/versions/:version/test-cases/:testCaseId`,
    permission: 'question:update',
    audit: { action: 'QUESTION_TEST_CASE_REMOVED', entityType: 'question' },
    metadataKeys: ['testCaseId', 'version'],
    metadataShape: { testCaseId: isUuid, version: isInt },
    mutating: true,
    takesBody: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/test-cases/${f.hiddenId}`,
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () => (await h.owner.testCase.count({ where: { id: f.hiddenId } })) === 1,
      };
    },
  }),
  q04({
    id: 'variants-list',
    method: 'GET',
    template: `${QUESTIONS}/:id/versions/:version/variants`,
    permission: 'question:update',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await variantFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/variants`,
        entityId: f.id,
        secrets: [],
        unchanged: noop,
      };
    },
  }),
  q04({
    id: 'variants-create',
    method: 'POST',
    template: `${QUESTIONS}/:id/versions/:version/variants`,
    permission: 'question:update',
    audit: { action: 'QUESTION_VARIANT_ADDED', entityType: 'question' },
    metadataKeys: ['isActive', 'variantId', 'version'],
    metadataShape: { isActive: isBool, variantId: isUuid, version: isInt },
    mutating: true,
    ok: [201],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      const versionId = f.versionIds[1] as string;
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/variants`,
        body: { params: { secret: VARIANT_SECRET } },
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () => (await variantCount(h, versionId)) === 0,
      };
    },
  }),
  q04({
    id: 'variants-preview',
    method: 'GET',
    template: `${QUESTIONS}/:id/versions/:version/variants/:variantId/preview`,
    permission: 'question:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await variantFixture(h, orgId, { published: true, override: true });
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/variants/${f.variantId}/preview`,
        entityId: f.id,
        secrets: [],
        unchanged: noop,
      };
    },
  }),
  q04({
    id: 'variants-update',
    method: 'PATCH',
    template: `${QUESTIONS}/:id/versions/:version/variants/:variantId`,
    permission: 'question:update',
    audit: { action: 'QUESTION_VARIANT_UPDATED', entityType: 'question' },
    metadataKeys: ['fields', 'variantId', 'version'],
    metadataShape: {
      fields: (v) => isFieldList(v) && JSON.stringify(v) === '["params","isActive"]',
      variantId: isUuid,
      version: isInt,
    },
    mutating: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await variantFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/variants/${f.variantId}`,
        body: { params: { secret: 'QA-VARIANT-CHANGED' }, isActive: false },
        entityId: f.id,
        secrets: [...qSecrets, 'QA-VARIANT-CHANGED'],
        unchanged: async () =>
          (await h.owner.questionVariant.findUniqueOrThrow({ where: { id: f.variantId } }))
            .isActive === true,
      };
    },
  }),
  q04({
    id: 'variants-remove',
    method: 'DELETE',
    template: `${QUESTIONS}/:id/versions/:version/variants/:variantId`,
    permission: 'question:update',
    audit: { action: 'QUESTION_VARIANT_REMOVED', entityType: 'question' },
    metadataKeys: ['variantId', 'version'],
    metadataShape: { variantId: isUuid, version: isInt },
    mutating: true,
    takesBody: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await variantFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/variants/${f.variantId}`,
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (await h.owner.questionVariant.count({ where: { id: f.variantId } })) === 1,
      };
    },
  }),
  q04({
    id: 'variants-override-set',
    method: 'PUT',
    template: `${QUESTIONS}/:id/versions/:version/variants/:variantId/test-cases/:testCaseId`,
    permission: 'question:update',
    audit: { action: 'QUESTION_VARIANT_TEST_CASE_SET', entityType: 'question' },
    metadataKeys: ['isHidden', 'testCaseId', 'variantId', 'version'],
    metadataShape: { isHidden: isBool, testCaseId: isUuid, variantId: isUuid, version: isInt },
    mutating: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await variantFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/variants/${f.variantId}/test-cases/${f.hiddenId}`,
        body: { input: OVERRIDE_IN, expectedOutput: OVERRIDE_OUT },
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (await h.owner.variantTestCase.count({ where: { variantId: f.variantId } })) === 0,
      };
    },
  }),
  q04({
    id: 'variants-override-remove',
    method: 'DELETE',
    template: `${QUESTIONS}/:id/versions/:version/variants/:variantId/test-cases/:testCaseId`,
    permission: 'question:update',
    audit: { action: 'QUESTION_VARIANT_TEST_CASE_REMOVED', entityType: 'question' },
    metadataKeys: ['testCaseId', 'variantId', 'version'],
    metadataShape: { testCaseId: isUuid, variantId: isUuid, version: isInt },
    mutating: true,
    takesBody: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await variantFixture(h, orgId, { override: true });
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/variants/${f.variantId}/test-cases/${f.hiddenId}`,
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (await h.owner.variantTestCase.count({ where: { variantId: f.variantId } })) === 1,
      };
    },
  }),
  q04({
    id: 'questions-validate',
    method: 'POST',
    template: `${QUESTIONS}/:id/validate`,
    permission: 'question:validate',
    audit: { action: 'QUESTION_VALIDATION_STARTED', entityType: 'question' },
    metadataKeys: ['variants', 'version'],
    metadataShape: { variants: isInt, version: isInt },
    mutating: true,
    ok: [202],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/validate`,
        body: {},
        entityId: f.id,
        secrets: qSecrets,
        unchanged: async () =>
          (await h.owner.auditLog.count({
            where: { entityId: f.id, action: 'QUESTION_VALIDATION_STARTED' },
          })) === 0,
      };
    },
  }),
  q04({
    id: 'questions-validation-status',
    method: 'GET',
    template: `${QUESTIONS}/:id/validation`,
    permission: 'question:validate',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/validation`,
        entityId: f.id,
        secrets: [],
        unchanged: noop,
      };
    },
  }),
  q04({
    id: 'ai-references-list',
    method: 'GET',
    template: `${QUESTIONS}/:id/versions/:version/ai-references`,
    permission: 'ai_reference:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/ai-references`,
        entityId: f.id,
        secrets: [],
        unchanged: noop,
      };
    },
  }),
  q04({
    id: 'ai-references-create',
    method: 'POST',
    template: `${QUESTIONS}/:id/versions/:version/ai-references`,
    permission: 'ai_reference:create',
    audit: { action: 'AI_REFERENCE_CREATED', entityType: 'question' },
    metadataKeys: ['aiReferenceId', 'language', 'variantId', 'version'],
    metadataShape: {
      aiReferenceId: isUuid,
      language: (v) => v === 'python',
      variantId: (v) => v === null,
      version: isInt,
    },
    mutating: true,
    ok: [201],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/ai-references`,
        body: {
          assistant: 'QA-ASSISTANT',
          modelLabel: 'qa-model',
          language: 'python',
          solutionCode: AI_SECRET,
          promptText: AI_PROMPT,
        },
        entityId: f.id,
        secrets: [...qSecrets, AI_SECRET, AI_PROMPT, 'QA-ASSISTANT'],
        unchanged: async () =>
          (await h.owner.aiReferenceSolution.count({
            where: { questionVersionId: f.versionIds[1] as string },
          })) === 0,
      };
    },
  }),
  q04({
    id: 'ai-references-supersede',
    method: 'POST',
    template: `${QUESTIONS}/:id/versions/:version/ai-references/:aiReferenceId/supersede`,
    permission: 'ai_reference:supersede',
    audit: { action: 'AI_REFERENCE_SUPERSEDED', entityType: 'question' },
    metadataKeys: ['aiReferenceId', 'replacementId', 'version'],
    metadataShape: { aiReferenceId: isUuid, replacementId: (v) => v === null, version: isInt },
    mutating: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId);
      const collector = await h.owner.user.findFirstOrThrow({
        where: { orgId },
        orderBy: { createdAt: 'asc' },
      });
      const row = await h.owner.aiReferenceSolution.create({
        data: {
          questionVersionId: f.versionIds[1] as string,
          assistant: 'QA-ASSISTANT',
          modelLabel: 'qa-model',
          language: 'python',
          solutionCode: AI_SECRET,
          promptText: AI_PROMPT,
          collectedAt: new Date(),
          collectedById: collector.id,
        },
      });
      return {
        path: `${QUESTIONS}/${f.id}/versions/1/ai-references/${row.id}/supersede`,
        body: {},
        entityId: f.id,
        secrets: [...qSecrets, AI_SECRET, AI_PROMPT, 'QA-ASSISTANT'],
        unchanged: async () =>
          (await h.owner.aiReferenceSolution.findUniqueOrThrow({ where: { id: row.id } }))
            .supersededAt === null,
      };
    },
  }),
];

// ---- BE-06 test builder fixtures (owner role) -----------------------------------------------------
export const TESTS = '/tests';
export const TEST_NAME_SECRET = 'QA-CREATED-TEST-SECRET';
export const TEST_RENAMED_SECRET = 'QA-RENAMED-TEST-SECRET';
export const TEST_DESC_SECRET = 'QA-TEST-DESCRIPTION-SECRET';
export const TEST_SECTION_SECRET = 'QA-SECTION-TITLE-SECRET';
export const TEST_FIXTURE_NAME = 'QA test fixture';
const tSecrets = [
  TEST_NAME_SECRET,
  TEST_RENAMED_SECRET,
  TEST_DESC_SECRET,
  TEST_SECTION_SECRET,
  TEST_FIXTURE_NAME,
  REF_SECRET,
];
const TEST_FIELD_NAMES = [
  'name',
  'description',
  'durationMinutes',
  'profile',
  'passScore',
  'sections',
];
const isTestFieldList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => typeof x === 'string' && TEST_FIELD_NAMES.includes(x));

export interface TestFix {
  id: string;
  name: string;
  sectionId: string;
  testQuestionId: string;
  question: QuestionFix;
}

/**
 * A test template in `orgId` built with the owner role: one section (30 min limit), one fixed question
 * (a published version), duration 60, pass score 50. `used` adds an invitation (and `session` a
 * session on it), which locks the test against edits (ADR 0002 S-6).
 */
export async function testFixture(
  h: Harness,
  orgId: string,
  opts: { used?: boolean; session?: boolean; createdById?: string } = {},
): Promise<TestFix> {
  const t = uniq();
  const question = await questionFixture(h, orgId, { published: true });
  const name = `${TEST_FIXTURE_NAME} ${t}`;
  const test = await h.owner.test.create({
    data: {
      orgId,
      name,
      durationMinutes: 60,
      passScore: 50,
      createdById: opts.createdById ?? null,
    },
  });
  const section = await h.owner.testSection.create({
    data: { testId: test.id, title: 'Section one', position: 1, timeLimitMin: 30 },
  });
  const tq = await h.owner.testQuestion.create({
    data: {
      sectionId: section.id,
      questionVersionId: question.versionIds[1] as string,
      points: 100,
      position: 1,
    },
  });
  if (opts.used || opts.session) {
    const candidate = await h.owner.candidate.create({
      data: { orgId, email: `qa-t06-${t}@example.com`, fullName: 'QA T06 Candidate' },
    });
    const invitation = await h.owner.invitation.create({
      data: {
        orgId,
        testId: test.id,
        candidateId: candidate.id,
        tokenHash: `qa-t06-token-hash-${t}`,
        windowStart: new Date(Date.now() - 3_600_000),
        windowEnd: new Date(Date.now() + 3_600_000),
      },
    });
    if (opts.session) {
      await h.owner.session.create({
        data: { orgId, invitationId: invitation.id, status: 'INVITED' },
      });
    }
  }
  return { id: test.id, name, sectionId: section.id, testQuestionId: tq.id, question };
}

/** The create body for a one-section test with one fixed question. */
export const testBody = (
  name: string,
  versionId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name,
  description: TEST_DESC_SECRET,
  durationMinutes: 60,
  passScore: 50,
  sections: [
    {
      title: TEST_SECTION_SECRET,
      timeLimitMin: 30,
      questions: [{ questionVersionId: versionId, points: 100 }],
    },
  ],
  ...over,
});

const t06 = (r: Omit<Be03Route, 'step'>): Be03Route => ({ step: 'BE-06', ...r });

const BE06_ROUTES: Be03Route[] = [
  t06({
    id: 'tests-list',
    method: 'GET',
    template: TESTS,
    permission: 'test:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: () =>
      Promise.resolve({ path: `${TESTS}?page=1&pageSize=50`, secrets: [], unchanged: noop }),
  }),
  t06({
    id: 'tests-create',
    method: 'POST',
    template: TESTS,
    permission: 'test:create',
    audit: { action: 'TEST_CREATED', entityType: 'test' },
    metadataKeys: ['questions', 'sections'],
    metadataShape: { questions: (v) => v === 1, sections: (v) => v === 1 }, // the fixture has 1 and 1
    mutating: true,
    ok: [201],
    prepare: async (h, orgId) => {
      const f = await questionFixture(h, orgId, { published: true });
      const name = `${TEST_NAME_SECRET} ${uniq()}`;
      const lookup = (): Promise<{ id: string } | null> =>
        h.owner.test.findFirst({ where: { orgId, name }, select: { id: true } });
      return {
        path: TESTS,
        body: testBody(name, f.versionIds[1] as string),
        secrets: tSecrets,
        resolveEntityId: async () => (await lookup())?.id,
        unchanged: async () => (await lookup()) === null,
      };
    },
  }),
  t06({
    id: 'tests-get',
    method: 'GET',
    template: `${TESTS}/:id`,
    permission: 'test:read',
    audit: null,
    mutating: false,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await testFixture(h, orgId);
      return { path: `${TESTS}/${f.id}`, entityId: f.id, secrets: [], unchanged: noop };
    },
  }),
  t06({
    id: 'tests-update',
    method: 'PATCH',
    template: `${TESTS}/:id`,
    permission: 'test:update',
    audit: { action: 'TEST_UPDATED', entityType: 'test' },
    metadataKeys: ['fields'],
    metadataShape: {
      fields: (v) => isTestFieldList(v) && JSON.stringify(v) === '["name"]', // the body sends name only
    },
    mutating: true,
    ok: [200],
    prepare: async (h, orgId) => {
      const f = await testFixture(h, orgId);
      return {
        path: `${TESTS}/${f.id}`,
        body: { name: `${TEST_RENAMED_SECRET} ${uniq()}` },
        entityId: f.id,
        secrets: tSecrets,
        unchanged: async () =>
          (await h.owner.test.findUniqueOrThrow({ where: { id: f.id } })).name === f.name,
      };
    },
  }),
];

export const BE03_ROUTES: Be03Route[] = [
  ...reissueRoutes,
  ...BE04_ROUTES,
  ...BE06_ROUTES,
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

/**
 * Candidate-session routes (BE-07, FR-106, FR-401; ADR 0013 5.10), for REGISTRY AGREEMENT ONLY
 * (tc-004 "route registry"): they use candidate tokens, so the staff 401/403/404/audit loops
 * (BE03_ROUTES) never see them. Each is included only when the backend's ROUTE_PERMISSIONS has the
 * key, so this is green before and after BE-07 (#98) merges. `permission: 'public'` = a pre-JWT
 * bootstrap route; otherwise the candidate_* permission the matrix must carry.
 */
export interface CandidateRoute {
  key: string;
  permission: 'public' | Permission;
}
const KNOWN_CANDIDATE_ROUTES: readonly CandidateRoute[] = [
  { key: 'POST /candidate/session/link', permission: 'public' },
  { key: 'POST /candidate/session/otp', permission: 'public' },
  { key: 'POST /candidate/session/start', permission: 'public' },
  { key: 'GET /candidate/session/consent', permission: 'candidate_consent:read' },
  { key: 'POST /candidate/session/consent/sign', permission: 'candidate_consent:sign' },
  { key: 'POST /candidate/session/consent/decline', permission: 'candidate_consent:decline' },
  { key: 'GET /candidate/session', permission: 'candidate_session:read' },
  { key: 'POST /candidate/session/test/start', permission: 'candidate_session:start' },
  { key: 'POST /candidate/session/heartbeat', permission: 'candidate_session:heartbeat' },
  { key: 'POST /candidate/session/proctor-key', permission: 'candidate_session:key' },
  // BE-09 media (Backend B, PR #119): confirm reuses the presign permission.
  { key: 'POST /candidate/session/media/presign', permission: 'candidate_media:presign' },
  { key: 'POST /candidate/session/media/confirm', permission: 'candidate_media:presign' },
  // BE-08b identity check (Integrity B, PR #129): the status read reuses the upload permission
  // (shared has no candidate_identity:read yet). BE-08c POST .../identity/recheck is not built: not listed.
  { key: 'POST /candidate/session/identity/presign', permission: 'candidate_identity:upload' },
  { key: 'POST /candidate/session/identity', permission: 'candidate_identity:upload' },
  { key: 'GET /candidate/session/identity', permission: 'candidate_identity:upload' },
  // BE-11 answers and finish (Backend B, PR #187, gated): keys and permissions as registered on that branch.
  { key: 'POST /candidate/answers/:questionId/run', permission: 'candidate_answer:run' },
  { key: 'POST /candidate/answers/:questionId/submit', permission: 'candidate_answer:submit' },
  { key: 'PUT /candidate/answers/:questionId/draft', permission: 'candidate_answer:draft' },
  { key: 'POST /candidate/session/finish', permission: 'candidate_session:finish' },
  { key: 'POST /candidate/session/section/finish', permission: 'candidate_section:finish' },
];
export const CANDIDATE_ROUTES: readonly CandidateRoute[] = KNOWN_CANDIDATE_ROUTES.filter((r) =>
  backendHasRoute(r.key),
);

const STAFF_ROLE_NAMES: readonly string[] = USER_ROLES;
export const isCandidatePath = (key: string): boolean => /^\S+ \/candidate(\/|$)/i.test(key);

/**
 * Pure registry check for the CANDIDATE route variant (FU-BE-91), so it can be unit tested with
 * synthetic matrices (tc-004 always-run block) and run over the real matrix (registry test).
 * `routes` is what the backend registry reports per key, `bootstrap` is CANDIDATE_BOOTSTRAP_ROUTES,
 * `listed` is CANDIDATE_ROUTES. Returns one message per problem; [] means agreement.
 */
export function candidateRegistryProblems(input: {
  matrix: Readonly<Record<string, AnyMatrixEntry>>;
  routes: ReadonlyMap<string, ListedRoute>;
  bootstrap: readonly string[];
  listed: readonly CandidateRoute[];
}): string[] {
  const { matrix, routes, bootstrap, listed } = input;
  const problems: string[] = [];
  const known = new Set<string>(PERMISSIONS);
  for (const [key, access] of Object.entries(matrix)) {
    if (isCandidateEntry(access)) {
      const extra = Object.keys(access).filter((k) => k !== 'principal' && k !== 'permission');
      if (extra.length > 0)
        problems.push(`${key}: CANDIDATE entry has extra keys ${extra.join(',')}`);
      if (access.principal !== 'CANDIDATE') problems.push(`${key}: principal is not CANDIDATE`);
      if (!access.permission.startsWith('candidate_') || !known.has(access.permission))
        problems.push(`${key}: permission ${access.permission} is not a candidate_* permission`);
      const r = routes.get(key);
      if (r === undefined) problems.push(`${key}: not served by the backend`);
      else {
        if ((r.roles ?? []).length > 0) problems.push(`${key}: candidate route carries roles`);
        if (r.audited === true) problems.push(`${key}: candidate route is @Audited`);
        if (r.candidatePermission !== access.permission)
          problems.push(`${key}: @CandidateRoute permission differs from the matrix`);
      }
    } else if (isStaffEntry(access)) {
      if (access.permission.startsWith('candidate_'))
        problems.push(`${key}: staff entry carries candidate permission ${access.permission}`);
      const odd = access.roles.filter((x) => !STAFF_ROLE_NAMES.includes(x));
      if (odd.length > 0)
        problems.push(`${key}: staff entry lists non-staff roles ${odd.join(',')}`);
      if ((routes.get(key)?.candidatePermission ?? null) !== null)
        problems.push(`${key}: staff route carries @CandidateRoute`);
    } else if (access === 'public' && isCandidatePath(key) && !bootstrap.includes(key)) {
      problems.push(`${key}: /candidate/ route listed public but not a bootstrap route`);
    }
  }
  for (const key of bootstrap) {
    if (!isCandidatePath(key) || matrix[key] !== 'public')
      problems.push(`${key}: bootstrap route must be a /candidate/ route listed public`);
  }
  for (const c of listed) {
    const entry = matrix[c.key];
    const ok =
      c.permission === 'public'
        ? entry === 'public' && bootstrap.includes(c.key)
        : isCandidateEntry(entry) && entry.permission === c.permission;
    if (!ok) problems.push(`${c.key}: QA list says ${c.permission}, matrix disagrees`);
  }
  const listedKeys = new Set(listed.map((c) => c.key));
  for (const [key, access] of Object.entries(matrix)) {
    const candidateKey = isCandidateEntry(access) || (isCandidatePath(key) && access === 'public');
    if (candidateKey && !listedKeys.has(key))
      problems.push(`${key}: candidate route not in CANDIDATE_ROUTES (be03-routes.ts)`);
  }
  return problems;
}

export const routesFor = (step: Be03Route['step']): Be03Route[] =>
  BE03_ROUTES.filter((r) => r.step === step);
