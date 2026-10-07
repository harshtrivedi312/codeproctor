// FR-104, TC-005, DL-37, FU-BE-207: the refresh rotation transaction inserts the new token and
// revokes the old one. Only a clean pre-commit failure may answer 503 BUSY (a retry with the same
// token is safe); an outcome-unknown failure answers the fixed 401, so the client signs in again
// instead of retrying with a token that may already be revoked (which reuse detection would read
// as theft and kill the family). Hub ruling FU-BE-207 (pool exhaustion is FU-BE-197). No TC id covers the failure split; names cite FR-104/TC-005.
import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import type { OrgContextService } from '../database/org-context';
import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import { ARGON2_OPTIONS } from './password.service';

const API = '/api/v1/auth';
const PASSWORD = 'Correct-Horse-9';

type Tx = Prisma.TransactionClient;
type TxCallback = (tx: Tx) => Promise<unknown>;
type TransactionFn = (cb: TxCallback, ...rest: unknown[]) => Promise<unknown>;

class RollbackProbe extends Error {}

function pgError(code: string): Error {
  return Object.assign(new Error('synthetic database failure'), { code });
}

function prismaError(code: string): Error {
  // The app loads its own module copy after jest.resetModules; instanceof needs that same class.
  const { Prisma: AppPrisma } = jest.requireActual<typeof import('../generated/prisma/client')>(
    '../generated/prisma/client',
  );
  return new AppPrisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: 'test',
  });
}

const p2028 = (): Error => prismaError('P2028');

