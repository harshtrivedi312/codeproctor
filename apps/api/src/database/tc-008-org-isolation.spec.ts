// TC-008 (NFR-04): a user from org A cannot read or change org B's data. These tests run against a
// real Postgres 16 started by Testcontainers (Docker is required), with the real migrations applied
// by `prisma migrate deploy`. The code under test connects as app_user through the real client
// factory, so the real grants are in force. Fixtures and checks use the owner role.
//
// Two tenants (A and B) hold one row in each of the 31 models. Every operation is tried as A against
// B's rows, for every model, including the models that have no org_id and are scoped only through a
// parent chain (for example proctor_events through its session, test_cases through their question
// version and question). A positive control proves A still sees and changes its own rows, so a
// filter that simply returns nothing cannot pass.
import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { DatabaseModule } from './database.module';
import { OrgContextMissingError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import { OrgContextService } from './org-context';
import type { AuthenticatedUser } from './org-context';
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

// Stand-in for the BE-02 auth guard: sets request.user from a header.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') req.user = JSON.parse(header) as unknown;
    return true;
  }
}

// What a staff route does: look a row up by the id in the URL, answer 404 on a miss.
@Controller('probe')
class ProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('sessions/:id')
  async session(@Param('id') id: string): Promise<{ id: string; orgId: string }> {
    const row = await this.prisma.client.session.findUnique({ where: { id } });
    if (row === null) throw new NotFoundException();
    return { id: row.id, orgId: row.orgId };
  }

  @Get('sessions')
  async sessions(): Promise<string[]> {
    return (await this.prisma.client.session.findMany()).map((s) => s.id);
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
          load: [() => ({ DATABASE_URL: url })],
        }),
        DatabaseModule,
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: FakeAuthGuard }],
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
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    A = await createTenant(owner, 'a');
    B = await createTenant(owner, 'b');
    moduleRef = await compileApp(db.appUserUrl);
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
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

    it("TC-008 select and include return only org A's rows, through every relation", async () => {
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

    it("TC-008 upsert that creates fills in org A's id, and refuses another org's", async () => {
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
    const userA: AuthenticatedUser = { orgId: '', userId: '', role: 'RECRUITER' };
    const asUser = (tenant: TenantFixture): string =>
      JSON.stringify({ ...userA, orgId: tenant.orgId, userId: tenant.userId });

    it("TC-008 GET another org's session is 404 and leaks nothing; own session is 200", async () => {
      const server = app.getHttpServer();
      const bSession = B.rows.Session.filter.id as string;
      const denied = await request(server)
        .get(`/probe/sessions/${bSession}`)
        .set('x-test-user', asUser(A))
        .expect(404);
      expect(JSON.stringify(denied.body)).not.toContain(B.orgId);
      const own = await request(server)
        .get(`/probe/sessions/${A.rows.Session.filter.id as string}`)
        .set('x-test-user', asUser(A))
        .expect(200);
      expect(own.body).toEqual({ id: A.rows.Session.filter.id, orgId: A.orgId });
      await request(server)
        .get(`/probe/sessions/${bSession}`)
        .set('x-test-user', asUser(B))
        .expect(200);
    });

    it("TC-008 GET a proctor event of another org's session is 404", async () => {
      const server = app.getHttpServer();
      const bEvent = String(B.rows.ProctorEvent.filter.id);
      await request(server)
        .get(`/probe/events/${bEvent}`)
        .set('x-test-user', asUser(A))
        .expect(404);
      await request(server)
        .get(`/probe/events/${bEvent}`)
        .set('x-test-user', asUser(B))
        .expect(200);
    });

    it("TC-008 listings contain only the caller's org", async () => {
      const server = app.getHttpServer();
      const listA = await request(server)
        .get('/probe/sessions')
        .set('x-test-user', asUser(A))
        .expect(200);
      const listB = await request(server)
        .get('/probe/sessions')
        .set('x-test-user', asUser(B))
        .expect(200);
      expect(listA.body).toEqual([A.rows.Session.filter.id]);
      expect(listB.body).toEqual([B.rows.Session.filter.id]);
      const casesA = await request(server)
        .get('/probe/test-cases')
        .set('x-test-user', asUser(A))
        .expect(200);
      expect(casesA.body).toEqual([A.rows.TestCase.filter.id]);
    });

    it('TC-008 a route reached with no authenticated user cannot read org data (500, nothing leaked)', async () => {
      const res = await request(app.getHttpServer()).get('/probe/sessions').expect(500);
      expect(JSON.stringify(res.body)).not.toContain('Session');
      expect(JSON.stringify(res.body)).not.toContain(A.orgId);
    });

    it("TC-008 concurrent requests from both orgs never see each other's rows", async () => {
      const server = app.getHttpServer();
      const calls = Array.from({ length: 30 }, (_, i) => {
        const tenant = i % 2 === 0 ? A : B;
        return request(server)
          .get('/probe/sessions')
          .set('x-test-user', asUser(tenant))
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
