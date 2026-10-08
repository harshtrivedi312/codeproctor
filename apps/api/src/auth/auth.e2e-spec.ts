import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { ARGON2_OPTIONS } from './password.service';
import { authenticator } from 'otplib';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import { encryptSecret, passwordVersion, sha256Hex } from './crypto.util';
import type { TokenService } from '../common/auth/token.service';
import type { MailPort } from '../mail/mail.port';
import type { AuthService } from './auth.service';
import type { PasswordService } from './password.service';
import type { TotpService } from './totp.service';

const API = '/api/v1/auth';
const PASSWORD = 'Correct-Horse-9';

// [$queryRaw, $executeRaw] calls for a refused setup/start (reserve and failure register).
const EXPECTED_SETUP_REFUSED_COUNTS = [2, 0];

// login, password/reset, 2fa/disable, 2fa/verify probe requests.
const EXPECTED_STATUSES = [401, 400, 401, 400];

/** A re-auth refusal: 403 with the machine code, never a 401 (FU-BE-39). */
function reauthRefused(res: request.Response): void {
  expect(res.status).toBe(403);
  expect((res.body as { code?: string }).code).toBe('REAUTH_FAILED');
}

/** The one fixed refusal of /auth/2fa/disable: same 403 REAUTH_FAILED, detail for both factors (FU-BE-58). */
const DISABLE_REFUSED_DETAIL = 'The password or code is incorrect.';
function disableRefused(res: request.Response): void {
  reauthRefused(res);
  expect((res.body as { detail?: string }).detail).toBe(DISABLE_REFUSED_DETAIL);
}