describe('Refresh rotation failure split (FR-104, TC-005, DL-37, FU-BE-207)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let svc: PrismaService;
  let orgContext: OrgContextService;
  let orgId: string;
  let seq = 0;
  let logged: string[] = [];
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
    orgId = (await prisma.organization.create({ data: { name: 'Busy Org' } })).id;
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { PrismaService: Svc } = jest.requireActual<typeof import('../database/prisma.service')>(
      '../database/prisma.service',
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    svc = app.get(Svc);
    const { OrgContextService: Ctx } =
      jest.requireActual<typeof import('../database/org-context')>('../database/org-context');
    orgContext = app.get(Ctx);
  });

  afterAll(async () => {
    stdout.mockRestore();
    await app?.close();
    await prisma?.$disconnect();
    await infra?.stop();
  });

  // restoreAllMocks would also undo the stdout capture; restore only the transaction stub.
  let txSpy: jest.SpyInstance | undefined;
  const restoreTransaction = (): void => {
    txSpy?.mockRestore();
    txSpy = undefined;
  };
  afterEach(restoreTransaction);

  function refreshCookie(res: request.Response): string {
    const header = res.headers['set-cookie'] as unknown as string[] | undefined;
    const raw = (header ?? []).find((c) => c.startsWith('cp_refresh='));
    if (!raw) throw new Error('no refresh cookie');
    return raw.split(';')[0] ?? '';
  }

  async function signedIn(): Promise<{ userId: string; cookie: string }> {
    const email = `busy${++seq}@example.com`;
    const user = await prisma.user.create({
      data: {
        orgId,
        email,
        fullName: `Busy ${seq}`,
        role: UserRole.RECRUITER,
        passwordHash: await hash(PASSWORD, ARGON2_OPTIONS),
      },
    });
    const res = await request(app.getHttpServer())
      .post(`${API}/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return { userId: user.id, cookie: refreshCookie(res) };
  }

  const refresh = (cookie: string): request.Test =>
    request(app.getHttpServer()).post(`${API}/refresh`).set('Cookie', cookie);

  /** Replace $transaction on the scoped client; `real` is the original, bound. */
  function stubTransaction(make: (real: TransactionFn) => TransactionFn): void {
    const client = svc.client as unknown as { $transaction: TransactionFn };
    const real = client.$transaction.bind(client);
    txSpy = jest.spyOn(client, '$transaction').mockImplementation(make(real));
  }

  /** The real callback runs; `fail` replaces what the caller sees afterwards. */
  function failAfterCallback(fail: () => Error, commit: boolean): void {
    stubTransaction((real) => async (cb, ...rest) => {
      if (commit) {
        await real(cb, ...rest);
      } else {
        // Run the callback, then roll back: the callback finished, nothing committed.
        await real(
          async (tx) => {
            await cb(tx);
            throw new RollbackProbe();
          },
          ...rest,
        ).catch((e: unknown) => {
          if (!(e instanceof RollbackProbe)) throw e;
        });
      }
      throw fail();
    });
  }

  /** A statement inside the callback fails with `err`; the real transaction rolls back. */
  function failInsideCallback(err: Error): void {
    stubTransaction(
      (real) =>
        (cb, ...rest) =>
          real(
            (tx) =>
              cb(
                new Proxy(tx, {
                  get: (target, key, receiver): unknown =>
                    key === '$queryRaw'
                      ? () => Promise.reject(err)
                      : (Reflect.get(target, key, receiver) as unknown),
                }),
              ),
            ...rest,
          ),
    );
  }

  const clearing = (res: request.Response): string[] =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).filter((c) =>
      c.startsWith('cp_refresh='),
    );

  /** The fixed 401; `clears` says whether the response clears cp_refresh (outcome unknown only). */
  function expectFixed401(res: request.Response, clears: boolean): void {
    expect(clearing(res)).toHaveLength(clears ? 1 : 0);
    expect(res.status).toBe(401);
    expect(res.headers['retry-after']).toBeUndefined();
    expect((res.body as { code?: string }).code).toBeUndefined();
    expect((res.body as { detail?: string }).detail).toBe('Authentication required.');
  }

  function expectBusy(res: request.Response): void {
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    expect((res.body as { code?: string }).code).toBe('BUSY');
    // A BUSY retry is safe, so the cookie stays.
    expect(String(res.headers['set-cookie'] ?? '')).not.toContain('cp_refresh=');
  }

  const liveCount = (userId: string): Promise<number> =>
    prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  it('FR-104, TC-005, DL-37, FU-BE-207: P2028 at commit (the commit really landed) is the fixed 401, the family is not revoked, and a later retry with the old token is reuse', async () => {
    const { userId, cookie } = await signedIn();
    failAfterCallback(p2028, true);
    expectFixed401(await refresh(cookie), true);
    restoreTransaction();
    // The new token was inserted and the old one flipped; nothing was revoked by the failure.
    expect(await liveCount(userId)).toBe(1);
    // Real DB state decides a later retry: the old token is revoked, so reuse detection applies.
    await refresh(cookie).expect(401);
    expect(await liveCount(userId)).toBe(0);
  });

  it('FR-104, TC-005, DL-37, FU-BE-207: P2028 after the callback finished with nothing committed is the fixed 401, no state change, and the old token still works', async () => {
    const { userId, cookie } = await signedIn();
    failAfterCallback(p2028, false);
    expectFixed401(await refresh(cookie), true);
    restoreTransaction();
    expect(await liveCount(userId)).toBe(1);
    await refresh(cookie).expect(200);
  });

  it.each([true, false])(
    'FR-104, DL-37, FU-BE-207: a lost connection after the callback finished (commit landed: %s) is the fixed 401, and the error log carries a name and fixed tokens, never the message',
    async (commit) => {
      const { userId, cookie } = await signedIn();
      logged = [];
      failAfterCallback(
        () => new Error('Connection terminated unexpectedly secret-marker'),
        commit,
      );
      expectFixed401(await refresh(cookie), true);
      restoreTransaction();
      expect(await liveCount(userId)).toBe(1);
      const lines = logged.join('');
      expect(lines).toContain('REFRESH_ROTATE_UNKNOWN');
      expect(lines).not.toContain('secret-marker');
    },
  );

  it.each([
    ['40001', () => pgError('40001')],
    ['40P01', () => pgError('40P01')],
    ['P2034', () => prismaError('P2034')],
  ])(
    'FR-104, DL-37, FU-BE-207: %s at commit (after the callback returned) is a rollback: 503 BUSY, cookie kept, and the old token still works',
    async (_name, make) => {
      const { userId, cookie } = await signedIn();
      failAfterCallback(make, false);
      expectBusy(await refresh(cookie));
      restoreTransaction();
      expect(await liveCount(userId)).toBe(1);
      await refresh(cookie).expect(200);
    },
  );

  it('FR-104, DL-37, FU-BE-207: P2028 thrown from inside the callback (the transaction timing out mid-callback) is a rollback: 503 BUSY', async () => {
    const { userId, cookie } = await signedIn();
    failInsideCallback(p2028());
    expectBusy(await refresh(cookie));
    restoreTransaction();
    expect(await liveCount(userId)).toBe(1);
    await refresh(cookie).expect(200);
  });

  it('FR-104, DL-37, FU-BE-207: P2034 inside the callback is a clean rollback: 503 BUSY', async () => {
    const { cookie } = await signedIn();
    failInsideCallback(prismaError('P2034'));
    expectBusy(await refresh(cookie));
    restoreTransaction();
    await refresh(cookie).expect(200);
  });

  it('FR-104, DL-37, FU-BE-207: a non-database error inside the callback is the ordinary 401: no cookie clearing, no state change, and the old token still works', async () => {
    const { userId, cookie } = await signedIn();
    failInsideCallback(new TypeError('synthetic'));
    expectFixed401(await refresh(cookie), false);
    restoreTransaction();
    expect(await liveCount(userId)).toBe(1);
  });

  it('FR-104, TC-005, DL-37, FU-BE-207: the outcome-unknown 401 clears cp_refresh, writes no audit row, and a later request without the cookie raises no reuse alert', async () => {
    const { userId, cookie } = await signedIn();
    failAfterCallback(p2028, true);
    const res = await refresh(cookie);
    restoreTransaction();
    expectFixed401(res, true);
    const set = clearing(res);
    expect(set[0]).toMatch(/^cp_refresh=;/);
    expect(set[0]).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(set[0]).toContain('Path=/api/v1/auth');
    expect(set[0]).toContain('HttpOnly');
    expect(set[0]).toContain('Secure');
    expect(set[0]).toContain('SameSite=Strict');
    const reuse = (): Promise<number> =>
      prisma.auditLog.count({ where: { actorId: userId, action: 'AUTH_REFRESH_REUSE_DETECTED' } });
    expect(await reuse()).toBe(0);
    // The browser dropped the cookie: the next load sends none, so nothing trips reuse detection.
    await request(app.getHttpServer()).post(`${API}/refresh`).expect(401);
    expect(await reuse()).toBe(0);
    expect(await liveCount(userId)).toBe(1);
  });

  it('FR-104, TC-005, FU-BE-207: an ordinary 401 (no cookie, tampered cookie, unknown, reuse) never clears cp_refresh', async () => {
    const bare = await request(app.getHttpServer()).post(`${API}/refresh`);
    expectFixed401(bare, false);
    expectFixed401(await refresh('cp_refresh=s%3Anot-a-valid-signature.AAAA'), false);
    const { cookie } = await signedIn();
    await refresh(cookie).expect(200);
    // The rotated-away token coming back is reuse: the 401 is ordinary, so a winning tab's new
    // cookie is not wiped.
    expectFixed401(await refresh(cookie), false);
  });

  it('FR-104, TC-005, DL-37, FU-BE-207: a forced 55P03 on revokeFamily during reuse is the ordinary 401 after bounded retries, never 503, and the error line fires', async () => {
    const { userId, cookie } = await signedIn();
    await refresh(cookie).expect(200);
    const model = svc.client.refreshToken as unknown as {
      updateMany: (...a: unknown[]) => Promise<unknown>;
    };
    const spy = jest.spyOn(model, 'updateMany').mockRejectedValue(pgError('55P03'));
    logged = [];
    try {
      expectFixed401(await refresh(cookie), false);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
    const lines = logged.join('');
    expect(lines).toContain('REFRESH_REVOKE_FAILED');
    expect(lines).not.toContain('synthetic database failure');
    expect(await liveCount(userId)).toBe(1);
  });

  it('FR-104, DL-37, FU-BE-207: a real 55P03 on the FOR SHARE of the user row (lock held elsewhere, short lock_timeout) is 503 BUSY, and the old token works after the lock is released', async () => {
    const { userId, cookie } = await signedIn();
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    stubTransaction(
      (real) =>
        (cb, ...rest) =>
          real(
            async (tx) => {
              return cb(
                new Proxy(tx, {
                  get: (target, key, receiver): unknown => {
                    const value = Reflect.get(target, key, receiver) as unknown;
                    if (key !== '$queryRaw' || typeof value !== 'function') return value;
                    // Every $queryRaw of the rotation is preceded by a short SET LOCAL lock_timeout.
                    return async (...args: unknown[]) => {
                      await orgContext.runRawSql('test: short lock_timeout for a real 55P03', () =>
                        target.$executeRawUnsafe(`SET LOCAL lock_timeout = '200ms'`),
                      );
                      return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
                    };
                  },
                }),
              );
            },
            ...rest,
          ),
    );
    try {
      await holder.query('BEGIN');
      const held = await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      expect(held.rowCount).toBe(1);
      expectBusy(await refresh(cookie));
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
      restoreTransaction();
    }
    await refresh(cookie).expect(200);
  });

  it.each(['55P03', '40001', '40P01'])(
    'FR-104, DL-37, FU-BE-207: SQLSTATE %s on a statement inside the callback is a clean rollback: 503 BUSY with Retry-After, and the old token still works',
    async (code) => {
      const { cookie } = await signedIn();
      failInsideCallback(pgError(code));
      expectBusy(await refresh(cookie));
      restoreTransaction();
      await refresh(cookie).expect(200);
    },
  );

  it('FR-104, DL-37, FU-BE-207: contention or a start timeout before the transaction begins is 503 BUSY with Retry-After, and the old token still works', async () => {
    const { cookie } = await signedIn();
    for (const err of [pgError('55P03'), p2028()]) {
      stubTransaction(() => () => Promise.reject(err));
      expectBusy(await refresh(cookie));
      restoreTransaction();
    }
    await refresh(cookie).expect(200);
  });

  it('FR-104, TC-005: the existing reuse detection is unchanged (a rotated token revokes the family)', async () => {
    const { userId, cookie } = await signedIn();
    const next = refreshCookie(await refresh(cookie).expect(200));
    await refresh(cookie).expect(401);
    expect(await liveCount(userId)).toBe(0);
    await refresh(next).expect(401);
  });
});
