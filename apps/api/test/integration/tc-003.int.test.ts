// TC-003 (FR-102): 2FA required for reviewer. Expected: forced TOTP enrollment before any page
// loads, i.e. no session, no refresh cookie and no data route until enrollment is confirmed.
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
} from '../support/harness';

describe('TC-003 (FR-102): 2FA required for reviewer', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  const post = (path: string): request.Test =>
    request(h.app.getHttpServer()).post(`${API}/auth/${path}`);

  it.each([UserRole.REVIEWER, UserRole.SUPER_ADMIN])(
    'TC-003: a %s without TOTP gets an enrollment challenge only: no session, no cookie, no access token',
    async (role) => {
      const u = await createUser(h, { role });
      const res = await login(h, u.email).expect(200);
      const body = res.body as Body;
      expect(body.status).toBe('two_factor_enrollment_required');
      expect(body.session).toBeUndefined();
      expect(body.accessToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await h.owner.refreshToken.count({ where: { userId: u.id } })).toBe(0);
    },
  );

  it('TC-003: the enrollment challenge opens no protected route and cannot be exchanged for a refresh token', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    await post('2fa/setup/start').set('Authorization', `Bearer ${challengeToken}`).expect(401);
    await post('refresh').expect(401);
    const verify = await post('2fa/verify').send({ challengeToken, code: '123456' });
    expect([400, 401]).toContain(verify.status);
  });

  it('TC-003: enrollment shows a QR code and manual key, keeps the secret encrypted, and stays off until a valid code is confirmed', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    const start = (await post('2fa/enroll/start').send({ challengeToken }).expect(200))
      .body as Body;
    expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(start.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(start.manualKey).toMatch(/^[A-Z2-7]{16,}$/);
    const stored = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(stored.totpSecretEnc).toBeTruthy();
    expect(stored.totpSecretEnc).not.toContain(start.manualKey);
    expect(stored.totpEnabled).toBe(false);

    await post('2fa/enroll/confirm').send({ challengeToken, code: '000000' }).expect(400);
    expect((await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).totpEnabled).toBe(false);
    // Still forced after a half-finished enrollment.
    expect(((await login(h, u.email).expect(200)).body as Body).status).toBe(
      'two_factor_enrollment_required',
    );
  });

  it('TC-003: a correct code completes enrollment: session, 10 recovery codes stored only as hashes, an audit row, and the next login asks for the code', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    const start = (await post('2fa/enroll/start').send({ challengeToken }).expect(200))
      .body as Body;
    const done = await post('2fa/enroll/confirm')
      .send({ challengeToken, code: authenticator.generate(start.manualKey) })
      .expect(200);
    const body = done.body as Body;
    expect(body.session.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(done)).toMatch(/^cp_refresh=/);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set(body.recoveryCodes).size).toBe(10);

    const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.totpEnabled).toBe(true);
    expect(row.recoveryCodeHashes).toHaveLength(10);
    expect(row.recoveryCodeHashes.sort()).toEqual(body.recoveryCodes.map(sha256Hex).sort());
    expect(
      await h.owner.auditLog.count({ where: { actorId: u.id, action: 'AUTH_TOTP_ENABLED' } }),
    ).toBe(1);

    expect(((await login(h, u.email).expect(200)).body as Body).status).toBe('two_factor_required');
    // The session from enrollment works with the refresh token.
    await refresh(h, refreshCookie(done)).expect(200);
  });

  it('TC-003: once enrolled, the enrollment endpoints refuse to replace the secret', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    await post('2fa/enroll/start').send({ challengeToken }).expect(409);
  });

  it('TC-003: a recovery code works once and is gone afterwards', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: secret });
    const code = 'ABCDEFGHJKLMNPQR';
    await h.owner.user.update({
      where: { id: u.id },
      data: { recoveryCodeHashes: [sha256Hex(code)] },
    });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    await post('2fa/verify').send({ challengeToken, code }).expect(200);
    await post('2fa/verify').send({ challengeToken, code }).expect(400);
  });

  it('TC-003: five wrong 2FA codes lock the account like five wrong passwords (FR-101)', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    for (let i = 0; i < 5; i++)
      await post('2fa/verify').send({ challengeToken, code: '000000' }).expect(400);
    await login(h, u.email).expect(401);
  });

  it('FR-102: AUTHOR and RECRUITER may turn 2FA on voluntarily, and it is then enforced', async () => {
    const u = await createUser(h, { role: UserRole.AUTHOR });
    const session = (await login(h, u.email).expect(200)).body as Body;
    const auth = { Authorization: `Bearer ${session.session.accessToken}` };
    const start = (await post('2fa/setup/start').set(auth).expect(200)).body as Body;
    await post('2fa/setup/confirm').set(auth).send({ code: '000000' }).expect(400);
    const ok = await post('2fa/setup/confirm')
      .set(auth)
      .send({ code: authenticator.generate(start.manualKey) })
      .expect(200);
    expect((ok.body as Body).recoveryCodes).toHaveLength(10);
    expect(((await login(h, u.email).expect(200)).body as Body).status).toBe('two_factor_required');
  });
});
