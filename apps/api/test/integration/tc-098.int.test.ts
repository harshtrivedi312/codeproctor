// TC-098 (FR-107): staff password reset. Expected: same response for a real and an unknown email;
// the valid link sets a new password and revokes all refresh tokens; the second use and an expired
// link are refused; the next login still asks for TOTP; no token appears in logs.
import { authenticator } from 'otplib';
import request from 'supertest';
import { sha256Hex } from '../../src/auth/crypto.util';
import { UserRole } from '../../src/generated/prisma/client';
import {
  API,
  Body,
  boot,
  createUser,
  Harness,
  login,
  refresh,
  refreshCookie,
  SentMail,
  TOTP_SECRET,
} from '../support/harness';

describe('TC-098 (FR-107): staff password reset', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot({ captureLogs: true });
  });
  afterAll(async () => {
    await h?.close();
  });

  const forgotRaw = (email: string): request.Test =>
    request(h.app.getHttpServer()).post(`${API}/auth/password/forgot`).send({ email });
  // The mail goes out after the response (FU-BE-31); wait for it before reading h.mails.
  const forgot = async (email: string): Promise<request.Response> => {
    const res = await forgotRaw(email);
    await h.settle();
    return res;
  };
  const reset = (token: string, newPassword: string): request.Test =>
    request(h.app.getHttpServer()).post(`${API}/auth/password/reset`).send({ token, newPassword });

  function tokenFrom(mail: SentMail | undefined): string {
    const match = /#token=([^&]+)$/.exec(mail?.url ?? '');
    if (!match?.[1]) throw new Error('no token in the reset link');
    return match[1];
  }

  it('TC-098: a real and an unknown email get the same status and body; only the real account is mailed', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    h.mails.length = 0;
    const real = await forgot(u.email);
    const unknown = await forgot('nobody-here@example.com');
    expect(real.status).toBe(unknown.status);
    expect(real.body).toEqual(unknown.body);
    expect(h.mails.map((m) => m.to)).toEqual([u.email]);
  });

  it('TC-098: the link resets the password once, revokes every refresh token of the user, keeps TOTP and clears a lockout', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    // Two open sessions on two devices.
    // A TOTP code is accepted once per time step (replay guard), so the second device signs in
    // with a recovery code.
    const recovery = 'ABCDEFGHJKLMNPQR';
    await h.owner.user.update({
      where: { id: u.id },
      data: { recoveryCodeHashes: [sha256Hex(recovery)] },
    });
    const cookies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
      const done = await request(h.app.getHttpServer())
        .post(`${API}/auth/2fa/verify`)
        .send({ challengeToken, code: i === 0 ? authenticator.generate(TOTP_SECRET) : recovery })
        .expect(200);
      cookies.push(refreshCookie(done));
    }
    await h.owner.user.update({
      where: { id: u.id },
      data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
    });
    h.mails.length = 0;
    expect((await forgot(u.email)).status).toBe(202);
    const token = tokenFrom(h.mails[0]);
    // Stored as a hash, never the raw token; 30 minute expiry.
    const stored = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(stored.setPasswordTokenHash).toBe(sha256Hex(token));
    const ttlMin = ((stored.setPasswordExpiresAt?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(ttlMin).toBeGreaterThan(29);
    expect(ttlMin).toBeLessThanOrEqual(30);

    await reset(token, 'A-Brand-New-Passphrase-1').expect(204);

    for (const c of cookies) await refresh(h, c).expect(401);
    const rows = await h.owner.refreshToken.findMany({ where: { userId: u.id } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

    const after = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.passwordHash).toMatch(/^\$argon2id\$/);
    expect(after.setPasswordTokenHash).toBeNull();
    expect(after.totpEnabled).toBe(true);
    expect(after.totpSecretEnc).toBeTruthy();
    expect(after.failedLogins).toBe(0);
    expect(after.lockedUntil).toBeNull();

    // Old password dead; new one works but TOTP is still asked, and no session is issued before it.
    await login(h, u.email).expect(401);
    const next = await login(h, u.email, 'A-Brand-New-Passphrase-1').expect(200);
    expect((next.body as Body).status).toBe('two_factor_required');
    expect((next.body as Body).session).toBeUndefined();
    expect(next.headers['set-cookie']).toBeUndefined();
  });

  it('TC-098: the second use of the same link is refused and does not change the password again', async () => {
    const u = await createUser(h);
    h.mails.length = 0;
    expect((await forgot(u.email)).status).toBe(202);
    const token = tokenFrom(h.mails[0]);
    await reset(token, 'First-New-Passphrase-1').expect(204);
    await reset(token, 'Second-New-Passphrase-2').expect(400);
    await login(h, u.email, 'First-New-Passphrase-1').expect(200);
    await login(h, u.email, 'Second-New-Passphrase-2').expect(401);
  });

  it('TC-098: a link older than 30 minutes is refused and the old password still works', async () => {
    const u = await createUser(h);
    h.mails.length = 0;
    expect((await forgot(u.email)).status).toBe(202);
    const token = tokenFrom(h.mails[0]);
    await h.owner.user.update({
      where: { id: u.id },
      data: { setPasswordExpiresAt: new Date(Date.now() - 1000) },
    });
    await reset(token, 'A-Brand-New-Passphrase-1').expect(400);
    await login(h, u.email).expect(200);
  });

  it('TC-098: a made-up token and a weak new password are refused with 400', async () => {
    await reset('x'.repeat(43), 'A-Brand-New-Passphrase-1').expect(400);
    await reset('x'.repeat(43), 'short').expect(400);
  });

  it('TC-098: a newer link replaces the older one', async () => {
    const u = await createUser(h);
    h.mails.length = 0;
    expect((await forgot(u.email)).status).toBe(202);
    expect((await forgot(u.email)).status).toBe(202);
    expect(h.mails).toHaveLength(2);
    const first = tokenFrom(h.mails[0]);
    const second = tokenFrom(h.mails[1]);
    await reset(first, 'First-New-Passphrase-1').expect(400);
    await reset(second, 'Second-New-Passphrase-2').expect(204);
  });

  it('TC-098: neither the raw token nor the new password appears in any log line or audit row', async () => {
    const u = await createUser(h);
    h.mails.length = 0;
    expect((await forgot(u.email)).status).toBe(202);
    const token = tokenFrom(h.mails[0]);
    await reset(token, 'Log-Probe-Passphrase-77').expect(204);
    expect(h.logged.length).toBeGreaterThan(0);
    const logs = h.logged.join('');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('Log-Probe-Passphrase-77');
    const audit = JSON.stringify(
      await h.owner.auditLog.findMany({ where: { actorId: u.id } }),
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(audit).not.toContain(token);
    expect(audit).not.toContain('Log-Probe-Passphrase-77');
  });

  it('TC-098: a deactivated account gets the same response and no email', async () => {
    const u = await createUser(h);
    await h.owner.user.update({ where: { id: u.id }, data: { isActive: false } });
    h.mails.length = 0;
    expect((await forgot(u.email)).status).toBe(202);
    expect(h.mails).toHaveLength(0);
  });
});
