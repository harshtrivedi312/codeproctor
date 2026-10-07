// The route permission matrix (FR-103, TC-004). One entry per controller route, as
// "METHOD /path" without the global prefix (/api/v1). A route is public, a candidate route, or lists the
// roles that may call it and the permission it needs (the resource:action vocabulary of
// packages/shared permissions, ADR 0010 section 6). Deny by default: the guard refuses a route
// that is neither @Public() nor @Roles(), and two tests fail when a controller route is missing
// here or its decorators disagree with this file: route-registry.spec.ts and the TC-004 test in
// users/users.e2e-spec.ts, which walks the real module graph. Add the route here in the same change that adds the controller.
import type { Permission } from '@codeproctor/shared';
import type { UserRole } from '../../generated/prisma/client';

/** A staff route: JwtAuthGuard checks the role, the matrix lists roles and the permission. */
export interface StaffAccess {
  readonly roles: readonly UserRole[];
  // TODO(FU-BE-75): type as Permission together with the typed staff parity check.
  readonly permission: string;
  /** The route carries @Audited (FR-105). The registry test checks both directions. */
  readonly audited?: true;
  /** The route reads or changes candidate data (FR-105): it must be audited. */
  readonly candidateData?: true;
}

/** The permissions of the CANDIDATE pseudo-role (ADR 0010 section 6). */
export type CandidatePermission = Extract<Permission, `candidate_${string}`>;

/**
 * Candidate routes the matrix may list as plain 'public': the pre-JWT bootstrap routes that run
 * without CandidateSessionGuard (ADR 0013 section 5.10: invitation-link resolve, OTP send, OTP
 * verify). Any other /candidate/ key listed 'public' is a matrix problem.
 */
export const CANDIDATE_BOOTSTRAP_ROUTES: readonly string[] = [
  'POST /candidate/session/link',
  'POST /candidate/session/otp',
  'POST /candidate/session/start',
];

/** A candidate route (pseudo-role CANDIDATE): @Public() to the staff guard plus @CandidateRoute(). */
export interface CandidateAccess {
  readonly principal: 'CANDIDATE';
  readonly permission: CandidatePermission;
}

export type RouteAccess = 'public' | StaffAccess | CandidateAccess;

export const isPublic = (access: RouteAccess): access is 'public' => access === 'public';
export const isCandidate = (access: RouteAccess): access is CandidateAccess =>
  typeof access === 'object' && 'principal' in access;
export const isStaff = (access: RouteAccess): access is StaffAccess =>
  typeof access === 'object' && 'roles' in access;

// How to add a candidate route (BE-07 onwards). All of 1 to 3 are mandatory: @Public() only
// switches the staff guard off, so without the guard the route is unauthenticated.
//   1. On the handler put @Public(), @CandidateRoute('candidate_answer:run') (a candidate_*
//      permission from packages/shared) and @UseGuards(CandidateSessionGuard) (BE-07; until it
//      exists, do not merge a candidate route). No @Roles(), no @Audited() (ADR 0013).
//   2. Here add 'POST /candidate/answers/:questionId/run':
//      { principal: 'CANDIDATE', permission: 'candidate_answer:run' }.
//   3. The registry tests fail when the decorators, the guard and this entry disagree.
// The three pre-JWT bootstrap routes are the only /candidate/ routes listed 'public'
// (CANDIDATE_BOOTSTRAP_ROUTES).

const ALL_STAFF: readonly UserRole[] = ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'];
const SUPER_ADMIN: readonly UserRole[] = ['SUPER_ADMIN'];

