// TC-003 (FR-102) stale forced-enrollment challenge (FU-BE-86, backend PR D). An enrollment
// challenge issued before a password reset or a deactivation is a 401 "challenge expired" on
// /2fa/enroll/start and /2fa/enroll/confirm, and NOTHING changes: no secret stored, no audit row,
// no session, no cookie. If TOTP was turned on meanwhile (password unchanged) start is a 409 and
// the live secret stays. Gap: the narrow race (reset landing between the service's read and its
// conditional write) cannot be forced from outside; the backend e2e spec covers it with hooks.
import { authenticator } from 'otplib';
import request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import { API, Body, boot, createUser, Harness, login, TOTP_SECRET } from '../support/harness';

const EXPIRED = 'Your sign-in has expired. Sign in again.';

describe('TC-003 (FR-102): stale forced-enrollment challenge', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  const post = (path: string): request.Test =>
    request(h.app.getHttpServer()).post(`${API}/auth/${path}`);

  async function staleCase(
    role: UserRole,
    how: 'reset' | 'deactivate',
  ): Promise<{ id: string; challengeToken: string }> {
    const u = await createUser(h, { role });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    if (how === 'reset') {
      const { hash } = await import('@node-rs/argon2');
      await h.owner.user.update({
        where: { id: u.id },
        data: { passwordHash: await hash('Another-Passphrase-42', { algorithm: 2 }) },
      });
    } else {
      await h.owner.user.update({ where: { id: u.id }, data: { isActive: false } });
    }
    return { id: u.id, challengeToken };
  }

  async function expectUntouched(id: string, auditBefore: number): Promise<void> {
    const row = await h.owner.user.findUniqueOrThrow({ where: { id } });
    expect(row.totpSecretEnc).toBeNull();
    expect(row.totpEnabled).toBe(false);
    expect(row.recoveryCodeHashes).toEqual([]);
    expect(await h.owner.refreshToken.count({ where: { userId: id } })).toBe(0);
    expect(await h.owner.auditLog.count({ where: { actorId: id } })).toBe(auditBefore);
  }

  describe.each([UserRole.REVIEWER, UserRole.SUPER_ADMIN])('%s', (role) => {
    it.each(['reset', 'deactivate'] as const)(
      'TC-003: enroll/start with a challenge issued before a password %s is 401 challenge-expired and changes nothing',
      async (how) => {
        const { id, challengeToken } = await staleCase(role, how);
        const auditBefore = await h.owner.auditLog.count({ where: { actorId: id } });
        const res = await post('2fa/enroll/start').send({ challengeToken });
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect((res.body as Body).detail).toBe(EXPIRED);
        expect(res.headers['set-cookie']).toBeUndefined();
        expect((res.body as Body).qrDataUrl).toBeUndefined();
        expect((res.body as Body).manualKey).toBeUndefined();
        await expectUntouched(id, auditBefore);
      },
    );

    it.each(['reset', 'deactivate'] as const)(
      'TC-003: enroll/confirm with a challenge issued before a password %s is 401 and enables nothing, even with a correct code',
      async (how) => {
        const { id, challengeToken } = await staleCase(role, how);
        const auditBefore = await h.owner.auditLog.count({ where: { actorId: id } });
        const res = await post('2fa/enroll/confirm').send({
          challengeToken,
          code: authenticator.generate(TOTP_SECRET),
        });
        expect(res.status).toBe(401);
        expect((res.body as Body).detail).toBe(EXPIRED);
        expect(res.headers['set-cookie']).toBeUndefined();
        expect((res.body as Body).session).toBeUndefined();
        await expectUntouched(id, auditBefore);
      },
    );

    it('TC-003: TOTP turned on after the challenge was issued (same password) is a 409 on enroll/start and the live secret stays', async () => {
      const u = await createUser(h, { role });
      const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
      const key = (await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).totpSecretEnc;
      expect(key).toBeNull();
      const other = await createUser(h, { role, totp: TOTP_SECRET });
      const live = (await h.owner.user.findUniqueOrThrow({ where: { id: other.id } }))
        .totpSecretEnc;
      await h.owner.user.update({
        where: { id: u.id },
        data: { totpEnabled: true, totpSecretEnc: live },
      });
      const auditBefore = await h.owner.auditLog.count({ where: { actorId: u.id } });
      const res = await post('2fa/enroll/start').send({ challengeToken });
      expect(res.status).toBe(409);
      expect(res.headers['set-cookie']).toBeUndefined();
      const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpSecretEnc).toBe(live);
      expect(row.totpEnabled).toBe(true);
      expect(await h.owner.auditLog.count({ where: { actorId: u.id } })).toBe(auditBefore);
    });
  });
});