/** A response body without the per-request members, for wrong-vs-locked comparisons. */
function sameShape(res: request.Response): object {
  return { ...(res.body as object), instance: undefined, traceId: undefined };
}

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
  let passwordVerify: jest.SpyInstance;
  let totpVerify: jest.SpyInstance;
  let authService: AuthService;
  let tokenService: TokenService;
  let realPasswordVerify: PasswordService['verify'];

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
    const { PasswordService: Passwords } =
      jest.requireActual<typeof import('./password.service')>('./password.service');
    const { TotpService: Totp } =
      jest.requireActual<typeof import('./totp.service')>('./totp.service');
    const { AuthService: Auth } =
      jest.requireActual<typeof import('./auth.service')>('./auth.service');
    authService = app.get(Auth);
    const { TokenService: Tokens } = jest.requireActual<
      typeof import('../common/auth/token.service')
    >('../common/auth/token.service');
    tokenService = app.get(Tokens);
    const passwords: PasswordService = app.get(Passwords);
    realPasswordVerify = passwords.verify.bind(passwords);
    const totp: TotpService = app.get(Totp);
    passwordVerify = jest.spyOn(passwords, 'verify');
    totpVerify = jest.spyOn(totp, 'verify');
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
          opts.password === null ? null : await hash(opts.password ?? PASSWORD, ARGON2_OPTIONS),
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
    code?: string;
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
        .expect(401);
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

  describe('TC-003 (FR-102): 2FA is optional for every role, required at login once enrolled', () => {
    it.each([UserRole.SUPER_ADMIN, UserRole.REVIEWER, UserRole.RECRUITER, UserRole.AUTHOR])(
      'TC-003: a %s without TOTP signs in with the password alone and is told 2FA is recommended (FR-102)',
      async (role) => {
        const u = await createUser({ role });
        const res = await login(u.email).expect(200);
        const body = res.body as Body;
        expect(body.status).toBe('authenticated');
        expect(body.challengeToken).toBeUndefined();
        expect(body.session.user).toMatchObject({
          role,
          totpEnabled: false,
          twoFactorRecommended: true,
        });
        expect(res.headers['set-cookie']).toBeDefined();
        expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(1);
        // The refresh cookie keeps working for a role that used to need 2FA.
        const cookie = refreshCookie(res);
        const renewed = await refresh(cookie).expect(200);
        expect(
          (renewed.body as { user: { twoFactorRecommended: boolean } }).user.twoFactorRecommended,
        ).toBe(true);
      },
    );

    it('TC-003: a wrong password for a role without TOTP is the same 401 and still counts toward lockout (FR-102, FR-101)', async () => {
      const u = await createUser({ role: UserRole.REVIEWER });
      const res = await login(u.email, 'wrong-password-x').expect(401);
      expect((res.body as Body).status).not.toBe('authenticated');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(1);
    });

    it('TC-003: an enrolled user reports twoFactorRecommended false after the code (FR-102)', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const first = (await login(u.email).expect(200)).body as Body;
      expect(first.status).toBe('two_factor_required');
      const done = await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken: first.challengeToken, code: authenticator.generate(secret) })
        .expect(200);
      expect(
        (done.body as { user: { twoFactorRecommended: boolean } }).user.twoFactorRecommended,
      ).toBe(false);
    });

    it.each(['start', 'confirm'])(
      'TC-003: the pre-login forced-enrollment route 2fa/enroll/%s is gone (FR-102)',
      async (step) => {
        await request(app.getHttpServer())
          .post(`${API}/2fa/enroll/${step}`)
          .send({ challengeToken: 'x', code: '123456' })
          .expect(404);
      },
    );

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
      const second = (await login(u.email).expect(200)).body as Body;
      await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken: second.challengeToken, code })
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
        .expect(400);
    });

    it('FR-102: a recruiter can turn on optional 2FA while signed in', async () => {
      const u = await createUser();
      const session = (await login(u.email).expect(200)).body as Body;
      const auth = { Authorization: `Bearer ${session.session.accessToken}` };
      const start = (
        await request(app.getHttpServer())
          .post(`${API}/2fa/setup/start`)
          .set(auth)
          .send({ currentPassword: PASSWORD })
          .expect(200)
      ).body as Body;
      const res = await request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set(auth)
        .send({ currentPassword: PASSWORD, code: authenticator.generate(start.manualKey) })
        .expect(200);
      expect((res.body as Body).recoveryCodes).toHaveLength(10);
      expect(((await login(u.email).expect(200)).body as Body).status).toBe('two_factor_required');
    });
  });

  describe('TC-003 (FR-102): signed-in 2FA setup needs the current password (FU-BE-39)', () => {
    const setup = (
      path: 'start' | 'confirm',
      accessToken: string,
      body: Record<string, string>,
    ): request.Test =>
      request(app.getHttpServer())
        .post(`${API}/2fa/setup/${path}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body);

    async function signedIn(): Promise<{ id: string; token: string }> {
      const u = await createUser();
      const { session } = (await login(u.email).expect(200)).body as Body;
      return { id: u.id, token: session.accessToken };
    }

    it('TC-003: setup/start refuses a missing or wrong password with 403 REAUTH_FAILED, changes nothing and counts the failure', async () => {
      const u = await signedIn();
      await setup('start', u.token, {}).expect(400);
      expect(
        await setup('start', u.token, { currentPassword: 'wrong-password' }).expect(403),
      ).toMatchObject({
        status: 403,
        body: { detail: 'The current password is incorrect.', code: 'REAUTH_FAILED' },
      });
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpSecretEnc).toBeNull();
      expect(row.failedLogins).toBe(1);
    });

    it('TC-003: setup/confirm refuses a missing or wrong password even with a valid code, and enables nothing', async () => {
      const u = await signedIn();
      const start = (await setup('start', u.token, { currentPassword: PASSWORD }).expect(200))
        .body as Body;
      const code = authenticator.generate(start.manualKey);
      await setup('confirm', u.token, { code }).expect(400);
      reauthRefused(
        await setup('confirm', u.token, { currentPassword: 'wrong-password', code }).expect(403),
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpEnabled).toBe(false);
      expect(row.failedLogins).toBe(1);
    });

    it('TC-003: a stolen access token alone can no longer enable TOTP', async () => {
      const u = await signedIn();
      for (const path of ['start', 'confirm'] as const) {
        await setup(path, u.token, { code: '123456' }).expect(400);
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).totpEnabled).toBe(
        false,
      );
    });

    it('TC-003: 5 wrong passwords lock the account, then the correct password is refused with the same generic 403 REAUTH_FAILED', async () => {
      const u = await signedIn();
      const generic = { detail: 'The current password is incorrect.', code: 'REAUTH_FAILED' };
      const wrongs: request.Response[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await setup('start', u.token, { currentPassword: `wrong-${i}` }).expect(403);
        expect(res.body).toMatchObject(generic);
        wrongs.push(res);
      }
      const locked = await setup('start', u.token, { currentPassword: PASSWORD }).expect(403);
      expect(locked.body).toMatchObject(generic);
      expect(sameShape(locked)).toEqual(sameShape(wrongs[4] as request.Response));
      reauthRefused(
        await setup('confirm', u.token, { currentPassword: PASSWORD, code: '123456' }).expect(403),
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.lockedUntil).not.toBeNull();
      expect(row.totpSecretEnc).toBeNull();
      // The same lock stops a login too.
      await login((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).expect(401);
    });

    it('TC-003: a wrong password on setup counts toward the same lockout as login failures', async () => {
      const u = await signedIn();
      const email = (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email;
      for (let i = 0; i < 3; i++) await login(email, 'nope').expect(401);
      for (let i = 0; i < 2; i++) {
        reauthRefused(await setup('start', u.token, { currentPassword: 'nope' }).expect(403));
      }
      reauthRefused(await setup('start', u.token, { currentPassword: PASSWORD }).expect(403));
    });

    it('TC-003: the right password succeeds and gives the attempt back', async () => {
      const u = await signedIn();
      const start = (await setup('start', u.token, { currentPassword: PASSWORD }).expect(200))
        .body as Body;
      const res = await setup('confirm', u.token, {
        currentPassword: PASSWORD,
        code: authenticator.generate(start.manualKey),
      }).expect(200);
      expect((res.body as Body).recoveryCodes).toHaveLength(10);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpEnabled).toBe(true);
      expect(row.failedLogins).toBe(0);
    });

    it('TC-003: a password reset that lands while setup/confirm checks the code enables nothing (403 REAUTH_FAILED)', async () => {
      const u = await signedIn();
      const start = (await setup('start', u.token, { currentPassword: PASSWORD }).expect(200))
        .body as Body;
      totpVerify.mockImplementationOnce(async () => {
        await prisma.user.update({
          where: { id: u.id },
          data: { passwordHash: await hash('Another-Passphrase-12', ARGON2_OPTIONS) },
        });
        return true;
      });
      reauthRefused(
        await setup('confirm', u.token, {
          currentPassword: PASSWORD,
          code: authenticator.generate(start.manualKey),
        }).expect(403),
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpEnabled).toBe(false);
      expect(row.recoveryCodeHashes).toEqual([]);
      expect(row.failedLogins).toBe(0);
    });

    it('TC-003: a refused setup/start costs the same statements for a wrong password and a locked account', async () => {
      const wrong = await signedIn();
      const locked = await signedIn();
      await prisma.user.update({
        where: { id: locked.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
      });
      const { PrismaService: PrismaSvc } = jest.requireActual<
        typeof import('../database/prisma.service')
      >('../database/prisma.service');
      const client = app.get(PrismaSvc).client;
      const query = jest.spyOn(client, '$queryRaw');
      const exec = jest.spyOn(client, '$executeRaw');
      const counts: number[][] = [];
      try {
        for (const u of [wrong, locked]) {
          for (const spy of [query, exec]) spy.mockClear();
          reauthRefused(
            await setup('start', u.token, { currentPassword: 'not-the-password' }).expect(403),
          );
          counts.push([query, exec].map((spy) => spy.mock.calls.length));
        }
      } finally {
        for (const spy of [query, exec]) spy.mockRestore();
      }
      expect(counts[1]).toEqual(counts[0]);
      // Absolute shape too, so a statement dropped from both paths still fails.
      expect(counts[0]).toEqual(EXPECTED_SETUP_REFUSED_COUNTS);
    });
  });

  describe('TC-002 (FR-101): lockout under concurrency (FU-BE-26)', () => {
    const verify2fa = (challengeToken: string, code: string): request.Test =>
      request(app.getHttpServer()).post(`${API}/2fa/verify`).send({ challengeToken, code });

    it('TC-002: 10 parallel wrong logins verify at most 5 passwords, lock once, and the correct password is then refused with the same generic 401', async () => {
      const u = await createUser();
      passwordVerify.mockClear();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => login(u.email, `wrong-password-${i}`)),
      );
      expect(results.every((r) => r.status === 401)).toBe(true);
      expect(new Set(results.map((r) => (r.body as Body).detail))).toEqual(
        new Set(['Invalid email or password.']),
      );
      // burn() also calls verify, but with a dummy hash; count only checks against the account's own.
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      const realVerifies = passwordVerify.mock.calls.filter(
        (c: unknown[]) => c[0] === stored.passwordHash,
      );
      expect(realVerifies.length).toBeLessThanOrEqual(5);
      expect(realVerifies.length).toBeGreaterThan(0);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());
      expect(
        await prisma.auditLog.count({ where: { actorId: u.id, action: 'AUTH_ACCOUNT_LOCKED' } }),
      ).toBe(1);

      const refused = await login(u.email).expect(401);
      expect((refused.body as Body).detail).toBe('Invalid email or password.');
      expect(JSON.stringify(refused.body)).not.toMatch(/lock/i);
    });

    it('TC-002: a correct password in a burst of wrong ones never clears a lock a sibling set, whichever request wins', async () => {
      const u = await createUser();
      const results = await Promise.all([
        ...Array.from({ length: 8 }, (_, i) => login(u.email, `wrong-password-${i}`)),
        login(u.email),
      ]);
      expect(results.every((r) => r.status === 200 || r.status === 401)).toBe(true);
      const wins = results.filter((r) => r.status === 200).length;
      expect(wins).toBeLessThanOrEqual(1);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      if (wins === 1) {
        // The correct guess got a slot: the sign-in succeeded and any lock a sibling set after it
        // is still in force (it is never cleared half way).
        expect(row.failedLogins).toBeLessThanOrEqual(5);
        if (row.lockedUntil) expect(row.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      } else {
        // All 5 slots went to wrong guesses: the account is locked and the correct one was refused.
        expect(row.failedLogins).toBe(5);
        expect(row.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());
      }
      // Never more than 5 verified guesses against the account.
      expect(row.failedLogins).toBeLessThanOrEqual(5);
    });

    it('TC-002: 5 reservations held past the 2 minute window lock the account and no 6th password is verified (FU-BE-26)', async () => {
      const u = await createUser();
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The account's own verifies hang; the dummy-hash burn runs normally.
      passwordVerify.mockImplementation(async (hash: string, password: string) => {
        if (hash !== stored.passwordHash) return realPasswordVerify(hash, password);
        await gate;
        return false;
      });
      const inFlight: Promise<request.Response>[] = [];
      try {
        inFlight.push(
          ...Array.from({ length: 5 }, (_, i) => login(u.email, `slow-wrong-${i}`).then((r) => r)),
        );
        const deadline = Date.now() + 10_000;
        while (
          passwordVerify.mock.calls.filter((c: unknown[]) => c[0] === stored.passwordHash).length <
          5
        ) {
          if (Date.now() > deadline) throw new Error('reservations did not reach verify');
          await new Promise((r) => setTimeout(r, 20));
        }
        // Age the window past two minutes. The DB-03 trigger rewrites updated_at on every update,
        // so switch it off for this one statement.
        await prisma.$executeRaw`ALTER TABLE users DISABLE TRIGGER users_set_updated_at`;
        try {
          await prisma.$executeRaw`UPDATE users SET updated_at = now() - interval '3 minutes' WHERE id = ${u.id}::uuid`;
        } finally {
          await prisma.$executeRaw`ALTER TABLE users ENABLE TRIGGER users_set_updated_at`;
        }

        const sixth = await login(u.email, 'sixth-guess').expect(401);
        expect((sixth.body as Body).detail).toBe('Invalid email or password.');
        expect(
          passwordVerify.mock.calls.filter((c: unknown[]) => c[0] === stored.passwordHash),
        ).toHaveLength(5);
        const locked = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(locked.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now() + 14 * 60_000);
        expect(locked.failedLogins).toBe(5);

        release();
        const done = await Promise.all(inFlight);
        expect(done.every((r) => r.status === 401)).toBe(true);
      } finally {
        release();
        await Promise.allSettled(inFlight);
        passwordVerify.mockImplementation(realPasswordVerify);
      }
      expect(
        await prisma.auditLog.count({ where: { actorId: u.id, action: 'AUTH_ACCOUNT_LOCKED' } }),
      ).toBe(1);
    });

    it('TC-002: a refused attempt costs the same database statements for an unknown account, a wrong password and a locked account (FU-BE-30)', async () => {
      const wrong = await createUser();
      const locked = await createUser();
      await prisma.user.update({
        where: { id: locked.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
      });
      const { PrismaService: PrismaSvc } = jest.requireActual<
        typeof import('../database/prisma.service')
      >('../database/prisma.service');
      const client = app.get(PrismaSvc).client;
      const query = jest.spyOn(client, '$queryRaw');
      const exec = jest.spyOn(client, '$executeRaw');
      const find = jest.spyOn(client.user, 'findUnique');
      const counts: number[][] = [];
      try {
        for (const email of ['nobody-shape@example.com', wrong.email, locked.email]) {
          for (const spy of [query, exec, find]) spy.mockClear();
          await login(email, 'not-the-password').expect(401);
          counts.push([query, exec, find].map((spy) => spy.mock.calls.length));
        }
      } finally {
        for (const spy of [query, exec, find]) spy.mockRestore();
      }
      expect(counts[0]).toEqual([2, 0, 1]);
      expect(counts[1]).toEqual(counts[0]);
      expect(counts[2]).toEqual(counts[0]);
    });

    it('TC-002: 10 parallel wrong 2FA codes verify at most 5, lock the account, and a correct code is then refused exactly like a wrong one', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      // One challenge per request: a challenge is single use, so a shared one would serialise them.
      const challenges: string[] = [];
      for (let i = 0; i < 10; i++) {
        challenges.push(((await login(u.email).expect(200)).body as Body).challengeToken);
      }
      const challengeToken = challenges[0] ?? '';
      totpVerify.mockClear();
      const results = await Promise.all(challenges.map((c) => verify2fa(c, '000000')));
      expect(results.every((r) => r.status === 400)).toBe(true);
      expect(totpVerify.mock.calls.length).toBeLessThanOrEqual(5);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());
      expect(
        await prisma.auditLog.count({ where: { actorId: u.id, action: 'AUTH_ACCOUNT_LOCKED' } }),
      ).toBe(1);

      const wrong = await verify2fa(challengeToken, '000000');
      const right = await verify2fa(challengeToken, authenticator.generate(secret));
      expect(right.status).toBe(wrong.status);
      expect((right.body as Body).detail).toBe((wrong.body as Body).detail);
      expect(right.headers['set-cookie']).toBeUndefined();
    });

    it('FR-101: a locked account never reveals the lock on login or 2FA (FU-BE-22, FU-BE-34)', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      await prisma.user.update({
        where: { id: u.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
      });
      const wrongCode = await verify2fa(challengeToken, '000000');
      const rightCode = await verify2fa(challengeToken, authenticator.generate(secret));
      expect(wrongCode.status).toBe(400);
      expect(rightCode.status).toBe(400);
      const strip = (b: unknown): object => ({ ...(b as object), traceId: undefined });
      expect(strip(rightCode.body)).toEqual(strip(wrongCode.body));
      const loginRes = await login(u.email).expect(401);
      expect(JSON.stringify(loginRes.body)).not.toMatch(/lock/i);
    });
  });

  describe('FR-102 challenge token hardening (FU-BE-27)', () => {
    const post = (path: string, body: Record<string, string>): request.Test =>
      request(app.getHttpServer()).post(`${API}/${path}`).send(body);

    it('TC-003: a challenge is single use; reuse after a successful verify is refused even with a valid code', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      await post('2fa/verify', { challengeToken, code: authenticator.generate(secret) }).expect(
        200,
      );
      const reuse = await post('2fa/verify', {
        challengeToken,
        code: authenticator.generate(secret),
      }).expect(401);
      expect(reuse.headers['set-cookie']).toBeUndefined();
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(1);
    });

    it('TC-003: two parallel verifies with one challenge mint only one session', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const code = authenticator.generate(secret);
      const results = await Promise.all([
        post('2fa/verify', { challengeToken, code }),
        post('2fa/verify', { challengeToken, code }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(1);
    });

    it('TC-003: a challenge issued before a password reset is refused afterwards', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const withTotp = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const verifyChallenge = ((await login(withTotp.email).expect(200)).body as Body)
        .challengeToken;

      for (const u of [withTotp]) {
        // Seed a reset token directly so this test does not spend the per-IP forgot budget.
        const token = `reset-token-${u.id}-padding-padding`;
        await prisma.user.update({
          where: { id: u.id },
          data: {
            setPasswordTokenHash: sha256Hex(token),
            setPasswordExpiresAt: new Date(Date.now() + 600_000),
          },
        });
        await request(app.getHttpServer())
          .post(`${API}/password/reset`)
          .send({ token, newPassword: 'A-Brand-New-Passphrase-1' })
          .expect(204);
      }

      await post('2fa/verify', {
        challengeToken: verifyChallenge,
        code: authenticator.generate(secret),
      }).expect(401);
    });

    it('TC-003: an access token is refused as a challenge', async () => {
      const u = await createUser();
      const { session } = (await login(u.email).expect(200)).body as Body;
      await post('2fa/verify', { challengeToken: session.accessToken, code: '123456' }).expect(401);
    });

    it('FR-102: a wrong code does not burn the challenge; the right one still works once', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      await post('2fa/verify', { challengeToken, code: '000000' }).expect(400);
      await post('2fa/verify', { challengeToken, code: authenticator.generate(secret) }).expect(
        200,
      );
    });
  });

  /** Signed-in setup (ADR 0011): password sign-in, then setup/start. Returns the token and the new secret. */
  async function startSetup(
    email: string,
  ): Promise<{ auth: { Authorization: string }; key: string }> {
    const session = (await login(email).expect(200)).body as Body;
    const auth = { Authorization: `Bearer ${session.session.accessToken}` };
    const start = (
      await request(app.getHttpServer())
        .post(`${API}/2fa/setup/start`)
        .set(auth)
        .send({ currentPassword: PASSWORD })
        .expect(200)
    ).body as Body;
    return { auth, key: start.manualKey };
  }

  describe('FR-102 TOTP replay protection (FU-BE-20)', () => {
    const verify2fa = (challengeToken: string, code: string): request.Test =>
      request(app.getHttpServer()).post(`${API}/2fa/verify`).send({ challengeToken, code });

    it('TC-003: a TOTP code is accepted once; replaying it with a fresh challenge is refused', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const code = authenticator.generate(secret);
      const first = ((await login(u.email).expect(200)).body as Body).challengeToken;
      await verify2fa(first, code).expect(200);
      const second = ((await login(u.email).expect(200)).body as Body).challengeToken;
      const replay = await verify2fa(second, code).expect(400);
      expect(replay.headers['set-cookie']).toBeUndefined();
    });

    it('TC-003: replaying the code that confirmed enrollment is refused at login', async () => {
      const u = await createUser({ role: UserRole.SUPER_ADMIN });
      const { auth, key } = await startSetup(u.email);
      const code = authenticator.generate(key);
      await request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set(auth)
        .send({ currentPassword: PASSWORD, code })
        .expect(200);
      const next = ((await login(u.email).expect(200)).body as Body).challengeToken;
      await verify2fa(next, code).expect(400);
    });

    function failRedisSet(prefix: string): jest.SpyInstance {
      const redis = app.get<import('ioredis').Redis>(
        jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
          '../infrastructure/infrastructure.module',
        ).REDIS_CLIENT,
      );
      const realSet = redis.set.bind(redis) as (...args: unknown[]) => Promise<unknown>;
      return jest
        .spyOn(redis, 'set')
        .mockImplementation(((...args: unknown[]) =>
          String(args[0]).startsWith(prefix)
            ? Promise.reject(new Error('redis down'))
            : realSet(...args)) as unknown as typeof redis.set);
    }

    it('TC-003: when Redis is unavailable a valid code is refused with a fixed 503, the attempt is not counted and the challenge still works afterwards (fail closed)', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const setSpy = failRedisSet('auth:totp:used:');
      try {
        for (let i = 0; i < 7; i++) {
          const res = await verify2fa(challengeToken, authenticator.generate(secret)).expect(503);
          expect((res.body as Body).detail).toBe('Verification is temporarily unavailable.');
          expect(res.headers['set-cookie']).toBeUndefined();
        }
      } finally {
        setSpy.mockRestore();
      }
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(0);
      expect(row.lockedUntil).toBeNull();
      await verify2fa(challengeToken, authenticator.generate(secret)).expect(200);
    });

    it('TC-003: when Redis is unavailable the challenge claim fails closed with a 503 and reserves nothing', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const setSpy = failRedisSet('auth:challenge:used:');
      try {
        const res = await verify2fa(challengeToken, authenticator.generate(secret)).expect(503);
        expect((res.body as Body).detail).toBe('Verification is temporarily unavailable.');
        expect(res.headers['set-cookie']).toBeUndefined();
      } finally {
        setSpy.mockRestore();
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
      await verify2fa(challengeToken, authenticator.generate(secret)).expect(200);
    });

    it('TC-003: an enrollment race that finds TOTP already on is a 409 and gives the attempt back (FR-102)', async () => {
      const u = await createUser({ role: UserRole.SUPER_ADMIN });
      const { auth, key } = await startSetup(u.email);
      // Another request switches TOTP on after this one loaded the user and checked the code.
      totpVerify.mockImplementationOnce(async () => {
        await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: true } });
        return true;
      });
      await request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set(auth)
        .send({ currentPassword: PASSWORD, code: authenticator.generate(key) })
        .expect(409);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(0);
      expect(row.recoveryCodeHashes).toEqual([]);
      expect(
        await prisma.auditLog.count({ where: { actorId: u.id, action: 'AUTH_TOTP_ENABLED' } }),
      ).toBe(0);
    });

    it('TC-003: a TOTP user who logs in with the right password many times still gets 2FA and is never locked (reservation refunded)', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      for (let i = 0; i < 8; i++) {
        expect(((await login(u.email).expect(200)).body as Body).status).toBe(
          'two_factor_required',
        );
      }
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.failedLogins).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });
  });

  // DL-37: lock contention is 503 + Retry-After and invites a retry. No TC id covers it in
  // docs/test-cases.md; names cite FR-101/102 and the decision id.
  describe('DL-37 (FR-101, FR-102): contention gives back only the attempt that failed for contention', () => {
    const lockError = (): Error => Object.assign(new Error('lock wait'), { code: '55P03' });
    const markExists = async (challengeToken: string): Promise<boolean> => {
      const { jti } = JSON.parse(
        Buffer.from(challengeToken.split('.')[1] ?? '', 'base64url').toString(),
      ) as { jti: string };
      const redis = app.get<import('ioredis').Redis>(
        jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
          '../infrastructure/infrastructure.module',
        ).REDIS_CLIENT,
      );
      return (await redis.exists(`auth:challenge:used:${jti}`)) === 1;
    };
    const failedLogins = async (id: string): Promise<number> =>
      (await prisma.user.findUniqueOrThrow({ where: { id } })).failedLogins;
    const registerFailureSpy = (): jest.SpyInstance =>
      jest.spyOn(
        authService as unknown as { registerFailure: () => Promise<void> },
        'registerFailure',
      );
    const verify2fa = (challengeToken: string, code: string): request.Test =>
      request(app.getHttpServer()).post(`${API}/2fa/verify`).send({ challengeToken, code });
    const RECOVERY = 'ABCDEFGHJKLMNPQR';
    const reviewerWithRecovery = async (): Promise<{ id: string; email: string }> => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      await prisma.user.update({
        where: { id: u.id },
        data: { recoveryCodeHashes: [sha256Hex(RECOVERY)] },
      });
      return u;
    };
    const startSessionSpy = (): jest.SpyInstance =>
      jest.spyOn(
        authService as unknown as { startSession: () => Promise<unknown> },
        'startSession',
      );

    it('FR-101: a right password whose session transaction hits contention is 503, keeps no failed attempt, and the retry signs in', async () => {
      const u = await createUser();
      const spy = startSessionSpy().mockRejectedValueOnce(lockError());
      try {
        const res = await login(u.email).expect(503);
        expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
        await login(u.email).expect(200);
      } finally {
        spy.mockRestore();
      }
    });

    // DL-42, FU-BE-197: a pool-wait timeout carries no SQLSTATE; it is refunded like the lock errors.
    const poolError = (): Error => new Error('timeout exceeded when trying to connect');

    it('FR-101, DL-42, FU-BE-197: a right password whose session open cannot get a pool connection is 503 BUSY, keeps no failed attempt, and the retry signs in', async () => {
      const u = await createUser();
      const spy = startSessionSpy().mockRejectedValueOnce(poolError());
      try {
        const res = await login(u.email).expect(503);
        expect(res.headers['retry-after']).toBe('2');
        expect((res.body as { code?: string }).code).toBe('BUSY');
        expect(await failedLogins(u.id)).toBe(0);
        await login(u.email).expect(200);
      } finally {
        spy.mockRestore();
      }
    });

    it('FR-102, DL-42, FU-BE-197: a right TOTP code whose session open cannot get a pool connection is 503, gives the attempt back and releases the challenge', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const spy = startSessionSpy().mockRejectedValueOnce(poolError());
      try {
        const res = await request(app.getHttpServer())
          .post(`${API}/2fa/verify`)
          .send({ challengeToken, code: authenticator.generate(secret) })
          .expect(503);
        expect((res.body as { code?: string }).code).toBe('BUSY');
        expect(await failedLogins(u.id)).toBe(0);
        expect(await markExists(challengeToken)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('FR-102, DL-42, FU-BE-197: a pool timeout thrown by the TOTP check gives the attempt back exactly once', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 2 } });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      totpVerify.mockRejectedValueOnce(poolError());
      await verify2fa(challengeToken, '123456').expect(503);
      expect(await failedLogins(u.id)).toBe(2);
    });

    it('FR-101, DL-42, FU-BE-197: a wrong password whose failure write hits a pool timeout is 503 and is still counted (wrong credentials are never refunded)', async () => {
      const u = await createUser();
      const fail = registerFailureSpy().mockRejectedValueOnce(poolError());
      try {
        const res = await login(u.email, 'not-the-password-at-all-1').expect(503);
        expect((res.body as { code?: string }).code).toBe('BUSY');
        expect(await failedLogins(u.id)).toBe(1);
      } finally {
        fail.mockRestore();
      }
    });

    it('FR-101, DL-42, FU-BE-197: under pool exhaustion a wrong-password login answers the same for an existing and an unknown account', async () => {
      const u = await createUser();
      const comparable = (res: request.Response): unknown => {
        const body = { ...(res.body as Record<string, unknown>), traceId: undefined };
        const { 'retry-after': retryAfter, 'content-type': contentType } = res.headers;
        return { status: res.status, body, retryAfter, contentType };
      };
      const seen: unknown[] = [];
      for (const email of [u.email, `nobody-${Date.now()}@example.com`]) {
        const fail = registerFailureSpy().mockRejectedValueOnce(poolError());
        try {
          seen.push(comparable(await login(email, 'not-the-password-at-all-1')));
        } finally {
          fail.mockRestore();
        }
      }
      expect(seen[0]).toEqual(seen[1]);
      expect(seen[0]).toMatchObject({ status: 503, retryAfter: '2', body: { code: 'BUSY' } });
    });

    it('FR-101: a wrong password still counts as a failed attempt (never refunded)', async () => {
      const u = await createUser();
      await login(u.email, 'not-the-password-at-all-1').expect(401);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(1);
    });

    it('FR-102: a right TOTP code whose session transaction hits contention is 503, gives the attempt back and releases the challenge', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const u = await createUser({ role: UserRole.REVIEWER, totp: secret });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const spy = startSessionSpy().mockRejectedValueOnce(lockError());
      try {
        const res = await request(app.getHttpServer())
          .post(`${API}/2fa/verify`)
          .send({ challengeToken, code: authenticator.generate(secret) })
          .expect(503);
        expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
        expect(await markExists(challengeToken)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('FR-102: contention thrown by the TOTP check gives the attempt back exactly once (no double refund)', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 2 } });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      totpVerify.mockRejectedValueOnce(lockError());
      await verify2fa(challengeToken, '123456').expect(503);
      expect(await failedLogins(u.id)).toBe(2);
    });

    it('FR-102: a wrong TOTP code is still counted when the failure write hits contention (no refund of a failed guess)', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      totpVerify.mockResolvedValueOnce(false);
      const fail = jest
        .spyOn(
          authService as unknown as { registerFailure: () => Promise<void> },
          'registerFailure',
        )
        .mockRejectedValueOnce(lockError());
      try {
        await request(app.getHttpServer())
          .post(`${API}/2fa/verify`)
          .send({ challengeToken, code: '000000' })
          .expect(503);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(1);
        expect(await markExists(challengeToken)).toBe(false);
      } finally {
        fail.mockRestore();
      }
    });

    it('FR-101: a wrong password whose failure write hits contention is 503 and is still counted', async () => {
      const u = await createUser();
      const fail = registerFailureSpy().mockRejectedValueOnce(lockError());
      try {
        const res = await login(u.email, 'not-the-password-at-all-1').expect(503);
        expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
        expect(await failedLogins(u.id)).toBe(1);
      } finally {
        fail.mockRestore();
      }
    });

    it('FR-102: a wrong recovery code whose failure write hits contention is 503, stays counted, keeps the code and releases the challenge', async () => {
      const u = await reviewerWithRecovery();
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const fail = registerFailureSpy().mockRejectedValueOnce(lockError());
      try {
        await verify2fa(challengeToken, 'STUVWXYZ23456723').expect(503);
        expect(await failedLogins(u.id)).toBe(1);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).recoveryCodeHashes,
        ).toEqual([sha256Hex(RECOVERY)]);
        expect(await markExists(challengeToken)).toBe(false);
      } finally {
        fail.mockRestore();
      }
    });

    it('FR-102: contention on the recovery-code consume UPDATE is 503, gives the attempt back and the code is still there', async () => {
      const u = await reviewerWithRecovery();
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const real = (
        authService as unknown as {
          raw: (r: string, f: () => Promise<unknown>) => Promise<unknown>;
        }
      ).raw.bind(authService);
      const raw = jest
        .spyOn(
          authService as unknown as {
            raw: (reason: string, run: () => Promise<unknown>) => Promise<unknown>;
          },
          'raw',
        )
        .mockImplementation((reason, run) =>
          reason.includes('consume one recovery code')
            ? Promise.reject(lockError())
            : real(reason, run),
        );
      try {
        await verify2fa(challengeToken, RECOVERY).expect(503);
        expect(await failedLogins(u.id)).toBe(0);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).recoveryCodeHashes,
        ).toEqual([sha256Hex(RECOVERY)]);
        expect(await markExists(challengeToken)).toBe(false);
      } finally {
        raw.mockRestore();
      }
    });

    it('FR-102: a right recovery code whose session open hits contention is 503, refunds, restores the code, and the retry signs in', async () => {
      const u = await reviewerWithRecovery();
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const spy = startSessionSpy().mockRejectedValueOnce(lockError());
      try {
        await verify2fa(challengeToken, RECOVERY).expect(503);
        expect(await failedLogins(u.id)).toBe(0);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).recoveryCodeHashes,
        ).toEqual([sha256Hex(RECOVERY)]);
        await verify2fa(challengeToken, RECOVERY).expect(200);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // P-37 carve-out: a failed post-commit audit write on an auth route is only logged; the response
  // is the normal one, so no 500 can tell an existing account from an unknown one.
  describe('DL-37 (FR-101, FR-104): a failed post-commit audit write never changes an auth response', () => {
    const failAudit = (): jest.SpyInstance =>
      jest
        .spyOn(authService as unknown as { audit: () => Promise<void> }, 'audit')
        .mockRejectedValue(new Error('audit insert failed: secret-marker-9d2'));

    it('FR-101: the lockout audit failing leaves the 401 answers and the lock in place, and logs only the class name', async () => {
      const u = await createUser();
      const spy = failAudit();
      const from = logged.length;
      try {
        for (let i = 0; i < 5; i++) await login(u.email, `wrong-password-${i}`).expect(401);
        await login(u.email).expect(401);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.lockedUntil).not.toBeNull();
        const lines = logged.slice(from).join('');
        expect(lines).toContain('Audit write after commit failed (Error) for AUTH_ACCOUNT_LOCKED');
        expect(lines).not.toContain('secret-marker');
      } finally {
        spy.mockRestore();
      }
    });

    it('FR-101, DL-42, FU-BE-197: the lockout audit hitting a pool timeout leaves the 401 answers and the lock in place (no BUSY, no 500)', async () => {
      const u = await createUser();
      const spy = jest
        .spyOn(authService as unknown as { audit: () => Promise<void> }, 'audit')
        .mockRejectedValue(new Error('timeout exceeded when trying to connect'));
      const from = logged.length;
      try {
        for (let i = 0; i < 5; i++) await login(u.email, `wrong-password-${i}`).expect(401);
        const res = await login(u.email).expect(401);
        expect((res.body as { code?: string }).code).toBeUndefined();
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).lockedUntil,
        ).not.toBeNull();
        const lines = logged.slice(from).join('');
        expect(lines).toContain('Audit write after commit failed (Error) for AUTH_ACCOUNT_LOCKED');
        expect(lines).not.toContain('timeout exceeded');
      } finally {
        spy.mockRestore();
      }
    });

    it('FR-104: refresh reuse with a failing audit write is still the 401 and the family is revoked', async () => {
      const u = await createUser();
      const cookie1 = refreshCookie(await login(u.email).expect(200));
      const cookie2 = refreshCookie(await refresh(cookie1).expect(200));
      const spy = failAudit();
      try {
        await refresh(cookie1).expect(401);
        await refresh(cookie2).expect(401);
        const rows = await prisma.refreshToken.findMany({ where: { userId: u.id } });
        expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('FR-104: logout with a failing audit write is still 204 and revokes the family', async () => {
      const u = await createUser();
      const cookie = refreshCookie(await login(u.email).expect(200));
      const spy = failAudit();
      try {
        await request(app.getHttpServer()).post(`${API}/logout`).set('Cookie', cookie).expect(204);
        const rows = await prisma.refreshToken.findMany({ where: { userId: u.id } });
        expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('FR-104 access token re-check (FU-BE-19)', () => {
    const setupStart = (accessToken: string): request.Test =>
      request(app.getHttpServer())
        .post(`${API}/2fa/setup/start`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD });

    it("FR-104: a deactivated user's unexpired access token is refused at once", async () => {
      const u = await createUser();
      const { session } = (await login(u.email).expect(200)).body as Body;
      await setupStart(session.accessToken).expect(200);
      await prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
      await setupStart(session.accessToken).expect(401);
    });

    it('FR-104: an access token is refused after a role change', async () => {
      const u = await createUser();
      const { session } = (await login(u.email).expect(200)).body as Body;
      await prisma.user.update({ where: { id: u.id }, data: { role: UserRole.SUPER_ADMIN } });
      await setupStart(session.accessToken).expect(401);
    });

    it('FR-104: an access token is refused after a password reset', async () => {
      const u = await createUser();
      const { session } = (await login(u.email).expect(200)).body as Body;
      const token = `reset-token-${u.id}-padding-padding`;
      await prisma.user.update({
        where: { id: u.id },
        data: {
          setPasswordTokenHash: sha256Hex(token),
          setPasswordExpiresAt: new Date(Date.now() + 600_000),
        },
      });
      await request(app.getHttpServer())
        .post(`${API}/password/reset`)
        .send({ token, newPassword: 'A-Brand-New-Passphrase-1' })
        .expect(204);
      await setupStart(session.accessToken).expect(401);
    });

    it('FR-104: an access token for a deleted user id is refused', async () => {
      const { TokenService: Tokens } = jest.requireActual<
        typeof import('../common/auth/token.service')
      >('../common/auth/token.service');
      const forged = app.get(Tokens).sign(
        {
          sub: '11111111-1111-4111-8111-111111111111',
          org: orgId,
          role: 'RECRUITER',
          kind: 'access',
          pwv: 'x',
        },
        60,
      );
      await setupStart(forged).expect(401);
    });
  });

  describe('FR-102: totpEnabled on the session user', () => {
    type UserBody = { user: { totpEnabled?: boolean } };
    const SECRET = 'JBSWY3DPEHPK3PXP';

    it('FR-102: login without 2FA reports totpEnabled false, and refresh keeps reporting the real state', async () => {
      const u = await createUser();
      const res = await login(u.email).expect(200);
      expect((res.body as Body).session.user).toMatchObject({ totpEnabled: false });
      const next = await refresh(refreshCookie(res)).expect(200);
      expect((next.body as UserBody).user.totpEnabled).toBe(false);
    });

    it('FR-102: 2fa/verify reports true; after 2FA is disabled the refresh is refused and the next login reports false', async () => {
      const u = await createUser({ totp: SECRET });
      const first = (await login(u.email).expect(200)).body as Body;
      // The previous step's code, so the current step stays unused for the disable call.
      const previous = authenticator.clone({ epoch: Date.now() - 30_000 }).generate(SECRET);
      const verified = await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken: first.challengeToken, code: previous })
        .expect(200);
      expect((verified.body as UserBody).user.totpEnabled).toBe(true);
      const cookie = refreshCookie(verified);
      const same = await refresh(cookie).expect(200);
      expect((same.body as UserBody).user.totpEnabled).toBe(true);

      await request(app.getHttpServer())
        .post(`${API}/2fa/disable`)
        .set('Authorization', `Bearer ${(same.body as Body).accessToken}`)
        .send({ currentPassword: PASSWORD, totpCode: authenticator.generate(SECRET) })
        .expect(204);
      // Disable signs the user out everywhere.
      await refresh(refreshCookie(same)).expect(401);
      const again = (await login(u.email).expect(200)).body as Body;
      expect(again.status).toBe('authenticated');
      expect(again.session.user).toMatchObject({ totpEnabled: false });
    });

    it('FR-102: totpEnabled is not in the access token claims', async () => {
      const u = await createUser();
      const body = (await login(u.email).expect(200)).body as Body;
      const claims = JSON.parse(
        Buffer.from(body.session.accessToken.split('.')[1] ?? '', 'base64url').toString(),
      ) as Record<string, unknown>;
      expect(Object.keys(claims).join(',')).not.toMatch(/totp|twoFactor/i);
    });

    it("NFR-04: the running app's logger redacts secret fields (proves LOG_REDACT is wired into the live pinoHttp config)", () => {
      const { Logger } = jest.requireActual<typeof import('nestjs-pino')>('nestjs-pino');
      const live = app.get(Logger);
      logged.length = 0;
      live.log(
        {
          // The request serializer needs a url; it drops the body, so the body is also probed bare.
          req: { id: 'probe-req', method: 'POST', url: '/probe' },
          body: { password: 'ProbeX-11aa', nested: { totpCode: 'ProbeY-22bb' } },
          wrapper: { a: { b: { secret: 'ProbeZ-33cc', otpauthUri: 'ProbeW-44dd' } } },
        },
        'live-logger-probe',
      );
      const output = logged.join('');
      expect(output).toContain('live-logger-probe');
      expect(output).toContain('[Redacted]');
      for (const probe of ['ProbeX-11aa', 'ProbeY-22bb', 'ProbeZ-33cc', 'ProbeW-44dd']) {
        expect(output).not.toContain(probe);
      }
    });

    it('NFR-04: the request serializer keeps bodies and headers out of the request logs (probes sent to login, reset, disable and verify)', async () => {
      const probes = {
        password: 'ProbePassword-91ab',
        currentPassword: 'ProbeCurrent-82cd',
        newPassword: 'ProbeNewPass-73ef',
        code: 'ProbeCode-64aa',
        totpCode: 'ProbeTotp-55bb',
        token: 'ProbeToken-46cc',
        challengeToken: 'ProbeChallenge-37dd',
      };
      const u = await createUser({ totp: SECRET });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      logged.length = 0;
      const auth = { Authorization: `Bearer ${challengeToken}` };
      const statuses = [
        (await login(u.email, probes.password)).status,
        (
          await request(app.getHttpServer()).post(`${API}/password/reset`).send({
            token: probes.token,
            newPassword: probes.newPassword,
          })
        ).status,
        (
          await request(app.getHttpServer())
            .post(`${API}/2fa/disable`)
            .set(auth)
            .send({ currentPassword: probes.currentPassword, totpCode: probes.totpCode })
        ).status,
        (
          await request(app.getHttpServer())
            .post(`${API}/2fa/verify`)
            .send({ challengeToken: probes.challengeToken, code: probes.code })
        ).status,
      ];
      expect(statuses).toEqual(EXPECTED_STATUSES);
      const output = logged.join('');
      for (const path of ['/auth/login', '/password/reset', '/2fa/disable', '/2fa/verify']) {
        expect(output).toContain(path);
      }
      for (const value of Object.values(probes)) expect(output).not.toContain(value);
    });

    it('NFR-04: real response secrets (refresh cookie, access token, manualKey, otpauthUri) never appear in the logs', async () => {
      const u = await createUser();
      logged.length = 0;
      const res = await login(u.email).expect(200);
      const cookieValue = refreshCookie(res).split('=')[1] ?? '';
      const accessToken = (res.body as Body).session.accessToken;
      const start = (
        await request(app.getHttpServer())
          .post(`${API}/2fa/setup/start`)
          .set({ Authorization: `Bearer ${accessToken}` })
          .send({ currentPassword: PASSWORD })
          .expect(200)
      ).body as Body;
      const secrets = [cookieValue, accessToken, start.manualKey, start.otpauthUri];
      for (const value of secrets) expect(value.length).toBeGreaterThan(10);
      const output = logged.join('');
      expect(output).toContain('/auth/login');
      for (const value of secrets) expect(output).not.toContain(value);
    });

    it('FR-102: after setup/confirm the very next refresh reports totpEnabled true', async () => {
      const u = await createUser();
      const res = await login(u.email).expect(200);
      const auth = { Authorization: `Bearer ${(res.body as Body).session.accessToken}` };
      const start = (
        await request(app.getHttpServer())
          .post(`${API}/2fa/setup/start`)
          .set(auth)
          .send({ currentPassword: PASSWORD })
          .expect(200)
      ).body as Body;
      await request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set(auth)
        .send({ currentPassword: PASSWORD, code: authenticator.generate(start.manualKey) })
        .expect(200);
      const again = await refresh(refreshCookie(res)).expect(200);
      expect((again.body as UserBody).user.totpEnabled).toBe(true);
    });

    it('FR-102: challenge and failed responses carry no session user and no totpEnabled', async () => {
      const withTotp = await createUser({ totp: SECRET });
      const required = await login(withTotp.email).expect(200);
      const wrong = await login(withTotp.email, 'wrong-password-1').expect(401);
      const badCode = await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken: (required.body as Body).challengeToken, code: 'ZZZZZZZZZZZZZZZZ' })
        .expect(400);
      for (const res of [required, wrong, badCode]) {
        expect(JSON.stringify(res.body)).not.toContain('totpEnabled');
      }
      expect((required.body as Body).session).toBeUndefined();
    });

    it('FR-102: totpEnabled is read-only; sending it in a request body is refused with 400', async () => {
      const u = await createUser();
      await request(app.getHttpServer())
        .post(`${API}/login`)
        .send({ email: u.email, password: PASSWORD, totpEnabled: true })
        .expect(400);
      const session = (await login(u.email).expect(200)).body as Body;
      const t = await createUser({ totp: SECRET });
      const { challengeToken } = (await login(t.email).expect(200)).body as Body;
      const refused = await request(app.getHttpServer())
        .post(`${API}/2fa/verify`)
        .send({ challengeToken, code: '123456', totpEnabled: true })
        .expect(400);
      expect(JSON.stringify(refused.body)).toContain('totpEnabled');
      const setupRefused = await request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set('Authorization', `Bearer ${session.session.accessToken}`)
        .send({ currentPassword: PASSWORD, code: '123456', totpEnabled: true })
        .expect(400);
      expect(JSON.stringify(setupRefused.body)).toContain('totpEnabled');
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

    it('FR-104, TC-005, FU-BE-207: a cookieless POST /logout is 204 and sets no cp_refresh cookie', async () => {
      const res = await request(app.getHttpServer()).post(`${API}/logout`).expect(204);
      expect(String(res.headers['set-cookie'] ?? '')).not.toContain('cp_refresh=');
    });

    it('FR-104, TC-005, FU-BE-207: logout with a tampered signed cookie is 204, still clears cp_refresh, and revokes nothing', async () => {
      const u = await createUser();
      await login(u.email).expect(200);
      const live = (): Promise<number> =>
        prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } });
      expect(await live()).toBe(1);
      const res = await request(app.getHttpServer())
        .post(`${API}/logout`)
        .set('Cookie', 'cp_refresh=s%3Anot-a-valid-signature.AAAA')
        .expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(/cp_refresh=;/);
      expect(await live()).toBe(1);
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

    // The per-IP budget is shared by every test in this file; start the rate-limit test fresh.
    async function resetForgotBudget(): Promise<void> {
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      const keys = await redis.keys('pwreset:*');
      if (keys.length > 0) await redis.del(...keys);
    }

    // Every test starts with an empty forgot budget, so none depends on earlier forgot calls (FU-BE-28).
    beforeEach(resetForgotBudget);

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
      await authService.settleDeferred();
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
      await authService.settleDeferred();
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
      await authService.settleDeferred();
      expect(mails).toHaveLength(0);
    });

    it('TC-098: a pending invite gets the same 202 but no email, and its invite token is untouched (FU-BE-32)', async () => {
      const pending = await createUser({ password: null });
      const before = await prisma.user.findUniqueOrThrow({ where: { id: pending.id } });
      mails.length = 0;
      const res = await forgot(pending.email).expect(202);
      const unknown = await forgot('nobody-pending@example.com').expect(202);
      await authService.settleDeferred();
      expect(res.body).toEqual(unknown.body);
      expect(mails).toHaveLength(0);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: pending.id } });
      expect(after.setPasswordTokenHash).toBe(before.setPasswordTokenHash);
      expect(after.setPasswordExpiresAt).toEqual(before.setPasswordExpiresAt);
      expect(after.passwordHash).toBeNull();
    });

    it('TC-098: the awaited work of forgot-password is identical for real, pending, deactivated and unknown accounts; the reset is sent only afterwards, and only for a real one (FU-BE-31)', async () => {
      const real = await createUser();
      const pending = await createUser({ password: null });
      const inactive = await createUser();
      await prisma.user.update({ where: { id: inactive.id }, data: { isActive: false } });
      const { PrismaService: PrismaSvc } = jest.requireActual<
        typeof import('../database/prisma.service')
      >('../database/prisma.service');
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const appPrisma = app.get(PrismaSvc).client;
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      const findSpy = jest.spyOn(appPrisma.user, 'findUnique');
      const writeSpy = jest.spyOn(appPrisma.user, 'update');
      const writeManySpy = jest.spyOn(appPrisma.user, 'updateMany');
      const evalSpy = jest.spyOn(redis, 'eval');
      const sendSpy = jest.spyOn(fakeMail, 'sendPasswordReset');
      const ctx = { ip: '203.0.113.50' };
      const awaited: Record<string, number[]> = {};
      try {
        await resetForgotBudget();
        for (const [name, email] of [
          ['real', real.email],
          ['pending', pending.email],
          ['inactive', inactive.email],
          ['unknown', 'nobody-equal-work@example.com'],
        ] as const) {
          for (const spy of [findSpy, writeSpy, writeManySpy, evalSpy, sendSpy]) spy.mockClear();
          await authService.forgotPassword(email, ctx);
          // Measured the moment the awaited work is done: no account-dependent call yet.
          awaited[name] = [findSpy, writeSpy, writeManySpy, evalSpy, sendSpy].map(
            (spy) => spy.mock.calls.length,
          );
          await authService.settleDeferred();
          if (name === 'real') {
            expect(findSpy).toHaveBeenCalledTimes(1);
            expect(writeSpy).toHaveBeenCalledTimes(1);
            expect(sendSpy).toHaveBeenCalledTimes(1);
          } else {
            expect(writeSpy).not.toHaveBeenCalled();
            expect(sendSpy).not.toHaveBeenCalled();
          }
        }
      } finally {
        for (const spy of [findSpy, writeSpy, writeManySpy, evalSpy, sendSpy]) spy.mockRestore();
      }
      expect(awaited.real).toEqual([0, 0, 0, 2, 0]);
      expect(awaited.pending).toEqual(awaited.real);
      expect(awaited.inactive).toEqual(awaited.real);
      expect(awaited.unknown).toEqual(awaited.real);
    });

    it('TC-098: a failure in the deferred reset work is swallowed and logs neither the email nor a token', async () => {
      const u = await createUser();
      const failing = jest
        .spyOn(fakeMail, 'sendPasswordReset')
        .mockRejectedValue(new Error(`smtp refused ${u.email}`));
      logged.length = 0;
      try {
        await authService.forgotPassword(u.email, { ip: '203.0.113.51' });
        await authService.settleDeferred();
      } finally {
        failing.mockRestore();
      }
      expect(logged.join('')).toContain('Deferred password-reset work failed');
      expect(logged.join('')).not.toContain(u.email);
      expect(logged.join('')).not.toContain('#token=');
    });

    it('TC-098: requests are rate limited per email (silently) and per IP (429)', async () => {
      const u = await createUser();
      await resetForgotBudget();
      mails.length = 0;
      for (let i = 0; i < 6; i++) await forgot(u.email).expect(202);
      await authService.settleDeferred();
      expect(mails).toHaveLength(3);
      // Per IP: the budget is 10 per hour across all emails.
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await forgot(`ip-limit-${i}@example.com`)).status);
      expect(statuses).toContain(429);
    });

    it('TC-098 (FU-BE-64): a forgot counter that has no TTL is repaired by the next hit, and limits stay exact', async () => {
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      const ip = '198.51.100.9';
      const email = 'ttl-repair@example.com';
      const emailKey = `pwreset:email:${sha256Hex(email)}`;
      // Counters left without an expiry, as a connection drop between INCR and EXPIRE did.
      await redis.set(`pwreset:ip:${ip}`, '2');
      await redis.set(emailKey, '2');
      mails.length = 0;
      await authService.forgotPassword(email, { ip });
      await authService.settleDeferred();
      for (const key of [`pwreset:ip:${ip}`, emailKey]) {
        const ttl = await redis.ttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(3600);
      }
      expect(await redis.get(`pwreset:ip:${ip}`)).toBe('3');
      expect(await redis.get(emailKey)).toBe('3');
      // Parallel hits are counted exactly.
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          authService.forgotPassword(`parallel-${i}@example.com`, { ip }),
        ),
      );
      await authService.settleDeferred();
      expect(await redis.get(`pwreset:ip:${ip}`)).toBe('8');
    });

    it('TC-098: a short or malformed reset payload is a 400 validation error', async () => {
      await request(app.getHttpServer())
        .post(`${API}/password/reset`)
        .send({ token: 'x'.repeat(30), newPassword: 'short' })
        .expect(400);
    });
  });

  describe('FR-104 / FR-107: a password reset racing a sign-in', () => {
    const NEW_PASSWORD = 'A-Brand-New-Passphrase-1';
    const post = (path: string, body: object): request.Test =>
      request(app.getHttpServer()).post(`${API}/${path}`).send(body);

    async function resetPasswordOf(userId: string): Promise<void> {
      const token = `race-reset-${userId}-padding-padding`;
      await prisma.user.update({
        where: { id: userId },
        data: {
          setPasswordTokenHash: sha256Hex(token),
          setPasswordExpiresAt: new Date(Date.now() + 600_000),
        },
      });
      await request(app.getHttpServer())
        .post(`${API}/password/reset`)
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(204);
    }

    function makeGate(): { wait: Promise<void>; open: () => void } {
      let open: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    }

    async function until(cond: () => boolean): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error('condition not reached');
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it('TC-001: a login whose password check overlaps a reset is refused with no cookie and no refresh token (FR-104, FR-107)', async () => {
      const u = await createUser();
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      const gate = makeGate();
      passwordVerify.mockImplementation(async (hash: string, password: string) => {
        const ok = await realPasswordVerify(hash, password);
        if (hash === stored.passwordHash) await gate.wait;
        return ok;
      });
      const inFlight: Promise<request.Response>[] = [];
      try {
        inFlight.push(login(u.email).then((r) => r));
        await until(() =>
          passwordVerify.mock.calls.some((c: unknown[]) => c[0] === stored.passwordHash),
        );
        await resetPasswordOf(u.id);
        gate.open();
        const res = await inFlight[0];
        expect(res?.status).toBe(401);
        expect(res?.headers['set-cookie']).toBeUndefined();
      } finally {
        gate.open();
        await Promise.allSettled(inFlight);
        passwordVerify.mockImplementation(realPasswordVerify);
      }
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(0);
      // The password was right when checked: the reserved attempt is given back.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
    });

    it('TC-003: a 2FA completion that overlaps a reset is refused with no cookie and no refresh token (FR-102, FR-104)', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const gate = makeGate();
      let reached = false;
      totpVerify.mockImplementationOnce(async () => {
        reached = true;
        await gate.wait;
        return true;
      });
      const inFlight: Promise<request.Response>[] = [];
      try {
        inFlight.push(post('2fa/verify', { challengeToken, code: '123456' }).then((r) => r));
        await until(() => reached);
        await resetPasswordOf(u.id);
        gate.open();
        const res = await inFlight[0];
        expect(res?.status).toBe(401);
        expect(res?.headers['set-cookie']).toBeUndefined();
      } finally {
        gate.open();
        await Promise.allSettled(inFlight);
      }
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
    });

    it('TC-003: enrolment is refused with a 409 and the attempt refunded when the secret changed after the code was checked (FR-102)', async () => {
      const u = await createUser({ role: UserRole.SUPER_ADMIN });
      const { auth } = await startSetup(u.email);
      totpVerify.mockImplementationOnce(async () => {
        await prisma.user.update({
          where: { id: u.id },
          data: { totpSecretEnc: 'changed-secret' },
        });
        return true;
      });
      await request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set(auth)
        .send({ currentPassword: PASSWORD, code: '123456' })
        .expect(409);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.totpEnabled).toBe(false);
      expect(row.failedLogins).toBe(0);
      expect(row.recoveryCodeHashes).toEqual([]);
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(1);
    });

    // ---- uncommitted-reset interleavings (READ COMMITTED), driven by row locks -----------------

    /** True once some backend is waiting on a lock (the statement under test is blocked). */
    async function lockWaiters(): Promise<number> {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      return Number(rows[0]?.n ?? 0);
    }

    async function untilLockWaiter(): Promise<void> {
      const deadline = Date.now() + 10_000;
      while ((await lockWaiters()) === 0) {
        if (Date.now() > deadline) throw new Error('no statement is waiting on a lock');
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    /**
     * A reset as the real one runs it, held open: new password, then revoke-all, then wait for the
     * commit signal. Nothing is visible to other sessions until commit().
     */
    async function openReset(userId: string): Promise<{
      updated: Promise<void>;
      commit: () => void;
      done: Promise<void>;
    }> {
      const newHash = await hash(NEW_PASSWORD, ARGON2_OPTIONS);
      const commitGate = makeGate();
      let ready: () => void = () => undefined;
      const updated = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const done = prisma.$transaction(
        async (tx) => {
          await tx.user.update({ where: { id: userId }, data: { passwordHash: newHash } });
          await tx.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          ready();
          await commitGate.wait;
        },
        { timeout: 30_000 },
      );
      return { updated, commit: commitGate.open, done };
    }

    const liveTokens = (userId: string): Promise<number> =>
      prisma.refreshToken.count({ where: { userId, revokedAt: null } });

    type TxFn = (cb: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
    function serviceClient(): { $transaction: TxFn } {
      return (authService as unknown as { prisma: { client: { $transaction: TxFn } } }).prisma
        .client;
    }

    it('TC-098: a login whose session insert meets an uncommitted reset waits, is refused, and leaves no live refresh token (FR-104, FR-107)', async () => {
      const u = await createUser();
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      const gate = makeGate();
      passwordVerify.mockImplementation(async (h: string, password: string) => {
        const ok = await realPasswordVerify(h, password);
        if (h === stored.passwordHash) await gate.wait;
        return ok;
      });
      let reset: Awaited<ReturnType<typeof openReset>> | undefined;
      try {
        const inFlight = login(u.email).then((r) => r);
        await until(() =>
          passwordVerify.mock.calls.some((c: unknown[]) => c[0] === stored.passwordHash),
        );
        reset = await openReset(u.id);
        await reset.updated;
        gate.open();
        // With FOR SHARE the insert blocks on the reset's row lock; without it, it would finish
        // at once and leave a live token the reset never saw.
        await Promise.race([inFlight, untilLockWaiter()]);
        reset.commit();
        await reset.done;
        const res = await inFlight;
        expect(res.status).toBe(401);
        expect(res.headers['set-cookie']).toBeUndefined();
      } finally {
        gate.open();
        reset?.commit();
        await reset?.done.catch(() => undefined);
        passwordVerify.mockImplementation(realPasswordVerify);
      }
      expect(await liveTokens(u.id)).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
    });

    it('TC-003: a 2FA verify whose session insert meets an uncommitted reset waits, is refused, and leaves no live refresh token (FR-102, FR-104)', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const gate = makeGate();
      let reached = false;
      totpVerify.mockImplementationOnce(async () => {
        reached = true;
        await gate.wait;
        return true;
      });
      let reset: Awaited<ReturnType<typeof openReset>> | undefined;
      try {
        const inFlight = post('2fa/verify', { challengeToken, code: '123456' }).then((r) => r);
        await until(() => reached);
        reset = await openReset(u.id);
        await reset.updated;
        gate.open();
        await Promise.race([inFlight, untilLockWaiter()]);
        reset.commit();
        await reset.done;
        const res = await inFlight;
        expect(res.status).toBe(401);
        expect(res.headers['set-cookie']).toBeUndefined();
      } finally {
        gate.open();
        reset?.commit();
        await reset?.done.catch(() => undefined);
      }
      expect(await liveTokens(u.id)).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
    });

    it('TC-098: a refresh that meets an uncommitted reset is refused and leaves no live refresh token (FR-104, FR-107)', async () => {
      // Safe with or without FOR SHARE (the old row's lock also catches it); kept as the plain
      // refused-refresh case. The rotation-first order below is the one FOR SHARE decides.
      const u = await createUser();
      const cookie = refreshCookie(await login(u.email).expect(200));
      const reset = await openReset(u.id);
      await reset.updated;
      const inFlight = refresh(cookie).then((r) => r);
      try {
        await Promise.race([inFlight, untilLockWaiter()]);
      } finally {
        reset.commit();
        await reset.done;
      }
      expect((await inFlight).status).toBe(401);
      expect(await liveTokens(u.id)).toBe(0);
    });

    it('TC-098: a refresh rotation that is mid-transaction when the reset arrives is waited for, and the reset revokes the rotated token (FR-104, FR-107)', async () => {
      const u = await createUser();
      const cookie = refreshCookie(await login(u.email).expect(200));
      const token = `rotation-reset-${u.id}-padding-padding`;
      await prisma.user.update({
        where: { id: u.id },
        data: {
          setPasswordTokenHash: sha256Hex(token),
          setPasswordExpiresAt: new Date(Date.now() + 600_000),
        },
      });
      const client = serviceClient();
      const original = client.$transaction.bind(client);
      const release = makeGate();
      let paused = false;
      const spy = jest.spyOn(client, '$transaction').mockImplementationOnce((cb, opts) =>
        original(async (tx) => {
          const result = await cb(tx);
          // Token inserted and old row flipped, nothing committed yet.
          paused = true;
          await release.wait;
          return result;
        }, opts),
      );
      try {
        const rotation = refresh(cookie).then((r) => r);
        await until(() => paused);
        const resetting = request(app.getHttpServer())
          .post(`${API}/password/reset`)
          .send({ token, newPassword: NEW_PASSWORD })
          .then((r) => r);
        // The reset is stuck behind the rotation's lock (FOR SHARE on the user row, or, without
        // it, the flipped old row).
        await untilLockWaiter();
        release.open();
        expect((await rotation).status).toBe(200);
        expect((await resetting).status).toBe(204);
      } finally {
        release.open();
        spy.mockRestore();
      }
      expect(await liveTokens(u.id)).toBe(0);
    });

    it('TC-098: a refresh rotation that is mid-transaction when a non-key password update and revoke-all arrive is waited for, and the rotated token is revoked (FR-104, FR-107)', async () => {
      const u = await createUser();
      const cookie = refreshCookie(await login(u.email).expect(200));
      const client = serviceClient();
      const original = client.$transaction.bind(client);
      const release = makeGate();
      let paused = false;
      const spy = jest.spyOn(client, '$transaction').mockImplementationOnce((cb, opts) =>
        original(async (tx) => {
          const result = await cb(tx);
          // Token inserted and old row flipped, nothing committed yet.
          paused = true;
          await release.wait;
          return result;
        }, opts),
      );
      try {
        const rotation = refresh(cookie).then((r) => r);
        await until(() => paused);
        // Only non-key columns change here (the real route also clears an indexed column, whose
        // lock the insert's foreign key already conflicts with). Without FOR SHARE the UPDATE
        // passes and the revoke-all cannot see the uncommitted rotated token.
        const reset = await openReset(u.id);
        reset.commit();
        await untilLockWaiter();
        release.open();
        expect((await rotation).status).toBe(200);
        await reset.done;
      } finally {
        release.open();
        spy.mockRestore();
      }
      expect(await liveTokens(u.id)).toBe(0);
    });

    it('TC-003: a recovery-code login refused because the password changed puts the code back and refunds the attempt (FR-102, FR-104)', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: 'JBSWY3DPEHPK3PXP' });
      const code = 'ABCDEFGHJKLMNPQR';
      const other = 'STUVWXYZ23456723';
      const hashes = [sha256Hex(code), sha256Hex(other)];
      await prisma.user.update({ where: { id: u.id }, data: { recoveryCodeHashes: hashes } });
      const { challengeToken } = (await login(u.email).expect(200)).body as Body;
      const client = serviceClient();
      const original = client.$transaction.bind(client);
      // The reset lands after the challenge checks and before the session transaction starts.
      const spy = jest.spyOn(client, '$transaction').mockImplementationOnce(async (cb, opts) => {
        await resetPasswordOf(u.id);
        return original(cb, opts);
      });
      let res: request.Response;
      try {
        res = await post('2fa/verify', { challengeToken, code });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect([...row.recoveryCodeHashes].sort()).toEqual([...hashes].sort());
      expect(row.failedLogins).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: { actorId: u.id, action: 'AUTH_RECOVERY_CODE_USED' },
        }),
      ).toBe(0);
    });

    it('TC-098: forgot-password logs a fixed warning, without the email, when the limiter store is down', async () => {
      const u = await createUser();
      const redis = app.get<import('ioredis').Redis>(
        jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
          '../infrastructure/infrastructure.module',
        ).REDIS_CLIENT,
      );
      const evalSpy = jest.spyOn(redis, 'eval').mockRejectedValue(new Error(`down ${u.email}`));
      logged.length = 0;
      try {
        await authService.forgotPassword(u.email, { ip: '203.0.113.77' });
        await authService.settleDeferred();
      } finally {
        evalSpy.mockRestore();
      }
      expect(logged.join('')).toContain('reset limiter unavailable');
      expect(logged.join('')).not.toContain(u.email);
    });
  });

  describe('FR-102 / FR-104: manage 2FA while signed in, and admin reset (BE-02 addendum)', () => {
    const SECRET = 'JBSWY3DPEHPK3PXP';
    const post = (path: string, token: string | null, body?: object): request.Test => {
      const r = request(app.getHttpServer()).post(`${API}/${path}`);
      if (token) r.set('Authorization', `Bearer ${token}`);
      return r.send(body ?? {});
    };

    /** An access token as login would mint it (a 2FA-required role cannot log in without TOTP). */
    async function accessFor(id: string): Promise<string> {
      const u = await prisma.user.findUniqueOrThrow({ where: { id } });
      return tokenService.sign(
        {
          sub: u.id,
          org: u.orgId,
          role: u.role,
          kind: 'access',
          pwv: passwordVersion(u.passwordHash ?? ''),
        },
        900,
      );
    }

    async function withRecoveryCodes(id: string, codes: string[]): Promise<void> {
      await prisma.user.update({
        where: { id },
        data: { recoveryCodeHashes: codes.map((c) => sha256Hex(c)) },
      });
    }

    /** The current TOTP code, and one that cannot be in the accepted window. */
    const goodCode = (): string => authenticator.generate(SECRET);
    const badCode = (): string =>
      authenticator.clone({ epoch: Date.now() + 10 * 60_000 }).generate(SECRET);

    /**
     * A real sign-in for a TOTP user with the previous step's code, so the current step stays
     * unused for the disable call. Returns the refresh cookie of the new family.
     */
    async function signInWithTotp(email: string): Promise<string> {
      const { challengeToken } = (await login(email).expect(200)).body as Body;
      const code = authenticator.clone({ epoch: Date.now() - 30_000 }).generate(SECRET);
      const res = await post('2fa/verify', null, { challengeToken, code }).expect(200);
      return refreshCookie(res);
    }

    const countCalls = async (run: () => Promise<unknown>): Promise<number[]> => {
      const { PrismaService: PrismaSvc } = jest.requireActual<
        typeof import('../database/prisma.service')
      >('../database/prisma.service');
      const client = app.get(PrismaSvc).client;
      const query = jest.spyOn(client, '$queryRaw');
      const exec = jest.spyOn(client, '$executeRaw');
      try {
        await run();
        return [query, exec].map((spy) => spy.mock.calls.length);
      } finally {
        for (const spy of [query, exec]) spy.mockRestore();
      }
    };

    function failTotpMarker(): jest.SpyInstance {
      const redis = app.get<import('ioredis').Redis>(
        jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
          '../infrastructure/infrastructure.module',
        ).REDIS_CLIENT,
      );
      const realSet = redis.set.bind(redis) as (...args: unknown[]) => Promise<unknown>;
      return jest
        .spyOn(redis, 'set')
        .mockImplementation(((...args: unknown[]) =>
          String(args[0]).startsWith('auth:totp:used:')
            ? Promise.reject(new Error('redis down'))
            : realSet(...args)) as unknown as typeof redis.set);
    }

    describe('POST /auth/2fa/disable', () => {
      it('TC-003: password plus a current code turns 2FA off, clears secret and recovery codes, revokes every refresh family, clears the cookie and audits without secrets (FR-102, FR-104)', async () => {
        const u = await createUser({ totp: SECRET });
        await withRecoveryCodes(u.id, ['ABCDEFGHJKLMNPQR']);
        const cookie = await signInWithTotp(u.email);
        await prisma.refreshToken.create({
          data: {
            userId: u.id,
            familyId: '11111111-1111-4111-8111-111111111111',
            tokenHash: sha256Hex(`other-${u.id}`),
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
        const res = await post('2fa/disable', await accessFor(u.id), {
          currentPassword: PASSWORD,
          totpCode: goodCode(),
        }).expect(204);
        const cleared = ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find(
          (c) => c.startsWith('cp_refresh='),
        );
        expect(cleared).toMatch(/^cp_refresh=;/);
        expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.totpEnabled).toBe(false);
        expect(row.totpSecretEnc).toBeNull();
        expect(row.recoveryCodeHashes).toEqual([]);
        expect(row.failedLogins).toBe(0);
        expect(await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(
          0,
        );
        await refresh(cookie).expect(401);
        const audit = await prisma.auditLog.findMany({
          where: { actorId: u.id, action: 'AUTH_2FA_DISABLED' },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]?.metadata).toEqual({ sessionsRevoked: 2 });
        expect(((await login(u.email).expect(200)).body as Body).status).toBe('authenticated');
      });

      function failAccessMarker(): jest.SpyInstance {
        const redis = app.get<import('ioredis').Redis>(
          jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
            '../infrastructure/infrastructure.module',
          ).REDIS_CLIENT,
        );
        // Other callers also use eval (forgot counters, invite slot, throttler), so only the
        // marker write (key auth:tokens-valid-after:*) is failed; everything else runs for real.
        const realEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
        return jest
          .spyOn(redis, 'eval')
          .mockImplementation((...args: unknown[]) =>
            String(args[2]).startsWith('auth:tokens-valid-after:')
              ? Promise.reject(new Error('redis down'))
              : realEval(...args),
          );
      }

      it('TC-003, FR-104: an access token issued before a successful disable is 401 afterwards, even in the same second', async () => {
        const u = await createUser({ totp: SECRET });
        const old = await accessFor(u.id);
        const probe = (token: string): request.Test =>
          post('2fa/setup/start', token, { currentPassword: PASSWORD });
        expect((await probe(old)).status).not.toBe(401);
        await post('2fa/disable', old, { currentPassword: PASSWORD, totpCode: goodCode() }).expect(
          204,
        );
        expect((await probe(old)).status).toBe(401);
      });

      it('TC-003, FR-104: if the tokens-valid-after marker cannot be written the disable is a 503 and rolls back completely', async () => {
        const u = await createUser({ totp: SECRET });
        await signInWithTotp(u.email);
        const before = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        const liveBefore = await prisma.refreshToken.count({
          where: { userId: u.id, revokedAt: null },
        });
        expect(liveBefore).toBe(1);
        const fail = failAccessMarker();
        try {
          const res = await post('2fa/disable', await accessFor(u.id), {
            currentPassword: PASSWORD,
            totpCode: goodCode(),
          });
          expect(res.status).toBe(503);
        } finally {
          fail.mockRestore();
        }
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.totpEnabled).toBe(true);
        expect(row.totpSecretEnc).toBe(before.totpSecretEnc);
        expect(row.failedLogins).toBe(before.failedLogins);
        expect(await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(
          liveBefore,
        );
        expect(
          await prisma.auditLog.count({ where: { actorId: u.id, action: 'AUTH_2FA_DISABLED' } }),
        ).toBe(0);
      });

      /** True once some backend waits on a lock (the statement under test is blocked). */
      async function untilLockWaiter(): Promise<void> {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const rows = await prisma.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()`;
          if (Number(rows[0]?.n ?? 0) > 0) return;
          if (Date.now() > deadline) throw new Error('no statement is waiting on a lock');
          await new Promise((r) => setTimeout(r, 20));
        }
      }

      /** Waits until the current second is later than the user's tokens-valid-after marker. */
      async function pastMarker(userId: string): Promise<void> {
        const redis = app.get<import('ioredis').Redis>(
          jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
            '../infrastructure/infrastructure.module',
          ).REDIS_CLIENT,
        );
        const marker = Number(await redis.get(`auth:tokens-valid-after:${userId}`));
        expect(Number.isFinite(marker)).toBe(true);
        while (Math.floor(Date.now() / 1000) <= marker) await new Promise((r) => setTimeout(r, 50));
      }

      it('TC-003, FR-104: a recovery-code sign-in held inside its transaction makes the disable wait on the user row lock, and its token is refused afterwards', async () => {
        const u = await createUser({ totp: SECRET });
        const recovery = 'ABCDEFGHJKLMNPQR';
        await withRecoveryCodes(u.id, [recovery]);
        const { challengeToken } = (await login(u.email).expect(200)).body as Body;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached: () => void = () => undefined;
        const atGate = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const target = authService as unknown as {
          clearFailures: (...args: unknown[]) => Promise<void>;
        };
        const real = target.clearFailures.bind(authService);
        const hold = jest
          .spyOn(target, 'clearFailures')
          .mockImplementationOnce(async (...args: unknown[]) => {
            reached();
            await gate;
            return real(...args);
          });
        let signIn: Promise<request.Response>;
        let disable: Promise<request.Response>;
        try {
          signIn = Promise.resolve(post('2fa/verify', null, { challengeToken, code: recovery }));
          await atGate;
          // The family is inserted but uncommitted: the disable must wait for the row lock.
          disable = Promise.resolve(
            post('2fa/disable', await accessFor(u.id), {
              currentPassword: PASSWORD,
              totpCode: goodCode(),
            }),
          );
          await untilLockWaiter();
          release();
        } finally {
          hold.mockRestore();
        }
        expect((await signIn).status).toBe(200);
        expect((await disable).status).toBe(204);
        await pastMarker(u.id);
        const issued = ((await signIn).body as { accessToken: string }).accessToken;
        expect((await post('2fa/setup/start', issued, { currentPassword: PASSWORD })).status).toBe(
          401,
        );
        expect(await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(
          0,
        );
      });

      it('TC-004, FR-102: a password sign-in that read a RECRUITER cannot open a family after the role changes (held after the password check)', async () => {
        const admin = await createUser({ role: UserRole.SUPER_ADMIN, totp: SECRET });
        const u = await createUser({ role: UserRole.RECRUITER });
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached: () => void = () => undefined;
        const atGate = new Promise<void>((resolve) => {
          reached = resolve;
        });
        passwordVerify.mockImplementationOnce(async (hash: string, password: string) => {
          const ok = await realPasswordVerify(hash, password);
          if (ok) {
            reached();
            await gate;
          }
          return ok;
        });
        const signIn = Promise.resolve(login(u.email));
        await atGate;
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/users/${u.id}`)
          .set('Authorization', `Bearer ${await accessFor(admin.id)}`)
          .send({ currentPassword: PASSWORD, role: 'REVIEWER' })
          .expect(200);
        release();
        const res = await signIn;
        expect(res.status).toBe(401);
        expect(res.headers['set-cookie']).toBeUndefined();
        // The refused attempt was refunded: the right password must not count as a failure.
        expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
        expect(await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(
          0,
        );
      });

      it('TC-003, FR-104: a TOTP sign-in whose family commits before a disable but finishes after it gets an access token the guard refuses (held, same-second race)', async () => {
        const u = await createUser({ totp: SECRET });
        const { challengeToken } = (await login(u.email).expect(200)).body as Body;
        const code = authenticator.clone({ epoch: Date.now() - 30_000 }).generate(SECRET);
        // Hold the sign-in right after its refresh family committed (clearFailures runs next).
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached: () => void = () => undefined;
        const atGate = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const target = authService as unknown as {
          clearFailures: (...args: unknown[]) => Promise<void>;
        };
        const real = target.clearFailures.bind(authService);
        const hold = jest
          .spyOn(target, 'clearFailures')
          .mockImplementationOnce(async (...args: unknown[]) => {
            reached();
            await gate;
            return real(...args);
          });
        let signIn: Promise<request.Response>;
        try {
          signIn = Promise.resolve(post('2fa/verify', null, { challengeToken, code }));
          await atGate;
          // The disable commits while the sign-in is held.
          await post('2fa/disable', await accessFor(u.id), {
            currentPassword: PASSWORD,
            totpCode: goodCode(),
          }).expect(204);
          // Let the clock pass the marker's second before the sign-in finishes: with the access
          // token signed before the family commits the token is still refused, with the old order
          // (signed after) it would carry a later iat and be accepted.
          await pastMarker(u.id);
          release();
        } finally {
          hold.mockRestore();
        }
        const done = await signIn;
        expect(done.status).toBe(200);
        const issued = (done.body as { accessToken: string }).accessToken;
        const res = await post('2fa/setup/start', issued, { currentPassword: PASSWORD });
        expect(res.status).toBe(401);
      });

      it('TC-003: a missing or malformed totpCode is a 400 and nothing is counted (a recovery code is not accepted)', async () => {
        const u = await createUser({ totp: SECRET });
        const token = await accessFor(u.id);
        await post('2fa/disable', token, { currentPassword: PASSWORD }).expect(400);
        for (const totpCode of ['12345', '1234567', 'abcdef', 'ABCD-EFGH-JKLM', 123456, '']) {
          await post('2fa/disable', token, { currentPassword: PASSWORD, totpCode }).expect(400);
        }
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.totpEnabled).toBe(true);
        expect(row.failedLogins).toBe(0);
      });

      it('TC-003: a wrong password and a wrong code are the same 403 REAUTH_FAILED body; a stolen access token plus the password cannot disable', async () => {
        const u = await createUser({ totp: SECRET });
        const cookie = await signInWithTotp(u.email);
        const token = await accessFor(u.id);
        const wrongPassword = await post('2fa/disable', token, {
          currentPassword: 'wrong-password-1',
          totpCode: goodCode(),
        });
        const wrongCode = await post('2fa/disable', token, {
          currentPassword: PASSWORD,
          totpCode: badCode(),
        });
        disableRefused(wrongPassword);
        disableRefused(wrongCode);
        expect(sameShape(wrongCode)).toEqual(sameShape(wrongPassword));
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.totpEnabled).toBe(true);
        expect(row.totpSecretEnc).not.toBeNull();
        expect(row.failedLogins).toBe(2);
        expect(
          await prisma.auditLog.count({ where: { actorId: u.id, action: 'AUTH_2FA_DISABLED' } }),
        ).toBe(0);
        // The sessions are untouched.
        await refresh(cookie).expect(200);
      });

      it('TC-003: a replayed code is refused with the same 403 REAUTH_FAILED and counts as a failure', async () => {
        const u = await createUser({ totp: SECRET });
        const token = await accessFor(u.id);
        const { challengeToken } = (await login(u.email).expect(200)).body as Body;
        const code = goodCode();
        await post('2fa/verify', null, { challengeToken, code }).expect(200);
        const replay = await post('2fa/disable', token, {
          currentPassword: PASSWORD,
          totpCode: code,
        });
        disableRefused(replay);
        const wrongPassword = await post('2fa/disable', token, {
          currentPassword: 'wrong-password-1',
          totpCode: code,
        });
        expect(sameShape(replay)).toEqual(sameShape(wrongPassword));
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.totpEnabled).toBe(true);
        expect(row.failedLogins).toBe(2);
      });

      it('TC-003: wrong codes and wrong passwords share the 5-attempt lockout, and a locked account refuses the right password and code like a wrong one', async () => {
        const u = await createUser({ totp: SECRET });
        const token = await accessFor(u.id);
        for (let i = 0; i < 3; i++) {
          disableRefused(
            await post('2fa/disable', token, { currentPassword: PASSWORD, totpCode: badCode() }),
          );
        }
        for (let i = 0; i < 2; i++) {
          disableRefused(
            await post('2fa/disable', token, {
              currentPassword: 'wrong-password-1',
              totpCode: goodCode(),
            }),
          );
        }
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.failedLogins).toBe(5);
        expect(row.lockedUntil).not.toBeNull();
        const wrong = await post('2fa/disable', token, {
          currentPassword: 'wrong-password-1',
          totpCode: badCode(),
        });
        const locked = await post('2fa/disable', token, {
          currentPassword: PASSWORD,
          totpCode: goodCode(),
        });
        disableRefused(locked);
        expect(sameShape(locked)).toEqual(sameShape(wrong));
        expect(JSON.stringify(locked.body)).not.toMatch(/lock/i);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).totpEnabled).toBe(
          true,
        );
      });

      it('TC-003: a failure at the code step that fills the last slot locks the account', async () => {
        const u = await createUser({ totp: SECRET });
        await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 3 } });
        disableRefused(
          await post('2fa/disable', await accessFor(u.id), {
            currentPassword: PASSWORD,
            totpCode: badCode(),
          }),
        );
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.failedLogins).toBe(4);
        expect(row.lockedUntil).toBeNull();
        await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 4 } });
        disableRefused(
          await post('2fa/disable', await accessFor(u.id), {
            currentPassword: PASSWORD,
            totpCode: badCode(),
          }),
        );
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).lockedUntil,
        ).not.toBeNull();
      });

      it('TC-003: a refused disable costs the same statements for a wrong password and a locked account; a wrong code adds only the second reservation', async () => {
        const wrong = await createUser({ totp: SECRET });
        const locked = await createUser({ totp: SECRET });
        const codeUser = await createUser({ totp: SECRET });
        await prisma.user.update({
          where: { id: locked.id },
          data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
        });
        const counts: number[][] = [];
        for (const [u, currentPassword, totpCode] of [
          [wrong, 'wrong-password-1', goodCode()],
          [locked, 'wrong-password-1', goodCode()],
          [codeUser, PASSWORD, badCode()],
        ] as const) {
          const token = await accessFor(u.id);
          counts.push(
            await countCalls(async () =>
              disableRefused(await post('2fa/disable', token, { currentPassword, totpCode })),
            ),
          );
        }
        expect(counts[0]).toEqual(EXPECTED_SETUP_REFUSED_COUNTS);
        expect(counts[1]).toEqual(counts[0]);
        // Password reserve, refund, code reserve, failure register.
        expect(counts[2]).toEqual([3, 1]);
      });

      it('TC-003: when Redis cannot record the code a valid code gets a fixed 503, no failure is counted, nothing changes, and a retry works', async () => {
        const u = await createUser({ totp: SECRET });
        const token = await accessFor(u.id);
        const spy = failTotpMarker();
        try {
          for (let i = 0; i < 7; i++) {
            const res = await post('2fa/disable', token, {
              currentPassword: PASSWORD,
              totpCode: goodCode(),
            }).expect(503);
            expect((res.body as Body).detail).toBe('Verification is temporarily unavailable.');
            expect(res.headers['set-cookie']).toBeUndefined();
          }
        } finally {
          spy.mockRestore();
        }
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.failedLogins).toBe(0);
        expect(row.lockedUntil).toBeNull();
        expect(row.totpEnabled).toBe(true);
        await post('2fa/disable', token, {
          currentPassword: PASSWORD,
          totpCode: goodCode(),
        }).expect(204);
      });

      it.each([UserRole.SUPER_ADMIN, UserRole.REVIEWER, UserRole.RECRUITER, UserRole.AUTHOR])(
        'TC-003: a %s can disable 2FA with the right password and code; a wrong password or code is REAUTH_FAILED and counts toward lockout; success signs out everywhere (FR-102, FR-107, ADR 0011)',
        async (role) => {
          const u = await createUser({ role, totp: SECRET });
          const token = await accessFor(u.id);
          await prisma.refreshToken.create({
            data: {
              userId: u.id,
              familyId: '33333333-3333-4333-8333-333333333333',
              tokenHash: sha256Hex(`raw-refresh-${u.id}`),
              expiresAt: new Date(Date.now() + 600_000),
            },
          });
          disableRefused(
            await post('2fa/disable', token, {
              currentPassword: 'wrong-password-1',
              totpCode: goodCode(),
            }),
          );
          expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(
            1,
          );
          disableRefused(
            await post('2fa/disable', token, { currentPassword: PASSWORD, totpCode: badCode() }),
          );
          let row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
          expect(row.totpEnabled).toBe(true);
          expect(row.failedLogins).toBe(2);
          await post('2fa/disable', token, {
            currentPassword: PASSWORD,
            totpCode: goodCode(),
          }).expect(204);
          row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
          expect(row.totpEnabled).toBe(false);
          expect(row.totpSecretEnc).toBeNull();
          expect(row.recoveryCodeHashes).toEqual([]);
          expect(
            await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } }),
          ).toBe(0);
          // FR-107: with 2FA off the next login needs the password alone, for every role.
          expect(((await login(u.email).expect(200)).body as Body).status).toBe('authenticated');
        },
      );

      it('TC-003: without 2FA on it is a 409 after the password check, and without a token a 401', async () => {
        const u = await createUser();
        const body = { currentPassword: PASSWORD, totpCode: goodCode() };
        await post('2fa/disable', await accessFor(u.id), body).expect(409);
        disableRefused(
          await post('2fa/disable', await accessFor(u.id), {
            ...body,
            currentPassword: 'wrong-password-1',
          }),
        );
        await post('2fa/disable', null, body).expect(401);
      });
    });

    describe('2fa/disable racing a refresh or a 2FA sign-in', () => {
      const gate = (): { wait: Promise<void>; open: () => void } => {
        let open: () => void = () => undefined;
        const wait = new Promise<void>((resolve) => {
          open = resolve;
        });
        return { wait, open };
      };
      async function untilTrue(cond: () => boolean): Promise<void> {
        const deadline = Date.now() + 10_000;
        while (!cond()) {
          if (Date.now() > deadline) throw new Error('condition not reached');
          await new Promise((r) => setTimeout(r, 20));
        }
      }

      it('TC-003: a refresh that rotates while the disable waits is revoked by it, and no family stays live (FR-104)', async () => {
        const u = await createUser({ totp: SECRET });
        const cookie = await signInWithTotp(u.email);
        const token = await accessFor(u.id);
        const g = gate();
        let reached = false;
        totpVerify.mockImplementationOnce(async () => {
          reached = true;
          await g.wait;
          return true;
        });
        const inFlight = post('2fa/disable', token, {
          currentPassword: PASSWORD,
          totpCode: goodCode(),
        }).then((r) => r);
        try {
          await untilTrue(() => reached);
          const rotated = await refresh(cookie).expect(200);
          g.open();
          expect((await inFlight).status).toBe(204);
          await refresh(refreshCookie(rotated)).expect(401);
        } finally {
          g.open();
          await inFlight.catch(() => undefined);
        }
        expect(await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(
          0,
        );
      });

      it('TC-003: a 2FA sign-in that completes after the disable is refused and leaves no live refresh token (FR-102, FR-104)', async () => {
        const u = await createUser({ totp: SECRET });
        const { challengeToken } = (await login(u.email).expect(200)).body as Body;
        const token = await accessFor(u.id);
        const g = gate();
        let reached = false;
        totpVerify.mockImplementationOnce(async () => {
          reached = true;
          await g.wait;
          return true;
        });
        const signIn = post('2fa/verify', null, { challengeToken, code: '123456' }).then((r) => r);
        try {
          await untilTrue(() => reached);
          await post('2fa/disable', token, {
            currentPassword: PASSWORD,
            totpCode: goodCode(),
          }).expect(204);
          g.open();
          const res = await signIn;
          expect(res.status).toBe(401);
          expect(res.headers['set-cookie']).toBeUndefined();
        } finally {
          g.open();
          await signIn.catch(() => undefined);
        }
        expect(await prisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(
          0,
        );
      });
    });

    describe('POST /auth/2fa/recovery-codes/regenerate', () => {
      it('TC-003: regenerating returns 10 new codes, replaces every old hash, audits, and the old code no longer logs in', async () => {
        const u = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        const old = 'ABCDEFGHJKLMNPQR';
        await withRecoveryCodes(u.id, [old]);
        const res = await post('2fa/recovery-codes/regenerate', await accessFor(u.id), {
          currentPassword: PASSWORD,
        }).expect(200);
        const codes = (res.body as Body).recoveryCodes;
        expect(codes).toHaveLength(10);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.recoveryCodeHashes.sort()).toEqual(codes.map((c) => sha256Hex(c)).sort());
        expect(row.recoveryCodeHashes).not.toContain(sha256Hex(old));
        expect(
          await prisma.auditLog.count({
            where: { actorId: u.id, action: 'AUTH_RECOVERY_CODES_REGENERATED' },
          }),
        ).toBe(1);
        const c1 = (await login(u.email).expect(200)).body as Body;
        await post('2fa/verify', null, { challengeToken: c1.challengeToken, code: old }).expect(
          400,
        );
        const c2 = (await login(u.email).expect(200)).body as Body;
        await post('2fa/verify', null, {
          challengeToken: c2.challengeToken,
          code: codes[0] ?? '',
        }).expect(200);
        for (const code of codes) expect(logged.join('')).not.toContain(code);
      });

      it('TC-003: a missing or wrong password is refused with no state change, a stolen access token alone cannot regenerate, a locked account gets the same 403 REAUTH_FAILED', async () => {
        const u = await createUser({ totp: SECRET });
        await withRecoveryCodes(u.id, ['ABCDEFGHJKLMNPQR']);
        const token = await accessFor(u.id);
        await post('2fa/recovery-codes/regenerate', token, {}).expect(400);
        reauthRefused(
          await post('2fa/recovery-codes/regenerate', token, {
            currentPassword: 'nope-nope-1',
          }).expect(403),
        );
        let row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.recoveryCodeHashes).toEqual([sha256Hex('ABCDEFGHJKLMNPQR')]);
        expect(row.failedLogins).toBe(1);
        for (let i = 0; i < 4; i++) {
          reauthRefused(
            await post('2fa/recovery-codes/regenerate', token, {
              currentPassword: 'nope-nope-1',
            }).expect(403),
          );
        }
        const wrongBody = await post('2fa/recovery-codes/regenerate', token, {
          currentPassword: 'nope-nope-1',
        });
        const lockedBody = await post('2fa/recovery-codes/regenerate', token, {
          currentPassword: PASSWORD,
        });
        reauthRefused(lockedBody);
        expect(sameShape(lockedBody)).toEqual(sameShape(wrongBody));
        row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
        expect(row.recoveryCodeHashes).toEqual([sha256Hex('ABCDEFGHJKLMNPQR')]);
      });

      it('TC-003: it is refused with a 409 when 2FA is not on', async () => {
        const u = await createUser();
        await post('2fa/recovery-codes/regenerate', await accessFor(u.id), {
          currentPassword: PASSWORD,
        }).expect(409);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).recoveryCodeHashes,
        ).toEqual([]);
      });
    });

    describe('a change racing the password check (explainRefusedChange)', () => {
      /** Runs `mutate` right after the next password verify succeeds, before the bound write. */
      function afterNextVerify(mutate: () => Promise<unknown>): void {
        passwordVerify.mockImplementationOnce(async (h: string, p: string) => {
          const ok = await realPasswordVerify(h, p);
          await mutate();
          return ok;
        });
      }
      const newPassword = (): Promise<string> => hash('Another-Pass-77', ARGON2_OPTIONS);

      it('TC-003: disable and regenerate that race a password change are a 403 REAUTH_FAILED and change nothing', async () => {
        for (const route of ['2fa/disable', '2fa/recovery-codes/regenerate']) {
          const extra = route === '2fa/disable' ? { totpCode: goodCode() } : {};
          const u = await createUser({ totp: SECRET });
          await withRecoveryCodes(u.id, ['ABCDEFGHJKLMNPQR']);
          const token = await accessFor(u.id);
          const changed = await newPassword();
          afterNextVerify(() =>
            prisma.user.update({ where: { id: u.id }, data: { passwordHash: changed } }),
          );
          const refused = await post(route, token, {
            currentPassword: PASSWORD,
            ...extra,
          }).expect(403);
          if (route === '2fa/disable') disableRefused(refused);
          else reauthRefused(refused);
          const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
          expect(row.totpEnabled).toBe(true);
          expect(row.recoveryCodeHashes).toEqual([sha256Hex('ABCDEFGHJKLMNPQR')]);
        }
      });

      it('TC-003: regenerate racing a 2FA turn-off is a 409, also for an enforced role (not a 403)', async () => {
        const u = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        const token = await accessFor(u.id);
        afterNextVerify(() =>
          prisma.user.update({
            where: { id: u.id },
            data: { totpEnabled: false, totpSecretEnc: null },
          }),
        );
        await post('2fa/recovery-codes/regenerate', token, { currentPassword: PASSWORD }).expect(
          409,
        );
      });

      it('TC-003: setup/start racing a concurrent 2FA turn-on is a 409, not REAUTH_FAILED', async () => {
        const u = await createUser();
        const token = await accessFor(u.id);
        afterNextVerify(() =>
          prisma.user.update({
            where: { id: u.id },
            data: {
              totpEnabled: true,
              totpSecretEnc: encryptSecret(
                SECRET,
                Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64'),
              ),
            },
          }),
        );
        await post('2fa/setup/start', token, { currentPassword: PASSWORD }).expect(409);
        const changed = await newPassword();
        const w = await createUser();
        const wt = await accessFor(w.id);
        afterNextVerify(() =>
          prisma.user.update({ where: { id: w.id }, data: { passwordHash: changed } }),
        );
        reauthRefused(await post('2fa/setup/start', wt, { currentPassword: PASSWORD }));
      });

      it('TC-003: disable racing a 2FA turn-off is a 409, and a role change racing the disable no longer matters: it succeeds (FR-102 optional for all)', async () => {
        const u = await createUser({ totp: SECRET });
        const token = await accessFor(u.id);
        afterNextVerify(() =>
          prisma.user.update({
            where: { id: u.id },
            data: { totpEnabled: false, totpSecretEnc: null },
          }),
        );
        await post('2fa/disable', token, {
          currentPassword: PASSWORD,
          totpCode: goodCode(),
        }).expect(409);
        const v = await createUser({ totp: SECRET });
        afterNextVerify(() =>
          prisma.user.update({ where: { id: v.id }, data: { role: UserRole.REVIEWER } }),
        );
        await post('2fa/disable', await accessFor(v.id), {
          currentPassword: PASSWORD,
          totpCode: goodCode(),
        }).expect(204);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: v.id } })).totpEnabled).toBe(
          false,
        );
      });
    });

    describe('secret-bearing responses are not cacheable', () => {
      it('TC-003: setup, confirm and regenerate responses carry Cache-Control: no-store', async () => {
        const u = await createUser();
        const token = await accessFor(u.id);
        const start = await post('2fa/setup/start', token, { currentPassword: PASSWORD }).expect(
          200,
        );
        expect(start.headers['cache-control']).toBe('no-store');
        const key = (start.body as { manualKey: string }).manualKey;
        const confirm = await post('2fa/setup/confirm', token, {
          currentPassword: PASSWORD,
          code: authenticator.generate(key),
        }).expect(200);
        expect(confirm.headers['cache-control']).toBe('no-store');
        const regen = await post('2fa/recovery-codes/regenerate', token, {
          currentPassword: PASSWORD,
        }).expect(200);
        expect(regen.headers['cache-control']).toBe('no-store');
      });
    });

    describe('POST /auth/2fa/reset/:userId (super admin)', () => {
      const OK = { currentPassword: PASSWORD };
      async function admin(): Promise<{ id: string; token: string }> {
        const a = await createUser({ role: UserRole.SUPER_ADMIN, totp: SECRET });
        return { id: a.id, token: await accessFor(a.id) };
      }

      it('TC-003: a non-super-admin is refused with 403 and nothing changes', async () => {
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        const recruiter = await createUser();
        await post(`2fa/reset/${target.id}`, await accessFor(recruiter.id), OK).expect(403);
        await post(`2fa/reset/${target.id}`, null, OK).expect(401);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled,
        ).toBe(true);
      });

      it('TC-003: a user in another organization is a 404, the same as a missing one; a bad id is 400; self is refused', async () => {
        const a = await admin();
        const otherOrg = await prisma.organization.create({ data: { name: 'Other Org' } });
        const foreign = await prisma.user.create({
          data: {
            orgId: otherOrg.id,
            email: `foreign${++seq}@example.com`,
            fullName: 'Foreign',
            role: UserRole.REVIEWER,
            passwordHash: await hash(PASSWORD, ARGON2_OPTIONS),
            totpSecretEnc: encryptSecret(
              SECRET,
              Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64'),
            ),
            totpEnabled: true,
          },
        });
        const cross = await post(`2fa/reset/${foreign.id}`, a.token, OK).expect(404);
        const missing = await post(
          '2fa/reset/00000000-0000-4000-8000-000000000001',
          a.token,
          OK,
        ).expect(404);
        expect((cross.body as Body).detail).toBe((missing.body as Body).detail);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: foreign.id } })).totpEnabled,
        ).toBe(true);
        await post('2fa/reset/not-a-uuid', a.token, OK).expect(400);
        await post(`2fa/reset/${a.id}`, a.token, OK).expect(400);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).totpEnabled).toBe(
          true,
        );
      });

      it('TC-003: a reset clears 2FA, revokes every family, writes an audit row with actor and target, keeps the password, and a reviewer then signs in with the password alone (FR-102 optional for all)', async () => {
        const a = await admin();
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        await withRecoveryCodes(target.id, ['ABCDEFGHJKLMNPQR']);
        const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
        for (const n of ['a', 'b']) {
          await prisma.refreshToken.create({
            data: {
              userId: target.id,
              familyId:
                n === 'a'
                  ? '22222222-2222-4222-8222-222222222222'
                  : '33333333-3333-4333-8333-333333333333',
              tokenHash: sha256Hex(`fam-${n}-${target.id}`),
              expiresAt: new Date(Date.now() + 600_000),
            },
          });
        }
        await post(`2fa/reset/${target.id}`, a.token, OK).expect(204);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
        expect(row.totpEnabled).toBe(false);
        expect(row.totpSecretEnc).toBeNull();
        expect(row.recoveryCodeHashes).toEqual([]);
        expect(row.passwordHash).toBe(before.passwordHash);
        expect(
          await prisma.refreshToken.count({ where: { userId: target.id, revokedAt: null } }),
        ).toBe(0);
        const audit = await prisma.auditLog.findMany({
          where: { action: 'AUTH_2FA_RESET_BY_ADMIN', entityId: target.id },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]?.actorId).toBe(a.id);
        expect(audit[0]?.orgId).toBe(orgId);
        expect(audit[0]?.metadata).toEqual({
          previouslyEnabled: true,
          targetRole: 'REVIEWER',
          sessionsRevoked: 2,
        });
        const next = (await login(target.email).expect(200)).body as Body;
        expect(next.status).toBe('authenticated');
        expect(next.session.user).toMatchObject({ totpEnabled: false, twoFactorRecommended: true });
      });

      it('TC-003: a recruiter with optional 2FA is reset and then signs in with the password alone', async () => {
        const a = await admin();
        const target = await createUser({ totp: SECRET });
        await post(`2fa/reset/${target.id}`, a.token, OK).expect(204);
        expect(((await login(target.email).expect(200)).body as Body).status).toBe('authenticated');
      });

      it('TC-003: a 2FA completion that overlaps an admin reset is refused and leaves no live refresh token', async () => {
        const a = await admin();
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        const { challengeToken } = (await login(target.email).expect(200)).body as Body;
        const gate = makeGateLocal();
        let reached = false;
        totpVerify.mockImplementationOnce(async () => {
          reached = true;
          await gate.wait;
          return true;
        });
        const inFlight: Promise<request.Response>[] = [];
        try {
          inFlight.push(
            post('2fa/verify', null, { challengeToken, code: '123456' }).then((r) => r),
          );
          const deadline = Date.now() + 10_000;
          while (!reached && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
          expect(reached).toBe(true);
          await post(`2fa/reset/${target.id}`, a.token, OK).expect(204);
          gate.open();
          const res = await inFlight[0];
          expect(res?.status).toBe(401);
          expect(res?.headers['set-cookie']).toBeUndefined();
        } finally {
          gate.open();
          await Promise.allSettled(inFlight);
        }
        expect(
          await prisma.refreshToken.count({ where: { userId: target.id, revokedAt: null } }),
        ).toBe(0);
        expect(await prisma.refreshToken.count({ where: { userId: target.id } })).toBe(0);
      });

      it('TC-003: a 2FA verify whose session insert meets an uncommitted admin reset waits, is refused, and leaves no live family', async () => {
        const a = await admin();
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        const { challengeToken } = (await login(target.email).expect(200)).body as Body;
        const gate = makeGateLocal();
        let reached = false;
        totpVerify.mockImplementationOnce(async () => {
          reached = true;
          await gate.wait;
          return true;
        });
        const held = holdResetLock(a.id, target.id);
        let res: request.Response | undefined;
        try {
          const inFlight = post('2fa/verify', null, { challengeToken, code: '123456' }).then(
            (r) => r,
          );
          const deadline = Date.now() + 10_000;
          while (!reached && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
          await held.gotLock;
          gate.open();
          await new Promise((r) => setTimeout(r, 500));
          held.commit();
          await held.resetTx;
          res = await inFlight;
        } finally {
          gate.open();
          held.commit();
          await held.resetTx.catch(() => undefined);
        }
        expect(res?.status).toBe(401);
        expect(res?.headers['set-cookie']).toBeUndefined();
        expect(
          await prisma.refreshToken.count({ where: { userId: target.id, revokedAt: null } }),
        ).toBe(0);
      });
      it('TC-003: a recovery-code verify that overlaps an uncommitted admin reset waits, is refused, and leaves no live family', async () => {
        const a = await admin();
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        await withRecoveryCodes(target.id, ['ABCDEFGHJKLMNPQR']);
        const { challengeToken } = (await login(target.email).expect(200)).body as Body;
        const held = holdResetLock(a.id, target.id);
        let res: request.Response | undefined;
        try {
          await held.gotLock;
          const inFlight = post('2fa/verify', null, {
            challengeToken,
            code: 'ABCDEFGHJKLMNPQR',
          }).then((r) => r);
          await new Promise((r) => setTimeout(r, 500));
          held.commit();
          await held.resetTx;
          res = await inFlight;
        } finally {
          held.commit();
          await held.resetTx.catch(() => undefined);
        }
        expect(res?.status).toBe(400);
        expect(res?.headers['set-cookie']).toBeUndefined();
        expect(
          await prisma.refreshToken.count({ where: { userId: target.id, revokedAt: null } }),
        ).toBe(0);
      });

      it('TC-003: a missing or wrong admin password is refused and changes nothing; a stolen admin access token alone cannot reset', async () => {
        const a = await admin();
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        await prisma.refreshToken.create({
          data: {
            userId: target.id,
            familyId: '44444444-4444-4444-8444-444444444444',
            tokenHash: sha256Hex(`live-${target.id}`),
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
        await post(`2fa/reset/${target.id}`, a.token, {}).expect(400);
        await post(`2fa/reset/${target.id}`, a.token).expect(400);
        reauthRefused(
          await post(`2fa/reset/${target.id}`, a.token, { currentPassword: 'wrong-pass-1' }).expect(
            403,
          ),
        );
        const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
        expect(row.totpEnabled).toBe(true);
        expect(row.totpSecretEnc).not.toBeNull();
        expect(
          await prisma.refreshToken.count({ where: { userId: target.id, revokedAt: null } }),
        ).toBe(1);
        expect(
          await prisma.auditLog.count({
            where: { action: 'AUTH_2FA_RESET_BY_ADMIN', entityId: target.id },
          }),
        ).toBe(0);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).failedLogins).toBe(1);
      });

      it('TC-003: the admin own id in upper or mixed case is still the self-target 400 and changes nothing', async () => {
        const a = await admin();
        await prisma.refreshToken.create({
          data: {
            userId: a.id,
            familyId: '55555555-5555-4555-8555-555555555555',
            tokenHash: sha256Hex(`own-${a.id}`),
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
        const mixed = a.id
          .split('')
          .map((c, i) => (i % 2 ? c.toUpperCase() : c))
          .join('');
        for (const id of [a.id.toUpperCase(), mixed]) {
          const res = await post(`2fa/reset/${id}`, a.token, OK).expect(400);
          expect((res.body as Body).detail).toBe(
            'Use your own security settings to change your 2FA.',
          );
        }
        const row = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
        expect(row.totpEnabled).toBe(true);
        expect(row.totpSecretEnc).not.toBeNull();
        expect(await prisma.refreshToken.count({ where: { userId: a.id, revokedAt: null } })).toBe(
          1,
        );
        expect(
          await prisma.auditLog.count({
            where: { action: 'AUTH_2FA_RESET_BY_ADMIN', entityId: a.id },
          }),
        ).toBe(0);
      });

      it('TC-003: a changed admin gets 403 REAUTH_FAILED even when the target does not exist', async () => {
        const a = await admin();
        const newHash = await hash('Another-Pass-77', ARGON2_OPTIONS);
        passwordVerify.mockImplementationOnce(async (h: string, p: string) => {
          const ok = await realPasswordVerify(h, p);
          await prisma.user.update({ where: { id: a.id }, data: { passwordHash: newHash } });
          return ok;
        });
        reauthRefused(
          await post('2fa/reset/00000000-0000-4000-8000-000000000002', a.token, OK).expect(403),
        );
      });

      it('TC-003: login, 2fa/verify and refresh responses carry Cache-Control: no-store', async () => {
        const plain = await createUser();
        expect((await login(plain.email).expect(200)).headers['cache-control']).toBe('no-store');
        const u = await createUser({ totp: SECRET });
        const first = await login(u.email).expect(200);
        expect(first.headers['cache-control']).toBe('no-store');
        const verified = await post('2fa/verify', null, {
          challengeToken: (first.body as Body).challengeToken,
          code: authenticator.generate(SECRET),
        }).expect(200);
        expect(verified.headers['cache-control']).toBe('no-store');
        const refreshed = await refresh(refreshCookie(verified)).expect(200);
        expect(refreshed.headers['cache-control']).toBe('no-store');
      });

      it('TC-003: a locked admin gets the same generic 403 REAUTH_FAILED as a wrong password, even with the right one, and nothing changes', async () => {
        const a = await admin();
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        for (let i = 0; i < 5; i++) {
          reauthRefused(
            await post(`2fa/reset/${target.id}`, a.token, {
              currentPassword: 'wrong-pass-1',
            }).expect(403),
          );
        }
        const wrong = await post(`2fa/reset/${target.id}`, a.token, {
          currentPassword: 'wrong-pass-1',
        });
        const locked = await post(`2fa/reset/${target.id}`, a.token, OK);
        reauthRefused(wrong);
        reauthRefused(locked);
        expect(sameShape(locked)).toEqual(sameShape(wrong));
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled,
        ).toBe(true);
        expect(
          await prisma.auditLog.count({
            where: { action: 'AUTH_2FA_RESET_BY_ADMIN', entityId: target.id },
          }),
        ).toBe(0);
      });

      it('TC-003: an admin whose password changes between the check and the write is refused and nothing changes', async () => {
        const a = await admin();
        const target = await createUser({ role: UserRole.REVIEWER, totp: SECRET });
        const newHash = await hash('Another-Pass-77', ARGON2_OPTIONS);
        passwordVerify.mockImplementationOnce(async (h: string, p: string) => {
          const ok = await realPasswordVerify(h, p);
          await prisma.user.update({ where: { id: a.id }, data: { passwordHash: newHash } });
          return ok;
        });
        reauthRefused(await post(`2fa/reset/${target.id}`, a.token, OK).expect(403));
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled,
        ).toBe(true);
        expect(
          await prisma.auditLog.count({
            where: { action: 'AUTH_2FA_RESET_BY_ADMIN', entityId: target.id },
          }),
        ).toBe(0);
      });

      it('TC-003: two admins resetting each other at the same time neither deadlock nor 500; a refused request changes nothing', async () => {
        for (let round = 0; round < 5; round++) {
          const a = await admin();
          const b = await admin();
          const [ra, rb] = await Promise.all([
            post(`2fa/reset/${b.id}`, a.token, OK),
            post(`2fa/reset/${a.id}`, b.token, OK),
          ]);
          // A reset ends the target's access tokens at once (the Redis marker is written before the
          // other transaction commits, and it also refuses a token issued in the same second). Each
          // admin's own request races the other admin's reset, so the loser of that race is
          // refused 401 by the guard before the route runs. That is the designed behaviour, not a
          // lock problem. What must never happen: a 5xx (deadlock, lock timeout), both requests
          // refused, or a state change or audit row that does not match the response.
          const outcome = JSON.stringify({ ra: [ra.status, ra.body], rb: [rb.status, rb.body] });
          for (const r of [ra, rb]) expect([204, 401]).toContain(r.status);
          // Jest's expect takes no message: carry the outcome inside the compared value instead.
          expect([[ra, rb].some((r) => r.status === 204), outcome]).toEqual([true, outcome]);
          for (const [requester, target, res] of [
            [a, b, ra],
            [b, a, rb],
          ] as const) {
            const done = res.status === 204;
            const audits = await prisma.auditLog.count({
              where: {
                action: 'AUTH_2FA_RESET_BY_ADMIN',
                actorId: requester.id,
                entityId: target.id,
              },
            });
            const { totpEnabled } = await prisma.user.findUniqueOrThrow({
              where: { id: target.id },
            });
            expect([audits, totpEnabled, outcome]).toEqual([done ? 1 : 0, !done, outcome]);
          }
        }
      });
    });

    /**
     * Holds an admin reset open the way the route runs it: target row lock, user update, refresh
     * token revoke, then the audit insert (actor FK), in the route's order. Nothing commits until commit() is called.
     */
    function holdResetLock(
      actorId: string,
      targetId: string,
    ): { gotLock: Promise<void>; commit: () => void; resetTx: Promise<void> } {
      let commit: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let locked: () => void = () => undefined;
      const gotLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const resetTx = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${targetId}::uuid FOR NO KEY UPDATE`;
          await tx.user.update({
            where: { id: targetId },
            data: { totpEnabled: false, totpSecretEnc: null, recoveryCodeHashes: [] },
          });
          locked();
          await hold;
          await tx.refreshToken.updateMany({
            where: { userId: targetId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await tx.auditLog.create({
            data: {
              orgId,
              actorId,
              action: 'AUTH_2FA_RESET_BY_ADMIN',
              entityType: 'user',
              entityId: targetId,
              metadata: {},
            },
          });
        },
        { timeout: 20_000 },
      );
      return { gotLock, commit, resetTx };
    }

    function makeGateLocal(): { wait: Promise<void>; open: () => void } {
      let open: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    }
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
