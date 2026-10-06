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
//     Two models are special on delete: audit_logs is append-only for app_user, and Session rows
//     are never deleted (ADR 0004 section 9.3): for both the database refuses delete and
//     deleteMany, so those checks expect "permission denied" instead of P2025 or a count of 0, and
//     Session's own-row control asserts that A cannot delete its own session either.
//   - upsert (not generic): tried against B's row on three models only (Test, TestSection,
//     TestCase), plus A's own row and the create branch on Test and Candidate.
//   - Dedicated tests, on chosen models: create, createMany and createManyAndReturn, filters that
//     try to widen the scope, cursors (top-level, compound, nested and fluent), nested writes
//     (parent-side connect, set and connectOrCreate, nested creates naming another org, and nested
//     writes through a RULE_I relation, all refused; child-side connect and nested writes through
//     SCOPE_HOP and COMPOSITE relations still work), deleting own rows, transactions, system scope,
//     raw SQL, the app_user role and the HTTP path through the real guard.
//   - Not covered, by design (README "Limits"): re-parenting in an org scope, ids written through
//     a child-side connect or a scalar foreign key (rule (i), the service's job), and nested reads.
//     One test pins that an org scope can re-parent a row, one that an include follows a cross-org
//     foreign key. System scope refuses a first-hop key and `orgId` in an update (FU-DB-107).
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
import { TokenValidityService } from '../common/auth/token-validity.service';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { DatabaseModule } from './database.module';
import { OrgContextMissingError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import { OrgContextService } from './org-context';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { FK_CLASSES, scopeHopColumn } from './org-scope-relations';
import { PrismaService } from './prisma.service';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { staffBearer } from './testing/staff-token';
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
// JwtAuthGuard authenticates (deny by default: @Roles or @Public; both on one route is refused) and
// the interceptor sets the org. Roles are declared per method, and the public route lives in its own
// controller, because the merged guard refuses a @Public() method inside a @Roles() class.
@Controller('probe')
class ProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('sessions/:id')
  @Roles(...ALL_ROLES)
  async session(@Param('id') id: string): Promise<{ id: string; orgId: string }> {
    const row = await this.prisma.client.session.findUnique({ where: { id } });
    if (row === null) throw new NotFoundException();
    return { id: row.id, orgId: row.orgId };
  }

  @Get('sessions')
  @Roles(...ALL_ROLES)
  async sessions(@Query('id') id?: string): Promise<string[]> {
    const where = id === undefined ? undefined : { id };
    return (await this.prisma.client.session.findMany({ where })).map((s) => s.id);
  }

  // A filtered list on a model scoped through its parent chain.
  @Get('events')
  @Roles(...ALL_ROLES)
  async events(@Query('sessionId') sessionId?: string): Promise<string[]> {
    const where = sessionId === undefined ? undefined : { sessionId };
    return (await this.prisma.client.proctorEvent.findMany({ where, orderBy: { id: 'asc' } })).map(
      (e) => String(e.id),
    );
  }

  @Get('events/:id')
  @Roles(...ALL_ROLES)
  async event(@Param('id') id: string): Promise<{ id: string }> {
    const row = await this.prisma.client.proctorEvent.findUnique({ where: { id: BigInt(id) } });
    if (row === null) throw new NotFoundException();
    return { id: String(row.id) };
  }

  @Get('test-cases')
  @Roles(...ALL_ROLES)
  async testCases(): Promise<string[]> {
    return (await this.prisma.client.testCase.findMany()).map((c) => c.id);
  }
}

