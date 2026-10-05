import { PSEUDO_ROLES, USER_ROLES, userRoleSchema } from '@codeproctor/shared';
import { UserRole } from '../generated/prisma/client';

// No TC ID is assigned to this drift test yet. It is complementary to packages/shared/src/events.test.ts:52,
// which checks role order against schema.prisma.
// The API enforces roles with the Prisma enum; packages/shared owns the contract that the web app
// and the permission matrix use. They must list the same roles so neither side can drift.
describe('shared contract (NFR-04, FR-103)', () => {
  it('NFR-04 FR-103: the API role enum equals the shared USER_ROLES list', () => {
    expect(Object.values(UserRole).sort()).toEqual([...USER_ROLES].sort());
  });

  it('NFR-04 FR-103: every API role parses with the shared userRoleSchema', () => {
    for (const role of Object.values(UserRole)) {
      expect(userRoleSchema.safeParse(role).success).toBe(true);
    }
    for (const pseudo of PSEUDO_ROLES) {
      expect(userRoleSchema.safeParse(pseudo).success).toBe(false);
    }
  });
});
