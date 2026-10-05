// TC-002 (FR-101): lockout after failures. Expected: account locked 15 min; the 6th, correct
// attempt refused; audit entry written.
import request from 'supertest';
import { authenticator } from 'otplib';
import { UserRole } from '../../src/generated/prisma/client';
import { API, Body, boot, createUser, Harness, login, TOTP_SECRET } from '../support/harness';

describe('TC-002 (FR-101): lockout after failures', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  async function fail(email: string, times: number): Promise<void> {
    for (let i = 0; i < times; i++) await login(h, email, `wrong-password-${i}`).expect(401);
  }

  it('TC-002: 4 failures do not lock; the correct password still works and resets the counter', async () => {
    const u = await createUser(h);
    await fail(u.email, 4);
    await login(h, u.email).expect(200);
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
    // The counter restarted: 4 more failures still do not lock.
    await fail(u.email, 4);
    await login(h, u.email).expect(200);
  });

  it('TC-002: the 5th failure locks for 15 minutes, the 6th attempt with the correct password is refused, and one AUTH_ACCOUNT_LOCKED audit row is written', async () => {
    const u = await createUser(h);
    await fail(u.email, 5);
    const refused = await login(h, u.email).expect(401);
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect((refused.body as Body).session).toBeUndefined();

    const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    const minutes = ((row.lockedUntil?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    const audit = await h.owner.auditLog.findMany({
      where: { actorId: u.id, action: 'AUTH_ACCOUNT_LOCKED' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.orgId).toBe(h.orgId);
    expect(audit[0]?.ip).toEqual(expect.any(String));
    // The audit row names IDs and action names only (ADR 0001 C-3): no email.
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain(u.email);
  });

  it('TC-002: further attempts while locked do not extend the lock or write more lock rows', async () => {
    const u = await createUser(h);
    await fail(u.email, 5);
    const before = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    await login(h, u.email).expect(401);
    await login(h, u.email, 'wrong-again').expect(401);
    const after = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.lockedUntil?.getTime()).toBe(before.lockedUntil?.getTime());
    expect(
      await h.owner.auditLog.count({ where: { actorId: u.id, action: 'AUTH_ACCOUNT_LOCKED' } }),
    ).toBe(1);
  });

  it('TC-002: after the 15 minutes pass the correct password works again', async () => {
    const u = await createUser(h);
    await fail(u.email, 5);
    await h.owner.user.update({
      where: { id: u.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    await login(h, u.email).expect(200);
    const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil).toBeNull();
    expect(row.failedLogins).toBe(0);
  });

  it('TC-002: parallel wrong passwords still lock the account and write exactly one lock row', async () => {
    const u = await createUser(h);
    await Promise.all(Array.from({ length: 8 }, (_, i) => login(h, u.email, `bad-${i}`)));
    const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil).not.toBeNull();
    await login(h, u.email).expect(401);
    expect(
      await h.owner.auditLog.count({ where: { actorId: u.id, action: 'AUTH_ACCOUNT_LOCKED' } }),
    ).toBe(1);
  });

  it('TC-002: failures on one account never lock another account', async () => {
    const a = await createUser(h);
    const b = await createUser(h);
    await fail(a.email, 5);
    await login(h, b.email).expect(200);
    for (let i = 0; i < 6; i++) await login(h, 'ghost@example.com', 'x-wrong-1').expect(401);
    await login(h, b.email).expect(200);
  });

  it('TC-002: a locked account cannot finish a pending 2FA login either', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    await h.owner.user.update({
      where: { id: u.id },
      data: { lockedUntil: new Date(Date.now() + 600_000), failedLogins: 5 },
    });
    const res = await request(h.app.getHttpServer())
      .post(`${API}/auth/2fa/verify`)
      .send({ challengeToken, code: authenticator.generate(TOTP_SECRET) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((res.body as Body).accessToken).toBeUndefined();
  });
});
