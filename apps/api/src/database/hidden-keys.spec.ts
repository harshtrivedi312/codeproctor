// Hidden keys are refused in every scope (plain-args.ts, "Hidden keys"; FU-DB-281, the #261 delta review S1;
// CLAUDE.md rule 3). Real Postgres 16 (Testcontainers) with the real migrations, through the org-scoped client as
// app_user.
//
// Prisma 7.10 clones the arguments before the hook runs (a for-in copy), which drops a non-enumerable or symbol key
// and snapshots a getter or a Proxy. But it passes an object BY REFERENCE when
// `value[Symbol.for('prisma.objectEnumValue')] === true` (the brand of its null sentinels, a registered symbol), and
// reads a relation's args with `Wt({ select, include, ...rest })`, a [[Get]]. So a branded object kept its hidden
// keys: before this check, in system scope a branded `_count` with a non-enumerable `select` counted the relation,
// and in STAFF scope a branded relation args object with a getter `include` gave the omit check `{}` and Prisma
// `{ invitation: { omit: { _count: false } } }` (every relation count). Each shape is refused here before any
// statement, and the pins at the top show what the hook receives from Prisma's clone.
import { Prisma } from '../generated/prisma/client.js';
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

/** Prisma's brand of its null sentinels: its argument clone passes an object that carries it by reference. */
const BRAND = Symbol.for('prisma.objectEnumValue');
const HIDDEN_KEY =
  /a non-enumerable key|an accessor|a symbol key|a Proxy|where a query object is expected/;

/** A branded object with `key` held as a non-enumerable own value. */
const branded = (key: string, value: unknown): object =>
  Object.defineProperty({ [BRAND]: true }, key, { value, enumerable: false });

/** A branded object whose `key` is a getter: `first` on the first read, `later` on every read after it. */
function brandedGetter(
  key: string,
  first: unknown,
  later: unknown,
): { carrier: object; reads: () => number } {
  let reads = 0;
  const carrier = Object.defineProperty({ [BRAND]: true }, key, {
    get: () => (reads++ === 0 ? first : later),
    enumerable: false,
  });
  return { carrier, reads: () => reads };
}