const own = { roles: ALL_STAFF, permission: 'account:self' } as const;
const questionRead = {
  roles: ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR'],
  permission: 'question:read',
} as const;
const questionCreate = { roles: ['SUPER_ADMIN', 'AUTHOR'], permission: 'question:create' } as const;
const questionUpdate = { roles: ['SUPER_ADMIN', 'AUTHOR'], permission: 'question:update' } as const;
const questionValidate = {
  roles: ['SUPER_ADMIN', 'AUTHOR'],
  permission: 'question:validate',
} as const;
const aiRefRead = { roles: ['SUPER_ADMIN', 'AUTHOR'], permission: 'ai_reference:read' } as const;
const aiRefCreate = {
  roles: ['SUPER_ADMIN', 'AUTHOR'],
  permission: 'ai_reference:create',
} as const;
const aiRefSupersede = {
  roles: ['SUPER_ADMIN', 'AUTHOR'],
  permission: 'ai_reference:supersede',
} as const;
const userManage = { roles: SUPER_ADMIN, permission: 'user:manage' } as const;
const orgSettingsManage = { roles: SUPER_ADMIN, permission: 'org_settings:manage' } as const;
const RECRUITER_ADMIN: readonly UserRole[] = ['SUPER_ADMIN', 'RECRUITER'];
const REVIEW_STAFF: readonly UserRole[] = ['SUPER_ADMIN', 'REVIEWER'];
const reviewQueueRead = { roles: REVIEW_STAFF, permission: 'review_queue:read' } as const;
const reviewSessionRead = { roles: REVIEW_STAFF, permission: 'review_session:read' } as const;

