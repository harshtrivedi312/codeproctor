// TC-002 (FR-101) addition from P-03: when a staff account locks an admin is alerted, and a
// SUPER_ADMIN can unlock it with an audited action. Final BE-03 contract: POST
// /admin/users/:userId/unlock, 204, SUPER_ADMIN only, needs the acting admin's own `currentPassword`
// (missing 400, wrong or locked 403 REAUTH_FAILED), self-unlock allowed. The alert is the existing
// AUTH_ACCOUNT_LOCKED audit row (no ADMIN_ALERT row), GET /admin/users/lock-events, and a
// 'staff-account-locked' mail (MailPort.sendStaffAccountLocked) to every active SUPER_ADMIN of the org.
// Tests marked "[BE-03 pending]" are real but switched off until BE-03 ships (BE03_READY in
// support/be03-routes.ts).
import { UserRole } from '../../src/generated/prisma/client';
import {
  boot,
  createUser,
  expectReauthFailed,
  Harness,
  login,
  PASSWORD,
  stableProblem,
} from '../support/harness';
import { actor, Actor, call, flushDeferred } from '../support/be03-helpers';
import { ADMIN_USERS, BE03_READY, lockAlertsFor } from '../support/be03-routes';

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
    const unlockPath = (id: string): string => `${ADMIN_USERS}/${id}/unlock`;
    const lockState = async (
      id: string,
    ): Promise<{ failedLogins: number; lockedUntil: Date | null }> => {
      const r = await h.owner.user.findUniqueOrThrow({ where: { id } });
      return { failedLogins: r.failedLogins, lockedUntil: r.lockedUntil };
    };
    const unlock = (
      admin: Actor,
      id: string,
      body: object | undefined = { currentPassword: PASSWORD },
    ) => call(h, 'POST', unlockPath(id), admin.token, body);

    it('TC-002 [BE-03 pending]: the 5th failure leaves exactly one AUTH_ACCOUNT_LOCKED event for the admin alert (no ADMIN_ALERT row), and further attempts raise none', async () => {
      const u = await createUser(h);
      await lock(u.email);
      expect(await lockAlertsFor(h, h.orgId, u.id)).toHaveLength(1);
      await login(h, u.email).expect(401);
      expect(await lockAlertsFor(h, h.orgId, u.id)).toHaveLength(1);
      expect(
        await h.owner.auditLog.count({ where: { action: { startsWith: 'ADMIN_ALERT' } } }),
      ).toBe(0);
    });

    it('TC-002 [BE-03 pending]: locking an account mails every active SUPER_ADMIN of the org (staff-account-locked, 15 minutes), once, and not the locked user', async () => {
      const a1 = await actor(h, UserRole.SUPER_ADMIN);
      const a2 = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h);
      // Recipients that must NOT get the mail (it carries the locked user's email): an admin of
      // another org, and a deactivated admin of this org.
      const orgX = (await h.owner.organization.create({ data: { name: 'QA Org X lock mail' } })).id;
      const foreign = await createUser(h, { role: UserRole.SUPER_ADMIN, orgId: orgX });
      const gone = await createUser(h, { role: UserRole.SUPER_ADMIN });
      await h.owner.user.update({ where: { id: gone.id }, data: { isActive: false } });
      h.mails.length = 0;
      await lock(u.email);
      await flushDeferred(h);
      const lockMails = h.mails.filter((m) => m.method === 'sendStaffAccountLocked');
      expect(lockMails.map((m) => m.to)).toEqual(expect.arrayContaining([a1.email, a2.email]));
      const recipients = lockMails.map((m) => m.to);
      expect(recipients).not.toContain(u.email);
      expect(recipients).not.toContain(foreign.email); // other org
      expect(recipients).not.toContain(gone.email); // deactivated
      for (const r of [a1.email, a2.email]) {
        expect(recipients.filter((x) => x === r)).toHaveLength(1); // exactly one mail each
      }
      expect(new Set(recipients).size).toBe(recipients.length);
      for (const m of lockMails.filter((x) => x.to === a1.email || x.to === a2.email)) {
        expect(m.args[1]).toMatchObject({ email: u.email, minutes: 15 });
        expect(JSON.stringify(m.args)).not.toMatch(/password|token/i);
      }
      // One lock, one mail per admin: further failures while locked send nothing more.
      const count = lockMails.length;
      await login(h, u.email).expect(401);
      await flushDeferred(h);
      expect(h.mails.filter((m) => m.method === 'sendStaffAccountLocked')).toHaveLength(count);
    });

    it('TC-002 [BE-03 pending]: after an admin unlock (204) the user signs in again and the failed-attempt counter is reset', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h, { role: UserRole.RECRUITER });
      await lock(u.email);
      await login(h, u.email).expect(401); // locked
      await unlock(admin, u.id).expect(204);
      const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(0);
      expect(row.lockedUntil).toBeNull();
      await login(h, u.email).expect(200);
      // The counter really restarted: 4 more failures do not lock again.
      for (let i = 0; i < 4; i++) await login(h, u.email, `wrong-${i}`).expect(401);
      await login(h, u.email).expect(200);
    });

    it('TC-002 [BE-03 pending]: a non-admin cannot unlock anyone (403, still locked, counter unchanged)', async () => {
      const reviewer = await actor(h, UserRole.REVIEWER);
      const recruiter = await actor(h, UserRole.RECRUITER);
      const u = await createUser(h);
      await lock(u.email);
      const before = await lockState(u.id);
      expect(before.lockedUntil).not.toBeNull();
      await unlock(reviewer, u.id).expect(403);
      await unlock(recruiter, u.id).expect(403);
      expect(await lockState(u.id)).toEqual(before);
      await login(h, u.email).expect(401);
    });

    it('TC-002 [BE-03 pending]: unlocking an account that is not locked is a harmless 204 that writes no AUTH_ACCOUNT_LOCKED row and leaves it usable', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h);
      const locksBefore = await h.owner.auditLog.count({
        where: { action: 'AUTH_ACCOUNT_LOCKED' },
      });
      await unlock(admin, u.id).expect(204);
      expect(await h.owner.auditLog.count({ where: { action: 'AUTH_ACCOUNT_LOCKED' } })).toBe(
        locksBefore,
      );
      const rows = await h.owner.auditLog.findMany({
        where: { action: 'USER_UNLOCKED', entityId: u.id },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect([row?.actorId, row?.orgId]).toEqual([admin.id, h.orgId]);
      // Contract (backend.md): USER_UNLOCKED carries wasLocked; for a no-op it says false.
      expect((row?.metadata as { wasLocked?: boolean } | null)?.wasLocked).toBe(false);
      await login(h, u.email).expect(200);
    });

    it('TC-002 [BE-03 pending]: unlock without currentPassword is 400, with a wrong one 403 REAUTH_FAILED (identical bodies); the account stays locked and unchanged', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h);
      await lock(u.email);
      const before = await lockState(u.id);
      await unlock(admin, u.id, {}).expect(400);
      const wrongA = await unlock(admin, u.id, { currentPassword: 'Wrong-Password-1' });
      const wrongB = await unlock(admin, u.id, { currentPassword: 'Another-Wrong-2' });
      expectReauthFailed(wrongA);
      expectReauthFailed(wrongB);
      expect(stableProblem(wrongA)).toEqual(stableProblem(wrongB));
      expect(await lockState(u.id)).toEqual(before);
      await login(h, u.email).expect(401);
    });

    it('TC-002 [BE-03 pending]: an admin whose own account is locked gets the same 403 REAUTH_FAILED for the right password, and nothing is unlocked', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h);
      await lock(u.email);
      const before = await lockState(u.id);
      const wrong = await unlock(admin, u.id, { currentPassword: 'Wrong-Password-1' });
      await h.owner.user.update({
        where: { id: admin.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) },
      });
      const whileLocked = await unlock(admin, u.id);
      expectReauthFailed(whileLocked);
      expect(stableProblem(whileLocked)).toEqual(stableProblem(wrong)); // no lock oracle
      expect(await lockState(u.id)).toEqual(before);
    });

    it('TC-002 [BE-03 pending]: an unknown user id is 404 only after the right password, and the 404 changes nothing', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h);
      await lock(u.email);
      const before = await lockState(u.id);
      await unlock(admin, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(await lockState(u.id)).toEqual(before);
    });
  },
);