describe('hidden keys are refused, against Postgres, in every scope (FU-DB-281; ADR 0013 CS-4.4, CS-4.5; NFR-04, TC-008)', () => {
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
  /** Refused with OrgScopeViolationError for `reason` (one of the hidden-key faults), and no statement ran. */
  async function expectRefusedBeforeAnyStatement(
    reason: RegExp,
    run: () => Promise<unknown>,
  ): Promise<void> {
    const before = await statementCount();
    const error = await failure(run());
    expect(error).toBeInstanceOf(OrgScopeViolationError);
    expect((error as Error).message).toMatch(HIDDEN_KEY);
    expect((error as Error).message).toMatch(reason);
    expect(await statementCount()).toBe(before);
  }

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    appUser = createPrismaClient(db.appUserUrl);
    client = createOrgScopedClient(appUser, orgContext);
    T = await createTenant(owner, 'hidk');
  });

  afterAll(async () => {
    await appUser?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  describe('what the hook receives from Prisma 7.10 (pins: a release that changes the clone fails here)', () => {
    /** The args a query extension receives for `run`, which is stopped before any statement. */
    async function received(
      run: (spy: PrismaClient) => Promise<unknown>,
    ): Promise<Record<string, unknown>> {
      let seen: unknown;
      const spy = appUser.$extends({
        query: {
          $allModels: {
            $allOperations: ({ args }) => {
              seen = args;
              throw new Error('stopped by the spy');
            },
          },
        },
      }) as unknown as PrismaClient;
      await failure(run(spy));
      return seen as Record<string, unknown>;
    }

    it('TC-008 without the brand, the clone drops a non-enumerable select (so neither the hook nor Prisma sees it)', async () => {
      const hidden = Object.defineProperty({}, 'select', { value: { sessions: true } });
      const args = await received((spy) =>
        spy.invitation.findMany({ select: { id: true, _count: hidden } }),
      );
      const count = (args.select as Record<string, unknown>)._count as object;
      expect(count).not.toBe(hidden);
      expect(Object.getOwnPropertyNames(count)).toEqual([]);
    });

    it('TC-008 with the brand, the object reaches the hook by reference, its hidden select included', async () => {
      const carrier = branded('select', { sessions: true });
      const args = await received((spy) =>
        spy.invitation.findMany({ select: { id: true, _count: carrier } }),
      );
      expect((args.select as Record<string, unknown>)._count).toBe(carrier);
    });
  });

  it('TC-008 system scope: a branded _count with a non-enumerable select (the review scenario) is refused', async () => {
    await expectRefusedBeforeAnyStatement(/a non-enumerable key/, () =>
      orgContext.runSystem('BACKGROUND_JOB', () =>
        client.invitation.findMany({
          select: { id: true, _count: branded('select', { sessions: true }) },
        } as never),
      ),
    );
  });

  it('TC-008 system scope: a Proxy that answers the brand and a select is refused', async () => {
    const trap = new Proxy(
      {},
      {
        get: (_t, key) =>
          key === BRAND ? true : key === 'select' ? { sessions: true } : undefined,
      },
    );
    await expectRefusedBeforeAnyStatement(/a Proxy/, () =>
      orgContext.runSystem('BACKGROUND_JOB', () =>
        client.invitation.findMany({ select: { id: true, _count: trap } } as never),
      ),
    );
  });

  it('TC-008 STAFF: a branded relation args object with a getter include (the omit check bypass) is refused, and the getter never runs', async () => {
    const { carrier, reads } = brandedGetter(
      'include',
      {},
      { invitation: { omit: { _count: false } } },
    );
    await expectRefusedBeforeAnyStatement(/an accessor/, () =>
      asStaff(() =>
        client.sessionQuestion.findFirst({ select: { id: true, session: carrier } } as never),
      ),
    );
    expect(reads()).toBe(0);
  });

  it('TC-008 STAFF: a hidden include inside a relation args object is refused', async () => {
    await expectRefusedBeforeAnyStatement(/a non-enumerable key/, () =>
      asStaff(() =>
        client.sessionQuestion.findFirst({
          include: { session: branded('include', { invitation: true }) },
        } as never),
      ),
    );
  });

  it('TC-008 org job scope (runInOrg): a branded relation args object with a getter include is refused', async () => {
    const { carrier, reads } = brandedGetter(
      'include',
      {},
      { invitation: { omit: { _count: false } } },
    );
    await expectRefusedBeforeAnyStatement(/an accessor/, () =>
      orgContext.runInOrg(T.orgId, () =>
        client.sessionQuestion.findFirst({ select: { id: true, session: carrier } } as never),
      ),
    );
    expect(reads()).toBe(0);
  });

  it('TC-008 SERVICE (session job): a branded data row with a getter column is refused, and the row is unchanged', async () => {
    const before = await owner.session.findUniqueOrThrow({
      where: { id: T.chain.sessionId },
      select: { status: true },
    });
    const { carrier } = brandedGetter('status', before.status, 'ERASED');
    Object.defineProperty(carrier, 'lastHeartbeat', { value: new Date(), enumerable: true });
    await expectRefusedBeforeAnyStatement(/an accessor/, () =>
      orgContext.runAsSessionJob(T.chain.orgId, T.chain.sessionId, () =>
        client.session.update({
          where: { id: T.chain.sessionId },
          data: carrier,
          select: { id: true },
        } as never),
      ),
    );
    const after = await owner.session.findUniqueOrThrow({
      where: { id: T.chain.sessionId },
      select: { status: true },
    });
    expect(after.status).toBe(before.status);
  });

  it('TC-008 CANDIDATE: a branded where with a getter AND (a relation filter on the second read) is refused', async () => {
    const { carrier, reads } = brandedGetter(
      'AND',
      [],
      [{ invitation: { tokenHash: { startsWith: 'a' } } }],
    );
    Object.defineProperty(carrier, 'id', { value: T.chain.sessionId, enumerable: true });
    await expectRefusedBeforeAnyStatement(/an accessor/, () =>
      asCandidate(T.chain, () =>
        client.session.findFirst({ where: carrier, select: { id: true } } as never),
      ),
    );
    expect(reads()).toBe(0);
  });

  it('TC-008 CANDIDATE: a branded select with a non-enumerable sealed column is refused', async () => {
    const select = Object.defineProperty({ [BRAND]: true, id: true }, 'hmacKeyEnc', {
      value: true,
      enumerable: false,
    });
    await expectRefusedBeforeAnyStatement(/a non-enumerable key/, () =>
      asCandidate(T.chain, () =>
        client.session.findFirst({ where: { id: T.chain.sessionId }, select } as never),
      ),
    );
  });

  it("TC-008 CANDIDATE: Prisma's brand alone (the by-reference route) is refused as a symbol key", async () => {
    await expectRefusedBeforeAnyStatement(/a symbol key/, () =>
      asCandidate(T.chain, () =>
        client.session.findFirst({
          where: { id: T.chain.sessionId },
          select: { [BRAND]: true, id: true },
        } as never),
      ),
    );
  });

  it('TC-008 STAFF: a byte array whose own slice returns a byte array with keys, as the select, is refused (a value where a query object goes)', async () => {
    const select = Object.assign(new Uint8Array(0), {
      slice: () => Object.assign(new Uint8Array(0), { tokenHash: true }),
    });
    await expectRefusedBeforeAnyStatement(/where a query object is expected/, () =>
      asStaff(() => client.invitation.findFirst({ select } as never)),
    );
  });

  it('TC-008 what is not hidden still works: a relation _count and include (STAFF, system), a Decimal write, a DTO row', async () => {
    const counted = await orgContext.runSystem('BACKGROUND_JOB', () =>
      client.invitation.findFirst({
        where: { id: T.chain.invitationId },
        select: { id: true, _count: { select: { sessions: true } } },
      }),
    );
    expect(counted?._count.sessions).toBe(1);
    const included = await asStaff(() =>
      client.sessionQuestion.findFirst({
        where: { id: T.chain.sessionQuestionId },
        include: { session: { select: { id: true } } },
      }),
    );
    expect(included?.session.id).toBe(T.chain.sessionId);
    // A Decimal reaches the hook as the clone's `new Decimal(...)`, of the class the check expects.
    const points = await asStaff(() =>
      client.testQuestion.update({
        where: { id: T.chain.testQuestionId },
        data: { points: new Prisma.Decimal('7.25') },
        select: { points: true },
      }),
    );
    expect(points.points.toString()).toBe('7.25');
    // A class instance reaches the hook as the clone's plain object.
    class HeartbeatDto {
      lastHeartbeat = new Date('2026-10-07T00:00:00.000Z');
    }
    const beat = await asStaff(() =>
      client.session.update({
        where: { id: T.chain.sessionId },
        data: new HeartbeatDto(),
        select: { lastHeartbeat: true },
      }),
    );
    expect(beat.lastHeartbeat?.toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });
});
