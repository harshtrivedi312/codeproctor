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
 * TODO(FU-BE-90): fill in the three real keys when BE-07 defines them; empty until then.
 */
export const CANDIDATE_BOOTSTRAP_ROUTES: readonly string[] = [];

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
const userManage = { roles: SUPER_ADMIN, permission: 'user:manage' } as const;

export const ROUTE_PERMISSIONS: Readonly<Record<string, RouteAccess>> = {
  // Operations
  'GET /health': 'public',
  // Browser error reports (C-32). Public on purpose: candidates have no staff JWT and a crashed
  // page may have no session. Safe because it returns 204 with no body, touches no database or
  // Redis, logs only scrubbed fields, and has its own strict throttle and a 16 KB body limit.
  'POST /client-errors': 'public',

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
};
