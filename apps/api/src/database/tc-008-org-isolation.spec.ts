// TC-008 (NFR-04): a user from org A cannot read or change org B's data. These tests run against a
// real Postgres 16 started by Testcontainers (Docker is required), with the real migrations applied
// by `prisma migrate deploy`. The code under test connects as app_user through the real client
// factory, so the real grants are in force. Fixtures and checks use the owner role.
//
// Two tenants (A and B) hold one row in each of the 31 models, including the models that have no
// org_id and are scoped only through a parent chain (proctor_events through their session,
// test_cases through their question version and question). What is covered:
//   - For every one of the 31 models, as A against B's row: findMany, findFirst, findFirstOrThrow,
//     findUnique, findUniqueOrThrow, count, aggregate and groupBy find nothing; update, updateMany,
//     updateManyAndReturn, delete and deleteMany change nothing (B's rows are compared before and
//     after). Positive controls prove A still reads and updates its own row, and that A and B
//     between them see every row exactly once, so a filter that returns nothing cannot pass.
//   - upsert (not generic): tried against B's row on three models only (Test, TestSection,
//     TestCase), plus A's own row and the create branch on Test and Candidate.
//   - Dedicated tests, on chosen models: create, createMany and createManyAndReturn, filters that
//     try to widen the scope, cursors, deleting own rows, transactions, system scope, raw SQL, the
//     app_user role and the HTTP path through the real guard.
//   - Not covered, by design (README "Limits"): nested writes, re-parenting, and nested reads. One
//     test pins that an include follows a cross-org foreign key.
import { Controller, Get, INestApplication, NotFoundException, Param, Query } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Public, Roles } from '../common/auth/decorators';
import { ProblemFilter } from '../common/problem.filter';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { TokenModule, TokenService } from '../common/auth/token.service';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { DatabaseModule } from './database.module';
import { OrgContextMissingError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import { OrgContextService } from './org-context';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { PrismaService } from './prisma.service';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { TenantFixture } from './testing/tenant-fixtures';

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;

const MODELS = Object.keys(ORG_SCOPE) as ModelName[];
const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/** A harmless change per model, used to try updates. Dates are fixed so results are stable. */
const TOUCH: Record<ModelName, Record<string, unknown>> = {
  Organization: { name: 'Renamed' },
  User: { fullName: 'Renamed' },
  RefreshToken: { revokedAt: new Date('2026-10-06T00:00:00Z') },
  AuditLog: { action: 'renamed' },
  Question: { isArchived: true },
  QuestionVersion: { title: 'Renamed' },
  TestCase: { input: 'changed' },
  QuestionVariant: { renderedStatement: 'Changed.' },
  VariantTestCase: { input: 'changed' },
  AiReferenceSolution: { modelLabel: 'renamed' },
  Test: { name: 'Renamed' },
  TestSection: { title: 'Renamed' },
  TestQuestion: { position: 5 },
  Candidate: { fullName: 'Renamed' },
  Invitation: { sentAt: new Date('2026-10-06T00:00:00Z') },
  Session: { authEpoch: 1 },
  SessionSection: { position: 3 },
  SessionQuestion: { position: 3 },
  Submission: { language: 'java' },
  ConsentText: { bodyMd: 'Changed' },
  Consent: { userAgent: 'changed' },
  IdentityCheck: { reviewNote: 'changed' },
  MediaChunk: { durationMs: 5 },
  ProctorEventBatch: { eventCount: 1 },
  ProctorEvent: { durationMs: 1 },
  KeystrokeBatch: { startedAt: new Date('2026-10-06T00:00:00Z') },
  SessionReview: { notes: 'changed' },
  FlagDecision: { note: 'changed' },
  Appeal: { resolutionNote: 'changed' },
  WebhookEndpoint: { url: 'https://hooks.example.test/changed' },
  WebhookDelivery: { error: 'changed' },
};

const ALL_ROLES = ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'] as const;
const JWT_SECRET = 'a-secret-for-the-tc-008-tests-only';

// What a staff route does: look a row up by the id in the URL, answer 404 on a miss. BE-02's
// JwtAuthGuard authenticates (deny by default: @Roles or @Public) and the interceptor sets the org.
@Controller('probe')
@Roles(...ALL_ROLES)
class ProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('sessions/:id')
  async session(@Param('id') id: string): Promise<{ id: string; orgId: string }> {
    const row = await this.prisma.client.session.findUnique({ where: { id } });
    if (row === null) throw new NotFoundException();
    return { id: row.id, orgId: row.orgId };
  }

  @Get('sessions')
  async sessions(@Query('id') id?: string): Promise<string[]> {
    const where = id === undefined ? undefined : { id };
    return (await this.prisma.client.session.findMany({ where })).map((s) => s.id);
  }

  // A filtered list on a model scoped through its parent chain.
  @Get('events')
  async events(@Query('sessionId') sessionId?: string): Promise<string[]> {
    const where = sessionId === undefined ? undefined : { sessionId };
    return (await this.prisma.client.proctorEvent.findMany({ where, orderBy: { id: 'asc' } })).map(
      (e) => String(e.id),
    );
  }

  @Get('events/:id')
  async event(@Param('id') id: string): Promise<{ id: string }> {
    const row = await this.prisma.client.proctorEvent.findUnique({ where: { id: BigInt(id) } });
    if (row === null) throw new NotFoundException();
    return { id: String(row.id) };
  }

  @Get('test-cases')
  async testCases(): Promise<string[]> {
    return (await this.prisma.client.testCase.findMany()).map((c) => c.id);
  }

  // A public route (no request.user, so no org context) that tries to read org data.
  @Get('public-sessions')
  @Public()
  async publicSessions(): Promise<string[]> {
    return (await this.prisma.client.session.findMany()).map((s) => s.id);
  }
}

