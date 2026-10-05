// The extension's behaviour that is decided before any SQL is sent: no org context, raw SQL, and
// payloads for another org. The client points at a closed port and never connects, so this runs
// without Docker. The queries that do reach Postgres are in tc-008-org-isolation.spec.ts.
import { Prisma } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { OrgContextMissingError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import { SCOPED_OPERATIONS } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;

describe('org scope extension without a database (NFR-04, FR-103)', () => {
  const orgContext = new OrgContextService();
  const base = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
  const client = createOrgScopedClient(base, orgContext);

  afterAll(async () => {
    await base.$disconnect();
  });

  /** client.session, client.proctorEvent, ... by model name. */
  function delegate(model: ModelName): Delegate {
    const key = model.charAt(0).toLowerCase() + model.slice(1);
    return (client as unknown as Record<string, Delegate>)[key] as Delegate;
  }

  describe('no org context', () => {
    it.each(Object.keys(ORG_SCOPE) as ModelName[])(
      'TC-008 %s: every operation throws OrgContextMissingError',
      async (model) => {
        for (const operation of SCOPED_OPERATIONS) {
          await expect(delegate(model)[operation]?.({})).rejects.toBeInstanceOf(
            OrgContextMissingError,
          );
        }
      },
    );

    it('TC-008 the message names the model and the operation', async () => {
      await expect(client.session.findMany()).rejects.toThrow(
        /Session\.findMany needs an org context/,
      );
    });

    it('TC-008 the context does not leak out of a finished run', async () => {
      await orgContext.runInOrg(ORG_A, () => Promise.resolve());
      expect(orgContext.current()).toBeUndefined();
      await expect(client.session.findMany()).rejects.toBeInstanceOf(OrgContextMissingError);
    });
  });

  describe('a relation key inside a createMany row (FU-DB-106)', () => {
    // The nested-write guard does not walk createMany rows (they are flat, and ingest paths pay
    // nothing). It relies on Prisma itself refusing a relation in a row, and this pins that: if a
    // Prisma release accepted one, `connect` through createMany would bypass deny-by-default.
    const rows = [
      [
        'a relation connect',
        { testId: ORG_A, title: 't', position: 1, test: { connect: { id: ORG_B } } },
      ],
      [
        'a relation create',
        { testId: ORG_A, title: 't', position: 1, test: { create: { name: 'n' } } },
      ],
      [
        'a back relation',
        { testId: ORG_A, title: 't', position: 1, questions: { create: [{ position: 0 }] } },
      ],
    ] as const;

    it.each(rows)(
      'TC-008 createMany with %s in a row is rejected by Prisma validation',
      async (_name, row) => {
        for (const operation of ['createMany', 'createManyAndReturn'] as const) {
          const run = (): Promise<unknown> =>
            (client.testSection[operation] as (args: unknown) => Promise<unknown>)({ data: [row] });
          await expect(orgContext.runInOrg(ORG_A, run)).rejects.toBeInstanceOf(
            Prisma.PrismaClientValidationError,
          );
          await expect(orgContext.runSystem('BACKGROUND_JOB', run)).rejects.toBeInstanceOf(
            Prisma.PrismaClientValidationError,
          );
        }
      },
    );

    it('TC-008 the same holds on a model with its own org_id, for the single-object form too', async () => {
      const row = { name: 't', durationMinutes: 30, org: { connect: { id: ORG_B } } };
      for (const data of [[row], row]) {
        const run = (): Promise<unknown> =>
          (client.test.createMany as (args: unknown) => Promise<unknown>)({ data });
        // The extension refuses the org relation itself before Prisma sees it (deny by default).
        await expect(orgContext.runInOrg(ORG_A, run)).rejects.toThrow(
          /the org relation cannot be written; set the scalar orgId/,
        );
      }
    });
  });

  describe('orgId on a create (FU-DB-100)', () => {
    it('TC-008 the unchecked create types require orgId, so typed code passes it (a type-level pin)', () => {
      // Never called: this only has to compile. If Prisma made orgId optional, the directive below
      // would fail the type check, and the README's "pass orgId explicitly" would need a new look.
      const typeOnly = (): void => {
        void client.invitation.create({
          // @ts-expect-error orgId is a required scalar of the unchecked create input
          data: {
            testId: ORG_A,
            candidateId: ORG_B,
            tokenHash: 'h',
            windowStart: new Date(),
            windowEnd: new Date(),
          },
        });
        void client.invitation.create({
          data: {
            orgId: ORG_A,
            testId: ORG_A,
            candidateId: ORG_B,
            tokenHash: 'h',
            windowStart: new Date(),
            windowEnd: new Date(),
          },
        });
      };
      expect(typeof typeOnly).toBe('function');
    });
  });

  describe('lazy queries (a Prisma query sends nothing until it is awaited)', () => {
    it('TC-008 a query returned straight from the callback is started inside the scope', async () => {
      // It reaches the payload check, which only runs in a scope: the scope was active.
      await expect(
        orgContext.runInOrg(ORG_A, () =>
          client.test.create({ data: { orgId: ORG_B, name: 'x', durationMinutes: 60 } }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 a query wrapped in an object or an array is not started in the scope, and finds no context (fails closed)', async () => {
      const inObject = orgContext.runInOrg(ORG_A, () => ({ rows: client.session.findMany() }));
      await expect(inObject.rows).rejects.toBeInstanceOf(OrgContextMissingError);
      const inArray = orgContext.runInOrg(ORG_A, () => [client.session.findMany()]);
      await expect(Promise.all(inArray)).rejects.toBeInstanceOf(OrgContextMissingError);
    });
  });

  describe('nested relation writes (ADR 0006 section 8): refused in system scope too', () => {
    // The extension refuses before any SQL, so this needs no database.
    const attempts: Array<[string, () => Promise<unknown>]> = [
      [
        'organization.update users.connect',
        () =>
          client.organization.update({
            where: { id: ORG_A },
            data: { users: { connect: { id: ORG_B } } },
          }),
      ],
      [
        'session.update invitation.connect (COMPOSITE)',
        () =>
          client.session.update({
            where: { id: ORG_A },
            data: { invitation: { connect: { id: ORG_B } } },
          }),
      ],
      [
        'refreshToken.update user connect + update',
        () =>
          client.refreshToken.update({
            where: { id: ORG_A },
            data: { user: { connect: { id: ORG_B }, update: { passwordHash: 'p' } } },
          }),
      ],
      [
        'sessionReview.update reviewer.update (RULE_I)',
        () =>
          client.sessionReview.update({
            where: { id: ORG_A },
            data: { reviewer: { update: { passwordHash: 'p' } } },
          }),
      ],
      [
        'test.create sections.create (SCOPE_HOP)',
        () =>
          client.test.create({
            data: {
              orgId: ORG_A,
              name: 't',
              durationMinutes: 30,
              sections: { create: { title: 's', position: 0 } },
            },
          }),
      ],
      [
        'test.upsert update branch',
        () =>
          client.test.upsert({
            where: { id: ORG_A },
            create: { orgId: ORG_A, name: 't', durationMinutes: 30 },
            update: { sections: { deleteMany: {} } },
          }),
      ],
    ];

    it.each(attempts)('TC-008 %s is refused in system scope', async (_name, run) => {
      await expect(orgContext.runSystem('BACKGROUND_JOB', run)).rejects.toThrow(
        /nested relation write refused/,
      );
      await expect(orgContext.runSystem('BACKGROUND_JOB', run)).rejects.toBeInstanceOf(
        OrgScopeViolationError,
      );
    });

    it.each(attempts)('TC-008 %s is refused in an org scope too', async (_name, run) => {
      await expect(orgContext.runInOrg(ORG_A, run)).rejects.toThrow(
        /nested relation write refused/,
      );
    });

    it('TC-008 with no scope at all everything still throws OrgContextMissingError (nothing changes)', async () => {
      for (const [, run] of attempts) {
        await expect(run()).rejects.toBeInstanceOf(OrgContextMissingError);
      }
    });
  });

  describe('system scope: a scalar orgId in an update is refused (before any SQL)', () => {
    const ORG_X = '44444444-4444-4444-8444-444444444444';
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['user.update', () => client.user.update({ where: { id: ORG_A }, data: { orgId: ORG_X } })],
      [
        'user.update (set form)',
        () => client.user.update({ where: { id: ORG_A }, data: { orgId: { set: ORG_X } } }),
      ],
      ['question.updateMany', () => client.question.updateMany({ data: { orgId: ORG_X } })],
      [
        'question.updateManyAndReturn',
        () => client.question.updateManyAndReturn({ data: { orgId: ORG_X } }),
      ],
      [
        'test.upsert (update branch)',
        () =>
          client.test.upsert({
            where: { id: ORG_A },
            create: { orgId: ORG_A, name: 't', durationMinutes: 30 },
            update: { orgId: ORG_X },
          }),
      ],
      [
        'organization.update (id)',
        () => client.organization.update({ where: { id: ORG_A }, data: { id: ORG_X } }),
      ],
    ];

    it.each(attempts)('TC-008 %s is refused in system scope', async (_name, run) => {
      await expect(orgContext.runSystem('BACKGROUND_JOB', run)).rejects.toBeInstanceOf(
        OrgScopeViolationError,
      );
    });

    it('TC-008 and still refused in an org scope, and with no scope nothing changes', async () => {
      for (const [, run] of attempts) {
        await expect(orgContext.runInOrg(ORG_A, run)).rejects.toBeInstanceOf(
          OrgScopeViolationError,
        );
        await expect(run()).rejects.toBeInstanceOf(OrgContextMissingError);
      }
    });
  });

  describe('raw SQL', () => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['$queryRaw', () => client.$queryRaw`SELECT 1`],
      ['$queryRawUnsafe', () => client.$queryRawUnsafe('SELECT 1')],
      ['$executeRaw', () => client.$executeRaw`SELECT 1`],
      ['$executeRawUnsafe', () => client.$executeRawUnsafe('SELECT 1')],
    ];

    it.each(attempts)('TC-008 %s is refused with no context', async (_name, run) => {
      await expect(run()).rejects.toBeInstanceOf(RawQueryNotAllowedError);
    });

    it.each(attempts)('TC-008 %s is refused inside an org scope', async (_name, run) => {
      await expect(orgContext.runInOrg(ORG_A, run)).rejects.toBeInstanceOf(RawQueryNotAllowedError);
    });

    it.each(attempts)('TC-008 %s is refused inside system scope', async (_name, run) => {
      await expect(orgContext.runSystem('BACKGROUND_JOB', run)).rejects.toBeInstanceOf(
        RawQueryNotAllowedError,
      );
    });
  });

  describe('payloads for another org, inside an org scope', () => {
    const inOrgA = <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(ORG_A, fn);

    it("TC-008 create with another org's id is refused", async () => {
      await expect(
        inOrgA(() =>
          client.test.create({ data: { orgId: ORG_B, name: 'x', durationMinutes: 60 } }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 createMany with one row for another org is refused', async () => {
      await expect(
        inOrgA(() =>
          client.candidate.createMany({
            data: [
              { orgId: ORG_A, email: 'a@x.test', fullName: 'A' },
              { orgId: ORG_B, email: 'b@x.test', fullName: 'B' },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 update cannot move a row to another org', async () => {
      await expect(
        inOrgA(() => client.test.update({ where: { id: ORG_A }, data: { orgId: ORG_B } })),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 an organization cannot be created inside an org scope', async () => {
      await expect(
        inOrgA(() => client.organization.create({ data: { name: 'Rogue' } })),
      ).rejects.toBeInstanceOf(OrgScopeViolationError);
    });
  });
});
