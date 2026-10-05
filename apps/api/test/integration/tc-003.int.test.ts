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
  expectNoTotpEnabled,
  expectReauthFailed,
  Harness,
  login,
  PASSWORD,
  refresh,
  refreshCookie,
  sessionUser,
  signIn,
  signInKeepingCookie,
  signInWithTotp,
  stableProblem,
  TOTP_SECRET,
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
      expectNoTotpEnabled(res);
      expect(await h.owner.refreshToken.count({ where: { userId: u.id } })).toBe(0);
    },
  );

  it('TC-003: the enrollment challenge opens no protected route and cannot be exchanged for a refresh token', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    await post('2fa/setup/start')
      .set('Authorization', `Bearer ${challengeToken}`)
      .send({ currentPassword: PASSWORD })
      .expect(401);
    expectNoTotpEnabled(await post('refresh').expect(401));
    const verify = await post('2fa/verify').send({ challengeToken, code: '123456' });
    expect([400, 401]).toContain(verify.status);
    expectNoTotpEnabled(verify);
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
    const startRes = await post('2fa/enroll/start').send({ challengeToken }).expect(200);
    expectNoTotpEnabled(startRes);
    expect((startRes.body as Body).session).toBeUndefined();
    const start = startRes.body as Body;
    const done = await post('2fa/enroll/confirm')
      .send({ challengeToken, code: authenticator.generate(start.manualKey) })
      .expect(200);
    const body = done.body as Body;
    expect(body.session.accessToken).toEqual(expect.any(String));
    expect(sessionUser(body, 'nested').totpEnabled).toBe(true);
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
    const refreshed = await refresh(h, refreshCookie(done)).expect(200);
    expect(sessionUser(refreshed.body, 'flat').totpEnabled).toBe(true);
  });

  it('TC-003: once enrolled, the enrollment endpoints refuse to replace the secret', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    await post('2fa/enroll/start').send({ challengeToken }).expect(409);
  });

  it('TC-003: a recovery code works once and is gone afterwards', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const code = 'ABCDEFGHJKLMNPQR';
    await h.owner.user.update({
      where: { id: u.id },
      data: { recoveryCodeHashes: [sha256Hex(code)] },
    });
    const first = (await login(h, u.email).expect(200)).body as Body;
    const used = await post('2fa/verify')
      .send({ challengeToken: first.challengeToken, code })
      .expect(200);
    expect(sessionUser(used.body, 'flat').totpEnabled).toBe(true);
    // 2FA challenges are single-use, so the second attempt needs a fresh sign-in.
    const second = (await login(h, u.email).expect(200)).body as Body;
    expectNoTotpEnabled(
      await post('2fa/verify').send({ challengeToken: second.challengeToken, code }).expect(400),
    );
  });

  it('TC-003: a spent 2FA challenge cannot be used again, even with a correct code (single-use jti)', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    await post('2fa/verify')
      .send({ challengeToken, code: authenticator.generate(TOTP_SECRET) })
      .expect(200);
    const again = await post('2fa/verify').send({
      challengeToken,
      code: authenticator.generate(TOTP_SECRET),
    });
    expect(again.status).toBe(401);
    expect(await h.owner.refreshToken.count({ where: { userId: u.id } })).toBe(1);
  });

  it('TC-003: a challenge issued before a password change is refused', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    const { hash } = await import('@node-rs/argon2');
    await h.owner.user.update({
      where: { id: u.id },
      data: { passwordHash: await hash('Another-Passphrase-42', { algorithm: 2 }) },
    });
    await post('2fa/verify')
      .send({ challengeToken, code: authenticator.generate(TOTP_SECRET) })
      .expect(401);
  });

  it('TC-003: five wrong 2FA codes lock the account like five wrong passwords (FR-101)', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    for (let i = 0; i < 5; i++)
      await post('2fa/verify').send({ challengeToken, code: '000000' }).expect(400);
    // Locked: the generic 401 on login, 400 on a code (even a correct one); no 423, no lockedUntil.
    const locked = await login(h, u.email);
    expect(locked.status).toBe(401);
    expect(JSON.stringify(locked.body)).not.toMatch(/lockedUntil|locked/i);
    const sixth = await post('2fa/verify').send({
      challengeToken,
      code: authenticator.generate(TOTP_SECRET),
    });
    expect(sixth.status).toBe(400);
    expect(JSON.stringify(sixth.body)).not.toMatch(/lockedUntil|locked/i);
  });

  it('FR-102: AUTHOR and RECRUITER may turn 2FA on voluntarily with their current password, and it is then enforced', async () => {
    const u = await createUser(h, { role: UserRole.AUTHOR });
    const signedIn = await signInKeepingCookie(h, u.email);
    const auth = signedIn.auth;
    // Refresh rotates the cookie, so keep the newest one.
    const before = await refresh(h, signedIn.cookie).expect(200);
    expect(sessionUser(before.body, 'flat').totpEnabled).toBe(false);
    const cookie = refreshCookie(before);
    const start = (
      await post('2fa/setup/start').set(auth).send({ currentPassword: PASSWORD }).expect(200)
    ).body as Body;
    await post('2fa/setup/confirm')
      .set(auth)
      .send({ currentPassword: PASSWORD, code: '000000' })
      .expect(400);
    const ok = await post('2fa/setup/confirm')
      .set(auth)
      .send({ currentPassword: PASSWORD, code: authenticator.generate(start.manualKey) })
      .expect(200);
    expect((ok.body as Body).recoveryCodes).toHaveLength(10);
    expect((ok.body as Body).session).toBeUndefined();
    expectNoTotpEnabled(ok);
    expect(ok.headers['cache-control']).toContain('no-store');
    // The refresh cookie from before the change must report the new state, not a cached one.
    const afterOn = await refresh(h, cookie).expect(200);
    expect(sessionUser(afterOn.body, 'flat').totpEnabled).toBe(true);
    const next = await login(h, u.email).expect(200);
    expect((next.body as Body).status).toBe('two_factor_required');
    expectNoTotpEnabled(next);
  });

  it('FR-102: setup/start and setup/confirm refuse a missing (400) or wrong (403 REAUTH_FAILED) current password and change nothing', async () => {
    const u = await createUser(h, { role: UserRole.RECRUITER });
    const auth = await signIn(h, u.email);
    await post('2fa/setup/start').set(auth).send({}).expect(400);
    const wrong = await post('2fa/setup/start').set(auth).send({ currentPassword: 'Nope-Nope-1' });
    expectReauthFailed(wrong);
    expectReauthFailed(
      await post('2fa/setup/confirm')
        .set(auth)
        .send({ currentPassword: 'Nope-Nope-1', code: '123456' }),
    );
    const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.totpSecretEnc).toBeNull();
    expect(row.totpEnabled).toBe(false);
  });

  it('FR-102: setup/start answers a locked account with the same 403 REAUTH_FAILED body as a wrong password', async () => {
    const u = await createUser(h, { role: UserRole.RECRUITER });
    const auth = await signIn(h, u.email);
    let wrongBody: unknown;
    for (let i = 0; i < 5; i++) {
      const r = await post('2fa/setup/start').set(auth).send({ currentPassword: 'Nope-Nope-1' });
      expectReauthFailed(r);
      wrongBody = stableProblem(r);
    }
    const lockedRes = await post('2fa/setup/start').set(auth).send({ currentPassword: PASSWORD });
    expectReauthFailed(lockedRes);
    expect(stableProblem(lockedRes)).toEqual(wrongBody);
    // login stays the generic 401, locked too.
    await login(h, u.email).expect(401);
    // setup/confirm and the other re-auth routes answer a locked account the same way.
    const confirm = await post('2fa/setup/confirm')
      .set(auth)
      .send({ currentPassword: PASSWORD, code: '123456' });
    expectReauthFailed(confirm);
    expect(stableProblem(confirm)).toEqual(wrongBody);
  });

  it('FR-102, FR-107: enrol and recovery-code responses are Cache-Control no-store', async () => {
    const u = await createUser(h, { role: UserRole.REVIEWER });
    const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
    const start = await post('2fa/enroll/start').send({ challengeToken }).expect(200);
    expect(start.headers['cache-control']).toContain('no-store');
    const done = await post('2fa/enroll/confirm')
      .send({ challengeToken, code: authenticator.generate((start.body as Body).manualKey) })
      .expect(200);
    expect(done.headers['cache-control']).toContain('no-store');

    const auth = { Authorization: `Bearer ${(done.body as Body).session.accessToken}` };
    const regen = await post('2fa/recovery-codes/regenerate')
      .set(auth)
      .send({ currentPassword: PASSWORD })
      .expect(200);
    expect(regen.headers['cache-control']).toContain('no-store');

    const a = await createUser(h, { role: UserRole.AUTHOR });
    const authA = await signIn(h, a.email);
    const s = await post('2fa/setup/start')
      .set(authA)
      .send({ currentPassword: PASSWORD })
      .expect(200);
    expect(s.headers['cache-control']).toContain('no-store');
  });

  it('FR-102, FR-107: login, 2fa/verify and refresh responses are Cache-Control no-store', async () => {
    const plain = await createUser(h, { role: UserRole.AUTHOR });
    const loginRes = await login(h, plain.email).expect(200);
    expect(loginRes.headers['cache-control']).toContain('no-store');
    const refreshed = await refresh(h, refreshCookie(loginRes)).expect(200);
    expect(refreshed.headers['cache-control']).toContain('no-store');
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const step = await login(h, u.email).expect(200);
    expect(step.headers['cache-control']).toContain('no-store');
    const verified = await post('2fa/verify')
      .send({
        challengeToken: (step.body as Body).challengeToken,
        code: authenticator.generate(TOTP_SECRET),
      })
      .expect(200);
    expect(verified.headers['cache-control']).toContain('no-store');
    expect(sessionUser(verified.body, 'flat').totpEnabled).toBe(true);
    expectNoTotpEnabled(step);
  });

  describe('FR-102: disable and recovery-code regeneration', () => {
    it('TC-003: an AUTHOR with 2FA on can turn it off with the current password: 204, secret and codes cleared, audit row, next login needs no code', async () => {
      const u = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
      await h.owner.user.update({
        where: { id: u.id },
        data: { recoveryCodeHashes: [sha256Hex('AAAAAAAAAAAAAAAA')] },
      });
      const { auth, cookie } = await signInKeepingCookie(h, u.email, TOTP_SECRET);
      await post('2fa/disable').set(auth).send({}).expect(400);
      expectReauthFailed(
        await post('2fa/disable').set(auth).send({ currentPassword: 'Nope-Nope-1' }),
      );
      expect((await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).totpEnabled).toBe(
        true,
      );
      await post('2fa/disable').set(auth).send({ currentPassword: PASSWORD }).expect(204);
      const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpEnabled).toBe(false);
      expect(row.totpSecretEnc).toBeNull();
      expect(row.recoveryCodeHashes).toEqual([]);
      expect(
        await h.owner.auditLog.count({ where: { actorId: u.id, action: 'AUTH_2FA_DISABLED' } }),
      ).toBe(1);
      // Self-service disable does not revoke refresh families (only the admin reset does), so the
      // pre-change cookie is still valid and must now report false.
      const afterOff = await refresh(h, cookie).expect(200);
      expect(sessionUser(afterOff.body, 'flat').totpEnabled).toBe(false);
      const after = await login(h, u.email).expect(200);
      expect((after.body as Body).session).toBeDefined();
      expect(sessionUser(after.body, 'nested').totpEnabled).toBe(false);
      // Already off now.
      await post('2fa/disable').set(auth).send({ currentPassword: PASSWORD }).expect(409);
    });

    it.each([UserRole.SUPER_ADMIN, UserRole.REVIEWER])(
      'TC-003: a %s cannot disable 2FA: 403 TWO_FACTOR_REQUIRED_FOR_ROLE after the password check (wrong password is REAUTH_FAILED), 2FA stays on',
      async (role) => {
        const u = await createUser(h, { role, totp: TOTP_SECRET });
        const auth = await signInWithTotp(h, u.email);
        expectReauthFailed(
          await post('2fa/disable').set(auth).send({ currentPassword: 'Nope-Nope-1' }),
        );
        await post('2fa/disable').set(auth).send({}).expect(400);
        const res = await post('2fa/disable').set(auth).send({ currentPassword: PASSWORD });
        expect(res.status).toBe(403);
        expect((res.body as Body).code).toBe('TWO_FACTOR_REQUIRED_FOR_ROLE');
        expect((await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).totpEnabled).toBe(
          true,
        );
      },
    );

    it('TC-003: regenerate replaces all recovery codes (10 new, hashed, old ones dead), needs the current password and writes an audit row', async () => {
      const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
      const old = 'OLDCODEOLDCODEAB';
      await h.owner.user.update({
        where: { id: u.id },
        data: { recoveryCodeHashes: [sha256Hex(old)] },
      });
      const auth = await signInWithTotp(h, u.email);
      await post('2fa/recovery-codes/regenerate').set(auth).send({}).expect(400);
      expectReauthFailed(
        await post('2fa/recovery-codes/regenerate')
          .set(auth)
          .send({ currentPassword: 'Nope-Nope-1' }),
      );
      const res = await post('2fa/recovery-codes/regenerate')
        .set(auth)
        .send({ currentPassword: PASSWORD })
        .expect(200);
      const codes = (res.body as Body).recoveryCodes;
      expect(codes).toHaveLength(10);
      const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.recoveryCodeHashes.sort()).toEqual(codes.map(sha256Hex).sort());
      expect(
        await h.owner.auditLog.count({
          where: { actorId: u.id, action: 'AUTH_RECOVERY_CODES_REGENERATED' },
        }),
      ).toBe(1);
      const c1 = (await login(h, u.email).expect(200)).body as Body;
      await post('2fa/verify').send({ challengeToken: c1.challengeToken, code: old }).expect(400);
      const c2 = (await login(h, u.email).expect(200)).body as Body;
      await post('2fa/verify')
        .send({ challengeToken: c2.challengeToken, code: codes[0] })
        .expect(200);
    });

    it('TC-003: regenerate with 2FA off is 409 and the routes are closed to anonymous callers', async () => {
      const u = await createUser(h, { role: UserRole.RECRUITER });
      const auth = await signIn(h, u.email);
      await post('2fa/recovery-codes/regenerate')
        .set(auth)
        .send({ currentPassword: PASSWORD })
        .expect(409);
      await post('2fa/recovery-codes/regenerate').send({ currentPassword: PASSWORD }).expect(401);
      await post('2fa/disable').send({ currentPassword: PASSWORD }).expect(401);
    });
  });

  describe('FR-102: super admin 2FA reset', () => {
    const resetOf = (id: string): request.Test => post(`2fa/reset/${id}`);

    it('TC-003: a SUPER_ADMIN clears a colleague 2FA with their own password: 204, sessions revoked, audit row; the colleague must re-enrol at next login', async () => {
      const admin = await createUser(h, { role: UserRole.SUPER_ADMIN, totp: TOTP_SECRET });
      const target = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
      const { challengeToken } = (await login(h, target.email).expect(200)).body as Body;
      const targetSession = await post('2fa/verify')
        .send({ challengeToken, code: authenticator.generate(TOTP_SECRET) })
        .expect(200);
      const cookie = refreshCookie(targetSession);
      const auth = await signInWithTotp(h, admin.email);

      await resetOf(target.id).set(auth).send({}).expect(400);
      expectReauthFailed(
        await resetOf(target.id).set(auth).send({ currentPassword: 'Nope-Nope-1' }),
      );
      expect((await h.owner.user.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled).toBe(
        true,
      );
      await resetOf(target.id).set(auth).send({ currentPassword: PASSWORD }).expect(204);

      const row = await h.owner.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.totpEnabled).toBe(false);
      expect(row.totpSecretEnc).toBeNull();
      expect(row.recoveryCodeHashes).toEqual([]);
      await refresh(h, cookie).expect(401);
      expect(
        await h.owner.auditLog.count({
          where: { actorId: admin.id, action: 'AUTH_2FA_RESET_BY_ADMIN', entityId: target.id },
        }),
      ).toBe(1);
      expect(((await login(h, target.email).expect(200)).body as Body).status).toBe(
        'two_factor_enrollment_required',
      );
    });

    it('FR-102: a locked admin, or a wrong password, gets the identical REAUTH_FAILED body on reset, disable and regenerate', async () => {
      const admin = await createUser(h, { role: UserRole.SUPER_ADMIN, totp: TOTP_SECRET });
      const target = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
      const auth = await signInWithTotp(h, admin.email);
      const routes = [
        (pw: string): request.Test => resetOf(target.id).set(auth).send({ currentPassword: pw }),
        (pw: string): request.Test => post('2fa/disable').set(auth).send({ currentPassword: pw }),
        (pw: string): request.Test =>
          post('2fa/recovery-codes/regenerate').set(auth).send({ currentPassword: pw }),
      ];
      const wrong: Record<string, unknown>[] = [];
      for (let i = 0; i < 5; i++) {
        const route = routes[i % 3];
        const r = await route!('Nope-Nope-1');
        expectReauthFailed(r);
        wrong[i % 3] = stableProblem(r);
      }
      for (let i = 0; i < 3; i++) {
        const r = await routes[i]!(PASSWORD); // correct password, but the account is locked now
        expectReauthFailed(r);
        expect(stableProblem(r)).toEqual(wrong[i]);
      }
      expect((await h.owner.user.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled).toBe(
        true,
      );
    });

    it('FR-102: an admin demoted or whose password changed after sign-in cannot reset 2FA', async () => {
      const target = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
      const demoted = await createUser(h, { role: UserRole.SUPER_ADMIN, totp: TOTP_SECRET });
      const auth = await signInWithTotp(h, demoted.email);
      await h.owner.user.update({ where: { id: demoted.id }, data: { role: UserRole.RECRUITER } });
      // The guard re-reads the role, so the stale token is refused before the service runs.
      const res = await resetOf(target.id).set(auth).send({ currentPassword: PASSWORD });
      expect([401, 403]).toContain(res.status);
      expect((await h.owner.user.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled).toBe(
        true,
      );
    });

    it('TC-002: a non-SUPER_ADMIN gets 403 on the reset route and the target is unchanged', async () => {
      const target = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
      for (const role of [UserRole.RECRUITER, UserRole.AUTHOR]) {
        const caller = await createUser(h, { role });
        const auth = await signIn(h, caller.email);
        const res = await resetOf(target.id).set(auth).send({ currentPassword: PASSWORD });
        expect(res.status).toBe(403);
        expect((res.body as Body).code).toBeUndefined(); // role guard, not a coded refusal
      }
      const reviewer = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
      const rAuth = await signInWithTotp(h, reviewer.email);
      await resetOf(target.id).set(rAuth).send({ currentPassword: PASSWORD }).expect(403);
      await resetOf(target.id).send({ currentPassword: PASSWORD }).expect(401);
      expect((await h.owner.user.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled).toBe(
        true,
      );
    });

    it('TC-004: a user of another organization (or an unknown id) is 404, a non-UUID is 400, and resetting yourself is 400', async () => {
      const otherOrg = await h.owner.organization.create({ data: { name: 'QA Org B' } });
      const foreign = await createUser(h, {
        role: UserRole.REVIEWER,
        totp: TOTP_SECRET,
        orgId: otherOrg.id,
      });
      const admin = await createUser(h, { role: UserRole.SUPER_ADMIN, totp: TOTP_SECRET });
      const auth = await signInWithTotp(h, admin.email);
      await resetOf(foreign.id).set(auth).send({ currentPassword: PASSWORD }).expect(404);
      await resetOf('00000000-0000-4000-8000-000000000000')
        .set(auth)
        .send({ currentPassword: PASSWORD })
        .expect(404);
      await resetOf('not-a-uuid').set(auth).send({ currentPassword: PASSWORD }).expect(400);
      await resetOf(admin.id).set(auth).send({ currentPassword: PASSWORD }).expect(400);
      await resetOf(admin.id.toUpperCase())
        .set(auth)
        .send({ currentPassword: PASSWORD })
        .expect(400);
      expect(
        (await h.owner.user.findUniqueOrThrow({ where: { id: foreign.id } })).totpEnabled,
      ).toBe(true);
    });
  });

  // Last in the file on purpose: the Redis container is stopped for good (a restart would change
  // its mapped port). A paused container is not usable here, the client just waits.
  describe('FR-102: replay store outage', () => {
    it('TC-003: with Redis down, /2fa/verify answers 503 "temporarily unavailable" (not 500) and issues no session', async () => {
      const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
      const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
      await h.infra.redis.stop();
      const res = await post('2fa/verify')
        .send({ challengeToken, code: authenticator.generate(TOTP_SECRET) })
        .timeout({ response: 30000, deadline: 40000 });
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).toContain('temporarily unavailable');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await h.owner.refreshToken.count({ where: { userId: u.id } })).toBe(0);
    }, 90000);
  });
});