describe('TC-008 cross-org access (NFR-04, FR-103)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let moduleRef: Awaited<ReturnType<typeof compileApp>>;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let orgContext: OrgContextService;
  let A: TenantFixture;
  let B: TenantFixture;

  function compileApp(url: string) {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: url, JWT_ACCESS_SECRET: JWT_SECRET })],
        }),
        TokenModule,
        DatabaseModule,
      ],
      controllers: [ProbeController],
      // BE-02's guard. DatabaseModule registers the interceptor that runs after it.
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();
  }

  const asA = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(A.orgId, fn);
  const asB = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(B.orgId, fn);

  /** client.session, client.proctorEvent, ... for the scoped client (what the API uses). */
  function scoped(model: ModelName): Delegate {
    return (prisma.client as unknown as Record<string, Delegate>)[lowerFirst(model)] as Delegate;
  }
  /** The same delegate on the owner's plain client, which sees everything. */
  function plain(model: ModelName): Delegate {
    return (owner as unknown as Record<string, Delegate>)[lowerFirst(model)] as Delegate;
  }

  /** A row as text, so rows can be compared and counted as sets. */
  const text = (row: unknown): string =>
    JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
    );

  /** Every row of every model, as text, so a test can prove nothing changed. */
  async function snapshot(): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const model of MODELS) {
      result[model] = ((await plain(model).findMany?.({})) as unknown[]).map(text).sort();
    }
    return result;
  }

  beforeAll(async () => {
    // pg_stat_statements lets the HTTP tests prove that a refused request sent no query.
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    A = await createTenant(owner, 'a');
    B = await createTenant(owner, 'b');
    moduleRef = await compileApp(db.appUserUrl);
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    // The filter BE-01 registers in bootstrap.ts: every error leaves as RFC 7807 problem JSON.
    app.useGlobalFilters(new ProblemFilter());
    await app.listen(0);
    prisma = app.get(PrismaService);
    orgContext = app.get(OrgContextService);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await db?.stop();
  });

  describe.each(MODELS)('%s', (model) => {
    it(`TC-008 org A cannot read org B's ${model} row by any read operation`, async () => {
      const d = scoped(model);
      const b = B.rows[model];
      const by = Object.keys(b.filter)[0] as string;
      await asA(async () => {
        expect(await d.findMany?.({ where: b.filter })).toEqual([]);
        expect(await d.findFirst?.({ where: b.filter })).toBeNull();
        await expect(d.findFirstOrThrow?.({ where: b.filter })).rejects.toMatchObject({
          code: 'P2025',
        });
        expect(await d.findUnique?.({ where: b.unique })).toBeNull();
        await expect(d.findUniqueOrThrow?.({ where: b.unique })).rejects.toMatchObject({
          code: 'P2025',
        });
        expect(await d.count?.({ where: b.filter })).toBe(0);
        expect(await d.aggregate?.({ where: b.filter, _count: true })).toEqual({ _count: 0 });
        expect(await d.groupBy?.({ by: [by], where: b.filter, _count: true })).toEqual([]);
      });
    });

    it(`TC-008 org A still reads its own ${model} row, and A and B between them see every row once`, async () => {
      const d = scoped(model);
      const a = A.rows[model];
      await asA(async () => {
        expect(await d.findMany?.({ where: a.filter })).toHaveLength(1);
        expect(await d.findFirst?.({ where: a.filter })).not.toBeNull();
        expect(await d.findUnique?.({ where: a.unique })).not.toBeNull();
        expect(await d.count?.({ where: a.filter })).toBe(1);
      });
      // No filter at all: each tenant sees its own rows, and together they see exactly the table.
      // (Only tenants A and B exist at this point: later tests add more rows.)
      const seenByA = (await asA(() => d.findMany?.({}) as Promise<unknown[]>)).map(text);
      const seenByB = (await asB(() => d.findMany?.({}) as Promise<unknown[]>)).map(text);
      const total = (await plain(model).count?.({})) as number;
      expect(seenByA.length).toBeGreaterThanOrEqual(1);
      expect(seenByB.length).toBeGreaterThanOrEqual(1);
      expect(seenByA.length + seenByB.length).toBe(total);
      expect(seenByA.filter((row) => seenByB.includes(row))).toEqual([]);
      expect(await asA(() => d.count?.({}) as Promise<number>)).toBe(seenByA.length);
    });

    it(`TC-008 org A cannot change or delete org B's ${model} row (update, updateMany, updateManyAndReturn, delete, deleteMany)`, async () => {
      const d = scoped(model);
      const b = B.rows[model];
      const before = (await plain(model).findMany?.({ where: b.filter })) as unknown[];
      const attempts = asA(async () => {
        if (model === 'AuditLog') {
          // The database refuses UPDATE and DELETE on audit_logs for app_user whatever the filter.
          await expect(d.update?.({ where: b.unique, data: TOUCH[model] })).rejects.toThrow(
            /permission denied/i,
          );
          await expect(d.delete?.({ where: b.unique })).rejects.toThrow(/permission denied/i);
          await expect(d.updateMany?.({ where: b.filter, data: TOUCH[model] })).rejects.toThrow(
            /permission denied/i,
          );
          await expect(d.deleteMany?.({ where: b.filter })).rejects.toThrow(/permission denied/i);
          return;
        }
        await expect(d.update?.({ where: b.unique, data: TOUCH[model] })).rejects.toMatchObject({
          code: 'P2025',
        });
        expect(await d.updateMany?.({ where: b.filter, data: TOUCH[model] })).toEqual({ count: 0 });
        expect(await d.updateManyAndReturn?.({ where: b.filter, data: TOUCH[model] })).toEqual([]);
        await expect(d.delete?.({ where: b.unique })).rejects.toMatchObject({ code: 'P2025' });
        expect(await d.deleteMany?.({ where: b.filter })).toEqual({ count: 0 });
      });
      await attempts;
      expect(await plain(model).findMany?.({ where: b.filter })).toEqual(before);
    });

    it(`TC-008 org A changes its own ${model} row`, async () => {
      if (model === 'AuditLog') return; // append-only, see above
      const d = scoped(model);
      const a = A.rows[model];
      await asA(async () => {
        const updated = await d.update?.({ where: a.unique, data: TOUCH[model] });
        expect(updated).toMatchObject(TOUCH[model]);
        expect(await d.updateMany?.({ where: a.filter, data: TOUCH[model] })).toEqual({ count: 1 });
        expect(await d.updateManyAndReturn?.({ where: a.filter, data: TOUCH[model] })).toHaveLength(
          1,
        );
      });
    });
  });

  describe("writes without a where are limited to the caller's org", () => {
    it("TC-008 updateMany and deleteMany with no filter touch only org A's rows", async () => {
      // Own tenants, so deleting does not disturb the other tests.
      const c = await createTenant(owner, 'c');
      const d = await createTenant(owner, 'd');
      const before = await snapshot();
      const dCountBefore = before.WebhookDelivery?.length;
      await orgContext.runInOrg(c.orgId, async () => {
        expect(await prisma.client.webhookDelivery.deleteMany()).toEqual({ count: 1 });
        expect(await prisma.client.testSection.updateMany({ data: { title: 'only C' } })).toEqual({
          count: 1,
        });
        expect(await prisma.client.candidate.updateMany({ data: { fullName: 'only C' } })).toEqual({
          count: 1,
        });
      });
      const after = await snapshot();
      expect(after.WebhookDelivery).toHaveLength((dCountBefore ?? 0) - 1);
      const titles = await owner.testSection.findMany({ where: { test: { orgId: d.orgId } } });
      expect(titles.map((t) => t.title)).toEqual(['Section 1']);
      const names = await owner.candidate.findMany({ where: { orgId: d.orgId } });
      expect(names.map((n) => n.fullName)).toEqual(['Candidate d']);
    });
  });

  describe('filters that try to widen the scope', () => {
    it('TC-008 OR, NOT and a where that names org B cannot widen what org A sees', async () => {
      const bSessionId = B.rows.Session.filter.id as string;
      await asA(async () => {
        const client = prisma.client;
        expect(await client.session.findMany({ where: { orgId: B.orgId } })).toEqual([]);
        expect(await client.session.findMany({ where: { NOT: { orgId: A.orgId } } })).toEqual([]);
        const either = await client.session.findMany({
          where: { OR: [{ orgId: B.orgId }, { orgId: A.orgId }] },
        });
        expect(either.map((s) => s.orgId)).toEqual([A.orgId]);
        // A relation filter through org B's own chain finds nothing either.
        expect(
          await client.proctorEvent.findMany({ where: { session: { orgId: B.orgId } } }),
        ).toEqual([]);
        expect(await client.proctorEvent.findMany({ where: { sessionId: bSessionId } })).toEqual(
          [],
        );
        // A compound unique key that names org B's id and org is still scoped.
        expect(
          await client.test.findUnique({
            where: { id_orgId: { id: B.rows.Test.filter.id as string, orgId: B.orgId } },
          }),
        ).toBeNull();
      });
    });

    it("TC-008 select and include on a filtered parent return only org A's rows (the parent is filtered; relations are followed as they are)", async () => {
      const sessions = await asA(() =>
        prisma.client.session.findMany({
          include: {
            org: true,
            proctorEvents: true,
            questions: { include: { submissions: true } },
          },
        }),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.org.id).toBe(A.orgId);
      expect(sessions[0]?.proctorEvents).toHaveLength(1);
      expect(sessions[0]?.questions[0]?.submissions).toHaveLength(1);
    });

    it("TC-008 KNOWN LIMIT (pinned, not a fix): an include follows a foreign key into another org and returns that org's row", async () => {
      // The scope filters the top-level model only. If a foreign key crosses orgs (here a review
      // whose reviewer is org B's user, which the database allows), the include returns B's user,
      // password hash included. README "Limits" (c): every id written follows rule (i).
      const G = await createTenant(owner, 'g');
      const reviewId = G.rows.SessionReview.filter.id as string;
      await owner.sessionReview.update({ where: { id: reviewId }, data: { reviewerId: B.userId } });
      const review = await orgContext.runInOrg(G.orgId, () =>
        prisma.client.sessionReview.findUnique({
          where: { id: reviewId },
          include: { reviewer: true },
        }),
      );
      expect(review?.reviewer.id).toBe(B.userId);
      expect(review?.reviewer.orgId).toBe(B.orgId);
      expect(review?.reviewer.passwordHash).toBe('not-a-real-hash');
      // Reading that user directly is still scoped: org G does not see it.
      expect(
        await orgContext.runInOrg(G.orgId, () =>
          prisma.client.user.findUnique({ where: { id: B.userId } }),
        ),
      ).toBeNull();
    });

    it('TC-008 findUnique calls of both orgs in the same tick are not mixed up by batching', async () => {
      const sessionA = A.rows.Session.filter.id as string;
      const results = await Promise.all([
        asA(() => prisma.client.session.findUnique({ where: { id: sessionA } })),
        asB(() => prisma.client.session.findUnique({ where: { id: sessionA } })),
        asA(() => prisma.client.session.findUnique({ where: { id: sessionA } })),
        asB(() => prisma.client.session.findUnique({ where: { id: sessionA } })),
      ]);
      expect(results.map((r) => r?.id ?? null)).toEqual([sessionA, null, sessionA, null]);
    });
  });

  describe('cursor paging (Prisma finds the cursor row by its own fields, not by where)', () => {
    // Tenants E and F get rows in an interleaved order, so the ids (sequential BigInt identity
    // values) of E's rows sit on both sides of F's: a cursor on F's row ranks E's rows against it.
    let E: TenantFixture;
    let F: TenantFixture;
    let plain: PrismaClient; // the factory client with no scope, to show the hazard
    let eAudit: bigint[];
    let fAudit: bigint;
    let eEvents: bigint[];
    let fEvent: bigint;

    beforeAll(async () => {
      plain = createPrismaClient(db.appUserUrl);
      E = await createTenant(owner, 'e');
      F = await createTenant(owner, 'f');
      const audit = (org: TenantFixture, n: number): Promise<{ id: bigint }> =>
        owner.auditLog.create({
          data: { orgId: org.orgId, action: `cursor-${n}`, entityType: 'test' },
          select: { id: true },
        });
      const event = (org: TenantFixture, n: number): Promise<{ id: bigint }> =>
        owner.proctorEvent.create({
          data: {
            sessionId: org.rows.Session.filter.id as string,
            type: 'TAB_SWITCH',
            severity: 'LOW',
            occurredAt: new Date(),
            durationMs: n,
          },
          select: { id: true },
        });
      // Fixture rows exist already (E first, then F). E gets two more after F's.
      eAudit = [
        E.rows.AuditLog.filter.id as bigint,
        (await audit(E, 2)).id,
        (await audit(E, 3)).id,
      ];
      fAudit = F.rows.AuditLog.filter.id as bigint;
      eEvents = [
        E.rows.ProctorEvent.filter.id as bigint,
        (await event(E, 2)).id,
        (await event(E, 3)).id,
      ];
      fEvent = F.rows.ProctorEvent.filter.id as bigint;
    });

    afterAll(async () => {
      await plain?.$disconnect();
    });

    const asE = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(E.orgId, fn);
    const ids = (rows: Array<{ id: bigint }>): bigint[] => rows.map((r) => r.id);
    const order = { id: 'asc' } as const;

    it("TC-008 left as it is, a cursor on org F's row ranks org E's rows against it (why the scope handles cursors)", async () => {
      // The ids are sequential, so E's rows 2 and 3 come after F's row: they are returned.
      expect(fAudit > eAudit[0]! && fAudit < eAudit[1]!).toBe(true);
      const leaked = await plain.auditLog.findMany({
        where: { orgId: E.orgId },
        cursor: { id: fAudit },
        orderBy: order,
      });
      expect(ids(leaked)).toEqual([eAudit[1], eAudit[2]]);
      expect(
        await plain.auditLog.count({
          where: { orgId: E.orgId },
          cursor: { id: fAudit },
          orderBy: order,
        }),
      ).toBe(2);
    });

    it("TC-008 org E cannot rank its rows against org F's row: findMany, findFirst, findFirstOrThrow, count and aggregate see nothing", async () => {
      const cursor = { id: fAudit };
      await asE(async () => {
        const client = prisma.client;
        expect(await client.auditLog.findMany({ cursor, orderBy: order })).toEqual([]);
        expect(
          await client.auditLog.findMany({
            where: { orgId: E.orgId },
            cursor,
            orderBy: order,
            take: 2,
          }),
        ).toEqual([]);
        expect(await client.auditLog.findFirst({ cursor, orderBy: order })).toBeNull();
        await expect(
          client.auditLog.findFirstOrThrow({ cursor, orderBy: order }),
        ).rejects.toMatchObject({ code: 'P2025' });
        expect(await client.auditLog.count({ cursor, orderBy: order })).toBe(0);
        expect(await client.auditLog.aggregate({ cursor, orderBy: order, _count: true })).toEqual({
          _count: 0,
        });
      });
    });

    it('TC-008 a cursor that names another org (orgId, or a compound key) is refused for every operation that takes a cursor', async () => {
      await asE(async () => {
        const client = prisma.client;
        const test = F.rows.Test.filter.id as string;
        const cursors = [{ id: test, orgId: F.orgId }, { id_orgId: { id: test, orgId: F.orgId } }];
        for (const cursor of cursors) {
          const args = { cursor, orderBy: order };
          await expect(client.test.findMany(args)).rejects.toBeInstanceOf(OrgScopeViolationError);
          await expect(client.test.findFirst(args)).rejects.toBeInstanceOf(OrgScopeViolationError);
          await expect(client.test.findFirstOrThrow(args)).rejects.toBeInstanceOf(
            OrgScopeViolationError,
          );
          await expect(client.test.count(args)).rejects.toBeInstanceOf(OrgScopeViolationError);
          await expect(client.test.aggregate({ ...args, _count: true })).rejects.toBeInstanceOf(
            OrgScopeViolationError,
          );
        }
      });
    });

    it('TC-008 org E pages through its own rows with its own cursor (positive control)', async () => {
      await asE(async () => {
        const client = prisma.client;
        const from = (cursor: bigint) => ({ cursor: { id: cursor }, orderBy: order });
        expect(ids(await client.auditLog.findMany(from(eAudit[0]!)))).toEqual(eAudit);
        expect(ids(await client.auditLog.findMany(from(eAudit[1]!)))).toEqual([
          eAudit[1],
          eAudit[2],
        ]);
        expect(ids(await client.auditLog.findMany({ ...from(eAudit[0]!), take: 2 }))).toEqual([
          eAudit[0],
          eAudit[1],
        ]);
        expect(
          ids(await client.auditLog.findMany({ ...from(eAudit[0]!), skip: 1, take: 1 })),
        ).toEqual([eAudit[1]]);
        expect(ids(await client.auditLog.findMany({ ...from(eAudit[2]!), take: -2 }))).toEqual([
          eAudit[1],
          eAudit[2],
        ]);
        expect((await client.auditLog.findFirst(from(eAudit[1]!)))?.id).toBe(eAudit[1]);
        expect((await client.auditLog.findFirstOrThrow(from(eAudit[2]!))).id).toBe(eAudit[2]);
        expect(await client.auditLog.count(from(eAudit[0]!))).toBe(3);
        expect(await client.auditLog.count(from(eAudit[1]!))).toBe(2);
        expect(await client.auditLog.aggregate({ ...from(eAudit[0]!), _count: true })).toEqual({
          _count: 3,
        });
        // Naming its own org in the cursor is fine.
        expect(
          ids(
            await client.auditLog.findMany({
              cursor: { id: eAudit[1]!, orgId: E.orgId },
              orderBy: order,
            }),
          ),
        ).toEqual([eAudit[1], eAudit[2]]);
      });
    });

    it('TC-008 a model without org_id takes no cursor in an org scope, and where plus orderBy pages it instead', async () => {
      await asE(async () => {
        const client = prisma.client;
        for (const cursor of [{ id: fEvent }, { id: eEvents[0]! }]) {
          const args = { cursor, orderBy: order };
          await expect(client.proctorEvent.findMany(args)).rejects.toThrow(
            /Page with where plus orderBy/,
          );
          await expect(client.proctorEvent.findFirst(args)).rejects.toBeInstanceOf(
            OrgScopeViolationError,
          );
          await expect(client.proctorEvent.findFirstOrThrow(args)).rejects.toBeInstanceOf(
            OrgScopeViolationError,
          );
          await expect(client.proctorEvent.count(args)).rejects.toBeInstanceOf(
            OrgScopeViolationError,
          );
          await expect(
            client.proctorEvent.aggregate({ ...args, _count: true }),
          ).rejects.toBeInstanceOf(OrgScopeViolationError);
        }
        // Keyset paging with where: only E's events, in order, never F's.
        const firstPage = await client.proctorEvent.findMany({ orderBy: order, take: 2 });
        expect(ids(firstPage)).toEqual([eEvents[0], eEvents[1]]);
        const secondPage = await client.proctorEvent.findMany({
          where: { id: { gt: firstPage.at(-1)!.id } },
          orderBy: order,
          take: 2,
        });
        expect(ids(secondPage)).toEqual([eEvents[2]]);
        // A where that starts from F's id still sees only E's rows after it.
        const afterF = await client.proctorEvent.findMany({
          where: { id: { gte: fEvent } },
          orderBy: order,
        });
        expect(ids(afterF)).toEqual([eEvents[1], eEvents[2]]);
      });
    });

    it('TC-008 the organization row takes only its own id as the cursor', async () => {
      await asE(async () => {
        const client = prisma.client;
        await expect(
          client.organization.findMany({ cursor: { id: F.orgId } }),
        ).rejects.toBeInstanceOf(OrgScopeViolationError);
        await expect(
          client.organization.findFirst({ cursor: { id: F.orgId }, orderBy: order }),
        ).rejects.toBeInstanceOf(OrgScopeViolationError);
        await expect(
          client.organization.count({ cursor: { id: F.orgId }, orderBy: order }),
        ).rejects.toBeInstanceOf(OrgScopeViolationError);
        expect(
          (await client.organization.findMany({ cursor: { id: E.orgId } })).map((o) => o.id),
        ).toEqual([E.orgId]);
        expect(await client.organization.count({ cursor: { id: E.orgId }, orderBy: order })).toBe(
          1,
        );
      });
    });
  });

  describe("nested writes (FU-DB-63): a write through a relation cannot change another org's rows", () => {
    // H acts; I is the victim. Fresh tenants, so the refusals can be checked against untouched rows.
    let H: TenantFixture;
    let I: TenantFixture;
    const asH = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(H.orgId, fn);
    const id = (tenant: TenantFixture, model: ModelName): string =>
      tenant.rows[model].filter.id as string;

    beforeAll(async () => {
      H = await createTenant(owner, 'h');
      I = await createTenant(owner, 'i');
    });

    it("TC-008 organization.update users.connect of org I's user is refused, and the user stays in org I", async () => {
      await expect(
        asH(() =>
          prisma.client.organization.update({
            where: { id: H.orgId },
            data: { users: { connect: { id: I.userId } } },
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect((await owner.user.findUniqueOrThrow({ where: { id: I.userId } })).orgId).toBe(I.orgId);
    });

    it("TC-008 a parent-side set, connect and connectOrCreate are refused, and org I's rows are unchanged", async () => {
      const before = await snapshot();
      const attempts: Array<() => Promise<unknown>> = [
        // set: re-point org I's test question at org H's section
        () =>
          prisma.client.testSection.update({
            where: { id: id(H, 'TestSection') },
            data: { questions: { set: [{ id: id(I, 'TestQuestion') }] } },
          }),
        // connect on a one-to-one whose key is on the related model
        () =>
          prisma.client.session.update({
            where: { id: id(H, 'Session') },
            data: { review: { connect: { id: id(I, 'SessionReview') } } },
          }),
        // connectOrCreate on the same relation
        () =>
          prisma.client.session.update({
            where: { id: id(H, 'Session') },
            data: {
              review: {
                connectOrCreate: {
                  where: { id: id(I, 'SessionReview') },
                  create: { reviewerId: H.userId },
                },
              },
            },
          }),
        // connect on a to-many deep inside a nested update
        () =>
          prisma.client.test.update({
            where: { id: id(H, 'Test') },
            data: {
              sections: {
                update: {
                  where: { id: id(H, 'TestSection') },
                  data: { questions: { connect: { id: id(I, 'TestQuestion') } } },
                },
              },
            },
          }),
      ];
      for (const attempt of attempts) {
        await expect(asH(attempt)).rejects.toBeInstanceOf(OrgScopeViolationError);
      }
      expect(await snapshot()).toEqual(before);
    });

    it('TC-008 a nested create that names another org is refused and creates nothing', async () => {
      // user.createdQuestions: the parent is the staff user, and the question names its own org.
      const questions = await owner.question.count();
      const create = (orgId: string, slug: string) =>
        asH(() =>
          prisma.client.user.update({
            where: { id: H.userId },
            data: { createdQuestions: { create: { orgId, slug } } },
          }),
        );
      await expect(create(I.orgId, 'smuggled')).rejects.toBeInstanceOf(OrgScopeViolationError);
      await expect(
        asH(() =>
          prisma.client.user.update({
            where: { id: H.userId },
            data: {
              createdQuestions: { createMany: { data: [{ orgId: I.orgId, slug: 'many' }] } },
            },
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      await expect(
        asH(() =>
          prisma.client.user.update({
            where: { id: H.userId },
            data: {
              createdQuestions: { create: { org: { connect: { id: I.orgId } }, slug: 'via-org' } },
            },
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(await owner.question.count()).toBe(questions);
      // Positive control: the same create naming org H works.
      await create(H.orgId, 'allowed');
      expect(await owner.question.count()).toBe(questions + 1);
      expect((await owner.question.findFirstOrThrow({ where: { slug: 'allowed' } })).orgId).toBe(
        H.orgId,
      );
    });

    it('TC-008 the refusals carry no ids, org ids or other values', async () => {
      const error = await asH(() =>
        prisma.client.organization.update({
          where: { id: H.orgId },
          data: { users: { connect: { id: I.userId } } },
        }),
      ).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(OrgScopeViolationError);
      for (const secret of [I.userId, I.orgId, H.orgId, H.userId]) {
        expect((error as Error).message).not.toContain(secret);
      }
    });

    it('TC-008 a child-side connect still works (rule (i) covers its id)', async () => {
      const updated = await asH(() =>
        prisma.client.testQuestion.update({
          where: { id: id(H, 'TestQuestion') },
          data: { questionVersion: { connect: { id: id(H, 'QuestionVersion') } } },
        }),
      );
      expect(updated.questionVersionId).toBe(id(H, 'QuestionVersion'));
    });

    it('TC-008 nested create, update and delete under an in-scope parent still work, and stay in org H', async () => {
      const test = await asH(() =>
        prisma.client.test.update({
          where: { id: id(H, 'Test') },
          data: {
            sections: {
              create: {
                title: 'nested',
                position: 11,
                questions: { create: { position: 0, questionVersionId: id(H, 'QuestionVersion') } },
              },
            },
          },
          include: { sections: { include: { questions: true } } },
        }),
      );
      const nested = test.sections.find((section) => section.title === 'nested');
      expect(nested?.questions).toHaveLength(1);
      // Visible to org H, invisible to org I.
      expect(await asH(() => prisma.client.testSection.count({ where: { title: 'nested' } }))).toBe(
        1,
      );
      expect(
        await orgContext.runInOrg(I.orgId, () =>
          prisma.client.testSection.count({ where: { title: 'nested' } }),
        ),
      ).toBe(0);
      // Update and delete through the parent.
      await asH(() =>
        prisma.client.test.update({
          where: { id: id(H, 'Test') },
          data: {
            sections: { update: { where: { id: nested?.id ?? '' }, data: { title: 'renamed' } } },
          },
        }),
      );
      expect(
        (await owner.testSection.findUniqueOrThrow({ where: { id: nested?.id ?? '' } })).title,
      ).toBe('renamed');
      await asH(() =>
        prisma.client.test.update({
          where: { id: id(H, 'Test') },
          data: { sections: { deleteMany: { title: 'renamed' } } },
        }),
      );
      expect(await owner.testSection.count({ where: { title: 'renamed' } })).toBe(0);
    });

    it('TC-008 a Json column and a scalar list are never mistaken for a nested write', async () => {
      const lookalike = { users: { connect: { id: I.userId } }, sections: { set: [{ id: 'x' }] } };
      await asH(() =>
        prisma.client.test.update({ where: { id: id(H, 'Test') }, data: { settings: lookalike } }),
      );
      expect(
        (await owner.test.findUniqueOrThrow({ where: { id: id(H, 'Test') } })).settings,
      ).toEqual(lookalike);
      await asH(() =>
        prisma.client.question.update({
          where: { id: id(H, 'Question') },
          data: { tags: { set: ['a', 'b'] } },
        }),
      );
      expect(
        (await owner.question.findUniqueOrThrow({ where: { id: id(H, 'Question') } })).tags,
      ).toEqual(['a', 'b']);
    });

    it('TC-008 in system scope nested writes are not walked (the guard is for org scopes)', async () => {
      // System scope is for work with no org. The same connect that is refused above is allowed.
      const J = await createTenant(owner, 'j');
      const K = await createTenant(owner, 'k');
      await orgContext.runSystem('BACKGROUND_JOB', () =>
        prisma.client.organization.update({
          where: { id: J.orgId },
          data: { users: { connect: { id: K.userId } } },
        }),
      );
      expect((await owner.user.findUniqueOrThrow({ where: { id: K.userId } })).orgId).toBe(J.orgId);
    });
  });

  describe('FU-DB-04: the session of an invitation', () => {
    it("TC-008 a session is looked up by invitationId, and only inside the invitation's org", async () => {
      const invitationA = A.rows.Invitation.filter.id as string;
      const invitationB = B.rows.Invitation.filter.id as string;
      const own = await asA(() =>
        prisma.client.session.findUnique({ where: { invitationId: invitationA } }),
      );
      expect(own?.id).toBe(A.rows.Session.filter.id);
      expect(
        await asA(() => prisma.client.session.findUnique({ where: { invitationId: invitationB } })),
      ).toBeNull();
    });
  });

  describe('upsert', () => {
    it.each([['Test'], ['TestSection'], ['TestCase']] as const)(
      "TC-008 upsert of org B's %s row, a way to take over a row by id, is refused",
      async (model) => {
        // Test has its own org_id, TestSection is one parent away from it, TestCase two.
        const create: Record<string, Record<string, unknown>> = {
          Test: { id: B.rows.Test.filter.id, name: 'hijacked', durationMinutes: 60 },
          TestSection: {
            id: B.rows.TestSection.filter.id,
            testId: A.rows.Test.filter.id,
            title: 'hijacked',
            position: 9,
          },
          TestCase: {
            id: B.rows.TestCase.filter.id,
            questionVersionId: A.rows.QuestionVersion.filter.id,
            input: 'x',
            expectedOutput: 'y',
            position: 9,
          },
        };
        const before = (await plain(model).findMany?.({
          where: B.rows[model].filter,
        })) as unknown[];
        await expect(
          asA(
            () =>
              scoped(model).upsert?.({
                where: B.rows[model].unique,
                create: create[model],
                update: TOUCH[model],
              }) as Promise<unknown>,
          ),
        ).rejects.toThrow(); // the where finds nothing, so the create runs and hits B's primary key
        expect(await plain(model).findMany?.({ where: B.rows[model].filter })).toEqual(before);
      },
    );

    it("TC-008 upsert of org A's own row updates it", async () => {
      const row = await asA(() =>
        prisma.client.test.upsert({
          where: { id: A.rows.Test.filter.id as string },
          create: { orgId: A.orgId, name: 'new', durationMinutes: 60 },
          update: { name: 'upserted by A' },
        }),
      );
      expect(row).toMatchObject({
        id: A.rows.Test.filter.id,
        name: 'upserted by A',
        orgId: A.orgId,
      });
    });

    it("TC-008 upsert's create branch gets org A's id when it has none, and a create for another org is refused", async () => {
      // No orgId in the create branch: the scope fills it in.
      const filled = await asA(
        () =>
          scoped('Candidate').upsert?.({
            where: { orgId_email: { orgId: A.orgId, email: 'filled-upsert@example.test' } },
            create: { email: 'filled-upsert@example.test', fullName: 'Filled' },
            update: {},
          }) as Promise<{ orgId: string }>,
      );
      expect(filled.orgId).toBe(A.orgId);
      // The caller's own orgId is accepted as it is.
      const created = await asA(() =>
        prisma.client.candidate.upsert({
          where: { orgId_email: { orgId: A.orgId, email: 'new-upsert@example.test' } },
          create: { orgId: A.orgId, email: 'new-upsert@example.test', fullName: 'Upserted' },
          update: {},
        }),
      );
      expect(created.orgId).toBe(A.orgId);
      await expect(
        asA(() =>
          prisma.client.candidate.upsert({
            where: { orgId_email: { orgId: A.orgId, email: 'other@example.test' } },
            create: { orgId: B.orgId, email: 'other@example.test', fullName: 'Other' },
            update: {},
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
    });
  });

  describe('create', () => {
    it("TC-008 create fills in the caller's org when the data has none", async () => {
      const row = await asA(
        () =>
          scoped('Test').create?.({
            data: { name: 'No org given', durationMinutes: 30 },
          }) as Promise<{ orgId: string }>,
      );
      expect(row.orgId).toBe(A.orgId);
    });

    it('TC-008 create for another org is refused and inserts nothing', async () => {
      const before = await owner.test.count();
      await expect(
        asA(() =>
          prisma.client.test.create({
            data: { orgId: B.orgId, name: 'Smuggled', durationMinutes: 30 },
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(await owner.test.count()).toBe(before);
    });

    it('TC-008 createMany and createManyAndReturn stamp org A, and refuse a batch that names org B', async () => {
      await asA(async () => {
        const result = await prisma.client.candidate.createMany({
          data: [
            { orgId: A.orgId, email: 'many-1@example.test', fullName: 'One' },
            { orgId: A.orgId, email: 'many-2@example.test', fullName: 'Two' },
          ],
        });
        expect(result.count).toBe(2);
        const returned = await prisma.client.candidate.createManyAndReturn({
          data: [{ orgId: A.orgId, email: 'many-3@example.test', fullName: 'Three' }],
        });
        expect(returned.map((r) => r.orgId)).toEqual([A.orgId]);
      });
      const before = await owner.candidate.count();
      await expect(
        asA(() =>
          prisma.client.candidate.createMany({
            data: [
              { orgId: A.orgId, email: 'many-4@example.test', fullName: 'Four' },
              { orgId: B.orgId, email: 'many-5@example.test', fullName: 'Five' },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(await owner.candidate.count()).toBe(before);
      // Org B does not see org A's new candidates.
      const seenByB = await asB(() =>
        prisma.client.candidate.findMany({ where: { email: { startsWith: 'many-' } } }),
      );
      expect(seenByB).toEqual([]);
    });

    it("TC-008 a row created through a parent path belongs to the parent's org and is hidden from org B", async () => {
      const section = await asA(() =>
        prisma.client.testSection.create({
          data: { testId: A.rows.Test.filter.id as string, title: 'Added by A', position: 7 },
        }),
      );
      expect(
        await asA(() => prisma.client.testSection.findUnique({ where: { id: section.id } })),
      ).not.toBeNull();
      expect(
        await asB(() => prisma.client.testSection.findUnique({ where: { id: section.id } })),
      ).toBeNull();
      expect(
        await asB(() => prisma.client.testSection.count({ where: { title: 'Added by A' } })),
      ).toBe(0);
    });

    it('TC-008 an organization cannot be created or replaced inside an org scope, only in system scope', async () => {
      await expect(
        asA(() => prisma.client.organization.create({ data: { name: 'Rogue' } })),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      const created = await orgContext.runSystem('BACKGROUND_JOB', () =>
        prisma.client.organization.create({ data: { name: 'Provisioned' } }),
      );
      expect(created.name).toBe('Provisioned');
      expect(
        await asA(() => prisma.client.organization.findUnique({ where: { id: created.id } })),
      ).toBeNull();
    });

    it('TC-008 update cannot move a row to another org', async () => {
      await expect(
        asA(() =>
          prisma.client.test.update({
            where: { id: A.rows.Test.filter.id as string },
            data: { orgId: B.orgId },
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(
        (await owner.test.findUniqueOrThrow({ where: { id: A.rows.Test.filter.id as string } }))
          .orgId,
      ).toBe(A.orgId);
    });
  });

  describe('deleting own rows', () => {
    it("TC-008 org A deletes its own rows, one at a time and in bulk, and not org B's", async () => {
      const bTestsBefore = await owner.test.count({ where: { orgId: B.orgId } });
      await asA(async () => {
        const one = await prisma.client.test.create({
          data: { orgId: A.orgId, name: 'To delete', durationMinutes: 30 },
        });
        await prisma.client.test.delete({ where: { id: one.id } });
        await prisma.client.test.createMany({
          data: [
            { orgId: A.orgId, name: 'Bulk delete', durationMinutes: 30 },
            { orgId: A.orgId, name: 'Bulk delete', durationMinutes: 30 },
          ],
        });
        expect(await prisma.client.test.deleteMany({ where: { name: 'Bulk delete' } })).toEqual({
          count: 2,
        });
        // A path-scoped model: a section of A's test, then gone.
        const section = await prisma.client.testSection.create({
          data: { testId: A.rows.Test.filter.id as string, title: 'Temp', position: 8 },
        });
        await prisma.client.testSection.delete({ where: { id: section.id } });
      });
      expect(await owner.test.count({ where: { orgId: B.orgId } })).toBe(bTestsBefore);
    });
  });

  describe('transactions', () => {
    it('TC-008 an interactive transaction is scoped, and sees its own writes', async () => {
      const result = await asA(() =>
        prisma.client.$transaction(async (tx) => {
          const own = await tx.test.findMany();
          const other = await tx.test.findUnique({
            where: { id: B.rows.Test.filter.id as string },
          });
          const created = await tx.test.create({
            data: { orgId: A.orgId, name: 'In tx', durationMinutes: 30 },
          });
          const visible = await tx.test.findUnique({ where: { id: created.id } });
          const section = await tx.testSection.create({
            data: { testId: created.id, title: 'In tx', position: 0 },
          });
          const sectionVisible = await tx.testSection.findUnique({ where: { id: section.id } });
          return { ownOrgs: new Set(own.map((t) => t.orgId)), other, visible, sectionVisible };
        }),
      );
      expect([...result.ownOrgs]).toEqual([A.orgId]);
      expect(result.other).toBeNull();
      expect(result.visible).not.toBeNull();
      expect(result.sectionVisible).not.toBeNull();
    });

    it('TC-008 a rolled-back transaction leaves nothing behind', async () => {
      const before = await owner.test.count();
      await expect(
        asA(() =>
          prisma.client.$transaction(async (tx) => {
            await tx.test.create({
              data: { orgId: A.orgId, name: 'Rolled back', durationMinutes: 30 },
            });
            throw new Error('abort');
          }),
        ),
      ).rejects.toThrow('abort');
      expect(await owner.test.count()).toBe(before);
    });

    it('TC-008 a batch transaction is scoped too', async () => {
      const [tests, candidates, other] = await asA(() =>
        prisma.client.$transaction([
          prisma.client.test.findMany(),
          prisma.client.candidate.count(),
          prisma.client.test.findMany({ where: { id: B.rows.Test.filter.id as string } }),
        ]),
      );
      expect(new Set(tests.map((t) => t.orgId))).toEqual(new Set([A.orgId]));
      expect(candidates).toBe(await owner.candidate.count({ where: { orgId: A.orgId } }));
      expect(other).toEqual([]);
    });

    it('TC-008 a batch built in one scope and run in another runs with the scope it runs in', async () => {
      // The queries are lazy, so the scope that counts is the one active when the batch runs. This
      // is why a batch must be built and run in the same scope (README "Writing queries").
      const builtInA = orgContext.runInOrg(A.orgId, () => [prisma.client.test.findMany()]);
      const results = await orgContext.runInOrg(B.orgId, () =>
        prisma.client.$transaction(builtInA),
      );
      expect(new Set((results[0] ?? []).map((t) => t.orgId))).toEqual(new Set([B.orgId]));
    });

    it('TC-008 a transaction with no org context throws before it starts', async () => {
      await expect(
        prisma.client.$transaction(async (tx) => tx.test.findMany()),
      ).rejects.toBeInstanceOf(OrgContextMissingError);
    });
  });

  describe('system scope and raw SQL', () => {
    it('TC-008 system scope reads every org, and is only reachable through runSystem', async () => {
      const everyOrg = await orgContext.runSystem('AUTH_BOOTSTRAP', () =>
        prisma.client.user.findMany(),
      );
      expect(new Set(everyOrg.map((u) => u.orgId)).size).toBeGreaterThanOrEqual(2);
      await expect(prisma.client.user.findMany()).rejects.toBeInstanceOf(OrgContextMissingError);
    });

    it('TC-008 raw SQL is refused unless wrapped in runRawSql, and then it is not filtered', async () => {
      await expect(
        asA(() => prisma.client.$queryRaw`SELECT count(*)::int AS n FROM tests`),
      ).rejects.toBeInstanceOf(RawQueryNotAllowedError);
      const rows = await asA(() =>
        orgContext.runRawSql(
          'count every test for this contract test of the raw SQL policy',
          () => prisma.client.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM tests`,
        ),
      );
      // Raw SQL ignores the org scope: it sees org B's tests as well. The SQL must filter itself.
      expect(rows[0]?.n).toBe(await owner.test.count());
      // Model queries inside runRawSql are still scoped to the org.
      const scopedInside = await asA(() =>
        orgContext.runRawSql('model queries stay scoped inside a raw SQL block', () =>
          prisma.client.test.count(),
        ),
      );
      expect(scopedInside).toBe(await owner.test.count({ where: { orgId: A.orgId } }));
    });

    it('TC-008 the API connects as app_user, with the real grants', async () => {
      const rows = await asA(() =>
        orgContext.runRawSql(
          'read the connected role to prove the API runs as app_user',
          () => prisma.client.$queryRaw<Array<{ u: string }>>`SELECT current_user AS u`,
        ),
      );
      expect(rows[0]?.u).toBe('app_user');
    });
  });

  describe('staff routes: user from org A requests data of org B (TC-008)', () => {
    // A real access token with the claims BE-02's AuthService signs: sub, org, role, kind.
    const asUser = (tenant: TenantFixture): string =>
      `Bearer ${app
        .get(TokenService)
        .sign({ sub: tenant.userId, org: tenant.orgId, role: 'RECRUITER', kind: 'access' }, 300)}`;

    it("TC-008 GET another org's session is 404 and leaks nothing; own session is 200", async () => {
      const server = app.getHttpServer();
      const bSession = B.rows.Session.filter.id as string;
      const denied = await request(server)
        .get(`/probe/sessions/${bSession}`)
        .set('Authorization', asUser(A))
        .expect(404);
      expect(JSON.stringify(denied.body)).not.toContain(B.orgId);
      const own = await request(server)
        .get(`/probe/sessions/${A.rows.Session.filter.id as string}`)
        .set('Authorization', asUser(A))
        .expect(200);
      expect(own.body).toEqual({ id: A.rows.Session.filter.id, orgId: A.orgId });
      await request(server)
        .get(`/probe/sessions/${bSession}`)
        .set('Authorization', asUser(B))
        .expect(200);
    });

    it("TC-008 GET a proctor event of another org's session is 404", async () => {
      const server = app.getHttpServer();
      const bEvent = String(B.rows.ProctorEvent.filter.id);
      await request(server)
        .get(`/probe/events/${bEvent}`)
        .set('Authorization', asUser(A))
        .expect(404);
      await request(server)
        .get(`/probe/events/${bEvent}`)
        .set('Authorization', asUser(B))
        .expect(200);
    });

    it("TC-008 listings contain only the caller's org", async () => {
      const server = app.getHttpServer();
      const listA = await request(server)
        .get('/probe/sessions')
        .set('Authorization', asUser(A))
        .expect(200);
      const listB = await request(server)
        .get('/probe/sessions')
        .set('Authorization', asUser(B))
        .expect(200);
      expect(listA.body).toEqual([A.rows.Session.filter.id]);
      expect(listB.body).toEqual([B.rows.Session.filter.id]);
      const casesA = await request(server)
        .get('/probe/test-cases')
        .set('Authorization', asUser(A))
        .expect(200);
      expect(casesA.body).toEqual([A.rows.TestCase.filter.id]);
    });

    // ---- no existence oracle -------------------------------------------------------------------

    /** The response as an observer sees it, with what legitimately differs per request set aside. */
    const observed = (res: request.Response, requestedId: string, trace: string) => {
      const {
        date: _date,
        etag,
        'content-length': _length,
        ...headers
      } = res.headers as Record<string, string | undefined>;
      const body = res.body as Record<string, unknown>;
      return {
        status: res.status,
        headers,
        hasEtag: etag !== undefined,
        keys: Object.keys(body).sort(),
        // instance carries the requested path and traceId the trace header; nothing else may differ.
        body: {
          ...body,
          instance: String(body.instance).replace(requestedId, ':id'),
          traceId: body.traceId === trace ? '<trace>' : body.traceId,
        },
      };
    };

    /** The two bodies differ in length by exactly the difference between the two requested ids. */
    const expectSameSize = (
      a: request.Response,
      b: request.Response,
      idA: string,
      idB: string,
    ): void => {
      const size = (res: request.Response): number => Number(res.headers['content-length']);
      expect(size(b) - size(a)).toBe(idB.length - idA.length);
    };

    it("TC-008 no existence oracle: another org's session id and an id that exists nowhere get the same 404, field by field", async () => {
      const server = app.getHttpServer();
      const bSession = B.rows.Session.filter.id as string;
      const nowhere = randomUUID();
      const get = (id: string, trace: string) =>
        request(server)
          .get(`/probe/sessions/${id}`)
          .set('Authorization', asUser(A))
          .set('x-request-id', trace);
      const denied = await get(bSession, 'trace-oracle-aaa');
      const missing = await get(nowhere, 'trace-oracle-bbb');

      expect(denied.status).toBe(404);
      expect(missing.status).toBe(404);
      // The problem body, field by field, as ProblemFilter emits it for a NotFoundException.
      for (const [res, id, trace] of [
        [denied, bSession, 'trace-oracle-aaa'],
        [missing, nowhere, 'trace-oracle-bbb'],
      ] as const) {
        const body = res.body as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual([
          'detail',
          'instance',
          'status',
          'title',
          'traceId',
          'type',
        ]);
        expect(body.type).toBe('about:blank');
        expect(body.title).toBe('Not Found');
        expect(body.status).toBe(404);
        expect(body.detail).toBe('Not Found');
        expect(body.instance).toBe(`/probe/sessions/${id}`);
        expect(body.traceId).toBe(trace);
        expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      }
      // Everything that is not the requested id or the trace value is identical: status, every
      // header except Date (and ETag, which hashes the body that holds those two values), and body.
      expect(observed(denied, bSession, 'trace-oracle-aaa')).toEqual(
        observed(missing, nowhere, 'trace-oracle-bbb'),
      );
      expectSameSize(denied, missing, bSession, nowhere);
      // Nothing about org B is in the response.
      expect(JSON.stringify([denied.body, denied.headers])).not.toContain(B.orgId);
    });

    it('TC-008 no existence oracle: the same holds for a model scoped through its parent chain (a proctor event)', async () => {
      const server = app.getHttpServer();
      const bEvent = String(B.rows.ProctorEvent.filter.id);
      const nowhere = '9'.repeat(12); // an id no tenant has
      const get = (id: string, trace: string) =>
        request(server)
          .get(`/probe/events/${id}`)
          .set('Authorization', asUser(A))
          .set('x-request-id', trace);
      const denied = await get(bEvent, 'trace-oracle-ccc');
      const missing = await get(nowhere, 'trace-oracle-ddd');
      expect([denied.status, missing.status]).toEqual([404, 404]);
      expect((denied.body as Record<string, unknown>).detail).toBe('Not Found');
      expect(observed(denied, bEvent, 'trace-oracle-ccc')).toEqual(
        observed(missing, nowhere, 'trace-oracle-ddd'),
      );
      expectSameSize(denied, missing, bEvent, nowhere);
    });

    it("TC-008 no existence oracle: a filtered list for another org's id and for an id that exists nowhere have the same shape", async () => {
      const server = app.getHttpServer();
      const cases: Array<[string, string, string]> = [
        ['/probe/sessions?id=', B.rows.Session.filter.id as string, randomUUID()],
        ['/probe/events?sessionId=', B.rows.Session.filter.id as string, randomUUID()],
      ];
      for (const [path, bId, nowhere] of cases) {
        const get = (id: string) =>
          request(server).get(`${path}${id}`).set('Authorization', asUser(A));
        const denied = await get(bId);
        const missing = await get(nowhere);
        expect([denied.status, missing.status]).toEqual([200, 200]);
        expect([denied.body, missing.body]).toEqual([[], []]);
        // No id in the response, so every header but Date matches, ETag included.
        const strip = (res: request.Response) => {
          const { date: _date, ...headers } = res.headers as Record<string, string | undefined>;
          return headers;
        };
        expect(strip(denied)).toEqual(strip(missing));
        // The same filter for an id that does exist in org A returns A's row: the filter works.
        const own = await get(
          path.includes('sessions?')
            ? (A.rows.Session.filter.id as string)
            : (A.rows.Session.filter.id as string),
        );
        expect((own.body as unknown[]).length).toBeGreaterThan(0);
      }
    });

    // ---- a public route with no org scope fails closed -----------------------------------------

    it('TC-008 a staff route without a token is 401 from the guard, and the handler never runs', async () => {
      await db.statements.reset();
      const res = await request(app.getHttpServer()).get('/probe/sessions');
      expect(res.status).toBe(401);
      expect(await db.statements.read()).toEqual([]);
    });

    it('TC-008 a public route that reads org data fails closed: exactly the defined 500 problem, nothing leaked, no query sent', async () => {
      await db.statements.reset();
      const res = await request(app.getHttpServer())
        .get('/probe/public-sessions')
        .set('x-request-id', 'trace-public-1');

      // Exactly the defined status and shape (ProblemFilter, an unhandled error), field by field.
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      const body = res.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['instance', 'status', 'title', 'traceId', 'type']);
      expect(body.type).toBe('about:blank');
      expect(body.title).toBe('Internal Server Error');
      expect(body.status).toBe(500);
      expect(body.instance).toBe('/probe/public-sessions');
      expect(body.traceId).toBe('trace-public-1');
      expect(body).not.toHaveProperty('detail');
      expect(body).not.toHaveProperty('errors');

      // No row data, ids, org names or error internals anywhere in the response.
      const everything = JSON.stringify([res.body, res.headers, res.text]);
      const secrets = [
        A.orgId,
        B.orgId,
        A.userId,
        B.userId,
        A.rows.Session.filter.id as string,
        B.rows.Session.filter.id as string,
        'Org a',
        'Org b',
        'staff-a@',
        'staff-b@',
        'OrgContextMissingError',
        'needs an org context',
        'org context',
        'OrgScope',
        'Prisma',
        'prisma',
        'stack',
        'node_modules',
        '.ts:',
        'runInOrg',
        'runSystem',
      ];
      for (const secret of secrets) expect(everything).not.toContain(secret);
      expect(everything).not.toMatch(/\bat \S+ \(/); // no stack frame

      // The handler threw before any query: Postgres saw nothing from this request.
      expect(await db.statements.read()).toEqual([]);
    });

    it("TC-008 concurrent requests from both orgs never see each other's rows", async () => {
      const server = app.getHttpServer();
      const calls = Array.from({ length: 30 }, (_, i) => {
        const tenant = i % 2 === 0 ? A : B;
        return request(server)
          .get('/probe/sessions')
          .set('Authorization', asUser(tenant))
          .then((res) => ({ tenant, body: res.body as string[] }));
      });
      for (const { tenant, body } of await Promise.all(calls)) {
        expect(body).toEqual([tenant.rows.Session.filter.id]);
      }
    });
  });
});

describe('PrismaService lifecycle (ADR 0009 section 4.2)', () => {
  let db: MigratedDatabase;

  beforeAll(async () => {
    db = await startMigratedDatabase();
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function appUserConnections(): Promise<number> {
    const client = new Client({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      const res = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'app_user'",
      );
      return Number(res.rows[0]?.n);
    } finally {
      await client.end();
    }
  }

  it("NFR-04 connects as app_user with Nest's lifecycle, and disconnects on shutdown", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: db.appUserUrl })],
        }),
        DatabaseModule,
      ],
    }).compile();
    await moduleRef.init(); // onModuleInit: $connect
    const orgContext = moduleRef.get(OrgContextService);
    const prisma = moduleRef.get(PrismaService);

    const count = await orgContext.runSystem('BACKGROUND_JOB', () =>
      prisma.client.organization.count(),
    );
    expect(count).toBe(0);
    expect(await appUserConnections()).toBeGreaterThanOrEqual(1);

    await moduleRef.close(); // onApplicationShutdown: $disconnect
    // The server closes the backend a moment after the client hangs up.
    let remaining = await appUserConnections();
    for (let i = 0; i < 20 && remaining > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remaining = await appUserConnections();
    }
    expect(remaining).toBe(0);
  });

  it('NFR-04 starts without a database: $connect does not dial, so /health can report the outage', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none' })],
        }),
        DatabaseModule,
      ],
    }).compile();
    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });
});
