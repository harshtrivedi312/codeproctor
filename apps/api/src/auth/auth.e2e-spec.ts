import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import { encryptSecret, sha256Hex } from './crypto.util';
import type { MailPort } from '../mail/mail.port';

const API = '/api/v1/auth';
const PASSWORD = 'Correct-Horse-9';

interface SentMail {
  to: string;
  url: string;
}

describe('Staff authentication (FR-101, FR-102, FR-104, FR-107)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let orgId: string;
  const mails: SentMail[] = [];
  let seq = 0;

  const fakeMail: Pick<MailPort, 'sendPasswordReset'> = {
    sendPasswordReset: (to, url) => {
      mails.push({ to, url });
      return Promise.resolve();
    },
  };

  // Request logs are on (LOG_LEVEL=info) so TC-098 can prove no token reaches them; keep them
  // out of the test output and collect them instead.
  const logged: string[] = [];
  let stdout: jest.SpyInstance;

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '10000', LOG_LEVEL: 'info' });
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    orgId = (await prisma.organization.create({ data: { name: 'Acme Hiring' } })).id;

    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { MailPort: MailToken } =
      jest.requireActual<typeof import('../mail/mail.port')>('../mail/mail.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailToken)
      .useValue(fakeMail)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    stdout.mockRestore();
    await app?.close();
    await prisma?.$disconnect();
    await infra?.stop();
  });

  async function createUser(
    opts: { role?: UserRole; password?: string | null; totp?: string } = {},
  ): Promise<{ id: string; email: string }> {
    const email = `user${++seq}@example.com`;
    const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
    const user = await prisma.user.create({
      data: {
        orgId,
        email,
        fullName: `User ${seq}`,
        role: opts.role ?? UserRole.RECRUITER,
        passwordHash:
          opts.password === null ? null : await hash(opts.password ?? PASSWORD, { algorithm: 2 }),
        // A pending invite must carry a set-password token (schema CHECK).
        setPasswordTokenHash: opts.password === null ? sha256Hex(`invite-${seq}`) : null,
        totpSecretEnc: opts.totp ? encryptSecret(opts.totp, key) : null,
        totpEnabled: opts.totp !== undefined,
      },
    });
    return { id: user.id, email };
  }

  const login = (email: string, password = PASSWORD): request.Test =>
    request(app.getHttpServer()).post(`${API}/login`).send({ email, password });

  function refreshCookie(res: request.Response): string {
    const header = res.headers['set-cookie'] as unknown as string[] | undefined;
    const raw = (header ?? []).find((c) => c.startsWith('cp_refresh='));
    if (!raw) throw new Error('no refresh cookie');
    return raw.split(';')[0] ?? '';
  }

  const refresh = (cookie: string): request.Test =>
    request(app.getHttpServer()).post(`${API}/refresh`).set('Cookie', cookie);

  // Loose view of the JSON bodies these tests read; each test only touches the fields it expects.
  interface Body {
    status: string;
    detail: string;
    challengeToken: string;
    accessToken: string;
    session: { accessToken: string; user: { email: string; role: string } };
    manualKey: string;
    otpauthUri: string;
    qrDataUrl: string;
    recoveryCodes: string[];
  }

  describe('TC-001 (FR-101): valid staff login', () => {
    it('TC-001: correct credentials sign a recruiter in with a 15 minute access token and a hardened refresh cookie', async () => {
      const u = await createUser();
      const res = await login(u.email).expect(200);
      const body = res.body as Body;
      expect(body.status).toBe('authenticated');
      expect(body.session.user).toMatchObject({ email: u.email, role: 'RECRUITER' });
      const claims = JSON.parse(
        Buffer.from(body.session.accessToken.split('.')[1] ?? '', 'base64url').toString(),
      ) as { exp: number; iat: number };
      expect(claims.exp - claims.iat).toBe(900);
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('cp_refresh='),
      );
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      const stored = await prisma.refreshToken.findMany({ where: { userId: u.id } });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cookie).not.toContain(stored[0]?.tokenHash);
    });

    it('TC-001: an account with TOTP gets a 2FA prompt, then a session after the code', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const first = (await login(u.email).expect(200)).body as Body;
      expect(first.status).toBe('two_factor_required');
      expect(first.session).toBeUndefined();
      const res = await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken: first.challengeToken, code: authenticator.generate(secret) })
        .expect(200);
      expect((res.body as Body).accessToken).toEqual(expect.any(String));
      refreshCookie(res);
      await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken: first.challengeToken, code: '000000' })
        .expect(400);
    });

    it('TC-001: wrong password, unknown email and a pending invite all get the same generic 401', async () => {
      const u = await createUser();
      const pending = await createUser({ password: null });
      const bodies = [
        (await login(u.email, 'wrong-password-1').expect(401)).body as Body,
        (await login('nobody@example.com').expect(401)).body as Body,
        (await login(pending.email, 'anything-at-all').expect(401)).body as Body,
      ];
      for (const b of bodies) expect(b.detail).toBe('Invalid email or password.');
      expect(new Set(bodies.map((b) => b.detail)).size).toBe(1);
    });
  });

  describe('TC-002 (FR-101): lockout after failures', () => {
    it('TC-002: 5 wrong passwords lock the account 15 minutes, the 6th correct attempt is refused and an audit row is written', async () => {
      const u = await createUser();
      for (let i = 0; i < 5; i++) await login(u.email, `wrong-password-${i}`).expect(401);
      await login(u.email).expect(401);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(5);
      const minutes = ((row.lockedUntil?.getTime() ?? 0) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);
      const audit = await prisma.auditLog.findMany({
        where: { actorId: u.id, action: 'AUTH_ACCOUNT_LOCKED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.orgId).toBe(orgId);
    });

    it('TC-002: once the lock has expired the correct password works and the counter resets', async () => {
      const u = await createUser();
      for (let i = 0; i < 5; i++) await login(u.email, `wrong-password-${i}`).expect(401);
      await prisma.user.update({
        where: { id: u.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      await login(u.email).expect(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });

    it('TC-002: a wrong password right after an expired lock starts a fresh count, not an instant relock', async () => {
      const u = await createUser();
      for (let i = 0; i < 5; i++) await login(u.email, `wrong-password-${i}`).expect(401);
      await prisma.user.update({
        where: { id: u.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      await login(u.email, 'wrong-password-x').expect(401);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(1);
      expect(row.lockedUntil).toBeNull();
    });
  });

  describe('TC-003 (FR-102): 2FA required for reviewer', () => {
    it('TC-003: a reviewer without TOTP gets no session, only an enrollment challenge', async () => {
      const u = await createUser({ role: UserRole.REVIEWER });
      const res = await login(u.email).expect(200);
      const body = res.body as Body;
      expect(body.status).toBe('two_factor_enrollment_required');
      expect(body.session).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      // The challenge is not a session: protected routes refuse it.
      await request(app.getHttpServer())
        .post(`${API}/2fa/setup/start`)
        .set('Authorization', `Bearer ${body.challengeToken}`)
        .expect(401);
    });

    it('TC-003: enrollment returns a QR data URL, confirms with a valid code, issues 10 hashed recovery codes and a session', async () => {
      const u = await createUser({ role: UserRole.SUPER_ADMIN });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;

      const start = (
        await request(app.getHttpServer())
          .post(`${API}/2fa/enroll/start`)
          .send({ challengeToken })
          .expect(200)
      ).body as Body;
      expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(start.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(stored.totpSecretEnc).not.toContain(start.manualKey);
      expect(stored.totpEnabled).toBe(false);

      await request(app.getHttpServer())
        .post(`${API}/2fa/enroll/confirm`)
        .send({ challengeToken, code: '000000' })
        .expect(400);

      const done = await request(app.getHttpServer())
        .post(`${API}/2fa/enroll/confirm`)
        .send({ challengeToken, code: authenticator.generate(start.manualKey) })
        .expect(200);
      const body = done.body as Body;
      expect(body.session.accessToken).toEqual(expect.any(String));
      const codes = body.recoveryCodes;
      expect(codes).toHaveLength(10);
      for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{16}$/);
      refreshCookie(done);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpEnabled).toBe(true);
      expect(row.recoveryCodeHashes.sort()).toEqual(codes.map((c) => sha256Hex(c)).sort());
      // Next login asks for the code.
      expect(((await login(u.email).expect(200)).body as Body).status).toBe('two_factor_required');
    });

    it('TC-003: a recovery code signs in once and is removed on use', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const code = 'ABCDEFGHJKLMNPQR';
      const other = 'STUVWXYZ23456723';
      await prisma.user.update({
        where: { id: u.id },
        data: { recoveryCodeHashes: [sha256Hex(code), sha256Hex(other)] },
      });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken, code: code.toLowerCase() })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken, code })
        .expect(400);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.recoveryCodeHashes).toEqual([sha256Hex(other)]);
      const audit = await prisma.auditLog.count({
        where: { actorId: u.id, action: 'AUTH_RECOVERY_CODE_USED' },
      });
      expect(audit).toBe(1);
    });

    it('TC-003: repeated wrong 2FA codes count toward the same 5-failure lockout', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post(`${API}/2fa/verify`)
          .send({ challengeToken, code: '000000' })
          .expect(400);
      }
      await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken, code: authenticator.generate('JBSWY3DPEHPK3PXP') })
        .expect(401);
    });

    it('FR-102: a recruiter can turn on optional 2FA while signed in', async () => {
      const u = await createUser();
      const session = (await login(u.email).expect(200)).body as Body;
      const auth = { Authorization: `Bearer ${session.session.accessToken}` };
      const start = (
        await request(app.getHttpServer()).post(`${API}/2fa/setup/start`).set(auth).expect(200)
      ).body as Body;
      const res = await request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set(auth)
        .send({ code: authenticator.generate(start.manualKey) })
        .expect(200);
      expect((res.body as Body).recoveryCodes).toHaveLength(10);
      expect(((await login(u.email).expect(200)).body as Body).status).toBe('two_factor_required');
    });
  });

  describe('TC-005 (FR-104): refresh token rotation and reuse', () => {
    it('TC-005: the second use of a refresh token is rejected and the whole family is revoked', async () => {
      const u = await createUser();
      const cookie1 = refreshCookie(await login(u.email).expect(200));
      const second = await refresh(cookie1).expect(200);
      expect((second.body as Body).accessToken).toEqual(expect.any(String));
      const cookie2 = refreshCookie(second);
      expect(cookie2).not.toBe(cookie1);

      await refresh(cookie1).expect(401);
      // The legitimate descendant is dead too.
      await refresh(cookie2).expect(401);

      const rows = await prisma.refreshToken.findMany({ where: { userId: u.id } });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(
        await prisma.auditLog.count({
          where: { actorId: u.id, action: 'AUTH_REFRESH_REUSE_DETECTED' },
        }),
      ).toBe(1);
    });

    it('TC-005: concurrent use of one refresh token lets only one caller win', async () => {
      const u = await createUser();
      const cookie = refreshCookie(await login(u.email).expect(200));
      const results = await Promise.all([refresh(cookie), refresh(cookie), refresh(cookie)]);
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(results.filter((r) => r.status === 401).length).toBeGreaterThanOrEqual(2);
    });

    it('FR-104: refresh without a cookie or with a forged cookie is 401', async () => {
      await request(app.getHttpServer()).post(`${API}/refresh`).expect(401);
      await refresh('cp_refresh=forged').expect(401);
    });

    it('FR-104: logout revokes the family and clears the cookie', async () => {
      const u = await createUser();
      const cookie = refreshCookie(await login(u.email).expect(200));
      const rotated = refreshCookie(await refresh(cookie).expect(200));
      const res = await request(app.getHttpServer())
        .post(`${API}/logout`)
        .set('Cookie', rotated)
        .expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(/cp_refresh=;/);
      await refresh(rotated).expect(401);
      const rows = await prisma.refreshToken.findMany({ where: { userId: u.id } });
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it('FR-104: a deactivated user cannot refresh', async () => {
      const u = await createUser();
      const cookie = refreshCookie(await login(u.email).expect(200));
      await prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
      await refresh(cookie).expect(401);
    });
  });

  describe('TC-098 (FR-107): staff password reset', () => {
    const forgot = (email: string): request.Test =>
      request(app.getHttpServer()).post(`${API}/password/forgot`).send({ email });

    function tokenFrom(mail: SentMail | undefined): string {
      const match = /#token=([^&]+)$/.exec(mail?.url ?? '');
      if (!match?.[1]) throw new Error('no token in mail');
      return match[1];
    }

    it('TC-098: same 202 for a real and an unknown email; the link resets once, revokes all refresh tokens, keeps TOTP, and the token is never logged', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      // An open session and a lockout that the reset must clear.
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const opened = await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken, code: authenticator.generate(secret) })
        .expect(200);
      const cookie = refreshCookie(opened);
      await prisma.user.update({
        where: { id: u.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
      });
      mails.length = 0;

      const real = await forgot(u.email).expect(202);
      const unknown = await forgot('nobody-at-all@example.com').expect(202);
      expect(real.body).toEqual(unknown.body);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.to).toBe(u.email);
      const token = tokenFrom(mails[0]);

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(stored.setPasswordTokenHash).toBe(sha256Hex(token));
      const ttl = (stored.setPasswordExpiresAt?.getTime() ?? 0) - Date.now();
      expect(ttl).toBeGreaterThan(29 * 60_000);
      expect(ttl).toBeLessThanOrEqual(30 * 60_000);

      const reset = await request(app.getHttpServer())
        .post(`${API}/password/reset`)
        .send({ token, newPassword: 'A-Brand-New-Passphrase-1' })
        .expect(204);
      expect(reset.headers['set-cookie']).toBeUndefined();
      // Second use of the same link is refused.
      await request(app.getHttpServer())
        .post(`${API}/password/reset`)
        .send({ token, newPassword: 'Another-Passphrase-22' })
        .expect(400);
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join('')).not.toContain(token);

      const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(after.setPasswordTokenHash).toBeNull();
      expect(after.failedLogins).toBe(0);
      expect(after.lockedUntil).toBeNull();
      expect(after.totpEnabled).toBe(true);
      expect(
        await prisma.auditLog.count({ where: { actorId: u.id, action: 'AUTH_PASSWORD_RESET' } }),
      ).toBe(1);
      await refresh(cookie).expect(401);
      expect(
        (await prisma.refreshToken.findMany({ where: { userId: u.id } })).every(
          (r) => r.revokedAt !== null,
        ),
      ).toBe(true);

      // Old password is dead; the new one works but still asks for TOTP.
      await login(u.email).expect(401);
      const next = (await login(u.email, 'A-Brand-New-Passphrase-1').expect(200)).body as Body;
      expect(next.status).toBe('two_factor_required');
      expect(next.session).toBeUndefined();
    });

    it('TC-098: a link older than 30 minutes is refused and the password is unchanged', async () => {
      const u = await createUser();
      mails.length = 0;
      await forgot(u.email).expect(202);
      const token = tokenFrom(mails[0]);
      await prisma.user.update({
        where: { id: u.id },
        data: { setPasswordExpiresAt: new Date(Date.now() - 1000) },
      });
      await request(app.getHttpServer())
        .post(`${API}/password/reset`)
        .send({ token, newPassword: 'A-Brand-New-Passphrase-1' })
        .expect(400);
      await login(u.email).expect(200);
    });

    it('TC-098: a deactivated user gets the same 202 but no email', async () => {
      const u = await createUser();
      await prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
      mails.length = 0;
      await forgot(u.email).expect(202);
      expect(mails).toHaveLength(0);
    });

    it('TC-098: requests are rate limited per email (silently) and per IP (429)', async () => {
      const u = await createUser();
      mails.length = 0;
      for (let i = 0; i < 6; i++) await forgot(u.email).expect(202);
      expect(mails).toHaveLength(3);
      // Per IP: the budget is 10 per hour across all emails.
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await forgot(`ip-limit-${i}@example.com`)).status);
      expect(statuses).toContain(429);
    });

    it('TC-098: a short or malformed reset payload is a 400 validation error', async () => {
      await request(app.getHttpServer())
        .post(`${API}/password/reset`)
        .send({ token: 'x'.repeat(30), newPassword: 'short' })
        .expect(400);
    });
  });

  describe('FR-103 foundation: deny by default', () => {
    it('FU-BE-04: /health is explicitly public', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    });

    it('FR-104: protected routes need a valid access token', async () => {
      await request(app.getHttpServer()).post(`${API}/2fa/setup/start`).expect(401);
      await request(app.getHttpServer())
        .post(`${API}/2fa/setup/start`)
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });
  });
});
