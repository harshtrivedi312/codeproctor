// What BE-02's auth needs from the scoped client before it moves onto it (DB-05 add-on):
//
//   1. Raw SQL works inside system scope (and inside an org scope) through runRawSql, and is
//      still refused outside it. Auth's lockout counter and recovery-code consume are raw SQL.
//   2. Interactive and batch transactions work inside system scope, keep it, and accept raw SQL.
//      Auth rotates refresh tokens and enrols TOTP in transactions.
//   3. Entering a scope, and the extension itself, send no SQL of their own. Auth has a test that
//      counts statements for unknown, wrong and locked logins, so any extra query would show.
//
// Real Postgres 16 (Testcontainers; Docker is required) with the real migrations, connected as
// app_user. Postgres runs with pg_stat_statements, so the statement counts are what the server
// saw, not what the client thinks it sent.
import { Controller, Get, INestApplication, NotFoundException, Param } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Roles } from '../common/auth/decorators';
import { passwordVersion } from '../auth/crypto.util';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { TokenModule, TokenService } from '../common/auth/token.service';
import { TokenValidityService } from '../common/auth/token-validity.service';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { DatabaseModule } from './database.module';
import { OrgContextMissingError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import { OrgContextService } from './org-context';
import type { AuthenticatedUser } from './org-context';
import { PrismaService } from './prisma.service';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase, StatementCount } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { TenantFixture } from './testing/tenant-fixtures';

const JWT_SECRET = 'a-secret-for-the-auth-bootstrap-tests-only';
const WHY = 'auth bootstrap: the same raw statement BE-02 runs today';

@Controller('probe')
class ProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('users/:id')
  @Roles('RECRUITER')
  async user(@Param('id') id: string): Promise<{ id: string }> {
    const row = await this.prisma.client.user.findUnique({ where: { id } });
    if (row === null) throw new NotFoundException();
    return { id: row.id };
  }
}