export const ROUTE_PERMISSIONS: Readonly<Record<string, RouteAccess>> = {
  // Operations
  'GET /health': 'public',
  // Browser error reports (C-32). Public on purpose: candidates have no staff JWT and a crashed
  // page may have no session. Safe because it returns 204 with no body, touches no database or
  // Redis, logs only scrubbed fields, and has its own strict throttle and a 16 KB body limit.
  'POST /client-errors': 'public',

  // Candidate session (BE-07, FR-106, FR-401; ADR 0013 section 5.10). The three pre-token routes
  // are plain public; the rest sit behind CandidateSessionGuard.
  'POST /candidate/session/link': 'public',
  'POST /candidate/session/otp': 'public',
  'POST /candidate/session/start': 'public',
  'GET /candidate/session/consent': {
    principal: 'CANDIDATE',
    permission: 'candidate_consent:read',
  },
  'POST /candidate/session/consent/sign': {
    principal: 'CANDIDATE',
    permission: 'candidate_consent:sign',
  },
  'POST /candidate/session/consent/decline': {
    principal: 'CANDIDATE',
    permission: 'candidate_consent:decline',
  },
  'GET /candidate/session': { principal: 'CANDIDATE', permission: 'candidate_session:read' },
  'POST /candidate/session/test/start': {
    principal: 'CANDIDATE',
    permission: 'candidate_session:start',
  },
  'POST /candidate/session/heartbeat': {
    principal: 'CANDIDATE',
    permission: 'candidate_session:heartbeat',
  },
  'POST /candidate/session/proctor-key': {
    principal: 'CANDIDATE',
    permission: 'candidate_session:key',
  },

  // Authentication (FR-101, FR-102, FR-104, FR-107). Public: the credential is in the body.
  'POST /auth/login': 'public',
  'POST /auth/2fa/enroll/start': 'public',
  'POST /auth/2fa/enroll/confirm': 'public',
  'POST /auth/2fa/verify': 'public',
  'POST /auth/refresh': 'public',
  'POST /auth/logout': 'public',
  'POST /auth/password/forgot': 'public',
  'POST /auth/password/reset': 'public',
  // Signed-in account security.
  'POST /auth/2fa/setup/start': own,
  'POST /auth/2fa/setup/confirm': own,
  'POST /auth/2fa/disable': own,
  'POST /auth/2fa/recovery-codes/regenerate': own,
  'POST /auth/2fa/reset/:userId': userManage,

  // Staff user management (FR-103, FR-105; SUPER_ADMIN only, same org only).
  'GET /admin/users': { ...userManage, audited: true },
  'GET /admin/users/lock-events': { ...userManage, audited: true },
  'POST /admin/users': userManage,
  'POST /admin/users/:userId/invite': userManage,
  'PATCH /admin/users/:userId': userManage,
  'POST /admin/users/:userId/unlock': userManage,

  // Organization settings (FR-103, ADR 0010 org_settings:manage; SUPER_ADMIN only, own org only).
  // The PATCH needs the admin's currentPassword (step-up) and writes its audit row (ORG_SETTINGS_UPDATED) in the same transaction as the update.
  'GET /admin/org-settings': orgSettingsManage,
  'PATCH /admin/org-settings': orgSettingsManage,

  // Test templates (FR-301, FR-302; ADR 0010 section 3): SUPER_ADMIN and RECRUITER. No copy or
  // archive route yet (no schema support). Writes audit in their own transaction (tests.service.ts).
  'GET /tests': { roles: RECRUITER_ADMIN, permission: 'test:read' },
  'POST /tests': { roles: RECRUITER_ADMIN, permission: 'test:create' },
  'GET /tests/:id': { roles: RECRUITER_ADMIN, permission: 'test:read' },
  'PATCH /tests/:id': { roles: RECRUITER_ADMIN, permission: 'test:update' },
  // Reviewer read API (FR-901, FR-703, FR-105): REVIEWER and SUPER_ADMIN. All three read candidate
  // data, so all three are audited (the row is written before the response leaves).
  'GET /review/queue': { ...reviewQueueRead, audited: true, candidateData: true },
  'GET /review/sessions/:id': { ...reviewSessionRead, audited: true, candidateData: true },
  'GET /review/sessions/:id/recordings/:recordingId/playback': {
    ...reviewSessionRead,
    audited: true,
    candidateData: true,
  },
  // Question bank (FR-201..FR-205). Reads: SUPER_ADMIN, RECRUITER, AUTHOR; writes: SUPER_ADMIN,
  // AUTHOR (ADR 0010 section 3). Publish, archive and test cases are changes: question:update.
  'GET /questions': questionRead,
  'POST /questions': questionCreate,
  'GET /questions/ai-policy': aiRefRead,
  'GET /questions/:id': questionRead,
  'GET /questions/:id/preview': questionRead,
  'PATCH /questions/:id': questionUpdate,
  'POST /questions/:id/publish': questionUpdate,
  'POST /questions/:id/archive': questionUpdate,
  'POST /questions/:id/unarchive': questionUpdate,
  'POST /questions/:id/versions/:version/test-cases': questionUpdate,
  'PATCH /questions/:id/versions/:version/test-cases/:testCaseId': questionUpdate,
  'DELETE /questions/:id/versions/:version/test-cases/:testCaseId': questionUpdate,
  // Variants (FR-203, BE-04 slice 4b). Params and overrides are author data: question:update. The
  // variant preview is the candidate-shaped view: question:read.
  'GET /questions/:id/versions/:version/variants': questionUpdate,
  'POST /questions/:id/versions/:version/variants': questionUpdate,
  'GET /questions/:id/versions/:version/variants/:variantId/preview': questionRead,
  'PATCH /questions/:id/versions/:version/variants/:variantId': questionUpdate,
  'DELETE /questions/:id/versions/:version/variants/:variantId': questionUpdate,
  'PUT /questions/:id/versions/:version/variants/:variantId/test-cases/:testCaseId': questionUpdate,
  'DELETE /questions/:id/versions/:version/variants/:variantId/test-cases/:testCaseId':
    questionUpdate,
  // Reference validation (FR-203, BE-04 slice 4c): the report is author data, so the status read
  // needs question:validate too. AI reference solutions (ADR 0005 AI-1) are never for recruiters.
  'POST /questions/:id/validate': questionValidate,
  'GET /questions/:id/validation': questionValidate,
  'GET /questions/:id/versions/:version/ai-references': aiRefRead,
  'POST /questions/:id/versions/:version/ai-references': aiRefCreate,
  'POST /questions/:id/versions/:version/ai-references/:aiReferenceId/supersede': aiRefSupersede,
};
