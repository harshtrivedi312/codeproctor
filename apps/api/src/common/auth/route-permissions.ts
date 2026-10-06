// The route permission matrix (FR-103, TC-004). One entry per controller route, as
// "METHOD /path" without the global prefix (/api/v1). A route is either public or lists the
// roles that may call it and the permission it needs (the resource:action vocabulary of
// packages/shared permissions, ADR 0010 section 6). Deny by default: the guard refuses a route
// that is neither @Public() nor @Roles(), and two tests fail when a controller route is missing
// here or its decorators disagree with this file: route-registry.spec.ts and the TC-004 test in
// users/users.e2e-spec.ts, which walks the real module graph. Add the route here in the same change that adds the controller.
import type { UserRole } from '../../generated/prisma/client';

export type RouteAccess =
  | 'public'
  | {
      readonly roles: readonly UserRole[];
      readonly permission: string;
      /** The route carries @Audited (FR-105). The registry test checks both directions. */
      readonly audited?: true;
      /** The route reads or changes candidate data (FR-105): it must be audited. */
      readonly candidateData?: true;
    };

const ALL_STAFF: readonly UserRole[] = ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'];
const SUPER_ADMIN: readonly UserRole[] = ['SUPER_ADMIN'];

const own = { roles: ALL_STAFF, permission: 'account:self' } as const;
const userManage = { roles: SUPER_ADMIN, permission: 'user:manage' } as const;

export const ROUTE_PERMISSIONS: Readonly<Record<string, RouteAccess>> = {
  // Operations
  'GET /health': 'public',

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
