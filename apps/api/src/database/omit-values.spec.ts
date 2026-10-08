// `omit` takes only `true`, in every scope (omit-args.ts; ADR 0013 CS-4.4 relation vectors; CLAUDE.md rule 3).
// Real Postgres 16 (Testcontainers) with the real migrations, through the org-scoped client as app_user. Each case
// is a shape that, before the check, Prisma 7 turned into a selection: the related QuestionVersion row (its
// referenceSolution included) through `omit: { questionVersion: false }`, and every relation count through
// `omit: { _count: false }`. Each is refused before any statement.
import type { PrismaClient } from '../generated/prisma/client.js';
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import { OrgScopeViolationError } from './errors';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { SessionChain, TenantFixture } from './testing/tenant-fixtures';

describe('omit takes only true, against Postgres, in every scope (ADR 0013 CS-4.4; NFR-04, TC-008)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let appUser: PrismaClient;
  let client: ReturnType<typeof createOrgScopedClient>;
  const orgContext = new OrgContextService();
  let T: TenantFixture;

  const statementCount = async (): Promise<number> =>
    (await db.statements.read()).reduce((sum, s) => sum + s.calls, 0);
  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  const asCandidate = <R>(chain: SessionChain, fn: () => Promise<R>): Promise<R> =>
    orgContext.runAsCandidate(chain.orgId, chain.sessionId, async () => {
      setCandidateFacts(orgContext, {
        candidateId: chain.candidateId,
        invitationId: chain.invitationId,
        testId: chain.testId,
      });
      return fn();
    });
  const asStaff = <R>(fn: () => Promise<R>): Promise<R> =>
    orgContext.runAsUser({ orgId: T.orgId, userId: T.userId, role: T.userRole }, fn);
  /** Refused with OrgScopeViolationError, and no statement reached the database. */
  async function expectRefusedBeforeAnyStatement(run: () => Promise<unknown>): Promise<void> {
    const before = await statementCount();
    const error = await failure(run());
    expect(error).toBeInstanceOf(OrgScopeViolationError);
    expect((error as Error).message).toMatch(/omit/);
    expect(await statementCount()).toBe(before);
  }

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    appUser = createPrismaClient(db.appUserUrl);
    client = createOrgScopedClient(appUser, orgContext);
    T = await createTenant(owner, 'omit');
  });

  afterAll(async () => {
    await appUser?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  it('TC-008 CANDIDATE: omit questionVersion false (the related QuestionVersion, referenceSolution included) is refused', async () => {
    await expectRefusedBeforeAnyStatement(() =>
      asCandidate(T.chain, () =>
        client.sessionQuestion.findFirst({ omit: { questionVersion: false } } as never),
      ),
    );
  });

  it('TC-008 CANDIDATE: omit _count false and null (every relation count of the session) are refused', async () => {
    for (const value of [false, null]) {
      await expectRefusedBeforeAnyStatement(() =>
        asCandidate(T.chain, () =>
          client.session.findFirst({
            where: { id: T.chain.sessionId },
            omit: { _count: value },
          } as never),
        ),
      );
    }
  });

  it('TC-008 STAFF: a nested omit that is not true is refused (include of a relation)', async () => {
    await expectRefusedBeforeAnyStatement(() =>
      asStaff(() =>
        client.sessionQuestion.findFirst({
          include: { session: { omit: { _count: false } } },
        } as never),
      ),
    );
  });

  it('TC-008 STAFF: a create with an omit that is not true is refused, and no row is written', async () => {
    await expectRefusedBeforeAnyStatement(() =>
      asStaff(() =>
        client.candidate.create({
          data: { orgId: T.orgId, email: 'omit-probe@example.test', fullName: 'Omit Probe' },
          omit: { invitations: false },
        } as never),
      ),
    );
    expect(await owner.candidate.count({ where: { email: 'omit-probe@example.test' } })).toBe(0);
  });

  it('TC-008 SERVICE (session job): omit _count false is refused', async () => {
    await expectRefusedBeforeAnyStatement(() =>
      orgContext.runAsSessionJob(T.chain.orgId, T.chain.sessionId, () =>
        client.session.findFirst({ omit: { _count: false } } as never),
      ),
    );
  });

  it('TC-008 system scope: omit _count false is refused', async () => {
    await expectRefusedBeforeAnyStatement(() =>
      orgContext.runSystem('BACKGROUND_JOB', () =>
        client.organization.findMany({ omit: { _count: false } } as never),
      ),
    );
  });

  it('TC-008 an omit of exactly true still works: the column is left out', async () => {
    const row = await asStaff(() =>
      client.session.findFirst({ where: { id: T.chain.sessionId }, omit: { hmacKeyEnc: true } }),
    );
    expect(row).not.toBeNull();
    expect(row as object).not.toHaveProperty('hmacKeyEnc');
  });
});
