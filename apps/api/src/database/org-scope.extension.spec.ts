// The extension's behaviour that is decided before any SQL is sent: no org context, raw SQL, and
// payloads for another org. The client points at a closed port and never connects, so this runs
// without Docker. The queries that do reach Postgres are in tc-008-org-isolation.spec.ts.
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
