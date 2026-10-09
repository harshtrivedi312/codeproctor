// FU-BE-208 (Trap A), DL-37, FR-101, FR-102: the TOTP used-step key is written when a code
// verifies. If the database work after it rolls back CLEANLY (503 BUSY invites a retry), the key is
// given back, so the honest retry with the same code works and is not counted as a replay. On an
// UNKNOWN outcome (P2028, a failure after the work finished) the key stays. No TC id covers it in
// docs/test-cases.md; names cite the decision ids and FRs.
import type { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { Redis } from 'ioredis';
import { authenticator } from 'otplib';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { TokenService } from '../common/auth/token.service';
import type { TokenValidityService } from '../common/auth/token-validity.service';
import { createPrismaClient } from '../database/create-prisma-client';
import type { PrismaService } from '../database/prisma.service';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import type { AuthService } from './auth.service';
import {
  encryptSecret,
  newRecoveryCode,
  normalizeRecoveryCode,
  passwordVersion,
  sha256Hex,
} from './crypto.util';
import { ARGON2_OPTIONS } from './password.service';
import type { TotpService } from './totp.service';

const API = '/api/v1/auth';
const PASSWORD = 'Correct-Horse-9';
const SECRET = 'JBSWY3DPEHPK3PXP';

interface Body {
  status: string;
  challengeToken: string;
  manualKey: string;
}

describe('TOTP used-step key after a rolled-back transaction (FU-BE-208, DL-37, FR-101, FR-102)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let orgId: string;
  let authService: AuthService;
  let tokenService: TokenService;
  let totp: TotpService;
  let redis: Redis;
  let appPrisma: PrismaService;
  let validity: TokenValidityService;
  let seq = 0;

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '10000' });
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    orgId = (await prisma.organization.create({ data: { name: 'Mark Org' } })).id;
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    authService = app.get(
      jest.requireActual<typeof import('./auth.service')>('./auth.service').AuthService,
    );
    tokenService = app.get(
      jest.requireActual<typeof import('../common/auth/token.service')>(
        '../common/auth/token.service',
      ).TokenService,
    );
    totp = app.get(
      jest.requireActual<typeof import('./totp.service')>('./totp.service').TotpService,
    );
    redis = app.get<Redis>(
      jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
        '../infrastructure/infrastructure.module',
      ).REDIS_CLIENT,
    );
    appPrisma = app.get(
      jest.requireActual<typeof import('../database/prisma.service')>('../database/prisma.service')
        .PrismaService,
    );
    validity = app.get(
      jest.requireActual<typeof import('../common/auth/token-validity.service')>(
        '../common/auth/token-validity.service',
      ).TokenValidityService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await infra?.stop();
  });

  const lockError = (): Error => Object.assign(new Error('lock wait'), { code: '55P03' });
  // The app was built after jest.resetModules(), so error classes must come from the same registry
  // the service checks with instanceof.
  const p2028 = (): Error => {
    const { Prisma } = jest.requireActual<typeof import('../generated/prisma/client')>(
      '../generated/prisma/client',
    );
    return new Prisma.PrismaClientKnownRequestError('Transaction API error', {
      code: 'P2028',
      clientVersion: 'test',
    });
  };

  async function createUser(opts: {
    role?: UserRole;
    totp: boolean;
  }): Promise<{ id: string; email: string }> {
    const email = `mark${++seq}@example.com`;
    const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
    const user = await prisma.user.create({
      data: {
        orgId,
        email,
        fullName: `Mark ${seq}`,
        role: opts.role ?? UserRole.RECRUITER,
        passwordHash: await hash(PASSWORD, ARGON2_OPTIONS),
        totpSecretEnc: opts.totp ? encryptSecret(SECRET, key) : null,
        totpEnabled: opts.totp,
      },
    });
    return { id: user.id, email };
  }

  const login = (email: string): request.Test =>
    request(app.getHttpServer()).post(`${API}/login`).send({ email, password: PASSWORD });
  const challengeFor = async (email: string): Promise<string> =>
    ((await login(email).expect(200)).body as Body).challengeToken;
  const verify2fa = (challengeToken: string, code: string): request.Test =>
    request(app.getHttpServer()).post(`${API}/2fa/verify`).send({ challengeToken, code });
  const failedLogins = async (id: string): Promise<number> =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).failedLogins;
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
  /** Spies on the private give-back of one reserved attempt (FU-BE-220). */
  const spyRefund = (): jest.SpyInstance =>
    jest.spyOn(authService as unknown as { refundAttempt: () => Promise<void> }, 'refundAttempt');
  const spyOnService = (name: 'audit' | 'startSession' | 'clearFailures'): jest.SpyInstance =>
    jest.spyOn(authService as unknown as Record<typeof name, () => Promise<unknown>>, name);
  /**
   * The transaction runs to its last statement, then the error is thrown from inside the
   * wrapper, so the real transaction rolls back: this models "the commit did not land". Use
   * commitThenFail for the landed case.
   */
  function failAfterCallback(error: () => Error = p2028): jest.SpyInstance {
    const client = appPrisma.client;
    const real = client.$transaction.bind(client) as (
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown,
    ) => Promise<unknown>;
    return jest.spyOn(client, '$transaction').mockImplementationOnce(((
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown,
    ) =>
      real(async (tx) => {
        await fn(tx);
        throw error();
      }, opts)) as unknown as typeof client.$transaction);
  }
  // Scans for the user's used-step keys, so a 30 s step boundary between generating a code and
  // asserting cannot make the check flaky.
  const markKeys = (userId: string): Promise<string[]> => redis.keys(`auth:totp:used:${userId}:*`);
  const markCount = async (userId: string): Promise<number> => (await markKeys(userId)).length;
  const dropMarks = async (userId: string): Promise<void> => {
    for (const k of await markKeys(userId)) await redis.del(k);
  };

  // The commit really lands, then the error is thrown: the worst case for an unknown outcome.
  function commitThenFail(error: () => Error): jest.SpyInstance {
    const client = appPrisma.client;
    const real = client.$transaction.bind(client) as (
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown,
    ) => Promise<unknown>;
    return jest.spyOn(client, '$transaction').mockImplementationOnce((async (
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown,
    ) => {
      await real(fn, opts);
      throw error();
    }) as unknown as typeof client.$transaction);
  }
  const prismaCode = (code: string): Error => {
    const { Prisma } = jest.requireActual<typeof import('../generated/prisma/client')>(
      '../generated/prisma/client',
    );
    return new Prisma.PrismaClientKnownRequestError('driver failure', {
      code,
      clientVersion: 'test',
    });
  };
  const connLost = (): Error =>
    Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  const enabledInDb = async (id: string): Promise<{ on: boolean; hashes: number }> => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { on: u.totpEnabled, hashes: u.recoveryCodeHashes.length };
  };
  const unknownCases: [string, () => Error][] = [
    ['P2028 at COMMIT', p2028],
    ['P1017 at COMMIT', () => prismaCode('P1017')],
    ['a driver connection error after the callback', connLost],
  ];
  const rollbackCases: [string, () => Error][] = [
    ['P2034', () => prismaCode('P2034')],
    ['40001', () => Object.assign(new Error('serialization'), { code: '40001' })],
    ['40P01', () => Object.assign(new Error('deadlock'), { code: '40P01' })],
    [
      'a driver-adapter-shaped 40001 (cause.originalCode)',
      () =>
        Object.assign(prismaCode('P2010'), {
          meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
        }),
    ],
  ];
  /** The 500 is the generic body: no code, no Retry-After, nothing that says whether 2FA is on. */
  function expectFixed500(res: request.Response): void {
    expect(res.status).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBeUndefined();
    expect(body.recoveryCodes).toBeUndefined();
    expect(body.session).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/recovery|enabled|two-factor/i);
  }

  describe('outcome unknown on the two 2FA confirm routes (DL-37, FU-BE-208, FU-BE-214, FR-102)', () => {
    describe('POST /auth/2fa/setup/confirm', () => {
      async function started(): Promise<{ id: string; token: string; key: string }> {
        const u = await createUser({ totp: false });
        const token = await accessFor(u.id);
        const start = (
          await request(app.getHttpServer())
            .post(`${API}/2fa/setup/start`)
            .set('Authorization', `Bearer ${token}`)
            .send({ currentPassword: PASSWORD })
            .expect(200)
        ).body as Body;
        // The confirm now ends the user's access tokens (Redis marker, as disable does); these tests
        // retry with the same token after a rollback, so the marker write is stubbed like disable's.
        jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
        return { id: u.id, token, key: start.manualKey };
      }
      const confirm = (token: string, code: string): request.Test =>
        request(app.getHttpServer())
          .post(`${API}/2fa/setup/confirm`)
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPassword: PASSWORD, code });

      it.each(unknownCases)(
        'DL-37, FU-BE-208, FR-102: %s with the commit landed is the fixed 500; 2FA is on, the mark is kept, the counter is unchanged, and a retry is not counted as a guess',
        async (_n, make) => {
          const e = await started();
          const code = authenticator.generate(e.key);
          const refund = spyRefund();
          commitThenFail(make);
          expectFixed500(await confirm(e.token, code));
          // FU-BE-220: only the password step's refund; none after the landed commit.
          expect(refund).toHaveBeenCalledTimes(1);
          expect(await enabledInDb(e.id)).toEqual({ on: true, hashes: 10 });
          expect(await markCount(e.id)).toBe(1);
          expect(await failedLogins(e.id)).toBe(0);
          // Already on: the retry is the existing 409 and never a second set of recovery codes.
          const retry = await confirm(e.token, code).expect(409);
          expect((retry.body as Record<string, unknown>).recoveryCodes).toBeUndefined();
          expect(await failedLogins(e.id)).toBe(0);
        },
      );

      it('DL-37, FU-BE-208, FR-102: P2028 at COMMIT with the commit NOT landed is the same fixed 500; 2FA is off, the mark stays, and the retry of the code is a replay counted once', async () => {
        const e = await started();
        const code = authenticator.generate(e.key);
        const refund = spyRefund();
        failAfterCallback();
        expectFixed500(await confirm(e.token, code));
        expect(await enabledInDb(e.id)).toEqual({ on: false, hashes: 0 });
        expect(await markCount(e.id)).toBe(1);
        // FU-BE-220: nothing is given back after an unknown outcome: the reservation stays (+1).
        // The only refund call is the password step's, made before the confirm transaction.
        expect(refund).toHaveBeenCalledTimes(1);
        expect(await failedLogins(e.id)).toBe(1);
        await confirm(e.token, code).expect(400);
        expect(await failedLogins(e.id)).toBe(2);
      });

      it('DL-37, FU-BE-208: the unknown-outcome error log carries only traceId, errorName and the route', async () => {
        const e = await started();
        const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
        const spy = jest.spyOn(Logger.prototype, 'error');
        commitThenFail(p2028);
        await confirm(e.token, authenticator.generate(e.key)).expect(500);
        const call = spy.mock.calls.find((c) => c[1] === 'Write outcome unknown');
        const entry = call?.[0] as Record<string, unknown> | undefined;
        expect(entry).toBeDefined();
        expect(entry?.route).toBe('auth.2fa.setup.confirm');
        expect(entry?.errorName).toBe('OutcomeUnknownError');
        expect(Object.keys(entry ?? {}).sort()).toEqual(['errorName', 'route', 'traceId']);
        expect(JSON.stringify(entry)).not.toContain(e.id);
      });

      it.each(rollbackCases)(
        'DL-37, FU-BE-208, FR-102 (PR #279): %s at commit stays 503 BUSY with Retry-After and a code, the mark is released, and the same code then enables 2FA',
        async (_n, make) => {
          const e = await started();
          const code = authenticator.generate(e.key);
          const refund = spyRefund();
          failAfterCallback(make);
          const res = await confirm(e.token, code).expect(503);
          // The password step's refund plus exactly one for the rolled-back confirm (FU-BE-220).
          expect(refund).toHaveBeenCalledTimes(2);
          expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
          expect((res.body as { code?: string }).code).toBe('BUSY');
          expect(await markCount(e.id)).toBe(0);
          expect(await enabledInDb(e.id)).toEqual({ on: false, hashes: 0 });
          await confirm(e.token, code).expect(200);
          expect(await failedLogins(e.id)).toBe(0);
        },
      );

      it('DL-37, FU-BE-208, FR-102: a pre-commit lock timeout (55P03 inside the callback) stays 503 BUSY and the mark is released', async () => {
        const e = await started();
        const code = authenticator.generate(e.key);
        spyOnService('audit').mockRejectedValueOnce(lockError());
        await confirm(e.token, code).expect(503);
        expect(await markCount(e.id)).toBe(0);
        await confirm(e.token, code).expect(200);
      });

      it('DL-37, FU-BE-208, FR-102: a wrong code is never refunded, also next to an unknown outcome (nothing committed)', async () => {
        const e = await started();
        await confirm(e.token, '000000').expect(400);
        expect(await failedLogins(e.id)).toBe(1);
        failAfterCallback();
        expectFixed500(await confirm(e.token, authenticator.generate(e.key)));
        // Wrong guess counted (1) plus the kept reservation of the unknown outcome (FU-BE-220).
        expect(await failedLogins(e.id)).toBe(2);
      });
    });
  });

  describe('login with a TOTP code (completeLogin)', () => {
    it('FU-BE-208, DL-37, FR-102: a clean rollback (503 BUSY) gives the code back: the retry with the SAME code signs in and the failed_logins counter is unchanged', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: true });
      const challenge = await challengeFor(u.email);
      const code = authenticator.generate(SECRET);
      spyOnService('startSession').mockRejectedValueOnce(lockError());
      const res = await verify2fa(challenge, code).expect(503);
      expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(await failedLogins(u.id)).toBe(0);
      await verify2fa(challenge, code).expect(200);
      expect(await failedLogins(u.id)).toBe(0);
    });

    it('FU-BE-208, DL-37, FR-102: a lock error after the refresh-family INSERT returned is an unknown outcome: the mark stays and the retry is a replay counted once', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: true });
      const challenge = await challengeFor(u.email);
      const code = authenticator.generate(SECRET);
      spyOnService('clearFailures').mockRejectedValueOnce(lockError());
      const refund = spyRefund();
      await verify2fa(challenge, code).expect(503);
      expect(await markCount(u.id)).toBe(1);
      // FU-BE-220: the INSERT returned (a landed commit): no refund, the reservation stays (+1).
      expect(refund).not.toHaveBeenCalled();
      expect(await failedLogins(u.id)).toBe(1);
      await verify2fa(challenge, code).expect(400);
      expect(await failedLogins(u.id)).toBe(2);
    });

    it('FU-BE-208, FU-BE-220, DL-37, FR-102: plain login of a user without 2FA: a lock error from clearFailures AFTER the family INSERT returned is 503 BUSY with no refund (counter stays 1)', async () => {
      const u = await createUser({ role: UserRole.RECRUITER, totp: false });
      spyOnService('clearFailures').mockRejectedValueOnce(lockError());
      const refund = spyRefund();
      const res = await login(u.email).expect(503);
      expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(refund).not.toHaveBeenCalled();
      expect(await failedLogins(u.id)).toBe(1);
    });

    it('FU-BE-208, FU-BE-220, DL-37, FR-102: plain login: a lock error from the family INSERT itself (before insert.done) is 503 BUSY and the attempt is refunded once (counter back to 0)', async () => {
      const u = await createUser({ role: UserRole.RECRUITER, totp: false });
      const base = appPrisma.client as unknown as {
        $queryRaw: (...a: unknown[]) => Promise<unknown>;
      };
      const real = base.$queryRaw.bind(base);
      jest.spyOn(base, '$queryRaw').mockImplementation(async (...args: unknown[]) => {
        const text = JSON.stringify((args[0] as { strings?: string[] } | undefined)?.strings ?? '');
        if (text.includes('INSERT INTO refresh_tokens')) throw lockError();
        return real(...args);
      });
      const refund = spyRefund();
      await login(u.email).expect(503);
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await failedLogins(u.id)).toBe(0);
    });

    // FU-BE-219, FU-BE-220: the recovery-code branch is the fifth outcome-unknown route.
    async function recoveryUser(): Promise<{
      id: string;
      email: string;
      recovery: string;
      other: string;
    }> {
      const u = await createUser({ role: UserRole.REVIEWER, totp: true });
      const recovery = newRecoveryCode();
      const other = newRecoveryCode();
      await prisma.user.update({
        where: { id: u.id },
        data: {
          recoveryCodeHashes: [recovery, other].map((c) => sha256Hex(normalizeRecoveryCode(c))),
        },
      });
      return { ...u, recovery, other };
    }
    const expectUnknownLogged = (spy: jest.SpyInstance): void => {
      const calls = spy.mock.calls as unknown[][];
      const call = calls.find((c) => c[1] === 'Write outcome unknown');
      expect((call?.[0] as Record<string, unknown> | undefined)?.route).toBe(
        'auth.2fa.verify.recovery',
      );
    };
    const hashesOf = async (id: string): Promise<string[]> =>
      (await prisma.user.findUniqueOrThrow({ where: { id } })).recoveryCodeHashes;
    const families = (id: string): Promise<number> =>
      prisma.refreshToken.count({ where: { userId: id, revokedAt: null } });

    it.each(unknownCases)(
      'FU-BE-208, FU-BE-219, FU-BE-220, DL-37, FR-102: recovery-code login, %s with the commit LANDED is the fixed 500: code consumed, family exists, challenge stays spent, no refund',
      async (_n, make) => {
        const u = await recoveryUser();
        const challenge = await challengeFor(u.email);
        const refund = spyRefund();
        const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
        const logSpy = jest.spyOn(Logger.prototype, 'error');
        commitThenFail(make);
        const res = await verify2fa(challenge, u.recovery);
        expectFixed500(res);
        expectUnknownLogged(logSpy);
        expect(refund).not.toHaveBeenCalled();
        // The transaction's own clearFailures committed: the counter is what the success path left.
        expect(await failedLogins(u.id)).toBe(0);
        expect(await hashesOf(u.id)).toEqual([sha256Hex(normalizeRecoveryCode(u.other))]);
        expect(await families(u.id)).toBe(1);
        // The challenge stays spent: the retry with another code is refused as an expired challenge.
        const retry = await verify2fa(challenge, u.other);
        expect(retry.status).toBe(401);
        expect(await hashesOf(u.id)).toHaveLength(1);
        expect(await families(u.id)).toBe(1);
      },
    );

    it.each(unknownCases)(
      'FU-BE-208, FU-BE-219, FU-BE-220, DL-37, FR-102: recovery-code login, %s with NOTHING committed is the same 500: code intact, counter keeps the reservation, no refund',
      async (_n, make) => {
        const u = await recoveryUser();
        const challenge = await challengeFor(u.email);
        const refund = spyRefund();
        const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
        const logSpy = jest.spyOn(Logger.prototype, 'error');
        failAfterCallback(make);
        expectFixed500(await verify2fa(challenge, u.recovery));
        expectUnknownLogged(logSpy);
        expect(refund).not.toHaveBeenCalled();
        expect(await failedLogins(u.id)).toBe(1);
        expect(await hashesOf(u.id)).toHaveLength(2);
        expect(await families(u.id)).toBe(0);
        expect((await verify2fa(challenge, u.recovery)).status).toBe(401);
      },
    );

    it.each(rollbackCases)(
      'FU-BE-208, FU-BE-219, FU-BE-220, DL-37, FR-102: recovery-code login, %s at commit is a rollback: 503 BUSY with Retry-After, code intact, challenge released, refunded once, the same code then signs in',
      async (_n, make) => {
        const u = await recoveryUser();
        const challenge = await challengeFor(u.email);
        const refund = spyRefund();
        failAfterCallback(make);
        const res = await verify2fa(challenge, u.recovery).expect(503);
        expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
        expect(refund).toHaveBeenCalledTimes(1);
        expect(await failedLogins(u.id)).toBe(0);
        expect(await hashesOf(u.id)).toHaveLength(2);
        expect(await families(u.id)).toBe(0);
        await verify2fa(challenge, u.recovery).expect(200);
        expect(await hashesOf(u.id)).toHaveLength(1);
      },
    );

    it('FU-BE-208, FU-BE-219, DL-37, FR-102: recovery-code login, a pre-commit lock timeout inside the callback is 503 BUSY: code intact, challenge released, refunded once, the retry signs in', async () => {
      const u = await recoveryUser();
      const challenge = await challengeFor(u.email);
      const refund = spyRefund();
      spyOnService('startSession').mockRejectedValueOnce(lockError());
      const res = await verify2fa(challenge, u.recovery).expect(503);
      expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await failedLogins(u.id)).toBe(0);
      expect(await hashesOf(u.id)).toHaveLength(2);
      await verify2fa(challenge, u.recovery).expect(200);
    });

    it('FU-BE-208, FU-BE-219, DL-37, FR-102: recovery-code login, P2028 INSIDE the callback is a rollback: 503 BUSY, refunded once, code intact', async () => {
      const u = await recoveryUser();
      const challenge = await challengeFor(u.email);
      const refund = spyRefund();
      spyOnService('startSession').mockRejectedValueOnce(p2028());
      await verify2fa(challenge, u.recovery).expect(503);
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await hashesOf(u.id)).toHaveLength(2);
      await verify2fa(challenge, u.recovery).expect(200);
    });

    it('FU-BE-219, FU-BE-220, DL-37, FR-102, TC-002: a WRONG recovery code is still a counted 400 and is never refunded', async () => {
      const u = await recoveryUser();
      const challenge = await challengeFor(u.email);
      const refund = spyRefund();
      await verify2fa(challenge, newRecoveryCode()).expect(400);
      expect(refund).not.toHaveBeenCalled();
      expect(await failedLogins(u.id)).toBe(1);
      expect(await hashesOf(u.id)).toHaveLength(2);
    });

    it('DL-37, FU-BE-208, FU-BE-219: the recovery unknown-outcome error log carries only traceId, errorName and the route', async () => {
      const u = await recoveryUser();
      const challenge = await challengeFor(u.email);
      const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
      const spy = jest.spyOn(Logger.prototype, 'error');
      commitThenFail(p2028);
      await verify2fa(challenge, u.recovery).expect(500);
      const call = spy.mock.calls.find((c) => c[1] === 'Write outcome unknown');
      const entry = call?.[0] as Record<string, unknown> | undefined;
      expect(entry).toBeDefined();
      expect(entry?.route).toBe('auth.2fa.verify.recovery');
      expect(entry?.errorName).toBe('OutcomeUnknownError');
      expect(Object.keys(entry ?? {}).sort()).toEqual(['errorName', 'route', 'traceId']);
      expect(JSON.stringify(entry)).not.toContain(u.id);
      expect(JSON.stringify(entry)).not.toContain(u.recovery);
    });

    it('FU-BE-208, FU-BE-219, DL-37, FR-102: the TOTP branch is unchanged: a P2028 after the family INSERT is not the recovery 500', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: true });
      const challenge = await challengeFor(u.email);
      const { Logger } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
      const logSpy = jest.spyOn(Logger.prototype, 'error');
      spyOnService('clearFailures').mockRejectedValueOnce(p2028());
      const res = await verify2fa(challenge, authenticator.generate(SECRET));
      expect(res.status).toBe(503);
      expect(logSpy.mock.calls.some((c) => c[1] === 'Write outcome unknown')).toBe(false);
    });

    it('FU-BE-208, FR-102: a successful login keeps its mark: the same code cannot be replayed with a fresh challenge', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: true });
      const code = authenticator.generate(SECRET);
      await verify2fa(await challengeFor(u.email), code).expect(200);
      expect(await markCount(u.id)).toBe(1);
      await verify2fa(await challengeFor(u.email), code).expect(400);
    });

    it('FU-BE-208, FR-102, TC-002: wrong codes are still counted and the fifth locks the account; nothing releases', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: true });
      const challenge = await challengeFor(u.email);
      for (let i = 1; i <= 5; i += 1) {
        await verify2fa(challenge, '000000').expect(400);
        expect(await failedLogins(u.id)).toBe(i);
      }
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.lockedUntil).not.toBeNull();
      // Locked: even the right code is refused like a wrong one.
      await verify2fa(challenge, authenticator.generate(SECRET)).expect(400);
    });

    it('FU-BE-208: release deletes only the key this request set, never one set by another request', async () => {
      const u = await createUser({ totp: true });
      const mark: { release?: () => Promise<void> } = {};
      expect(
        await totp.verify(
          u.id,
          encryptSecret(SECRET, Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64')),
          authenticator.generate(SECRET),
          mark,
        ),
      ).toBe(true);
      const [key] = await markKeys(u.id);
      await redis.set(key ?? '', 'someone-else', 'EX', 60);
      await mark.release?.();
      expect(await redis.get(key ?? '')).toBe('someone-else');
      await dropMarks(u.id);
    });

    it('FU-BE-208: release deletes its own unchanged key', async () => {
      const u = await createUser({ totp: true });
      const mark: { release?: () => Promise<void> } = {};
      expect(
        await totp.verify(
          u.id,
          encryptSecret(SECRET, Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64')),
          authenticator.generate(SECRET),
          mark,
        ),
      ).toBe(true);
      expect(await markCount(u.id)).toBe(1);
      await mark.release?.();
      expect(await markCount(u.id)).toBe(0);
    });

    it('FU-BE-208, DL-37, FR-102: a REAL 55P03 on the refresh-family INSERT (row lock held elsewhere, short lock_timeout) is 503 BUSY, releases the mark, and the retry with the SAME code signs in', async () => {
      const u = await createUser({ role: UserRole.REVIEWER, totp: true });
      const challenge = await challengeFor(u.email);
      const code = authenticator.generate(SECRET);
      const holder = new Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      const base = appPrisma.client as unknown as {
        $queryRaw: (...a: unknown[]) => Promise<unknown>;
      };
      const real = base.$queryRaw.bind(base);
      const spy = jest.spyOn(base, '$queryRaw').mockImplementation(async (...args: unknown[]) => {
        const text = JSON.stringify((args[0] as { strings?: string[] } | undefined)?.strings ?? '');
        if (!text.includes('INSERT INTO refresh_tokens')) return real(...args);
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [u.id]);
        try {
          return await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '200ms'`);
            return (tx.$queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
          });
        } finally {
          // Free the row at once: the request's own refund UPDATE must not wait on the holder.
          await holder.query('ROLLBACK');
        }
      });
      try {
        await verify2fa(challenge, code).expect(503);
        expect(await markCount(u.id)).toBe(0);
      } finally {
        spy.mockRestore();
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
      await verify2fa(challenge, code).expect(200);
      expect(await failedLogins(u.id)).toBe(0);
    });
  });

  describe('enrollment confirm, signed in (confirmEnrollment)', () => {
    async function startedEnrollment(): Promise<{ id: string; token: string; key: string }> {
      const u = await createUser({ totp: false });
      const token = await accessFor(u.id);
      const start = (
        await request(app.getHttpServer())
          .post(`${API}/2fa/setup/start`)
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPassword: PASSWORD })
          .expect(200)
      ).body as Body;
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      return { id: u.id, token, key: start.manualKey };
    }
    const confirm = (token: string, code: string): request.Test =>
      request(app.getHttpServer())
        .post(`${API}/2fa/setup/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, code });

    it('FU-BE-208, DL-37, FR-102: a clean rollback inside the transaction (55P03, 503 BUSY) gives the code back: the retry with the SAME code enables TOTP, counter unchanged', async () => {
      const e = await startedEnrollment();
      const code = authenticator.generate(e.key);
      spyOnService('audit').mockRejectedValueOnce(lockError());
      await confirm(e.token, code).expect(503);
      expect(await failedLogins(e.id)).toBe(0);
      await confirm(e.token, code).expect(200);
      expect(await failedLogins(e.id)).toBe(0);
    });

    it('FU-BE-208, DL-37, FR-102: P2028 after the callback finished is the fixed 500 (not 503) and keeps the mark: the retry is a replay, counted once', async () => {
      const e = await startedEnrollment();
      const code = authenticator.generate(e.key);
      failAfterCallback();
      const res = await confirm(e.token, code).expect(500);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(await markCount(e.id)).toBe(1);
      await confirm(e.token, code).expect(400);
      expect(await failedLogins(e.id)).toBe(2); // kept reservation + counted replay (FU-BE-220)
    });

    it('FU-BE-208, DL-37, FR-102: P2028 INSIDE the callback and 40P01 at commit are rollbacks: each gives the code back', async () => {
      const e = await startedEnrollment();
      const code = authenticator.generate(e.key);
      spyOnService('audit').mockRejectedValueOnce(p2028());
      await confirm(e.token, code).expect(503);
      failAfterCallback(() => Object.assign(new Error('deadlock'), { code: '40P01' }));
      await confirm(e.token, code).expect(503);
      await confirm(e.token, code).expect(200);
      expect(await failedLogins(e.id)).toBe(0);
    });

    it('FU-BE-208, DL-37, FR-102: 40001 at commit is a rollback: the code comes back', async () => {
      const e = await startedEnrollment();
      const code = authenticator.generate(e.key);
      failAfterCallback(() => Object.assign(new Error('serialization'), { code: '40001' }));
      await confirm(e.token, code).expect(503);
      await confirm(e.token, code).expect(200);
    });

    it('FU-BE-208, FR-102: a non-lock error inside the callback (AlreadyEnrolledSignal, 409) keeps the mark', async () => {
      const e = await startedEnrollment();
      const code = authenticator.generate(e.key);
      const realVerify = totp.verify.bind(totp);
      jest.spyOn(totp, 'verify').mockImplementationOnce(async (...args) => {
        const ok = await realVerify(...args);
        await prisma.user.update({ where: { id: e.id }, data: { totpSecretEnc: null } });
        return ok;
      });
      await confirm(e.token, code).expect(409);
      expect(await markCount(e.id)).toBe(1);
    });

    it('FU-BE-208, FR-102: wrong enrollment codes still count and lock at 5', async () => {
      const e = await startedEnrollment();
      for (let i = 1; i <= 5; i += 1) {
        await confirm(e.token, '000000').expect(400);
        expect(await failedLogins(e.id)).toBe(i);
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: e.id } })).lockedUntil).not.toBe(
        null,
      );
    });
  });

  describe('disable 2FA (disableTwoFactor)', () => {
    const disable = (token: string, totpCode: string): request.Test =>
      request(app.getHttpServer())
        .post(`${API}/2fa/disable`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, totpCode });
    async function enrolled(): Promise<{ id: string; token: string }> {
      const u = await createUser({ totp: true });
      return { id: u.id, token: await accessFor(u.id) };
    }

    it('FU-BE-208, DL-37, FR-102: a clean rollback (55P03, 503 BUSY) gives the code back: the retry with the SAME code disables 2FA, counter unchanged', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      jest.spyOn(validity, 'invalidateIssuedTokens').mockRejectedValueOnce(lockError());
      await disable(d.token, code).expect(503);
      expect(await failedLogins(d.id)).toBe(0);
      await disable(d.token, code).expect(204);
      expect(await failedLogins(d.id)).toBe(0);
    });

    it('FU-BE-208, DL-37, FR-102: P2034 at COMMIT on disable is a rollback: 503 BUSY and the same code then disables 2FA (204)', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      failAfterCallback(() => prismaCode('P2034'));
      const res = await disable(d.token, code).expect(503);
      expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      await disable(d.token, code).expect(204);
      expect(await failedLogins(d.id)).toBe(0);
    });

    it('FU-BE-208, DL-37, FR-102: a Redis outage while writing the token marker (our own 503 inside the transaction) is a clean rollback too', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      const { ServiceUnavailableException } =
        jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
      jest
        .spyOn(validity, 'invalidateIssuedTokens')
        .mockRejectedValueOnce(new ServiceUnavailableException('down'));
      await disable(d.token, code).expect(503);
      await disable(d.token, code).expect(204);
      expect(await failedLogins(d.id)).toBe(0);
    });

    it.each(unknownCases)(
      'FU-BE-208, FU-BE-219, DL-37, FR-102: %s with the commit landed is the fixed 500; 2FA is off, the mark is kept, no refund after it, and (token marker mocked) the retry is a 409',
      async (_n, make) => {
        const d = await enrolled();
        const code = authenticator.generate(SECRET);
        jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
        const refund = spyRefund();
        commitThenFail(make);
        expectFixed500(await disable(d.token, code));
        // The password step and the pre-transaction refund; none after the unknown outcome.
        expect(refund).toHaveBeenCalledTimes(2);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: d.id } })).totpEnabled).toBe(
          false,
        );
        expect(await markCount(d.id)).toBe(1);
        expect(await failedLogins(d.id)).toBe(0);
        // 2FA is already off: the retry is the existing 409, never a second disable.
        await disable(d.token, code).expect(409);
      },
    );

    it('FU-BE-208, FU-BE-219, DL-37, FR-102: with the REAL token marker, a landed disable ends the caller token: the retry is 401 (the real web flow)', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      commitThenFail(p2028);
      expectFixed500(await disable(d.token, code));
      expect((await prisma.user.findUniqueOrThrow({ where: { id: d.id } })).totpEnabled).toBe(
        false,
      );
      await disable(d.token, code).expect(401);
    });

    it('FU-BE-208, FU-BE-219, DL-37, FR-102: P2028 at COMMIT with nothing committed is the same fixed 500; 2FA stays on, the mark is kept, and the retry is a counted replay (403)', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      failAfterCallback();
      expectFixed500(await disable(d.token, code));
      expect((await prisma.user.findUniqueOrThrow({ where: { id: d.id } })).totpEnabled).toBe(true);
      expect(await markCount(d.id)).toBe(1);
      await disable(d.token, code).expect(403);
      expect(await failedLogins(d.id)).toBe(1);
    });

    it.each(rollbackCases)(
      'FU-BE-208, FU-BE-219, DL-37, FR-102: %s at commit on disable stays 503 BUSY and the same code then disables 2FA (204)',
      async (_n, make) => {
        const d = await enrolled();
        const code = authenticator.generate(SECRET);
        jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
        failAfterCallback(make);
        const res = await disable(d.token, code).expect(503);
        expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
        await disable(d.token, code).expect(204);
      },
    );

    it('FU-BE-208, DL-37, FR-102: P2028 INSIDE the callback and 40P01 at commit are rollbacks: each gives the code back', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      jest.spyOn(validity, 'invalidateIssuedTokens').mockRejectedValueOnce(p2028());
      await disable(d.token, code).expect(503);
      // The token marker would end the caller's token at once; keep the token usable for the retry.
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      failAfterCallback(() => Object.assign(new Error('deadlock'), { code: '40P01' }));
      await disable(d.token, code).expect(503);
      await disable(d.token, code).expect(204);
      expect(await failedLogins(d.id)).toBe(0);
    });

    it('FU-BE-208, DL-37, FR-102: 40001 at commit is a rollback: the code comes back', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      failAfterCallback(() => Object.assign(new Error('serialization'), { code: '40001' }));
      await disable(d.token, code).expect(503);
      await disable(d.token, code).expect(204);
    });

    it('FU-BE-208, FR-102: a non-lock refusal inside the callback (409 from explainRefusedChange) keeps the mark', async () => {
      const d = await enrolled();
      const code = authenticator.generate(SECRET);
      const realVerify = totp.verify.bind(totp);
      jest.spyOn(totp, 'verify').mockImplementationOnce(async (...args) => {
        const ok = await realVerify(...args);
        await prisma.user.update({ where: { id: d.id }, data: { totpSecretEnc: null } });
        return ok;
      });
      await disable(d.token, code).expect(409);
      expect(await markCount(d.id)).toBe(1);
    });

    it('FU-BE-208, FR-102: wrong codes still count and lock at 5', async () => {
      const d = await enrolled();
      for (let i = 1; i <= 5; i += 1) {
        await disable(d.token, '000000').expect(403);
        expect(await failedLogins(d.id)).toBe(i);
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: d.id } })).lockedUntil).not.toBe(
        null,
      );
    });
  });
});