describe('auth bootstrap on the scoped client (NFR-04, FR-104)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let plain: PrismaClient; // the factory's client with no extension: the baseline
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let orgContext: OrgContextService;
  let A: TenantFixture;
  let B: TenantFixture;
  let userA: AuthenticatedUser;

  /** The scoped client typed as a plain one, so one function can run on both. */
  const scoped = (): PrismaClient => prisma.client as unknown as PrismaClient;
  const system = <T>(fn: () => Promise<T>): Promise<T> =>
    orgContext.runSystem('AUTH_BOOTSTRAP', fn);
  const rawSql = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runRawSql(WHY, fn);
  const failedLogins = async (tenant: TenantFixture): Promise<number> =>
    (await owner.user.findUniqueOrThrow({ where: { id: tenant.userId } })).failedLogins;

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    plain = createPrismaClient(db.appUserUrl);
    A = await createTenant(owner, 'a');
    B = await createTenant(owner, 'b');
    await owner.user.update({
      where: { id: A.userId },
      data: { recoveryCodeHashes: ['hash-1', 'hash-2'] },
    });
    userA = { orgId: A.orgId, userId: A.userId, role: 'RECRUITER' };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: db.appUserUrl, JWT_ACCESS_SECRET: JWT_SECRET })],
        }),
        TokenModule,
        DatabaseModule,
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    })
      // The guard's Redis marker check (S1) is not under test here: no token is invalidated.
      .overrideProvider(TokenValidityService)
      .useValue({ isFresh: () => Promise.resolve(true) })
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0);
    prisma = app.get(PrismaService);
    orgContext = app.get(OrgContextService);
  });

  afterAll(async () => {
    await app?.close();
    await plain?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  // ---- 1. raw SQL inside system scope and org scopes ------------------------------------------

  describe('raw SQL through runRawSql', () => {
    const lockoutCounter = (id: string): Prisma.Sql => Prisma.sql`
      UPDATE users SET failed_logins = failed_logins + 1, updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING failed_logins`;

    it('NFR-04 runRawSql works nested inside runSystem(AUTH_BOOTSTRAP), for every raw form', async () => {
      const before = await failedLogins(A);
      const rows = await system(() =>
        rawSql(() => scoped().$queryRaw<{ failed_logins: number }[]>(lockoutCounter(A.userId))),
      );
      expect(rows).toEqual([{ failed_logins: before + 1 }]);

      const changed = await system(() =>
        rawSql(
          () =>
            scoped().$executeRaw`UPDATE users SET failed_logins = 0 WHERE id = ${A.userId}::uuid`,
        ),
      );
      expect(changed).toBe(1);

      const unsafeRows = await system(() =>
        rawSql(() =>
          scoped().$queryRawUnsafe<{ n: number }[]>(
            'SELECT count(*)::int AS n FROM users WHERE id = $1::uuid',
            A.userId,
          ),
        ),
      );
      expect(unsafeRows).toEqual([{ n: 1 }]);

      const unsafeChanged = await system(() =>
        rawSql(() =>
          scoped().$executeRawUnsafe(
            'UPDATE users SET failed_logins = 0 WHERE id = $1::uuid',
            A.userId,
          ),
        ),
      );
      expect(unsafeChanged).toBe(1);
    });

    it('NFR-04 the recovery-code consume statement works inside system scope, and is atomic', async () => {
      const consume = (hash: string): Promise<number> =>
        system(() =>
          rawSql(
            () => scoped().$executeRaw`
              UPDATE users SET recovery_code_hashes = array_remove(recovery_code_hashes, ${hash}),
                               updated_at = now()
              WHERE id = ${A.userId}::uuid AND ${hash} = ANY(recovery_code_hashes)`,
          ),
        );
      expect(await consume('hash-1')).toBe(1);
      expect(await consume('hash-1')).toBe(0); // already used: no second win
      expect(
        (await owner.user.findUniqueOrThrow({ where: { id: A.userId } })).recoveryCodeHashes,
      ).toEqual(['hash-2']);
    });

    it('NFR-04 the nesting works in either order, but runRawSql needs an active scope', async () => {
      const count = (): Promise<{ n: number }[]> =>
        scoped().$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
      expect((await system(() => rawSql(count)))[0]?.n).toBeGreaterThanOrEqual(2);
      // The hatch alone is not a scope.
      expect(() => rawSql(count)).toThrow(OrgContextMissingError);
      expect(
        (await orgContext.runInOrg(A.orgId, () => rawSql(count)))[0]?.n,
      ).toBeGreaterThanOrEqual(2);
    });

    it('NFR-04 runRawSql works nested inside runAsUser and runInOrg, and model queries there stay scoped', async () => {
      const inUser = await orgContext.runAsUser(userA, () =>
        rawSql(async () => ({
          raw: await scoped().$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM users`,
          scopedUsers: await prisma.client.user.findMany(),
        })),
      );
      expect(inUser.raw[0]?.n).toBeGreaterThanOrEqual(2); // raw SQL is not filtered
      expect(inUser.scopedUsers.map((u) => u.orgId)).toEqual([A.orgId]);

      const inOrg = await orgContext.runInOrg(A.orgId, () =>
        rawSql(
          () =>
            scoped().$executeRaw`UPDATE users SET failed_logins = 0 WHERE id = ${A.userId}::uuid`,
        ),
      );
      expect(inOrg).toBe(1);
    });

    it('NFR-04 raw SQL is still refused outside runRawSql: in system scope, in org scopes, and after the block', async () => {
      const attempt = (): Promise<unknown> => scoped().$queryRaw`SELECT 1`;
      await expect(system(attempt)).rejects.toBeInstanceOf(RawQueryNotAllowedError);
      await expect(orgContext.runAsUser(userA, attempt)).rejects.toBeInstanceOf(
        RawQueryNotAllowedError,
      );
      await expect(orgContext.runInOrg(A.orgId, attempt)).rejects.toBeInstanceOf(
        RawQueryNotAllowedError,
      );
      // Inside the same system scope, the hatch covers only its own block.
      await system(async () => {
        await rawSql(() => scoped().$queryRaw`SELECT 1`);
        await expect(attempt()).rejects.toBeInstanceOf(RawQueryNotAllowedError);
      });
    });

    it('NFR-04 the hatch of one unit of work does not open raw SQL for a concurrent one', async () => {
      const slow = system(() =>
        rawSql(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return scoped().$queryRaw`SELECT 1 AS one`;
        }),
      );
      const refused = system(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return scoped().$queryRaw`SELECT 1 AS one`;
      });
      await expect(refused).rejects.toBeInstanceOf(RawQueryNotAllowedError);
      await expect(slow).resolves.toEqual([{ one: 1 }]);
    });

    it('NFR-04 system scope may narrow to the user once the user is known, and returns to system scope after', async () => {
      await system(async () => {
        const user = await prisma.client.user.findUnique({ where: { id: B.userId } }); // pre-login lookup
        expect(user?.orgId).toBe(B.orgId);
        await orgContext.runAsUser(
          { orgId: B.orgId, userId: B.userId, role: 'RECRUITER' },
          async () => {
            expect((await prisma.client.user.findMany()).map((u) => u.orgId)).toEqual([B.orgId]);
            await expect(scoped().$queryRaw`SELECT 1`).rejects.toBeInstanceOf(
              RawQueryNotAllowedError,
            );
            expect(await rawSql(() => scoped().$queryRaw`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
          },
        );
        // Back in system scope: unfiltered again.
        expect(new Set((await prisma.client.user.findMany()).map((u) => u.orgId)).size).toBe(2);
        expect(orgContext.current()?.scope).toEqual({ kind: 'system', reason: 'AUTH_BOOTSTRAP' });
      });
    });

    it('NFR-04 an org scope still cannot widen to system scope', async () => {
      await orgContext.runAsUser(userA, async () => {
        await Promise.resolve();
        expect(() => orgContext.runSystem('AUTH_BOOTSTRAP', () => undefined)).toThrow(
          OrgScopeViolationError,
        );
      });
    });
  });

  // ---- 2. transactions inside system scope ----------------------------------------------------

  describe('transactions inside runSystem(AUTH_BOOTSTRAP)', () => {
    it('NFR-04 an interactive transaction keeps system scope and commits its writes', async () => {
      const tokenHash = `rt-${randomUUID()}`;
      const result = await system(() =>
        prisma.client.$transaction(async (tx) => {
          const scope = orgContext.current()?.scope;
          const everyOrg = await tx.user.findMany();
          const created = await tx.refreshToken.create({
            data: {
              userId: A.userId,
              familyId: randomUUID(),
              tokenHash,
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
          const flipped = await tx.refreshToken.updateMany({
            where: { id: created.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return { scope, orgs: new Set(everyOrg.map((u) => u.orgId)), flipped: flipped.count };
        }),
      );
      expect(result.scope).toEqual({ kind: 'system', reason: 'AUTH_BOOTSTRAP' });
      expect(result.orgs).toEqual(new Set([A.orgId, B.orgId]));
      expect(result.flipped).toBe(1);
      expect(await owner.refreshToken.count({ where: { tokenHash } })).toBe(1);
    });

    it('NFR-04 an interactive transaction rolls back when its callback throws', async () => {
      const tokenHash = `rt-${randomUUID()}`;
      await expect(
        system(() =>
          prisma.client.$transaction(async (tx) => {
            await tx.refreshToken.create({
              data: {
                userId: B.userId,
                familyId: randomUUID(),
                tokenHash,
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            throw new Error('refresh token reuse');
          }),
        ),
      ).rejects.toThrow('refresh token reuse');
      expect(await owner.refreshToken.count({ where: { tokenHash } })).toBe(0);
    });

    it('NFR-04 a batch transaction keeps system scope: it reads every org', async () => {
      const [users, tokens] = await system(() =>
        prisma.client.$transaction([
          prisma.client.user.findMany({ where: { id: { in: [A.userId, B.userId] } } }),
          prisma.client.refreshToken.findMany({ where: { userId: { in: [A.userId, B.userId] } } }),
        ]),
      );
      expect(new Set(users.map((u) => u.orgId))).toEqual(new Set([A.orgId, B.orgId]));
      expect(new Set(tokens.map((t) => t.userId))).toEqual(new Set([A.userId, B.userId]));
    });

    it('NFR-04 raw SQL works inside an interactive transaction, and sees its uncommitted writes', async () => {
      const seen = await system(() =>
        rawSql(() =>
          prisma.client.$transaction(async (tx) => {
            await tx.user.update({ where: { id: A.userId }, data: { failedLogins: 7 } });
            const rows = await tx.$queryRaw<{ n: number }[]>`
              SELECT failed_logins AS n FROM users WHERE id = ${A.userId}::uuid`;
            // Not committed yet: another connection still sees the old value.
            return { inside: rows[0]?.n, outside: await failedLogins(A) };
          }),
        ),
      );
      expect(seen.inside).toBe(7);
      expect(seen.outside).not.toBe(7);
      expect(await failedLogins(A)).toBe(7);
    });

    it('NFR-04 runRawSql inside the transaction callback works too, and a raw write rolls back with it', async () => {
      await expect(
        system(() =>
          prisma.client.$transaction(async (tx) => {
            await orgContext.runRawSql(
              WHY,
              () =>
                tx.$executeRaw`UPDATE users SET failed_logins = 99 WHERE id = ${B.userId}::uuid`,
            );
            throw new Error('abort');
          }),
        ),
      ).rejects.toThrow('abort');
      expect(await failedLogins(B)).not.toBe(99);
    });

    it('NFR-04 raw SQL in a transaction without runRawSql is refused, and the transaction rolls back', async () => {
      await expect(
        system(() =>
          prisma.client.$transaction(async (tx) => {
            await tx.user.update({ where: { id: B.userId }, data: { failedLogins: 55 } });
            await tx.$executeRaw`UPDATE users SET failed_logins = 56 WHERE id = ${B.userId}::uuid`;
          }),
        ),
      ).rejects.toBeInstanceOf(RawQueryNotAllowedError);
      expect(await failedLogins(B)).not.toBe(55);
    });

    it('NFR-04 a batch transaction with raw SQL works inside runRawSql, and is atomic', async () => {
      const [changed, users] = await system(() =>
        rawSql(() =>
          prisma.client.$transaction([
            prisma.client
              .$executeRaw`UPDATE users SET failed_logins = 3 WHERE id = ${A.userId}::uuid`,
            prisma.client.user.findMany({ where: { id: { in: [A.userId, B.userId] } } }),
          ]),
        ),
      );
      expect(changed).toBe(1);
      expect(users).toHaveLength(2);
      expect(await failedLogins(A)).toBe(3);

      // The second item fails (duplicate email), so the raw update before it is undone.
      await expect(
        system(() =>
          rawSql(() =>
            prisma.client.$transaction([
              prisma.client
                .$executeRaw`UPDATE users SET failed_logins = 4 WHERE id = ${A.userId}::uuid`,
              prisma.client.user.create({
                data: {
                  orgId: A.orgId,
                  email: 'staff-a@example.test',
                  fullName: 'Duplicate',
                  passwordHash: 'x',
                  role: 'RECRUITER',
                },
              }),
            ]),
          ),
        ),
      ).rejects.toThrow();
      expect(await failedLogins(A)).toBe(3);
    });

    it('NFR-04 a batch transaction with raw SQL outside runRawSql is refused and changes nothing', async () => {
      await expect(
        system(() =>
          prisma.client.$transaction([
            prisma.client.user.update({ where: { id: A.userId }, data: { failedLogins: 8 } }),
            prisma.client
              .$executeRaw`UPDATE users SET failed_logins = 9 WHERE id = ${A.userId}::uuid`,
          ]),
        ),
      ).rejects.toBeInstanceOf(RawQueryNotAllowedError);
      expect(await failedLogins(A)).toBe(3);
    });

    it('NFR-04 transactions in an org scope accept raw SQL through runRawSql as well', async () => {
      const rows = await orgContext.runAsUser(userA, () =>
        rawSql(() =>
          prisma.client.$transaction(async (tx) => ({
            raw: await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM users`,
            scoped: await tx.user.findMany(),
          })),
        ),
      );
      expect(rows.raw[0]?.n).toBeGreaterThanOrEqual(2);
      expect(rows.scoped.map((u) => u.orgId)).toEqual([A.orgId]);
    });
  });

  // ---- 3. no extra statements -----------------------------------------------------------------

  describe('no SQL of its own', () => {
    /** The statements app_user sent to Postgres while `run` ran, as Postgres counted them. */
    async function statementsOf(run: () => Promise<unknown>): Promise<StatementCount[]> {
      await db.statements.reset();
      await run();
      return db.statements.read();
    }

    it('NFR-04 entering and leaving a scope sends no statement', async () => {
      const enter: Array<[string, () => Promise<unknown>]> = [
        ['runSystem', () => system(async () => Promise.resolve())],
        ['runAsUser', () => orgContext.runAsUser(userA, async () => Promise.resolve())],
        ['runInOrg', () => orgContext.runInOrg(A.orgId, async () => Promise.resolve())],
        ['runRawSql (inside a scope)', () => system(() => rawSql(async () => Promise.resolve()))],
        [
          'runSystem > runRawSql > runInOrg',
          () =>
            system(() => rawSql(() => orgContext.runInOrg(A.orgId, async () => Promise.resolve()))),
        ],
        [
          'runSystem > runAsUser',
          () => system(() => orgContext.runAsUser(userA, async () => Promise.resolve())),
        ],
      ];
      for (const [name, run] of enter) {
        expect({ name, statements: await statementsOf(run) }).toEqual({ name, statements: [] });
      }
    });

    /**
     * One operation, as the plain factory client runs it and as the scoped client runs it.
     * `orgId` makes the plain version carry by hand the filter the extension adds, so the two
     * can be compared statement for statement.
     */
    interface Op {
      readonly name: string;
      /** Needs runRawSql. */
      readonly raw: boolean;
      readonly run: (c: PrismaClient, orgId?: string) => Promise<unknown>;
    }
    const and = (
      orgId: string | undefined,
      filter: (id: string) => Record<string, unknown>,
    ): object => (orgId === undefined ? {} : { AND: [filter(orgId)] });
    const direct = (id: string): Record<string, unknown> => ({ orgId: id });
    const throughUser = (id: string): Record<string, unknown> => ({ user: { orgId: id } });
    const throughSession = (id: string): Record<string, unknown> => ({
      sessionQuestion: { session: { orgId: id } },
    });
    const ops: Op[] = [
      {
        name: 'user lookup by email with its org (login)',
        raw: false,
        run: (c, orgId) =>
          c.user.findUnique({
            where: { email: 'staff-a@example.test', ...and(orgId, direct) },
            include: { org: { select: { name: true } } },
          }),
      },
      {
        name: 'user update',
        raw: false,
        run: (c, orgId) =>
          c.user.update({
            where: { id: A.userId, ...and(orgId, direct) },
            data: { failedLogins: 0 },
          }),
      },
      {
        name: 'refresh token updateMany (path-scoped through user)',
        raw: false,
        run: (c, orgId) =>
          c.refreshToken.updateMany({
            where: { userId: A.userId, revokedAt: null, ...and(orgId, throughUser) },
            data: { revokedAt: new Date() },
          }),
      },
      {
        name: 'submission findMany (path-scoped three hops)',
        raw: false,
        run: (c, orgId) =>
          c.submission.findMany({
            where: {
              language: 'python',
              ...and(orgId, throughSession),
            },
          }),
      },
      {
        name: 'nested write (test.update with sections.create): the guard walks data and sends nothing',
        raw: false,
        run: (c, orgId) =>
          c.test.update({
            where: { id: A.rows.Test.filter.id as string, ...and(orgId, direct) },
            data: { name: 'nested', sections: { create: { title: 'n', position: 5 } } },
          }),
      },
      {
        name: 'audit log insert',
        raw: false,
        run: (c) =>
          c.auditLog.create({
            data: { orgId: A.orgId, actorId: A.userId, action: 'AUTH_TEST', entityType: 'user' },
          }),
      },
      {
        name: 'interactive transaction (refresh-token rotation)',
        raw: false,
        run: (c, orgId) =>
          c.$transaction(async (tx) => {
            const created = await tx.refreshToken.create({
              data: {
                userId: A.userId,
                familyId: randomUUID(),
                tokenHash: `rt-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 60_000),
              },
            });
            await tx.refreshToken.updateMany({
              where: { id: created.id, revokedAt: null, ...and(orgId, throughUser) },
              data: { revokedAt: new Date() },
            });
          }),
      },
      {
        name: 'batch transaction',
        raw: false,
        run: (c, orgId) =>
          c.$transaction([
            c.user.update({
              where: { id: A.userId, ...and(orgId, direct) },
              data: { failedLogins: 0 },
            }),
            c.refreshToken.updateMany({
              where: { userId: A.userId, revokedAt: null, ...and(orgId, throughUser) },
              data: { revokedAt: new Date() },
            }),
          ]),
      },
      {
        name: 'raw lockout counter ($queryRaw)',
        raw: true,
        run: (c) =>
          c.$queryRaw(
            Prisma.sql`UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ${A.userId}::uuid RETURNING failed_logins`,
          ),
      },
      {
        name: 'raw recovery-code consume ($executeRaw)',
        raw: true,
        run: (c) =>
          c.$executeRaw`UPDATE users SET recovery_code_hashes = array_remove(recovery_code_hashes, ${'nope'}) WHERE id = ${A.userId}::uuid AND ${'nope'} = ANY(recovery_code_hashes)`,
      },
      {
        name: 'raw statement inside an interactive transaction',
        raw: true,
        run: (c, orgId) =>
          c.$transaction(async (tx) => {
            await tx.$executeRaw`UPDATE users SET failed_logins = 0 WHERE id = ${A.userId}::uuid`;
            await tx.user.findUnique({ where: { id: A.userId, ...and(orgId, direct) } });
          }),
      },
    ];

    /** Runs `run` once to warm up (connections, first-use effects), then measures a second run. */
    async function measured(run: () => Promise<unknown>): Promise<StatementCount[]> {
      await run();
      return statementsOf(run);
    }

    describe.each(ops)('$name', (op) => {
      const inScope =
        (enter: (fn: () => Promise<unknown>) => Promise<unknown>): (() => Promise<unknown>) =>
        () =>
          enter(() => (op.raw ? rawSql(() => op.run(scoped())) : op.run(scoped())));

      it('NFR-04 sends the same statements in system scope as the plain client', async () => {
        const bare = await measured(() => op.run(plain));
        expect(bare.length).toBeGreaterThan(0);
        expect(await measured(inScope(system))).toEqual(bare);
      });

      it('NFR-04 sends the same statements in runAsUser and runInOrg as the plain client with the filter written by hand', async () => {
        const bare = await measured(() => op.run(plain, A.orgId));
        expect(bare.length).toBeGreaterThan(0);
        const asUser = await measured(inScope((fn) => orgContext.runAsUser(userA, fn)));
        const inOrg = await measured(inScope((fn) => orgContext.runInOrg(A.orgId, fn)));
        expect(asUser).toEqual(bare);
        expect(inOrg).toEqual(bare);
      });
    });

    it('NFR-04 an org filter changes the text of a statement, not the number of statements', async () => {
      // A sanity check on the comparison above: the by-hand filter really is in the SQL.
      const unfiltered = await statementsOf(() => plain.user.findMany());
      const filtered = await statementsOf(() =>
        orgContext.runInOrg(A.orgId, () => prisma.client.user.findMany()),
      );
      expect(unfiltered).toHaveLength(1);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.query).not.toBe(unfiltered[0]?.query);
      expect(filtered[0]?.query).toContain('org_id');
    });

    it("NFR-04 an authenticated HTTP request sends exactly two statements: the guard's user re-check, then the handler's one", async () => {
      const token = app.get(TokenService).sign(
        {
          sub: A.userId,
          org: A.orgId,
          role: 'RECRUITER',
          kind: 'access',
          pwv: passwordVersion('not-a-real-hash'),
        },
        300,
      );
      const get = (): Promise<unknown> =>
        request(app.getHttpServer())
          .get(`/probe/users/${A.userId}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      const bare = await measured(() =>
        plain.user.findUnique({ where: { id: A.userId, AND: [{ orgId: A.orgId }] } }),
      );
      expect(bare).toHaveLength(1);
      // The guard's own select (FU-BE-19), measured on the plain client with the same shape.
      const guardSelect = await measured(() =>
        plain.user.findUnique({
          where: { id: A.userId },
          select: { isActive: true, role: true, orgId: true, passwordHash: true },
        }),
      );
      expect(guardSelect).toHaveLength(1);
      // Entering the system scope for the guard and the org scope for the handler adds none.
      const sent = await measured(get);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toEqual(guardSelect[0]);
      expect(sent[1]).toEqual(bare[0]);
    });

    it('NFR-04 upsert is the one operation whose statements differ: native in system scope, SELECT then INSERT or UPDATE in an org scope', async () => {
      // The org filter on the where stops Prisma using INSERT ... ON CONFLICT. This is expected, and
      // documented in the README (S5): more statements, and a possible P2002 under concurrency.
      const email = 'upsert-statements@example.test';
      const upsert = (c: PrismaClient): Promise<unknown> =>
        c.candidate.upsert({
          where: { orgId_email: { orgId: A.orgId, email } },
          create: { orgId: A.orgId, email, fullName: 'Created' },
          update: { fullName: 'Updated' },
        });
      const native = await statementsOf(() => system(() => upsert(scoped())));
      expect(native).toHaveLength(1);
      expect(native[0]?.query).toContain('ON CONFLICT');
      // The row now exists. First an insert (row removed), then an update.
      for (const phase of ['insert', 'update']) {
        if (phase === 'insert') await owner.candidate.deleteMany({ where: { email } });
        const inOrg = await statementsOf(() =>
          orgContext.runInOrg(A.orgId, () => upsert(scoped())),
        );
        const text = inOrg.map((s) => s.query).join('\n');
        expect({ phase, native: text.includes('ON CONFLICT') }).toEqual({ phase, native: false });
        expect(inOrg.length).toBeGreaterThan(native.length);
        expect(text).toContain('SELECT');
        expect(text).toContain(phase === 'insert' ? 'INSERT INTO' : 'UPDATE');
      }
      await owner.candidate.deleteMany({ where: { email } });
    });

    it('NFR-04 $connect sends no statement', async () => {
      const fresh = createPrismaClient(db.appUserUrl);
      try {
        expect(await statementsOf(() => fresh.$connect())).toEqual([]);
      } finally {
        await fresh.$disconnect();
      }
    });
  });
});
