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

  // A TOTP step is accepted once per user. These sign in with the previous step's code (inside
  // the accepted drift window), so the current step is still unused for the disable call.
  const stepCode = (offsetMs = 0): string =>
    authenticator.clone({ epoch: Date.now() + offsetMs }).generate(TOTP_SECRET);
  const goodCode = (): string => stepCode();
  const badCode = (): string => stepCode(10 * 60_000); // far outside the accepted window
  const disable = (auth: { Authorization: string }, body: object): request.Test =>
    post('2fa/disable').set(auth).send(body);
  /** Avoids a TOTP step boundary between a sign-in and the disable call that follows it. */
  async function stepSafe(): Promise<void> {
    const into = Date.now() % 30_000;
    if (into > 28_000) await new Promise((r) => setTimeout(r, 30_000 - into + 200));
  }
  const failedLogins = async (id: string): Promise<number> =>
    (await h.owner.user.findUniqueOrThrow({ where: { id } })).failedLogins;
  async function signInPrevStep(
    email: string,
  ): Promise<{ auth: { Authorization: string }; cookie: string }> {
    await stepSafe();
    const { challengeToken } = (await login(h, email).expect(200)).body as Body;
    const res = await post('2fa/verify')
      .send({ challengeToken, code: stepCode(-30_000) })
      .expect(200);
    return {
      auth: { Authorization: `Bearer ${(res.body as Body).accessToken}` },
      cookie: refreshCookie(res),
    };
  }
  /** A second, real session (new refresh family) for a TOTP user, through a recovery code. */
  async function signInWithRecovery(email: string, code: string): Promise<{ cookie: string }> {
    const { challengeToken } = (await login(h, email).expect(200)).body as Body;
    const res = await post('2fa/verify').send({ challengeToken, code }).expect(200);
    return { cookie: refreshCookie(res) };
  }
  const twoFactorOn = async (id: string): Promise<boolean> =>
    (await h.owner.user.findUniqueOrThrow({ where: { id } })).totpEnabled;

  describe('FR-102: disable and recovery-code regeneration', () => {
    it('TC-003: an AUTHOR with 2FA on can turn it off with password and TOTP code: 204, cookie cleared, EVERY refresh family revoked (two sessions), secret and codes cleared, audit row with exactly sessionsRevoked, next login needs no code', async () => {
      const u = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
      const recovery = 'AAAAAAAAAAAAAAAA';
      await h.owner.user.update({
        where: { id: u.id },
        data: { recoveryCodeHashes: [sha256Hex(recovery)] },
      });
      const first = await signInPrevStep(u.email);
      const second = await signInWithRecovery(u.email, recovery); // a different family
      const live = await h.owner.refreshToken.findMany({
        where: { userId: u.id, revokedAt: null },
      });
      expect(live).toHaveLength(2);
      expect(new Set(live.map((t) => t.familyId)).size).toBe(2);

      const code = goodCode();
      const res = await disable(first.auth, { currentPassword: PASSWORD, totpCode: code }).expect(
        204,
      );
      const cleared = ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find(
        (c) => c.startsWith('cp_refresh='),
      );
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/cp_refresh=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      expect(cleared).toMatch(/Path=\/api\/v1\/auth/);
      expect(cleared).toMatch(/HttpOnly/i);
      expect(cleared).toMatch(/Secure/i);
      expect(cleared).toMatch(/SameSite=Strict/i);

      const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpEnabled).toBe(false);
      expect(row.totpSecretEnc).toBeNull();
      expect(row.recoveryCodeHashes).toEqual([]);
      const after = await h.owner.refreshToken.findMany({ where: { userId: u.id } });
      expect(after.every((t) => t.revokedAt !== null)).toBe(true);
      await refresh(h, first.cookie).expect(401);
      await refresh(h, second.cookie).expect(401); // the other family, not the caller's

      const audit = await h.owner.auditLog.findMany({
        where: { actorId: u.id, action: 'AUTH_2FA_DISABLED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toEqual({ sessionsRevoked: 2 });
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain(code);
      // Freshness comes from a new sign-in (every old refresh family is revoked above).
      const fresh = await login(h, u.email).expect(200);
      expect((fresh.body as Body).status).toBe('authenticated');
      expect(sessionUser(fresh.body, 'nested').totpEnabled).toBe(false);
      const freshRefresh = await refresh(h, refreshCookie(fresh)).expect(200);
      expect(sessionUser(freshRefresh.body, 'flat').totpEnabled).toBe(false);
    });

    it('TC-003: a RECRUITER can disable 2FA too (same rules as an AUTHOR): a rotated token of the family is revoked, a whitespace-padded code is trimmed, one AUTH_2FA_DISABLED row is written', async () => {
      const u = await createUser(h, { role: UserRole.RECRUITER, totp: TOTP_SECRET });
      const first = await signInPrevStep(u.email);
      const rotatedCookie = refreshCookie(await refresh(h, first.cookie).expect(200));
      await disable(first.auth, {
        currentPassword: PASSWORD,
        totpCode: ` ${goodCode()} `,
      }).expect(204);
      await refresh(h, rotatedCookie).expect(401);
      expect(await h.owner.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(
        0,
      );
      expect(await twoFactorOn(u.id)).toBe(false);
      const audit = await h.owner.auditLog.findMany({
        where: { actorId: u.id, action: 'AUTH_2FA_DISABLED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.orgId).toBe(h.orgId);
    });

    it('TC-003: disable refuses a missing or malformed totpCode (and a recovery code) with 400 and changes nothing', async () => {
      const u = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
      await h.owner.user.update({
        where: { id: u.id },
        data: { recoveryCodeHashes: [sha256Hex('AAAAAAAAAAAAAAAA')] },
      });
      const { auth } = await signInPrevStep(u.email);
      await disable(auth, {}).expect(400);
      await disable(auth, { currentPassword: PASSWORD }).expect(400);
      await disable(auth, { totpCode: goodCode() }).expect(400);
      for (const totpCode of ['AAAAAAAAAAAAAAAA', '12345', '1234567', 'abcdef', 123456, null, '']) {
        await disable(auth, { currentPassword: PASSWORD, totpCode }).expect(400);
      }
      expect(await twoFactorOn(u.id)).toBe(true);
      expect(await h.owner.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
        recoveryCodeHashes: [sha256Hex('AAAAAAAAAAAAAAAA')],
      });
    });

    it('TC-003: a wrong password or a wrong code is the same 403 REAUTH_FAILED body, a replayed code too, and 2FA stays on', async () => {
      const u = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
      const { auth } = await signInPrevStep(u.email);
      const wrongPw = await disable(auth, { currentPassword: 'Nope-Nope-1', totpCode: goodCode() });
      expectReauthFailed(wrongPw);
      const wrongCode = await disable(auth, { currentPassword: PASSWORD, totpCode: badCode() });
      expectReauthFailed(wrongCode);
      expect(stableProblem(wrongCode)).toEqual(stableProblem(wrongPw));
      expect(wrongCode.headers['set-cookie']).toBeUndefined();
      expect(await twoFactorOn(u.id)).toBe(true);
    });

    it('TC-003: a TOTP code already used (here to sign in, same step) cannot disable 2FA: 403 REAUTH_FAILED, identical body', async () => {
      const u = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
      const prev = await signInPrevStep(u.email);
      const wrongPwRes = await disable(prev.auth, {
        currentPassword: 'Nope-Nope-1',
        totpCode: goodCode(),
      });
      expectReauthFailed(wrongPwRes);
      const wrongPw = stableProblem(wrongPwRes);
      await stepSafe();
      const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
      const code = goodCode();
      const done = await post('2fa/verify').send({ challengeToken, code }).expect(200);
      const auth = { Authorization: `Bearer ${(done.body as Body).accessToken}` };
      const replay = await disable(auth, { currentPassword: PASSWORD, totpCode: code });
      expectReauthFailed(replay);
      expect(stableProblem(replay)).toEqual(wrongPw);
      expect(await twoFactorOn(u.id)).toBe(true);
    });

    it('TC-003: with 2FA already off, disable is 409 after the password check (wrong password is REAUTH_FAILED), before the code is looked at', async () => {
      const u = await createUser(h, { role: UserRole.AUTHOR });
      const auth = await signIn(h, u.email);
      expectReauthFailed(
        await disable(auth, { currentPassword: 'Nope-Nope-1', totpCode: goodCode() }),
      );
      await disable(auth, { currentPassword: PASSWORD, totpCode: goodCode() }).expect(409);
      await disable(auth, { currentPassword: PASSWORD, totpCode: '000000' }).expect(409);
    });

    it('TC-003: wrong password and wrong code attempts share one lockout: 5 failures lock, then even correct factors are REAUTH_FAILED', async () => {
      const u = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
      const { auth } = await signInPrevStep(u.email);
      let wrongBody: unknown;
      for (let i = 0; i < 5; i++) {
        const body =
          i % 2 === 0
            ? { currentPassword: 'Nope-Nope-1', totpCode: goodCode() }
            : { currentPassword: PASSWORD, totpCode: badCode() };
        const r = await disable(auth, body);
        expectReauthFailed(r);
        wrongBody ??= stableProblem(r);
        expect(stableProblem(r)).toEqual(wrongBody);
      }
      const locked = await disable(auth, { currentPassword: PASSWORD, totpCode: goodCode() });
      expectReauthFailed(locked);
      expect(stableProblem(locked)).toEqual(wrongBody);
      expect(await twoFactorOn(u.id)).toBe(true);
      await login(h, u.email).expect(401);
    });

    it.each([UserRole.SUPER_ADMIN, UserRole.REVIEWER])(
      'TC-003: a %s cannot disable 2FA: 403 TWO_FACTOR_REQUIRED_FOR_ROLE only with BOTH factors correct (a wrong factor is REAUTH_FAILED), 2FA and sessions stay',
      async (role) => {
        const u = await createUser(h, { role, totp: TOTP_SECRET });
        const { auth, cookie } = await signInPrevStep(u.email);
        const before = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
        expectReauthFailed(
          await disable(auth, { currentPassword: 'Nope-Nope-1', totpCode: goodCode() }),
        );
        expectReauthFailed(await disable(auth, { currentPassword: PASSWORD, totpCode: badCode() }));
        await disable(auth, {}).expect(400);
        await disable(auth, { currentPassword: PASSWORD }).expect(400);
        const failedBefore = await failedLogins(u.id); // the two refusals above counted
        const res = await disable(auth, { currentPassword: PASSWORD, totpCode: goodCode() });
        expect(res.status).toBe(403);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect((res.body as Body).code).toBe('TWO_FACTOR_REQUIRED_FOR_ROLE');
        expect(await failedLogins(u.id)).toBe(failedBefore); // a role refusal is not a failure
        const rowAfter = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(rowAfter.totpEnabled).toBe(true);
        expect(rowAfter.totpSecretEnc).toBe(before.totpSecretEnc);
        expect(rowAfter.recoveryCodeHashes).toEqual(before.recoveryCodeHashes);
        expect(
          await h.owner.auditLog.count({ where: { actorId: u.id, action: 'AUTH_2FA_DISABLED' } }),
        ).toBe(0);
        await refresh(h, cookie).expect(200); // the refusal revoked nothing
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
      await post('2fa/disable').send({ currentPassword: PASSWORD, totpCode: '123456' }).expect(401);
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
      await stepSafe();
      const { challengeToken } = (await login(h, admin.email).expect(200)).body as Body;
      const verified = await post('2fa/verify')
        .send({ challengeToken, code: stepCode(-30_000) })
        .expect(200);
      const auth = { Authorization: `Bearer ${(verified.body as Body).accessToken}` };
      const routes = [
        (pw: string): request.Test => resetOf(target.id).set(auth).send({ currentPassword: pw }),
        (pw: string): request.Test =>
          post('2fa/disable').set(auth).send({ currentPassword: pw, totpCode: goodCode() }),
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
});

// Last in the file on purpose: the Redis container is stopped for good (a restart would change
// its mapped port). A paused container is not usable here, the client just waits.
//
// Since #175 the global throttle guard keeps its counters in Redis and answers 503 "Service is
// temporarily unavailable." BEFORE any handler runs. So these tests boot with memoryThrottle
// (in-memory throttle store) and skipFreshnessCheck (the JWT guard's own Redis freshness check
// shares the handlers' wording), so the request reaches the HANDLER and its own fail-closed branch
// is what answers. They assert the handler wording, which the throttler 503 does not contain.
describe('TC-003 (FR-102): replay store outage reaches the handlers', () => {
  const HANDLER_503 = 'Verification is temporarily unavailable.';
  let h: Harness;
  let spy: jest.SpyInstance | undefined;
  beforeAll(async () => {
    h = await boot({ memoryThrottle: true });
  });
  afterAll(async () => {
    spy?.mockRestore();
    await h?.close();
  });
  const post = (path: string): request.Test =>
    request(h.app.getHttpServer()).post(`${API}/auth/${path}`);
  const slow = (t: request.Test): request.Test => t.timeout({ response: 30000, deadline: 40000 });
  const row = (id: string): ReturnType<typeof h.owner.user.findUniqueOrThrow> =>
    h.owner.user.findUniqueOrThrow({ where: { id } });
  const expectHandler503 = (res: request.Response): void => {
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect((res.body as Body).detail).toBe(HANDLER_503);
    expect(JSON.stringify(res.body)).not.toContain('Service is temporarily unavailable.');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((res.body as Body).accessToken).toBeUndefined();
    expect((res.body as Body).session).toBeUndefined();
  };

  // Fixtures that need Redis are made first; then Redis is stopped for the three tests below.
  let verifyCase: { id: string; challengeToken: string };
  let disableCase: { id: string; accessToken: string };
  let confirmCase: { id: string; challengeToken: string; code: string };
  let recoveryCase: { id: string; challengeToken: string; code: string };
  let recruiterToken: string;
  let auditBefore: number;
  beforeAll(async () => {
    const rec = await createUser(h, { role: UserRole.RECRUITER });
    recruiterToken = (await signIn(h, rec.email)).Authorization.replace('Bearer ', '');
    const r = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const code = 'QRSTUVWXYZABCDEF';
    await h.owner.user.update({
      where: { id: r.id },
      data: { recoveryCodeHashes: [sha256Hex(code)] },
    });
    recoveryCase = {
      id: r.id,
      code,
      challengeToken: ((await login(h, r.email).expect(200)).body as Body).challengeToken,
    };
    const u = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    verifyCase = {
      id: u.id,
      challengeToken: ((await login(h, u.email).expect(200)).body as Body).challengeToken,
    };
    const d = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
    const dChallenge = ((await login(h, d.email).expect(200)).body as Body).challengeToken;
    const dSession = await post('2fa/verify')
      .send({
        challengeToken: dChallenge,
        code: authenticator.clone({ epoch: Date.now() - 30_000 }).generate(TOTP_SECRET),
      })
      .expect(200);
    disableCase = { id: d.id, accessToken: (dSession.body as Body).accessToken ?? '' };
    const e = await createUser(h, { role: UserRole.REVIEWER });
    const eChallenge = ((await login(h, e.email).expect(200)).body as Body).challengeToken;
    const eStart = (await post('2fa/enroll/start').send({ challengeToken: eChallenge }).expect(200))
      .body as Body;
    confirmCase = {
      id: e.id,
      challengeToken: eChallenge,
      code: authenticator.generate(eStart.manualKey),
    };
    auditBefore = await h.owner.auditLog.count();
    await h.infra.redis.stop();
  }, 120000);

  // No isFresh spy here: the JWT guard's own freshness check is the layer under test. A valid token
  // on a route whose handler never touches Redis must NOT be served (a fail-open guard would 200).
  it('TC-003: with Redis down and no bypass, a valid access token on GET /tests is refused by the guard with 503 and no data', async () => {
    const res = await slow(
      request(h.app.getHttpServer())
        .get(`${API}/tests`)
        .set('Authorization', `Bearer ${recruiterToken}`),
    );
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect((res.body as Body).detail).toBe(HANDLER_503);
    expect(Array.isArray(res.body)).toBe(false);
    expect((res.body as { items?: unknown }).items).toBeUndefined();
  }, 90000);

  it('TC-003: with Redis down, /2fa/disable with correct factors answers the handler 503, keeps 2FA on, revokes nothing and counts no failure', async () => {
    const before = await row(disableCase.id);
    spy = h.skipFreshnessCheck();
    expectHandler503(
      await slow(
        post('2fa/disable')
          .set({ Authorization: `Bearer ${disableCase.accessToken}` })
          .send({ currentPassword: PASSWORD, totpCode: authenticator.generate(TOTP_SECRET) }),
      ),
    );
    expect(spy).toHaveBeenCalled(); // the bypass took effect, so the handler is what answered
    const after = await row(disableCase.id);
    expect(after.totpEnabled).toBe(true);
    expect(after.totpSecretEnc).toBe(before.totpSecretEnc);
    expect(after.failedLogins).toBe(before.failedLogins); // an outage counts as no failure
    expect(
      await h.owner.refreshToken.count({ where: { userId: disableCase.id, revokedAt: null } }),
    ).toBe(1);
    expect(
      await h.owner.auditLog.count({
        where: { actorId: disableCase.id, action: 'AUTH_2FA_DISABLED' },
      }),
    ).toBe(0);
  }, 90000);

  it('TC-003: with Redis down, /2fa/verify with a correct code answers the handler 503 and issues no session, cookie or refresh row', async () => {
    const before = await row(verifyCase.id);
    expectHandler503(
      await slow(
        post('2fa/verify').send({
          challengeToken: verifyCase.challengeToken,
          code: authenticator.generate(TOTP_SECRET),
        }),
      ),
    );
    expect(await h.owner.refreshToken.count({ where: { userId: verifyCase.id } })).toBe(0);
    expect((await row(verifyCase.id)).failedLogins).toBe(before.failedLogins);
  }, 90000);

  it('TC-003: with Redis down, /2fa/verify with a correct RECOVERY code answers the handler 503: no session, the code is not consumed, nothing counted', async () => {
    const before = await row(recoveryCase.id);
    expect(before.recoveryCodeHashes).toHaveLength(1);
    expectHandler503(
      await slow(
        post('2fa/verify').send({
          challengeToken: recoveryCase.challengeToken,
          code: recoveryCase.code,
        }),
      ),
    );
    const after = await row(recoveryCase.id);
    expect(after.recoveryCodeHashes).toEqual(before.recoveryCodeHashes);
    expect(after.failedLogins).toBe(before.failedLogins);
    expect(await h.owner.refreshToken.count({ where: { userId: recoveryCase.id } })).toBe(0);
  }, 90000);

  it('TC-003: with Redis down, /2fa/enroll/confirm with a correct code answers the handler 503: 2FA stays off, no recovery codes, no session', async () => {
    const before = await row(confirmCase.id);
    expectHandler503(
      await slow(
        post('2fa/enroll/confirm').send({
          challengeToken: confirmCase.challengeToken,
          code: confirmCase.code,
        }),
      ),
    );
    const after = await row(confirmCase.id);
    expect(after.totpEnabled).toBe(false);
    expect(after.recoveryCodeHashes).toEqual(before.recoveryCodeHashes);
    expect(after.failedLogins).toBe(before.failedLogins);
    expect(await h.owner.refreshToken.count({ where: { userId: confirmCase.id } })).toBe(0);
  }, 90000);

  it('TC-003: none of the refused outage calls wrote an audit row', async () => {
    expect(await h.owner.auditLog.count()).toBe(auditBefore);
  });
});
