import { hasPermission, USER_ROLES, type Permission, type UserRole } from '@codeproctor/shared';

/*
 * Role-based visibility (FR-103). The permission matrix lives in packages/shared (ARC-02
 * skeleton, ADR 0010 section 3); this file only adds what that skeleton does not have yet.
 * The API is the only enforcer; hiding a menu item is a convenience.
 *
 * [ARC-02] The two permissions below are web-local because the shared matrix has no entry for
 * them. Add `report:read` (Step 14 reports) and `candidate:erase` (BE-03 erasure endpoint, D-19,
 * NFR-05) to packages/shared and delete LOCAL_ROLE_PERMISSIONS. Until then the grants below are
 * a proposal: reports for everyone who can see candidate or review data, erasure for SUPER_ADMIN.
 */
export const LOCAL_PERMISSIONS = ['report:read', 'candidate:erase'] as const;
export type LocalPermission = (typeof LOCAL_PERMISSIONS)[number];
export type StaffPermission = Permission | LocalPermission;

const LOCAL_ROLE_PERMISSIONS: Readonly<Record<LocalPermission, readonly UserRole[]>> = {
  'report:read': ['SUPER_ADMIN', 'RECRUITER', 'REVIEWER'],
  'candidate:erase': ['SUPER_ADMIN'],
};

function isLocal(permission: StaffPermission): permission is LocalPermission {
  return (LOCAL_PERMISSIONS as readonly string[]).includes(permission);
}

/** True when the role holds the permission (deny by default). */
export function can(role: UserRole | null | undefined, permission: StaffPermission): boolean {
  if (!role) return false;
  if (isLocal(permission)) return LOCAL_ROLE_PERMISSIONS[permission].includes(role);
  return hasPermission(role, permission);
}

/** True when the role holds at least one of the permissions. */
export function canAny(
  role: UserRole | null | undefined,
  permissions: readonly StaffPermission[],
): boolean {
  return permissions.some((p) => can(role, p));
}

/** The roles that hold any of the permissions, for `<RequireRole roles={...}>`. */
export function rolesWith(...permissions: StaffPermission[]): UserRole[] {
  return USER_ROLES.filter((role) => canAny(role, permissions));
}
