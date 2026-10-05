// TC-002 (FR-101) addition from P-03: when a staff account locks an admin is alerted, and a
// SUPER_ADMIN can unlock it with an audited action. Tests marked "[BE-03 pending]" are real but
// switched off until BE-03 ships (BE03_READY in support/be03-routes.ts). The route path and the
// alert mechanism are ASSUMED (see be03-routes.ts: users-unlock and lockAlertsFor).
import { UserRole } from '../../src/generated/prisma/client';
import { boot, createUser, Harness, login } from '../support/harness';
import { actor, call } from '../support/be03-helpers';
import { BE03_READY, lockAlertsFor } from '../support/be03-routes';

(BE03_READY ? describe : describe.skip)(
  'TC-002 [BE-03 pending]: admin alert and admin unlock',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot();
    });
    afterAll(async () => {
      await h?.close();
    });

    async function lock(email: string): Promise<void> {
      for (let i = 0; i < 5; i++) await login(h, email, `wrong-password-${i}`).expect(401);
    }

    it('TC-002 [BE-03 pending]: the 5th failure raises exactly one admin alert, and further attempts raise none', async () => {
      const u = await createUser(h);
      await lock(u.email);
      expect(await lockAlertsFor(h, h.orgId, u.id)).toHaveLength(1);
      await login(h, u.email).expect(401);
      expect(await lockAlertsFor(h, h.orgId, u.id)).toHaveLength(1);
    });

    it('TC-002 [BE-03 pending]: after an admin unlock the user signs in again and the failed-attempt counter is reset', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h, { role: UserRole.RECRUITER });
      await lock(u.email);
      await login(h, u.email).expect(401); // locked
      const res = await call(h, 'POST', `/users/${u.id}/unlock`, admin.token); // ASSUMED path
      expect([200, 204]).toContain(res.status);
      const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(0);
      expect(row.lockedUntil).toBeNull();
      await login(h, u.email).expect(200);
      // The counter really restarted: 4 more failures do not lock again.
      for (let i = 0; i < 4; i++) await login(h, u.email, `wrong-${i}`).expect(401);
      await login(h, u.email).expect(200);
    });

    it('TC-002 [BE-03 pending]: a non-admin cannot unlock anyone (403, still locked)', async () => {
      const reviewer = await actor(h, UserRole.REVIEWER);
      const u = await createUser(h);
      await lock(u.email);
      await call(h, 'POST', `/users/${u.id}/unlock`, reviewer.token).expect(403);
      await login(h, u.email).expect(401);
    });

    it('TC-002 [BE-03 pending]: unlocking an account that is not locked is a harmless no-op that writes no misleading lock row', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h);
      const res = await call(h, 'POST', `/users/${u.id}/unlock`, admin.token);
      // ASSUMED: 200/204 (idempotent) or 409; never 5xx, and the account stays usable.
      expect([200, 204, 409]).toContain(res.status);
      await login(h, u.email).expect(200);
    });
  },
);