// A public route (no request.user, so no org context) that tries to read org data.
@Controller('probe')
@Public()
class PublicProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('public-sessions')
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
    return (
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [() => ({ DATABASE_URL: url, JWT_ACCESS_SECRET: JWT_SECRET })],
          }),
          TokenModule,
          // BE-02's unscoped client: the real guard re-reads the user through it on every request
          // (FU-DB-58 moves that to the scoped client in BE-03). DatabaseModule is the scoped one.
          DatabaseModule,
        ],
        controllers: [ProbeController, PublicProbeController],
        // BE-02's guard. DatabaseModule registers the interceptor that runs after it.
        providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
      })
        // The guard's Redis marker check (S1) is not under test here: no token is invalidated.
        .overrideProvider(TokenValidityService)
        .useValue({ isFresh: () => Promise.resolve(true) })
        .compile()
    );
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

    it(`${
      model === 'Session'
        ? "TC-008 org A cannot change org B's Session row, and Session rows are never deleted (ADR 0004 §9.3): delete and deleteMany are refused"
        : `TC-008 org A cannot change or delete org B's ${model} row (update, updateMany, updateManyAndReturn, delete, deleteMany)`
    }`, async () => {
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
        if (model === 'Session') {
          // Session rows are never deleted (ADR 0004 section 9.3): app_user has no DELETE on
          // sessions, so the database refuses both statements whatever the filter, before it looks
          // for a row. Deleting a session would cascade to its consent row, which R-9 keeps for
          // 3 years. The check after these attempts shows that B's row is still there.
          await expect(d.delete?.({ where: b.unique })).rejects.toThrow(/permission denied/i);
          await expect(d.deleteMany?.({ where: b.filter })).rejects.toThrow(/permission denied/i);
          return;
        }
        if (model === 'Organization') {
          // An org scope cannot delete an organization at all, its own or another (FU-DB-68):
          // refused before any query, so the answer is not P2025 or a count of 0.
          await expect(d.delete?.({ where: b.unique })).rejects.toBeInstanceOf(
            OrgScopeViolationError,
          );
          await expect(d.deleteMany?.({ where: b.filter })).rejects.toBeInstanceOf(
            OrgScopeViolationError,
          );
          return;
        }
        await expect(d.delete?.({ where: b.unique })).rejects.toMatchObject({ code: 'P2025' });
        expect(await d.deleteMany?.({ where: b.filter })).toEqual({ count: 0 });
      });
      await attempts;
      expect(await plain(model).findMany?.({ where: b.filter })).toEqual(before);
    });

    it(`${
      model === 'Session'
        ? 'TC-008 org A changes its own Session row, and cannot delete it either: Session rows are never deleted (ADR 0004 §9.3)'
        : `TC-008 org A changes its own ${model} row`
    }`, async () => {
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
        if (model === 'Session') {
          // The same-org control for delete is a refusal (see the cross-org test above).
          await expect(d.delete?.({ where: a.unique })).rejects.toThrow(/permission denied/i);
          await expect(d.deleteMany?.({ where: a.filter })).rejects.toThrow(/permission denied/i);
          expect(await d.count?.({ where: a.filter })).toBe(1);
        }
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

    it('TC-008 a compound own-org cursor ({ id_orgId } with the added top-level orgId) pages correctly (positive control)', async () => {
      // Test has @@unique([id, orgId]), so { id_orgId: { id, orgId } } is a valid cursor.
      for (let n = 0; n < 3; n++) {
        await owner.test.create({
          data: { orgId: E.orgId, name: `compound-${n}`, durationMinutes: 30 },
        });
      }
      const sorted = (await owner.test.findMany({ where: { orgId: E.orgId }, orderBy: order })).map(
        (t) => t.id,
      );
      expect(sorted.length).toBeGreaterThanOrEqual(4);
      const middle = sorted[2] as string;
      const paged = await asE(() =>
        prisma.client.test.findMany({
          cursor: { id_orgId: { id: middle, orgId: E.orgId } },
          orderBy: order,
        }),
      );
      expect(paged.map((t) => t.id)).toEqual(sorted.slice(2));
      expect(
        await asE(() =>
          prisma.client.test.count({
            cursor: { id_orgId: { id: middle, orgId: E.orgId } },
            orderBy: order,
          }),
        ),
      ).toBe(sorted.length - 2);
      // The same compound key naming org F is refused, and F's test is never used as a cursor.
      await expect(
        asE(() =>
          prisma.client.test.findMany({
            cursor: { id_orgId: { id: F.rows.Test.filter.id as string, orgId: F.orgId } },
            orderBy: order,
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
    });

    describe('a cursor nested in include or select (and the fluent API)', () => {
      it("TC-008 left as it is, a nested cursor on org F's event ranks org E's events against it (why nested cursors are refused)", async () => {
        const nested = await plain.session.findUnique({
          where: { id: E.rows.Session.filter.id as string },
          include: { proctorEvents: { cursor: { id: fEvent }, orderBy: order } },
        });
        // F's event sits between E's: E's later events come back, ranked against F's row.
        expect(ids(nested?.proctorEvents ?? [])).toEqual([eEvents[1], eEvents[2]]);
        const fluent = await plain.session
          .findUnique({ where: { id: E.rows.Session.filter.id as string } })
          .proctorEvents({ cursor: { id: fEvent }, orderBy: order });
        expect(ids(fluent ?? [])).toEqual([eEvents[1], eEvents[2]]);
      });

      it("TC-008 org E's nested cursor, in include, select and the fluent API, is refused (any row, own or not)", async () => {
        const where = { id: E.rows.Session.filter.id as string };
        await asE(async () => {
          const client = prisma.client;
          for (const cursor of [{ id: fEvent }, { id: eEvents[0]! }]) {
            const events = { cursor, orderBy: order };
            await expect(
              client.session.findUnique({ where, include: { proctorEvents: events } }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.session.findUnique({
                where,
                select: { proctorEvents: { select: { id: true }, ...events } },
              }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.session.findUniqueOrThrow({ where, include: { proctorEvents: events } }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.session.findMany({ where, include: { proctorEvents: events } }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            // The fluent API: session.findUnique(...).proctorEvents({ cursor }).
            await expect(
              client.session.findUnique({ where }).proctorEvents(events),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.session.findUniqueOrThrow({ where }).proctorEvents(events),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.session.findFirst({ where }).proctorEvents(events),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
          }
          // Deeper: a cursor two levels down.
          await expect(
            client.test.findMany({
              include: { sections: { include: { questions: { cursor: { id: 'x' } } } } },
            }),
          ).rejects.toBeInstanceOf(OrgScopeViolationError);
        });
      });

      it("TC-008 a nested include with take and orderBy and no cursor returns org E's events (positive control)", async () => {
        const where = { id: E.rows.Session.filter.id as string };
        await asE(async () => {
          const client = prisma.client;
          const page = await client.session.findUnique({
            where,
            include: { proctorEvents: { orderBy: order, take: 2 } },
          });
          expect(ids(page?.proctorEvents ?? [])).toEqual([eEvents[0], eEvents[1]]);
          const next = await client.session.findUnique({
            where,
            include: {
              proctorEvents: { where: { id: { gt: eEvents[1]! } }, orderBy: order, take: 2 },
            },
          });
          expect(ids(next?.proctorEvents ?? [])).toEqual([eEvents[2]]);
          const selected = await client.session.findUnique({
            where,
            select: {
              proctorEvents: { select: { id: true }, orderBy: { id: 'desc' }, skip: 1, take: 1 },
            },
          });
          expect(selected?.proctorEvents.map((e) => e.id)).toEqual([eEvents[1]]);
          // The fluent API pages the same way.
          const fluent = await client.session
            .findUnique({ where })
            .proctorEvents({ orderBy: order, take: 2 });
          expect(ids(fluent ?? [])).toEqual([eEvents[0], eEvents[1]]);
        });
      });
    });
  });

  describe("nested relation writes are denied by default (ADR 0006 section 8): a write through a relation cannot change another org's rows", () => {
    // H acts; I is the victim. Fresh tenants, so the refusals can be checked against untouched rows.
    let H: TenantFixture;
    let I: TenantFixture;
    let plain: PrismaClient; // the factory client with no scope: it shows what the writes would do
    const asH = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(H.orgId, fn);
    const id = (tenant: TenantFixture, model: ModelName): string =>
      tenant.rows[model].filter.id as string;
    /** An invitation of the tenant that has no session yet (sessions.invitation_id is unique). */
    const freeInvitation = (tenant: TenantFixture) =>
      owner.invitation.create({
        data: {
          orgId: tenant.orgId,
          testId: id(tenant, 'Test'),
          candidateId: id(tenant, 'Candidate'),
          tokenHash: `free-${randomUUID()}`,
          windowStart: new Date('2026-10-05T12:00:00Z'),
          windowEnd: new Date('2026-10-06T12:00:00Z'),
        },
      });
    const refusedByTheRule = (what: string): RegExp =>
      new RegExp(`nested relation write refused \\(${what}\\)`);

    beforeAll(async () => {
      plain = createPrismaClient(db.appUserUrl);
      H = await createTenant(owner, 'h');
      I = await createTenant(owner, 'i');
    });

    afterAll(async () => {
      await plain?.$disconnect();
    });

    it("TC-008 organization.update users.connect of org I's user is refused, and the user stays in org I", async () => {
      await expect(
        asH(() =>
          prisma.client.organization.update({
            where: { id: H.orgId },
            data: { users: { connect: { id: I.userId } } },
          }),
        ),
      ).rejects.toThrow(refusedByTheRule('Organization\\.users\\.connect'));
      expect((await owner.user.findUniqueOrThrow({ where: { id: I.userId } })).orgId).toBe(I.orgId);
    });

    it("TC-008 a parent-side set, connect, connectOrCreate and a deep connect are refused, and org I's rows are unchanged", async () => {
      const before = await snapshot();
      const attempts: Array<() => Promise<unknown>> = [
        () =>
          prisma.client.testSection.update({
            where: { id: id(H, 'TestSection') },
            data: { questions: { set: [{ id: id(I, 'TestQuestion') }] } },
          }),
        () =>
          prisma.client.session.update({
            where: { id: id(H, 'Session') },
            data: { review: { connect: { id: id(I, 'SessionReview') } } },
          }),
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
      const loose = <T>(value: unknown): T => value as T;
      type OrgData = Parameters<typeof prisma.client.organization.update>[0]['data'];
      const nested = (questions: unknown): OrgData => loose<OrgData>({ questions });
      const update = (data: OrgData) =>
        asH(() => prisma.client.organization.update({ where: { id: H.orgId }, data }));
      const questions = await owner.question.count();
      for (const data of [
        nested({ create: { orgId: I.orgId, slug: 'smuggled' } }),
        nested({ createMany: { data: [{ orgId: I.orgId, slug: 'many' }] } }),
        nested({ create: { org: { connect: { id: I.orgId } }, slug: 'via-org' } }),
        // Even naming the caller's own org: no nested relation write at all.
        nested({ create: { slug: 'under-own-org' } }),
      ]) {
        await expect(update(data)).rejects.toBeInstanceOf(OrgScopeViolationError);
      }
      expect(await owner.question.count()).toBe(questions);
      // Positive control, scalar form: a top-level create stamps org H, or takes the scalar orgId.
      const stamped = await asH(
        () =>
          (prisma.client as unknown as Record<string, Delegate>).question?.create?.({
            data: { slug: 'stamped' },
          }) as Promise<{ orgId: string }>,
      );
      expect(stamped.orgId).toBe(H.orgId);
      await asH(() => prisma.client.question.create({ data: { orgId: H.orgId, slug: 'scalar' } }));
      expect(await owner.question.count()).toBe(questions + 2);
    });

    it('TC-008 org: { connect } on a direct model is refused, and the scalar orgId is the way', async () => {
      await expect(
        asH(() =>
          prisma.client.test.create({
            data: { org: { connect: { id: H.orgId } }, name: 't', durationMinutes: 30 },
          }),
        ),
      ).rejects.toThrow(refusedByTheRule('Test\\.org\\.connect'));
      const created = await asH(() =>
        prisma.client.test.create({
          data: { orgId: H.orgId, name: 'scalar org', durationMinutes: 30 },
        }),
      );
      expect(created.orgId).toBe(H.orgId);
    });

    it('TC-008 the refusals carry no ids, org ids or other values', async () => {
      const error = await asH(() =>
        prisma.client.organization.update({
          where: { id: H.orgId },
          data: { users: { connect: { id: I.userId } } },
        }),
      ).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(OrgScopeViolationError);
      expect((error as Error).message).toBe(
        'Organization.update: nested relation write refused (Organization.users.connect): write ' +
          'related rows with their own scoped call and scalar foreign keys (ADR 0006 §8, ' +
          'deny-by-default).',
      );
      for (const secret of [I.userId, I.orgId, H.orgId, H.userId]) {
        expect((error as Error).message).not.toContain(secret);
      }
    });

    it('TC-008 a child-side connect is refused too, and the scalar foreign key does the same job', async () => {
      await expect(
        asH(() =>
          prisma.client.testQuestion.update({
            where: { id: id(H, 'TestQuestion') },
            data: { questionVersion: { connect: { id: id(H, 'QuestionVersion') } } },
          }),
        ),
      ).rejects.toThrow(refusedByTheRule('TestQuestion\\.questionVersion\\.connect'));
      const updated = await asH(() =>
        prisma.client.testQuestion.update({
          where: { id: id(H, 'TestQuestion') },
          data: { questionVersionId: id(H, 'QuestionVersion') },
        }),
      );
      expect(updated.questionVersionId).toBe(id(H, 'QuestionVersion'));
    });

    it('TC-008 nested create, update and delete under an in-scope parent are refused; separate top-level calls with scalar foreign keys work and stay in org H', async () => {
      // The nested forms, through a SCOPE_HOP relation (test.sections).
      const section = id(H, 'TestSection');
      for (const data of [
        { sections: { create: { title: 'nested', position: 11 } } },
        { sections: { update: { where: { id: section }, data: { title: 'renamed' } } } },
        { sections: { deleteMany: { title: 'x' } } },
        { sections: { updateMany: { where: {}, data: { title: 'x' } } } },
        {
          sections: {
            upsert: { where: { id: section }, create: { title: 'u', position: 1 }, update: {} },
          },
        },
        { sections: { delete: [{ id: section }] } },
        { sections: { disconnect: [{ id: section }] } },
      ]) {
        await expect(
          asH(() => prisma.client.test.update({ where: { id: id(H, 'Test') }, data: data })),
        ).rejects.toBeInstanceOf(OrgScopeViolationError);
      }
      // The same work as separate calls, with scalar foreign keys.
      const created = await asH(() =>
        prisma.client.testSection.create({
          data: { testId: id(H, 'Test'), title: 'scalar', position: 12 },
        }),
      );
      const question = await asH(() =>
        prisma.client.testQuestion.create({
          data: { sectionId: created.id, questionVersionId: id(H, 'QuestionVersion'), position: 0 },
        }),
      );
      expect(await asH(() => prisma.client.testSection.count({ where: { title: 'scalar' } }))).toBe(
        1,
      );
      expect(
        await orgContext.runInOrg(I.orgId, () =>
          prisma.client.testSection.count({ where: { title: 'scalar' } }),
        ),
      ).toBe(0);
      await asH(() =>
        prisma.client.testSection.update({ where: { id: created.id }, data: { title: 'renamed' } }),
      );
      expect((await owner.testSection.findUniqueOrThrow({ where: { id: created.id } })).title).toBe(
        'renamed',
      );
      await asH(() => prisma.client.testQuestion.delete({ where: { id: question.id } }));
      await asH(() => prisma.client.testSection.delete({ where: { id: created.id } }));
      expect(await owner.testSection.count({ where: { id: created.id } })).toBe(0);
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

    it('TC-008 nested relation writes are refused in system scope too, and scalar writes still work there', async () => {
      const J = await createTenant(owner, 'j');
      const K = await createTenant(owner, 'k');
      await expect(
        orgContext.runSystem('BACKGROUND_JOB', () =>
          prisma.client.organization.update({
            where: { id: J.orgId },
            data: { users: { connect: { id: K.userId } } },
          }),
        ),
      ).rejects.toThrow(refusedByTheRule('Organization\\.users\\.connect'));
      expect((await owner.user.findUniqueOrThrow({ where: { id: K.userId } })).orgId).toBe(K.orgId);
      await expect(
        orgContext.runSystem('BACKGROUND_JOB', () =>
          prisma.client.session.update({
            where: { id: id(J, 'Session') },
            data: { invitation: { connect: { id: id(K, 'Invitation') } } },
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      // The scalar form in system scope is an ordinary write.
      const renamed = await orgContext.runSystem('BACKGROUND_JOB', () =>
        prisma.client.user.update({
          where: { id: K.userId },
          data: { fullName: 'Renamed in system' },
        }),
      );
      expect(renamed.fullName).toBe('Renamed in system');
    });

    describe('B2(a): connect through a COMPOSITE relation rewrites org_id', () => {
      it('TC-008 evidence, plain client with the org filter written by hand: connect moves a session into another org, and the scalar form is rejected by Postgres', async () => {
        const P = await createTenant(owner, 'p');
        const Q = await createTenant(owner, 'q');
        const sessionP = id(P, 'Session');
        const freeQ = await freeInvitation(Q);

        // The scalar form keeps org_id = P, and the composite foreign key refuses it.
        await expect(
          plain.session.update({
            where: { id: sessionP, orgId: P.orgId },
            data: { invitationId: freeQ.id },
          }),
        ).rejects.toMatchObject({ code: 'P2003' });
        expect((await owner.session.findUniqueOrThrow({ where: { id: sessionP } })).orgId).toBe(
          P.orgId,
        );

        // connect writes every column of the key, org_id included, from the connected row.
        await plain.session.update({
          where: { id: sessionP, orgId: P.orgId },
          data: { invitation: { connect: { id: freeQ.id } } },
        });
        const moved = await owner.session.findUniqueOrThrow({ where: { id: sessionP } });
        expect({ orgId: moved.orgId, invitationId: moved.invitationId }).toEqual({
          orgId: Q.orgId,
          invitationId: freeQ.id,
        });
        // Its proctoring data went with it: the events are reachable from org Q now.
        expect(
          await owner.proctorEvent.count({
            where: { sessionId: sessionP, session: { orgId: Q.orgId } },
          }),
        ).toBe(1);

        // The same on create: org: connect R with invitation: connect Q ends up in org Q.
        const R = await createTenant(owner, 'r');
        const freeQ2 = await freeInvitation(Q);
        const created = await plain.session.create({
          data: {
            org: { connect: { id: R.orgId } },
            invitation: { connect: { id: freeQ2.id } },
          } as never,
        });
        expect(created.orgId).toBe(Q.orgId);

        // And an invitation moves when its test and candidate are both connected.
        const S = await createTenant(owner, 's');
        const freeS = await freeInvitation(S);
        await plain.invitation.update({
          where: { id: freeS.id, orgId: S.orgId },
          data: {
            test: { connect: { id: id(Q, 'Test') } },
            candidate: { connect: { id: id(Q, 'Candidate') } },
          },
        });
        expect((await owner.invitation.findUniqueOrThrow({ where: { id: freeS.id } })).orgId).toBe(
          Q.orgId,
        );
      });

      it("TC-008 as org H: session.update invitation.connect of org I's invitation is refused, and the session keeps its org and invitation", async () => {
        const freeI = await freeInvitation(I);
        const before = await owner.session.findUniqueOrThrow({ where: { id: id(H, 'Session') } });
        for (const data of [
          { invitation: { connect: { id: freeI.id } } },
          { invitation: { connectOrCreate: { where: { id: freeI.id }, create: {} } } },
        ]) {
          await expect(
            asH(() =>
              prisma.client.session.update({
                where: { id: id(H, 'Session') },
                data: data as never,
              }),
            ),
          ).rejects.toThrow(refusedByTheRule('Session\\.invitation\\.(connect|connectOrCreate)'));
        }
        // create: org connect with invitation connect
        await expect(
          asH(() =>
            prisma.client.session.create({
              data: {
                org: { connect: { id: H.orgId } },
                invitation: { connect: { id: freeI.id } },
              },
            }),
          ),
        ).rejects.toBeInstanceOf(OrgScopeViolationError);
        // invitation.update: test and candidate connect
        const freeH = await freeInvitation(H);
        await expect(
          asH(() =>
            prisma.client.invitation.update({
              where: { id: freeH.id },
              data: {
                test: { connect: { id: id(I, 'Test') } },
                candidate: { connect: { id: id(I, 'Candidate') } },
              },
            }),
          ),
        ).rejects.toBeInstanceOf(OrgScopeViolationError);
        const after = await owner.session.findUniqueOrThrow({ where: { id: id(H, 'Session') } });
        expect({ orgId: after.orgId, invitationId: after.invitationId }).toEqual({
          orgId: before.orgId,
          invitationId: before.invitationId,
        });
        expect((await owner.invitation.findUniqueOrThrow({ where: { id: freeH.id } })).orgId).toBe(
          H.orgId,
        );
      });

      it("TC-008 as org H: the scalar invitationId of org I's invitation is rejected by the composite foreign key in Postgres, and the scalar form with H's own invitation works", async () => {
        const freeI = await freeInvitation(I);
        await expect(
          asH(() =>
            prisma.client.session.update({
              where: { id: id(H, 'Session') },
              data: { invitationId: freeI.id },
            }),
          ),
        ).rejects.toMatchObject({ code: 'P2003' });
        expect(
          (await owner.session.findUniqueOrThrow({ where: { id: id(H, 'Session') } })).orgId,
        ).toBe(H.orgId);

        const freeH = await freeInvitation(H);
        const updated = await asH(() =>
          prisma.client.session.update({
            where: { id: id(H, 'Session') },
            data: { invitationId: freeH.id },
          }),
        );
        expect({ orgId: updated.orgId, invitationId: updated.invitationId }).toEqual({
          orgId: H.orgId,
          invitationId: freeH.id,
        });
      });
    });

    describe('B2(b): connect plus a write in one to-one input writes the connected row', () => {
      it("TC-008 evidence, plain client: refreshToken.update user connect + update writes the connected user (another org's)", async () => {
        const T = await createTenant(owner, 't');
        const U = await createTenant(owner, 'u');
        const token = id(T, 'RefreshToken');
        await plain.refreshToken.update({
          where: { id: token },
          data: {
            user: {
              connect: { id: U.userId },
              update: { passwordHash: 'pwned', email: 'attacker-t@example.test' },
            },
          } as never,
        });
        // The token was re-parented, and the update hit the user it was just connected to.
        expect((await owner.refreshToken.findUniqueOrThrow({ where: { id: token } })).userId).toBe(
          U.userId,
        );
        const victim = await owner.user.findUniqueOrThrow({ where: { id: U.userId } });
        expect({ passwordHash: victim.passwordHash, email: victim.email }).toEqual({
          passwordHash: 'pwned',
          email: 'attacker-t@example.test',
        });
        expect((await owner.user.findUniqueOrThrow({ where: { id: T.userId } })).passwordHash).toBe(
          'not-a-real-hash',
        );
      });

      it("TC-008 as org H: the same call, and the same shape on testSection.test, submission.sessionQuestion and session.invitation, is refused, and org I's user is unchanged", async () => {
        const before = await snapshot();
        const attempts: Array<() => Promise<unknown>> = [
          () =>
            prisma.client.refreshToken.update({
              where: { id: id(H, 'RefreshToken') },
              data: {
                user: {
                  connect: { id: I.userId },
                  update: { passwordHash: 'pwned', email: 'a@x.test' },
                },
              },
            }),
          () =>
            prisma.client.testSection.update({
              where: { id: id(H, 'TestSection') },
              data: {
                test: { connect: { id: id(I, 'Test') }, update: { name: 'pwned' } },
              },
            }),
          () =>
            prisma.client.submission.update({
              where: { id: id(H, 'Submission') },
              data: {
                sessionQuestion: {
                  connect: { id: id(I, 'SessionQuestion') },
                  update: { score: 1 },
                },
              },
            }),
          () =>
            prisma.client.session.update({
              where: { id: id(H, 'Session') },
              data: {
                invitation: {
                  connect: { id: id(I, 'Invitation') },
                  update: { sentAt: new Date() },
                },
              },
            }),
        ];
        for (const attempt of attempts) {
          await expect(asH(attempt)).rejects.toBeInstanceOf(OrgScopeViolationError);
        }
        const victim = await owner.user.findUniqueOrThrow({ where: { id: I.userId } });
        expect({ passwordHash: victim.passwordHash, email: victim.email }).toEqual({
          passwordHash: 'not-a-real-hash',
          email: 'staff-i@example.test',
        });
        expect(await snapshot()).toEqual(before);
      });
    });

    describe('through a RULE_I relation: the row on the other side can belong to another org', () => {
      // L's review names org I's user as its reviewer (the database allows it: the foreign key is
      // rule (i), not composite). Nested writes through that relation would reach org I's user.
      let L: TenantFixture;
      const asL = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(L.orgId, fn);
      const reviewId = () => id(L, 'SessionReview');

      beforeAll(async () => {
        L = await createTenant(owner, 'l');
        await owner.sessionReview.update({
          where: { id: reviewId() },
          data: { reviewerId: I.userId },
        });
      });

      it("TC-008 sessionReview.update reviewer.update (and connect + update, delete, upsert) and the parent-side updateMany and deleteMany are refused, and org I's user is unchanged", async () => {
        const before = await snapshot();
        const attempts: Array<() => Promise<unknown>> = [
          () =>
            prisma.client.sessionReview.update({
              where: { id: reviewId() },
              data: { reviewer: { update: { passwordHash: 'pwned' } } },
            }),
          () =>
            prisma.client.sessionReview.update({
              where: { id: reviewId() },
              data: { reviewer: { update: { data: { email: 'attacker@example.test' } } } },
            }),
          () =>
            prisma.client.sessionReview.update({
              where: { id: reviewId() },
              data: {
                reviewer: {
                  connect: { id: I.userId },
                  update: { email: 'attacker@example.test', passwordHash: 'pwned' },
                },
              },
            }),
          () =>
            prisma.client.sessionReview.update({
              where: { id: reviewId() },
              data: { reviewer: { delete: true } as never },
            }),
          () =>
            prisma.client.sessionReview.update({
              where: { id: reviewId() },
              data: {
                reviewer: { upsert: { create: {}, update: { passwordHash: 'pwned' } } } as never,
              },
            }),
          () =>
            prisma.client.user.update({
              where: { id: L.userId },
              data: {
                sessionReviews: { updateMany: { where: {}, data: { notes: 'overwritten' } } },
              },
            }),
          () =>
            prisma.client.user.update({
              where: { id: L.userId },
              data: { sessionReviews: { deleteMany: {} } },
            }),
        ];
        for (const attempt of attempts) {
          await expect(asL(attempt)).rejects.toBeInstanceOf(OrgScopeViolationError);
        }
        const victim = await owner.user.findUniqueOrThrow({ where: { id: I.userId } });
        expect(victim.passwordHash).toBe('not-a-real-hash');
        expect(victim.email).toBe('staff-i@example.test');
        expect(await snapshot()).toEqual(before);
      });

      it('TC-008 a child-side connect and disconnect through the same relations are refused, and the scalar foreign keys work', async () => {
        await expect(
          asL(() =>
            prisma.client.sessionReview.update({
              where: { id: reviewId() },
              data: { reviewer: { connect: { id: L.userId } } },
            }),
          ),
        ).rejects.toThrow(refusedByTheRule('SessionReview\\.reviewer\\.connect'));
        await expect(
          asL(() =>
            prisma.client.appeal.update({
              where: { id: id(L, 'Appeal') },
              data: { assignedTo: { disconnect: true } },
            }),
          ),
        ).rejects.toThrow(refusedByTheRule('Appeal\\.assignedTo\\.disconnect'));
        // Scalar foreign keys: the review back to L's own reviewer, and the nullable key set and cleared.
        const reconnected = await asL(() =>
          prisma.client.sessionReview.update({
            where: { id: reviewId() },
            data: { reviewerId: L.userId },
          }),
        );
        expect(reconnected.reviewerId).toBe(L.userId);
        await asL(() =>
          prisma.client.appeal.update({
            where: { id: id(L, 'Appeal') },
            data: { assignedToId: L.userId },
          }),
        );
        expect(
          (await owner.appeal.findUniqueOrThrow({ where: { id: id(L, 'Appeal') } })).assignedToId,
        ).toBe(L.userId);
        await asL(() =>
          prisma.client.appeal.update({
            where: { id: id(L, 'Appeal') },
            data: { assignedToId: null },
          }),
        );
        expect(
          (await owner.appeal.findUniqueOrThrow({ where: { id: id(L, 'Appeal') } })).assignedToId,
        ).toBeNull();
      });

      it('TC-008 nested writes through COMPOSITE relations are refused, and the work is done with scalar foreign keys', async () => {
        // candidate.invitations is COMPOSITE.
        await expect(
          asL(() =>
            prisma.client.candidate.update({
              where: { id: id(L, 'Candidate') },
              data: { invitations: { updateMany: { where: {}, data: { sentAt: new Date() } } } },
            }),
          ),
        ).rejects.toThrow(refusedByTheRule('Candidate\\.invitations\\.updateMany'));
        const updated = await asL(() =>
          prisma.client.invitation.updateMany({
            where: { candidateId: id(L, 'Candidate') },
            data: { sentAt: new Date('2026-10-07T00:00:00Z') },
          }),
        );
        expect(updated.count).toBeGreaterThan(0);
      });
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
    it('TC-008 the scalar-FK (unchecked) forms type-check through the extended client without casts, and write what they say', async () => {
      // These are the calls the README shows. If the generated types or the extension's type stopped
      // accepting them, `pnpm typecheck` would fail here: no `as` anywhere in this test.
      const stamp = randomUUID();
      const invitation = await asA(() =>
        prisma.client.invitation.create({
          data: {
            orgId: A.orgId,
            testId: A.rows.Test.filter.id as string,
            candidateId: A.rows.Candidate.filter.id as string,
            tokenHash: `unchecked-${stamp}`,
            windowStart: new Date('2026-10-05T12:00:00Z'),
            windowEnd: new Date('2026-10-06T12:00:00Z'),
          },
        }),
      );
      const session = await asA(() =>
        prisma.client.session.create({ data: { orgId: A.orgId, invitationId: invitation.id } }),
      );
      expect({ orgId: session.orgId, invitationId: session.invitationId }).toEqual({
        orgId: A.orgId,
        invitationId: invitation.id,
      });
      const created = await asA(() =>
        prisma.client.testSection.createMany({
          data: [1, 2].map((n) => ({
            testId: A.rows.Test.filter.id as string,
            title: `unchecked ${stamp} ${n}`,
            position: 30 + n,
          })),
        }),
      );
      expect(created.count).toBe(2);
      // Leave org A as it was: later tests expect it to have exactly one session and one invitation.
      await owner.session.delete({ where: { id: session.id } });
      await owner.invitation.delete({ where: { id: invitation.id } });
      await owner.testSection.deleteMany({ where: { title: { contains: stamp } } });
    });

    it('TC-008 orgId is stamped on scalar-only (unchecked) input: create, createMany, createManyAndReturn and upsert.create', async () => {
      const stamp = randomUUID();
      const loose = <T>(op: string, model: ModelName, args: unknown): Promise<T> =>
        asA(() => scoped(model)[op]?.(args) as Promise<T>);
      const fk = {
        testId: A.rows.Test.filter.id as string,
        candidateId: A.rows.Candidate.filter.id as string,
        windowStart: new Date('2026-10-05T12:00:00Z'),
        windowEnd: new Date('2026-10-06T12:00:00Z'),
      };

      // create: scalar foreign keys (testId, candidateId), no orgId.
      const one = await loose<{ orgId: string }>('create', 'Invitation', {
        data: { ...fk, tokenHash: `stamp-create-${stamp}` },
      });
      expect(one.orgId).toBe(A.orgId);

      // createMany: every row stamped.
      const many = await loose<{ count: number }>('createMany', 'Invitation', {
        data: [1, 2].map((n) => ({ ...fk, tokenHash: `stamp-many-${stamp}-${n}` })),
      });
      expect(many.count).toBe(2);

      // createManyAndReturn: stamped, and returned.
      const returned = await loose<Array<{ orgId: string }>>('createManyAndReturn', 'Invitation', {
        data: [1, 2].map((n) => ({ ...fk, tokenHash: `stamp-return-${stamp}-${n}` })),
      });
      expect(returned.map((row) => row.orgId)).toEqual([A.orgId, A.orgId]);

      // upsert: the create branch is stamped, the update branch is not touched.
      const upserted = await loose<{ orgId: string }>('upsert', 'Invitation', {
        where: { tokenHash: `stamp-upsert-${stamp}` },
        create: { ...fk, tokenHash: `stamp-upsert-${stamp}` },
        update: { sentAt: new Date('2026-10-05T13:00:00Z') },
      });
      expect(upserted.orgId).toBe(A.orgId);

      // Everything created above belongs to org A in the database, and to nobody else.
      const rows = await owner.invitation.findMany({ where: { tokenHash: { contains: stamp } } });
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((row) => row.orgId))).toEqual(new Set([A.orgId]));
      expect(
        await asB(() =>
          prisma.client.invitation.count({ where: { tokenHash: { contains: stamp } } }),
        ),
      ).toBe(0);

      // The same input naming another org's id is refused, on all four operations.
      for (const [op, args] of [
        ['create', { data: { ...fk, tokenHash: `x-${stamp}`, orgId: B.orgId } }],
        ['createMany', { data: [{ ...fk, tokenHash: `y-${stamp}`, orgId: B.orgId }] }],
        ['createManyAndReturn', { data: [{ ...fk, tokenHash: `z-${stamp}`, orgId: B.orgId }] }],
        [
          'upsert',
          {
            where: { tokenHash: `w-${stamp}` },
            create: { ...fk, tokenHash: `w-${stamp}`, orgId: B.orgId },
            update: {},
          },
        ],
      ] as const) {
        await expect(loose(op, 'Invitation', args)).rejects.toBeInstanceOf(OrgScopeViolationError);
      }
      await owner.invitation.deleteMany({ where: { tokenHash: { contains: stamp } } });
    });

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

  describe('system scope cannot move a row to another org (scalar orgId or first-hop key in an update)', () => {
    // Deny-by-default refuses nested relation writes, so a scalar foreign key is the only way left
    // to move a row: `orgId` on a model with its own org_id, and the first-hop scope key of a path
    // model (`testId` of TestSection, `sessionId` of ProctorEvent), which re-parents the row and so
    // moves it to the org of the new parent. Postgres catches `orgId` only on the composite-key
    // tables and the first-hop key never, so the extension refuses both in system scope. Org scope
    // refuses `orgId` (another org's) but leaves the first-hop key to rule (i), README "Limits" (b).
    let M: TenantFixture;
    let N: TenantFixture;
    const system = <T>(fn: () => Promise<T>): Promise<T> =>
      orgContext.runSystem('AUTH_BOOTSTRAP', fn);
    /** One operation of one model's delegate, run in system scope. */
    const call = (model: ModelName, operation: string, args: unknown): Promise<unknown> =>
      system(
        () => scoped(model)[operation]?.(args) ?? Promise.reject(new Error(`no ${operation}`)),
      );

    beforeAll(async () => {
      M = await createTenant(owner, 'm');
      N = await createTenant(owner, 'n');
    });

    it('TC-008 system-scope user.update({ data: { orgId: <other org> } }) is refused, and the user stays in its org', async () => {
      const before = await snapshot();
      await expect(
        system(() =>
          prisma.client.user.update({ where: { id: M.userId }, data: { orgId: N.orgId } }),
        ),
      ).rejects.toThrow(/orgId cannot be written by an update in system scope/);
      // The { set } form, and naming the row's own org: the key itself is refused, whatever the value.
      await expect(
        system(() =>
          prisma.client.user.update({ where: { id: M.userId }, data: { orgId: { set: N.orgId } } }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      await expect(
        system(() =>
          prisma.client.user.update({ where: { id: M.userId }, data: { orgId: M.orgId } }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect((await owner.user.findUniqueOrThrow({ where: { id: M.userId } })).orgId).toBe(M.orgId);
      expect(await snapshot()).toEqual(before);
    });

    it('TC-008 updateMany, updateManyAndReturn and the update branch of upsert are refused on other direct models (Question, Test, Candidate)', async () => {
      const before = await snapshot();
      const question = M.rows.Question.filter.id as string;
      const attempts: Array<() => Promise<unknown>> = [
        () =>
          prisma.client.question.updateMany({
            where: { id: question },
            data: { orgId: N.orgId },
          }),
        () =>
          prisma.client.question.updateManyAndReturn({
            where: { id: question },
            data: { orgId: N.orgId },
          }),
        () =>
          prisma.client.question.upsert({
            where: { id: question },
            create: { orgId: M.orgId, slug: 'never-created' },
            update: { orgId: N.orgId },
          }),
        () =>
          prisma.client.test.update({
            where: { id: M.rows.Test.filter.id as string },
            data: { orgId: N.orgId },
          }),
        () =>
          prisma.client.candidate.updateMany({
            where: { id: M.rows.Candidate.filter.id as string },
            data: { orgId: { set: N.orgId } },
          }),
      ];
      for (const attempt of attempts) {
        await expect(system(attempt)).rejects.toBeInstanceOf(OrgScopeViolationError);
      }
      expect((await owner.question.findUniqueOrThrow({ where: { id: question } })).orgId).toBe(
        M.orgId,
      );
      expect(await snapshot()).toEqual(before);
    });

    it('TC-008 an org scope cannot delete its own organization or another one, and system scope can (FU-DB-68)', async () => {
      const D1 = await createTenant(owner, 'od');
      const D2 = await createTenant(owner, 'oe');
      const before = await snapshot();
      const attempts: Array<() => Promise<unknown>> = [
        () => prisma.client.organization.delete({ where: { id: D1.orgId } }),
        () => prisma.client.organization.deleteMany({ where: { id: D1.orgId } }),
        () => prisma.client.organization.deleteMany(),
        () => prisma.client.organization.delete({ where: { id: D2.orgId } }),
      ];
      for (const attempt of attempts) {
        await expect(orgContext.runInOrg(D1.orgId, attempt)).rejects.toThrow(
          /organizations are deleted only in system scope/,
        );
      }
      expect(await snapshot()).toEqual(before);
      // System scope can: with the org's own rows out of the way (the foreign keys are NO ACTION),
      // so what this shows is that the extension does not refuse it there.
      await expect(
        orgContext.runSystem('BACKGROUND_JOB', () =>
          prisma.client.organization.delete({ where: { id: D2.orgId } }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' }); // the database, not the extension, objects
      const empty = await owner.organization.create({ data: { name: 'Empty org' } });
      await orgContext.runSystem('BACKGROUND_JOB', () =>
        prisma.client.organization.delete({ where: { id: empty.id } }),
      );
      expect(await owner.organization.count({ where: { id: empty.id } })).toBe(0);
    });

    it('TC-008 an Organization keeps its id in system scope too', async () => {
      await expect(
        system(() =>
          prisma.client.organization.update({ where: { id: M.orgId }, data: { id: N.orgId } }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
      expect(await owner.organization.count({ where: { id: M.orgId } })).toBe(1);
    });

    it('TC-008 system scope cannot re-parent a row: the first-hop scope key of every path model is refused on all four update operations, and nothing changes (FU-DB-107)', async () => {
      const before = await snapshot();
      const hops = FK_CLASSES.filter((key) => key.fkClass === 'SCOPE_HOP');
      expect(hops).toHaveLength(21);
      for (const key of hops) {
        const column = scopeHopColumn(key.model) as string;
        const row = M.rows[key.model];
        // The parent in the other org: the id the key would be re-pointed to.
        const otherParent = N.rows[key.target].filter.id;
        const refused = new RegExp(`${key.model}\\.\\w+: ${column} cannot be written`);
        for (const value of [otherParent, { set: otherParent }]) {
          const data = { [column]: value };
          await expect(call(key.model, 'update', { where: row.unique, data })).rejects.toThrow(
            refused,
          );
          await expect(call(key.model, 'updateMany', { where: row.filter, data })).rejects.toThrow(
            refused,
          );
          await expect(
            call(key.model, 'updateManyAndReturn', { where: row.filter, data }),
          ).rejects.toThrow(refused);
          await expect(
            call(key.model, 'upsert', { where: row.unique, create: {}, update: data }),
          ).rejects.toThrow(refused);
        }
        // Naming the row's own parent is refused too: the key itself is what is refused.
        await expect(
          call(key.model, 'updateMany', {
            where: row.filter,
            data: { [column]: M.rows[key.target].filter.id },
          }),
        ).rejects.toBeInstanceOf(OrgScopeViolationError);
      }
      expect(await snapshot()).toEqual(before);
      // Spot check against the owner: the section is still under M's test.
      expect(
        (
          await owner.testSection.findUniqueOrThrow({
            where: { id: M.rows.TestSection.filter.id as string },
          })
        ).testId,
      ).toBe(M.rows.Test.filter.id);
    });

    it('TC-008 the first-hop refusal is only for updates: system scope updates other columns and other foreign keys of a path model, and creates under any parent', async () => {
      // Every path model: a harmless change still works (the first-hop key is not touched).
      for (const model of MODELS) {
        if (ORG_SCOPE[model].kind !== 'path') continue;
        const row = M.rows[model];
        expect(await call(model, 'updateMany', { where: row.filter, data: TOUCH[model] })).toEqual({
          count: 1,
        });
      }
      // A rule (i) key of a path model (SessionQuestion.scoredById, a staff reference) is not a
      // first-hop key, so the extension leaves it to the service.
      const sessionQuestion = M.rows.SessionQuestion.unique;
      const scored = await system(() =>
        prisma.client.sessionQuestion.update({
          where: sessionQuestion as { id: string },
          data: { scoredById: M.userId },
        }),
      );
      expect(scored.scoredById).toBe(M.userId);
      // A create may name any parent in system scope (creates there are review-only).
      const created = await system(() =>
        prisma.client.testSection.create({
          data: { testId: M.rows.Test.filter.id as string, title: 'Added by system', position: 9 },
        }),
      );
      expect(created.testId).toBe(M.rows.Test.filter.id);
    });

    it('TC-008 an org scope does not refuse a first-hop key: re-parenting there is rule (i), the limit README (b) documents (FU-DB-107)', async () => {
      // This pins current behaviour; it is not a fix. A section of org P is pointed at org Q's test
      // by org P's own scope, because the scope filters the row it updates, not the new parent.
      const P = await createTenant(owner, 'rp');
      const Q = await createTenant(owner, 'rq');
      const section = P.rows.TestSection.filter.id as string;
      const qTest = Q.rows.Test.filter.id as string;
      const moved = await orgContext.runInOrg(P.orgId, () =>
        prisma.client.testSection.update({ where: { id: section }, data: { testId: qTest } }),
      );
      expect(moved.testId).toBe(qTest);
      // Restore through the owner, so the row is back under P's own test.
      await owner.testSection.update({
        where: { id: section },
        data: { testId: P.rows.Test.filter.id as string },
      });
    });

    it('TC-008 positive controls: a system-scope update without orgId works, and a system-scope create may set orgId', async () => {
      const renamed = await system(() =>
        prisma.client.user.update({
          where: { id: M.userId },
          data: { fullName: 'Renamed by system' },
        }),
      );
      expect(renamed).toMatchObject({ fullName: 'Renamed by system', orgId: M.orgId });
      const updated = await system(() =>
        prisma.client.question.updateMany({
          where: { id: M.rows.Question.filter.id as string },
          data: { isArchived: true },
        }),
      );
      expect(updated.count).toBe(1);
      // Creates in system scope are review-only: the orgId is whatever the caller wrote.
      const created = await system(() =>
        prisma.client.question.create({ data: { orgId: N.orgId, slug: 'created-by-system' } }),
      );
      expect(created.orgId).toBe(N.orgId);
      const many = await system(() =>
        prisma.client.question.createManyAndReturn({
          data: [{ orgId: M.orgId, slug: 'many-by-system' }],
        }),
      );
      expect(many.map((row) => row.orgId)).toEqual([M.orgId]);
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
    // A real access token with the claims BE-02's AuthService signs (sub, org, role, kind, pwv). The
    // guard re-reads the user, so the fixture user's role, org and password hash back the token.
    const asUser = (tenant: TenantFixture): string => staffBearer(app.get(TokenService), tenant);

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

    // ---- the same response for another org's id and for an id that exists nowhere -------------

    /** The response headers without the named ones. */
    const headersWithout = (res: request.Response, names: string[]): Record<string, unknown> =>
      Object.fromEntries(Object.entries(res.headers).filter(([name]) => !names.includes(name)));

    /** The response as an observer sees it, with what legitimately differs per request set aside. */
    const observed = (res: request.Response, requestedId: string, trace: string) => {
      const all = res.headers as Record<string, string | undefined>;
      const headers = headersWithout(res, ['date', 'etag', 'content-length']);
      const body = res.body as Record<string, unknown>;
      return {
        status: res.status,
        headers,
        hasEtag: all.etag !== undefined,
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

    it("TC-008 same response: another org's session id and an id that exists nowhere get the same 404, field by field", async () => {
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

    it('TC-008 same response: the same holds for a model scoped through its parent chain (a proctor event)', async () => {
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

    it("TC-008 same response: a filtered list for another org's id and for an id that exists nowhere have the same shape", async () => {
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
        expect(headersWithout(denied, ['date'])).toEqual(headersWithout(missing, ['date']));
        // The same filter for an id that does exist in org A returns A's row: the filter works.
        // Both filters take org A's own session id (events are filtered by their session).
        const own = await get(A.rows.Session.filter.id as string);
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

    it('TC-008 a public route that reads org data fails closed: exactly the defined 403 problem, nothing leaked, no query sent', async () => {
      await db.statements.reset();
      const res = await request(app.getHttpServer())
        .get('/probe/public-sessions')
        .set('x-request-id', 'trace-public-1');

      // Exactly the defined status and shape (ProblemFilter, an unhandled error), field by field.
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
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
      expect(body.title).toBe('Forbidden');
      expect(body.detail).toBe('Access denied.');
      expect(body.status).toBe(403);
      expect(body.instance).toBe('/probe/public-sessions');
      expect(body.traceId).toBe('trace-public-1');
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
