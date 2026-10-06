// ADR 0013 CS-4.4 (PR 2: column allowlists, explicit-only columns and grants, the submissions RUN filter,
// the consents create) against a real Postgres 16 started by Testcontainers, with the real migrations
// applied by `prisma migrate deploy`. The code under test connects as app_user through the real client
// factory, so the real grants are in force. Fixtures and checks use the owner role.
//
// Candidates A and B sit in one org, O in another (synthetic). What is covered, as candidate A:
//   - reads under every grant site: A reads its own value, a grant of A's with B's id (or both ids) reaches
//     only A's row, a grant never opens another model or column, and a query that outlives the grant throws;
//   - writes under the SessionStateService and DeviceInfoService grants, on A's session only;
//   - the consents create: verified keys, the org's current text, write-once through UNIQUE(session_id)
//     (P2002), the row it returns, the statement count, and the transaction with the state transition;
//   - the RUN filter: `count({ where: { kind: 'SUBMIT', passed: N } })` is 0, SUBMIT results are never read;
//   - omit on writes, the default select, the facts that must be set first.
// The pure rules are in candidate-interim.spec.ts, candidate-grants.spec.ts and org-context-grant.spec.ts.
// NFR-04, TC-008.
import { randomUUID } from 'node:crypto';
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import { OrgScopeViolationError } from './errors';
import { OrgContextService } from './org-context';
import type { CandidateFacts, GrantRequest } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import type { PrismaClient } from '../generated/prisma/client.js';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createCandidateChain, createTenant } from './testing/tenant-fixtures';
import type { SessionChain, TenantFixture } from './testing/tenant-fixtures';

type Row = Record<string, unknown>;
const WHEN = new Date('2026-10-06T00:00:00.000Z');
const ENDED = /the grant of this unit of work has ended/;

describe('ADR 0013 CS-4.4: column allowlists and grants against Postgres (NFR-04, TC-008)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let base: PrismaClient;
  let client: ReturnType<typeof createOrgScopedClient>;
  const orgContext = new OrgContextService();
  let T: TenantFixture;
  let A: SessionChain;
  let B: SessionChain;
  let O: SessionChain;
  let OT: TenantFixture;

  const factsOf = (chain: SessionChain): CandidateFacts => ({
    candidateId: chain.candidateId,
    invitationId: chain.invitationId,
    testId: chain.testId,
  });
  /** A candidate scope as the guard builds it: facts first, then everything else. */
  const asCandidate = <R>(chain: SessionChain, fn: () => Promise<R>): Promise<R> =>
    orgContext.runAsCandidate(chain.orgId, chain.sessionId, async () => {
      setCandidateFacts(orgContext, factsOf(chain));
      return fn();
    });
  const asService = <R>(chain: SessionChain, fn: () => Promise<R>): Promise<R> =>
    orgContext.runAsSessionJob(chain.orgId, chain.sessionId, fn);
  const grant = <R>(request: GrantRequest, fn: () => R | Promise<R>): Promise<R> =>
    Promise.resolve(orgContext.withGrant(request, fn)) as Promise<R>;
  const statementCount = async (): Promise<number> =>
    (await db.statements.read()).reduce((sum, s) => sum + s.calls, 0);
  const statementTexts = async (): Promise<string[]> =>
    (await db.statements.read()).flatMap((s) => Array<string>(Number(s.calls)).fill(s.query));
  /** The error a promise rejects with, or undefined. */
  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  // The explicit-only columns carry a value per candidate, so a read can tell whose it is.
  const sealed = (chain: SessionChain): string => `sealed-key-${chain.label}`;
  const OBJECT_KEY = (chain: SessionChain): string =>
    `orgs/${chain.orgId}/sessions/${chain.sessionId}/media/SCREEN/000000/00000000.webm`;

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    T = await createTenant(owner, 'a');
    A = T.chain;
    B = await createCandidateChain(owner, T, 'b');
    OT = await createTenant(owner, 'o');
    O = OT.chain;
    for (const [tenant, chain] of [
      [T, A],
      [T, B],
      [OT, O],
    ] as const) {
      await owner.session.update({
        where: { id: chain.sessionId },
        data: {
          hmacKeyEnc: sealed(chain),
          deviceInfo: { who: chain.label, systemCheck: { ok: true } },
        },
      });
      await owner.test.update({
        where: { id: chain.testId },
        data: { settings: { t: chain.label } },
      });
      await owner.invitation.update({
        where: { id: chain.invitationId },
        data: { accommodations: { extraTimePct: chain.label === 'a' ? 25 : 10, who: chain.label } },
      });
      await owner.mediaChunk.updateMany({
        where: { sessionId: chain.sessionId },
        data: { objectKey: OBJECT_KEY(chain) },
      });
      await owner.organization.update({
        where: { id: tenant.orgId },
        data: { currentConsentTextId: tenant.consentTextId, settings: { org: tenant.label } },
      });
    }
    base = createPrismaClient(db.appUserUrl);
    client = createOrgScopedClient(base, orgContext);
  });

  afterAll(async () => {
    await base?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  const chunkId = async (chain: SessionChain): Promise<bigint> =>
    (await owner.mediaChunk.findFirstOrThrow({ where: { sessionId: chain.sessionId } })).id;
  const testQuestionIdOf = async (chain: SessionChain): Promise<string> =>
    (await owner.sessionQuestion.findUniqueOrThrow({ where: { id: chain.sessionQuestionId } }))
      .testQuestionId;

  // -------------------------------------------------------------------------------------------------
  // Reads under the grants of the explicit-only columns
  // -------------------------------------------------------------------------------------------------
  describe('explicit-only columns: readable only under the grant that names them', () => {
    interface ReadSite {
      readonly name: string;
      readonly request: (chain: SessionChain, id: string | bigint) => GrantRequest;
      readonly id: (chain: SessionChain) => Promise<string | bigint>;
      readonly read: () => Promise<Row[]>;
      readonly column: string;
      readonly value: (chain: SessionChain) => unknown;
      /** The match of a read of the own row: the other columns the select names. */
      readonly name2: string;
    }
    const sites: ReadSite[] = [
      {
        name: 'KeyService (sessions.hmacKeyEnc)',
        request: (_c, id) => ({ model: 'Session', columns: ['hmacKeyEnc'], ids: [id] }),
        id: (c) => Promise.resolve(c.sessionId),
        read: () => client.session.findMany({ select: { id: true, hmacKeyEnc: true } }),
        column: 'hmacKeyEnc',
        value: sealed,
        name2: 'hmacKeyEnc',
      },
      {
        name: 'DeviceInfoService (sessions.deviceInfo)',
        request: (_c, id) => ({ model: 'Session', columns: ['deviceInfo'], ids: [id] }),
        id: (c) => Promise.resolve(c.sessionId),
        read: () => client.session.findMany({ select: { id: true, deviceInfo: true } }),
        column: 'deviceInfo',
        value: (c) => ({ who: c.label, systemCheck: { ok: true } }),
        name2: 'deviceInfo',
      },
      {
        name: 'StorageService (media_chunks.objectKey)',
        request: (_c, id) => ({ model: 'MediaChunk', columns: ['objectKey'], ids: [id] }),
        id: chunkId,
        read: () => client.mediaChunk.findMany({ select: { id: true, objectKey: true } }),
        column: 'objectKey',
        value: OBJECT_KEY,
        name2: 'objectKey',
      },
      {
        name: 'OrgSettingsService (organizations.settings)',
        request: (_c, id) => ({ model: 'Organization', columns: ['settings'], ids: [id] }),
        id: (c) => Promise.resolve(c.orgId),
        read: () => client.organization.findMany({ select: { id: true, settings: true } }),
        column: 'settings',
        value: (c) => ({ org: c.orgId === T.orgId ? T.label : OT.label }),
        name2: 'settings',
      },
      {
        name: 'TestSettingsService (tests.settings)',
        request: (_c, id) => ({ model: 'Test', columns: ['settings'], ids: [id] }),
        id: (c) => Promise.resolve(c.testId),
        read: () => client.test.findMany({ select: { id: true, settings: true } }),
        column: 'settings',
        value: (c) => ({ t: c.label }),
        name2: 'settings',
      },
      {
        name: 'AccommodationsService (invitations.accommodations)',
        request: (_c, id) => ({ model: 'Invitation', columns: ['accommodations'], ids: [id] }),
        id: (c) => Promise.resolve(c.invitationId),
        read: () => client.invitation.findMany({ select: { id: true, accommodations: true } }),
        column: 'accommodations',
        value: (c) => ({ extraTimePct: c.label === 'a' ? 25 : 10, who: c.label }),
        name2: 'accommodations',
      },
      {
        name: 'SectionGateService step 1 (session_questions.testQuestionId)',
        request: (_c, id) => ({ model: 'SessionQuestion', columns: ['testQuestionId'], ids: [id] }),
        id: (c) => Promise.resolve(c.sessionQuestionId),
        read: () =>
          client.sessionQuestion.findMany({
            select: { id: true, testQuestionId: true },
          }),
        column: 'testQuestionId',
        value: (c) => c.testQuestionId,
        name2: 'testQuestionId',
      },
    ];

    it.each(sites.map((s) => [s.name, s] as const))(
      'TC-008 %s: refused without the grant, with no statement',
      async (_name, s) => {
        await db.statements.reset();
        const error = await asCandidate(A, () => failure(s.read()));
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(
          new RegExp(`the column ${s.column} is not available`),
        );
        expect(await statementCount()).toBe(0);
      },
    );

    it.each(sites.map((s) => [s.name, s] as const))(
      "TC-008 %s: under A's grant A reads its own value; a grant naming B's id, and a grant naming both, reach only A's row",
      async (_name, s) => {
        const own = await s.id(A);
        const other = await s.id(B);
        const mine = await asCandidate(A, () => grant(s.request(A, own), s.read));
        expect(mine).toHaveLength(1);
        expect(mine[0]?.[s.column]).toEqual(s.value(A));
        // B's id: the grant filter ANDs with A's own session/org/test filter, which finds nothing.
        const theirs = await asCandidate(A, () => grant(s.request(A, other), s.read));
        const both = await asCandidate(A, () =>
          grant({ ...s.request(A, own), ids: [other, own] }, s.read),
        );
        if (own === other) {
          // The org has one organization row: both candidates share it.
          expect(theirs).toHaveLength(1);
        } else {
          expect(theirs).toEqual([]);
        }
        expect(both).toHaveLength(1);
        expect(both[0]?.[s.column]).toEqual(s.value(A));
        // B reaches its own value the same way, and never A's.
        const bs = await asCandidate(B, () => grant(s.request(B, other), s.read));
        expect(bs).toHaveLength(1);
        expect(bs[0]?.[s.column]).toEqual(s.value(B));
        const swapped = await asCandidate(B, () => grant(s.request(B, own), s.read));
        expect(own === other ? swapped.length : swapped).toEqual(own === other ? 1 : []);
      },
    );

    it.each(sites.map((s) => [s.name, s] as const))(
      "TC-008 %s: another org's row is never reached, whoever's id the grant names",
      async (_name, s) => {
        const foreign = await s.id(O);
        const own = await s.id(A);
        const rows = await asCandidate(A, () =>
          grant({ ...s.request(A, own), ids: [foreign, own] }, s.read),
        );
        expect(rows.map((r) => r[s.column])).toEqual([s.value(A)]);
        const asO = await asCandidate(O, () => grant(s.request(O, foreign), s.read));
        expect(asO).toHaveLength(1);
        expect(asO[0]?.[s.column]).toEqual(s.value(O));
        const crossing = await asCandidate(O, () => grant(s.request(O, own), s.read));
        expect(crossing).toEqual([]);
      },
    );

    it.each(sites.map((s) => [s.name, s] as const))(
      'TC-008 %s: a read that outlives the grant throws, and no statement reaches Postgres',
      async (_name, s) => {
        const own = await s.id(A);
        let detached: Promise<unknown> = Promise.resolve();
        await asCandidate(A, async () => {
          await grant(s.request(A, own), () => {
            detached = new Promise((resolve) => setTimeout(resolve, 15)).then(() => s.read());
          });
          await db.statements.reset();
          const error = await failure(detached);
          expect(error).toBeInstanceOf(OrgScopeViolationError);
          expect((error as Error).message).toMatch(ENDED);
        });
        expect(await statementCount()).toBe(0);
      },
    );

    it('TC-008 the default select leaves them out even under the grant (explicit-only), and a grant of another column does not open them', async () => {
      const rows = await asCandidate(A, () =>
        grant({ model: 'Session', columns: ['hmacKeyEnc'], ids: [A.sessionId] }, () =>
          client.session.findMany({}),
        ),
      );
      expect(Object.keys(rows[0] as Row).sort()).toEqual(
        [
          'authEpoch',
          'deadlineAt',
          'id',
          'orgId',
          'pausedMs',
          'pauseReasons',
          'proctorPausedAt',
          'startedAt',
          'status',
          'submittedAt',
        ].sort(),
      );
      // KeyService does not open deviceInfo, nor DeviceInfoService the key.
      await asCandidate(A, async () => {
        await grant({ model: 'Session', columns: ['hmacKeyEnc'], ids: [A.sessionId] }, async () => {
          await expect(client.session.findMany({ select: { deviceInfo: true } })).rejects.toThrow(
            /the column deviceInfo is not available/,
          );
          await expect(
            client.session.count({ where: { deviceInfo: { not: {} } } }),
          ).rejects.toThrow(/the column deviceInfo is not available/);
        });
      });
    });

    it('TC-008 the grant is a boolean oracle only for the rows it reaches: a filter on the key of A or B finds only A', async () => {
      const found = await asCandidate(A, () =>
        grant(
          { model: 'Session', columns: ['hmacKeyEnc'], ids: [A.sessionId, B.sessionId] },
          async () => ({
            a: await client.session.count({ where: { hmacKeyEnc: sealed(A) } }),
            b: await client.session.count({ where: { hmacKeyEnc: sealed(B) } }),
          }),
        ),
      );
      expect(found).toEqual({ a: 1, b: 0 });
    });
  });

  describe('SectionGateService step 2 and the ConsentService read: models readable only under a grant', () => {
    it('TC-008 test_questions: without a grant it throws; under the grant A reads (id, section_id) of the question its session points to', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        await expect(client.testQuestion.findMany({ select: { id: true } })).rejects.toThrow(
          /readable only under a grant of its own/,
        );
      });
      expect(await statementCount()).toBe(0);
      const tq = await testQuestionIdOf(A);
      const row = await asCandidate(A, () =>
        grant({ model: 'TestQuestion', columns: ['id', 'sectionId'], ids: [tq] }, () =>
          client.testQuestion.findFirst({}),
        ),
      );
      expect(row).toEqual({ id: tq, sectionId: A.sectionId });
    });

    it("TC-008 test_questions: a grant naming B's test question reaches nothing for A (the session's own questions only: the stricter reading)", async () => {
      const theirs = await testQuestionIdOf(B);
      const mine = await testQuestionIdOf(A);
      const rows = await asCandidate(A, () =>
        grant({ model: 'TestQuestion', columns: ['id', 'sectionId'], ids: [theirs] }, () =>
          client.testQuestion.findMany({ select: { id: true, sectionId: true } }),
        ),
      );
      expect(rows).toEqual([]);
      const both = await asCandidate(A, () =>
        grant({ model: 'TestQuestion', columns: ['id', 'sectionId'], ids: [theirs, mine] }, () =>
          client.testQuestion.findMany({ select: { id: true, sectionId: true } }),
        ),
      );
      expect(both).toEqual([{ id: mine, sectionId: A.sectionId }]);
      // The owner sees the row: it is the grant and the session filter that hide it.
      expect(await owner.testQuestion.count({ where: { id: theirs } })).toBe(1);
    });

    it('TC-008 test_questions: the content columns are not readable under the grant: the version, the rule, the points, the position', async () => {
      const tq = await testQuestionIdOf(A);
      await asCandidate(A, async () => {
        await grant(
          { model: 'TestQuestion', columns: ['id', 'sectionId'], ids: [tq] },
          async () => {
            for (const column of ['questionVersionId', 'randomRule', 'points', 'position']) {
              await expect(
                client.testQuestion.findMany({ select: { [column]: true } }),
              ).rejects.toThrow(new RegExp(`the column ${column} is not available`));
              await expect(
                client.testQuestion.count({ where: { [column]: { not: null } } }),
              ).rejects.toThrow(new RegExp(`the column ${column} is not available`));
            }
          },
        );
      });
    });

    it('TC-008 consent_texts: under the grant A reads id, version, bodyMd and legalApprovedAt of the two texts, nothing else, and not another org text', async () => {
      const second = await owner.consentText.create({
        data: { orgId: T.orgId, version: '2', bodyMd: 'PLACEHOLDER 2 - NOT APPROVED BY LEGAL' },
      });
      try {
        const rows = await asCandidate(A, () =>
          grant(
            {
              model: 'ConsentText',
              columns: ['id', 'version', 'bodyMd', 'legalApprovedAt'],
              ids: [T.consentTextId, second.id, OT.consentTextId],
            },
            () => client.consentText.findMany({ orderBy: { version: 'asc' } }),
          ),
        );
        expect(rows.map((r) => Object.keys(r).sort())).toEqual([
          ['bodyMd', 'id', 'legalApprovedAt', 'version'],
          ['bodyMd', 'id', 'legalApprovedAt', 'version'],
        ]);
        // The org filter holds: the other org's text is not among them.
        expect(rows.map((r) => r.id).sort()).toEqual([T.consentTextId, second.id].sort());
        // Without the grant, and under a grant of another model: refused, no statement.
        await db.statements.reset();
        await asCandidate(A, async () => {
          await expect(client.consentText.findMany({ select: { id: true } })).rejects.toThrow(
            /readable only under a grant of its own/,
          );
          await grant(
            { model: 'Organization', columns: ['settings'], ids: [T.orgId] },
            async () => {
              await expect(client.consentText.findMany({ select: { id: true } })).rejects.toThrow(
                /readable only under a grant of its own/,
              );
            },
          );
        });
        expect(await statementCount()).toBe(0);
        // The columns the grant leaves out are not readable.
        await asCandidate(A, async () => {
          await grant(
            {
              model: 'ConsentText',
              columns: ['id', 'version', 'bodyMd', 'legalApprovedAt'],
              ids: [T.consentTextId],
            },
            async () => {
              for (const column of ['orgId', 'legalApprovedBy', 'createdById', 'createdAt']) {
                await expect(
                  client.consentText.findMany({ select: { [column]: true } }),
                ).rejects.toThrow(new RegExp(`the column ${column} is not available`));
              }
            },
          );
        });
      } finally {
        await owner.consentText.delete({ where: { id: second.id } });
      }
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Writes under the grants
  // -------------------------------------------------------------------------------------------------
  describe('the session state columns are written only under the SessionStateService grant', () => {
    const state = (ids: string[]): GrantRequest => ({
      model: 'Session',
      columns: ['status', 'pauseReasons', 'submittedAt'],
      ids,
    });
    const reset = async (): Promise<void> => {
      await owner.session.updateMany({
        where: { id: { in: [A.sessionId, B.sessionId] } },
        data: { status: 'INVITED', pauseReasons: [], submittedAt: null },
      });
    };
    afterEach(reset);

    it.each(['update', 'updateMany', 'updateManyAndReturn'] as const)(
      'TC-008 %s: refused without the grant (no statement), written under it, on A and never on B',
      async (operation) => {
        const data = {
          status: 'PAUSED' as const,
          pauseReasons: ['FULLSCREEN_EXIT' as const],
          submittedAt: WHEN,
        };
        const run = (): Promise<unknown> =>
          operation === 'update'
            ? client.session.update({ where: { id: A.sessionId }, data, select: { id: true } })
            : operation === 'updateMany'
              ? client.session.updateMany({ where: { id: A.sessionId }, data })
              : client.session.updateManyAndReturn({
                  where: { id: A.sessionId },
                  data,
                  select: { id: true },
                });
        await db.statements.reset();
        await asCandidate(A, async () => {
          await expect(run()).rejects.toThrow(
            /status cannot be written by a candidate update here/,
          );
        });
        expect(await statementCount()).toBe(0);
        expect((await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).status).toBe(
          'INVITED',
        );
        await asCandidate(A, () => grant(state([A.sessionId]), run));
        const after = await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } });
        expect({
          status: after.status,
          pauseReasons: after.pauseReasons,
          submittedAt: after.submittedAt,
        }).toEqual({
          status: 'PAUSED',
          pauseReasons: ['FULLSCREEN_EXIT'],
          submittedAt: WHEN,
        });
        expect((await owner.session.findUniqueOrThrow({ where: { id: B.sessionId } })).status).toBe(
          'INVITED',
        );
      },
    );

    it("TC-008 a grant naming B's session, or both, writes nothing of B's: the session filter of the scope holds", async () => {
      await asCandidate(A, async () => {
        for (const ids of [[B.sessionId], [B.sessionId, A.sessionId]]) {
          const result = await grant(state(ids), () =>
            client.session.updateMany({ where: { id: B.sessionId }, data: { status: 'PAUSED' } }),
          );
          expect(result).toEqual({ count: 0 });
          await expect(
            grant(state(ids), () =>
              client.session.update({
                where: { id: B.sessionId },
                data: { status: 'PAUSED' },
                select: { id: true },
              }),
            ),
          ).rejects.toMatchObject({ code: 'P2025' });
        }
        // A grant naming only B's session cannot even write A's own row: ids AND the session filter.
        const own = await grant(state([B.sessionId]), () =>
          client.session.updateMany({ where: { id: A.sessionId }, data: { status: 'PAUSED' } }),
        );
        expect(own).toEqual({ count: 0 });
      });
      for (const chain of [A, B]) {
        expect(
          (await owner.session.findUniqueOrThrow({ where: { id: chain.sessionId } })).status,
        ).toBe('INVITED');
      }
    });

    it('TC-008 the grant writes its columns and no other: authEpoch, the scores and the key are refused under it, with no statement', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        await grant(state([A.sessionId]), async () => {
          for (const data of [
            { authEpoch: 9 },
            { riskScore: 1 },
            { hmacKeyEnc: 'x' },
            { deviceInfo: { a: 1 } },
            { invitationId: B.invitationId },
            { status: 'PAUSED', authEpoch: 9 },
          ]) {
            await expect(
              client.session.updateMany({ where: { id: A.sessionId }, data: data as never }),
            ).rejects.toThrow(OrgScopeViolationError);
          }
        });
      });
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 a write that outlives the grant throws, and the row is as it was', async () => {
      let detached: Promise<unknown> = Promise.resolve();
      await asCandidate(A, async () => {
        await grant(state([A.sessionId]), () => {
          detached = new Promise((resolve) => setTimeout(resolve, 15)).then(() =>
            client.session.updateMany({ where: { id: A.sessionId }, data: { status: 'PAUSED' } }),
          );
        });
        const error = await failure(detached);
        expect((error as Error).message).toMatch(ENDED);
      });
      expect((await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).status).toBe(
        'INVITED',
      );
    });

    it('TC-008 DeviceInfoService reads, merges and writes deviceInfo under its grant, fenced on the value it read', async () => {
      const device: GrantRequest = {
        model: 'Session',
        columns: ['deviceInfo'],
        ids: [A.sessionId],
      };
      try {
        await asCandidate(A, async () => {
          await expect(
            client.session.updateMany({
              where: { id: A.sessionId },
              data: { deviceInfo: { x: 1 } },
            }),
          ).rejects.toThrow(/deviceInfo cannot be written by a candidate update here/);
          await grant(device, async () => {
            const read = (await client.session.findUniqueOrThrow({
              where: { id: A.sessionId },
              select: { deviceInfo: true },
            })) as { deviceInfo: Record<string, unknown> };
            const merged = { ...read.deviceInfo, capabilities: ['webcam'] };
            const written = await client.session.updateMany({
              where: { id: A.sessionId, deviceInfo: { equals: read.deviceInfo as never } },
              data: { deviceInfo: merged },
            });
            expect(written).toEqual({ count: 1 });
            // A second writer that still holds the old value is fenced out: 0 rows.
            const stale = await client.session.updateMany({
              where: { id: A.sessionId, deviceInfo: { equals: read.deviceInfo as never } },
              data: { deviceInfo: { overwritten: true } },
            });
            expect(stale).toEqual({ count: 0 });
          });
        });
        expect(
          (await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).deviceInfo,
        ).toEqual({
          who: 'a',
          systemCheck: { ok: true },
          capabilities: ['webcam'],
        });
        expect(
          (await owner.session.findUniqueOrThrow({ where: { id: B.sessionId } })).deviceInfo,
        ).toEqual({
          who: 'b',
          systemCheck: { ok: true },
        });
      } finally {
        await owner.session.update({
          where: { id: A.sessionId },
          data: { deviceInfo: { who: 'a', systemCheck: { ok: true } } },
        });
      }
    });

    it('TC-008 a candidate writes the object key of a media chunk with no grant and reads it back only under StorageService', async () => {
      const key = `orgs/${A.orgId}/sessions/${A.sessionId}/media/SCREEN/000000/00000000.webm`;
      const id = await chunkId(A);
      await asCandidate(A, async () => {
        const written = await client.mediaChunk.update({
          where: { id },
          data: { objectKey: key, sizeBytes: 5n },
          select: { id: true, sizeBytes: true },
        });
        expect(written).toEqual({ id, sizeBytes: 5n });
        // The row that came back (no select) does not carry the key either.
        const bare = await client.mediaChunk.update({ where: { id }, data: { sizeBytes: 6n } });
        expect(Object.keys(bare as Row)).not.toContain('objectKey');
        await expect(
          client.mediaChunk.update({
            where: { id },
            data: { objectKey: key },
            select: { objectKey: true },
          }),
        ).rejects.toThrow(/the column objectKey is not available/);
      });
      await owner.mediaChunk.update({ where: { id }, data: { sizeBytes: null } });
    });
  });

  // -------------------------------------------------------------------------------------------------
  // The consents create
  // -------------------------------------------------------------------------------------------------
  describe('the consents create: one create under the ConsentService grant (item 9; FR-401, C-17)', () => {
    /** A session of A's org with no consent row yet, as the sign route finds it. */
    async function freshSession(label: string): Promise<SessionChain> {
      const chain = await createCandidateChain(owner, T, label);
      await owner.consent.delete({ where: { id: chain.rows.Consent.filter.id as string } });
      return chain;
    }
    const create = (chain: SessionChain): GrantRequest => ({
      model: 'Consent',
      columns: [
        'sessionId',
        'consentTextId',
        'signedName',
        'signedAt',
        'declinedAt',
        'ageConfirmedAt',
        'ip',
        'userAgent',
      ],
      ids: [chain.sessionId],
    });
    const signedRow = (chain: SessionChain, textId = T.consentTextId) => ({
      sessionId: chain.sessionId,
      consentTextId: textId,
      signedName: `Synthetic Name ${chain.label}`,
      signedAt: WHEN,
      ageConfirmedAt: WHEN,
      ip: '203.0.113.7',
      userAgent: 'synthetic-agent',
    });
    const declinedRow = (chain: SessionChain, textId = T.consentTextId) => ({
      sessionId: chain.sessionId,
      consentTextId: textId,
      declinedAt: WHEN,
      ip: '203.0.113.8',
      userAgent: 'synthetic-agent',
    });
    const consentOf = (chain: SessionChain) =>
      owner.consent.findUnique({ where: { sessionId: chain.sessionId } });
    const make = (chain: SessionChain, data: Row) =>
      asCandidate(chain, () =>
        grant(create(chain), () => client.consent.create({ data: data as never })),
      );

    it('TC-008 a sign is one create: the row is stored, the row it returns omits signedName, ip and userAgent, and it is two statements (the current-text read and the insert)', async () => {
      const C = await freshSession('c1');
      await db.statements.reset();
      const returned = await make(C, signedRow(C));
      const texts = await statementTexts();
      expect(texts).toHaveLength(2);
      // pg_stat_statements lists the statements in no particular order: find each of the two.
      const read = texts.find((t) => /^\s*SELECT/i.test(t));
      const insert = texts.find((t) => /^\s*INSERT/i.test(t));
      expect(read).toMatch(/organizations/);
      expect(read).toMatch(/current_consent_text_id/);
      expect(read).not.toMatch(/settings/); // only the one column is read
      expect(insert).toMatch(/^\s*INSERT INTO "public"\."consents"/i);
      expect(Object.keys(returned as Row).sort()).toEqual(
        ['consentTextId', 'declinedAt', 'id', 'sessionId', 'signedAt'].sort(),
      );
      expect(returned).toMatchObject({ sessionId: C.sessionId, consentTextId: T.consentTextId });
      const stored = await consentOf(C);
      expect(stored).toMatchObject({
        signedName: `Synthetic Name ${C.label}`,
        signedAt: WHEN,
        declinedAt: null,
        ageConfirmedAt: WHEN,
        ip: '203.0.113.7',
        userAgent: 'synthetic-agent',
        pdfKey: null,
        pdfGeneratedAt: null,
        copyEmailedAt: null,
        consentTextId: T.consentTextId,
      });
    });

    it('TC-008 a decline is one create too, with no name', async () => {
      const C = await freshSession('c2');
      await make(C, declinedRow(C));
      expect(await consentOf(C)).toMatchObject({
        signedName: null,
        signedAt: null,
        declinedAt: WHEN,
        ageConfirmedAt: null,
        ip: '203.0.113.8',
      });
    });

    it('FR-401 C-30 TC-095 the sign create stores ageConfirmedAt, the row it returns omits it, and a decline leaves it NULL (D-55)', async () => {
      const C = await freshSession('c2a');
      const returned = await make(C, signedRow(C));
      expect(Object.keys(returned as Row)).not.toContain('ageConfirmedAt');
      expect((await consentOf(C))?.ageConfirmedAt).toEqual(WHEN);
      const D = await freshSession('c2b');
      await make(D, declinedRow(D));
      expect((await consentOf(D))?.ageConfirmedAt).toBeNull();
    });

    it('FR-401 C-30 TC-008 a create that carries ageConfirmedAt is refused without the grant, and under a grant that leaves the column out: no statement, no row', async () => {
      const C = await freshSession('c2c');
      await db.statements.reset();
      await asCandidate(C, async () => {
        await expect(client.consent.create({ data: signedRow(C) })).rejects.toThrow(
          /creates this row only under its create grant/,
        );
        // The create grant of the model, narrowed so that it does not name the column.
        const narrowed = {
          ...create(C),
          columns: create(C).columns.filter((column) => column !== 'ageConfirmedAt'),
        };
        await expect(
          grant(narrowed, () => client.consent.create({ data: signedRow(C) })),
        ).rejects.toThrow(/ageConfirmedAt cannot be written by a candidate create/);
      });
      expect(await statementCount()).toBe(0);
      expect(await consentOf(C)).toBeNull();
    });

    it('TC-008 write-once: a second create for the session fails with P2002 (the service answers 409), and the first row is as it was', async () => {
      const C = await freshSession('c3');
      await make(C, signedRow(C));
      const before = await consentOf(C);
      for (const row of [signedRow(C), declinedRow(C)]) {
        await expect(make(C, row)).rejects.toMatchObject({ code: 'P2002' });
      }
      expect(await consentOf(C)).toEqual(before);
    });

    it('TC-008 a candidate cannot create the row outside the grant, after it, or in a batch, and nothing reaches Postgres', async () => {
      const C = await freshSession('c4');
      await db.statements.reset();
      await asCandidate(C, async () => {
        await expect(client.consent.create({ data: signedRow(C) })).rejects.toThrow(
          /creates this row only under its create grant/,
        );
        // Another grant, even of the same service, is not the create grant.
        await grant({ model: 'ConsentText', columns: ['id'], ids: [T.consentTextId] }, async () => {
          await expect(client.consent.create({ data: signedRow(C) })).rejects.toThrow(
            /creates this row only under its create grant/,
          );
        });
        let late: Promise<unknown> = Promise.resolve();
        await grant(create(C), () => {
          late = new Promise((resolve) => setTimeout(resolve, 15)).then(() =>
            client.consent.create({ data: signedRow(C) }),
          );
        });
        const error = await failure(late);
        expect((error as Error).message).toMatch(ENDED);
        await grant(create(C), async () => {
          for (const operation of ['createMany', 'createManyAndReturn'] as const) {
            await expect(
              (client.consent[operation] as (args: unknown) => Promise<unknown>)({
                data: [signedRow(C)],
              }),
            ).rejects.toThrow(/takes only create/);
          }
          await expect(
            client.consent.upsert({
              where: { sessionId: C.sessionId },
              create: signedRow(C),
              update: { ip: 'x' },
            }),
          ).rejects.toThrow(/takes only create/);
        });
      });
      expect(await statementCount()).toBe(0);
      expect(await consentOf(C)).toBeNull();
    });

    it('TC-008 a wrong session id throws, a session id that is not in the grant ids throws, and a missing key throws: no statement, no row', async () => {
      const C = await freshSession('c5');
      const D = await freshSession('c6');
      await db.statements.reset();
      await asCandidate(C, async () => {
        // The session of another candidate, and of another org.
        for (const sessionId of [D.sessionId, B.sessionId, O.sessionId]) {
          await expect(
            grant(create(C), () => client.consent.create({ data: { ...signedRow(C), sessionId } })),
          ).rejects.toThrow(/sessionId in the data is not the session of this scope/);
        }
        // The right session, but the grant names another one.
        await expect(
          grant({ ...create(C), ids: [D.sessionId] }, () =>
            client.consent.create({ data: signedRow(C) }),
          ),
        ).rejects.toThrow(/not in the ids of the active grant/);
        // Missing, or not an id.
        for (const bad of [undefined, null, 'x', 7]) {
          const row: Row = { ...signedRow(C) };
          if (bad === undefined) delete row.sessionId;
          else row.sessionId = bad;
          await expect(
            grant(create(C), () => client.consent.create({ data: row as never })),
          ).rejects.toThrow(/sessionId is required in this create/);
        }
      });
      expect(await statementCount()).toBe(0);
      expect(await consentOf(C)).toBeNull();
      expect(await consentOf(D)).toBeNull();
    });

    it("TC-008 B's grant cannot create A's consent, and A's cannot create B's (the context decides the session)", async () => {
      const C = await freshSession('c7');
      const D = await freshSession('c8');
      await expect(
        asCandidate(C, () =>
          grant({ ...create(D), ids: [D.sessionId, C.sessionId] }, () =>
            client.consent.create({ data: signedRow(D) }),
          ),
        ),
      ).rejects.toThrow(/is not the session of this scope/);
      expect(await consentOf(D)).toBeNull();
    });

    it('TC-008 the consent text must be the current one: another text of the org, a text of another org, a made-up id, a missing id and a null current text all throw, and nothing is inserted', async () => {
      const C = await freshSession('c9');
      const second = await owner.consentText.create({
        data: { orgId: T.orgId, version: 'older', bodyMd: 'PLACEHOLDER - NOT APPROVED BY LEGAL' },
      });
      try {
        // Another text of the org, a text of another org, a made-up id: one read, no insert.
        for (const textId of [second.id, OT.consentTextId, randomUUID()]) {
          await db.statements.reset();
          await expect(make(C, signedRow(C, textId))).rejects.toThrow(
            /consentTextId is not the current consent text of the organisation/,
          );
          expect(await statementCount()).toBe(1);
          expect(await consentOf(C)).toBeNull();
        }
        // Missing: refused before the read.
        const row: Row = { ...signedRow(C) };
        delete row.consentTextId;
        await db.statements.reset();
        await expect(make(C, row)).rejects.toThrow(/consentTextId is required in this create/);
        expect(await statementCount()).toBe(0);
        // The organisation has no current text: it throws after the read, and ConsentService answers 5xx.
        await owner.organization.update({
          where: { id: T.orgId },
          data: { currentConsentTextId: null },
        });
        try {
          await db.statements.reset();
          await expect(make(C, signedRow(C))).rejects.toThrow(/no current consent text/);
          expect(await statementCount()).toBe(1);
          expect(await consentOf(C)).toBeNull();
        } finally {
          await owner.organization.update({
            where: { id: T.orgId },
            data: { currentConsentTextId: T.consentTextId },
          });
        }
        // And the current one passes.
        await make(C, signedRow(C));
        expect(await consentOf(C)).not.toBeNull();
      } finally {
        await owner.consentText.delete({ where: { id: second.id } });
      }
    });

    it('TC-008 a text published after ConsentService read it is stale: the create with the old text throws, with the new one it passes', async () => {
      const C = await freshSession('c10');
      const published = await owner.consentText.create({
        data: {
          orgId: T.orgId,
          version: 'published',
          bodyMd: 'PLACEHOLDER - NOT APPROVED BY LEGAL',
        },
      });
      try {
        // ConsentService read T.consentTextId as the current text; an admin publishes another one.
        const seenByService = T.consentTextId;
        await owner.organization.update({
          where: { id: T.orgId },
          data: { currentConsentTextId: published.id },
        });
        await expect(make(C, signedRow(C, seenByService))).rejects.toThrow(
          /consentTextId is not the current consent text/,
        );
        expect(await consentOf(C)).toBeNull();
        await make(C, signedRow(C, published.id));
        expect((await consentOf(C))?.consentTextId).toBe(published.id);
      } finally {
        await owner.organization.update({
          where: { id: T.orgId },
          data: { currentConsentTextId: T.consentTextId },
        });
        await owner.consent.deleteMany({ where: { consentTextId: published.id } });
        await owner.consentText.delete({ where: { id: published.id } });
      }
    });

    it("TC-008 another org's candidate cannot record a consent against this org's text: its own org's current text decides", async () => {
      const OC = await createCandidateChain(owner, OT, 'oc');
      await owner.consent.delete({ where: { id: OC.rows.Consent.filter.id as string } });
      await expect(
        asCandidate(OC, () =>
          grant(create(OC), () => client.consent.create({ data: signedRow(OC, T.consentTextId) })),
        ),
      ).rejects.toThrow(/consentTextId is not the current consent text/);
      await asCandidate(OC, () =>
        grant(create(OC), () => client.consent.create({ data: signedRow(OC, OT.consentTextId) })),
      );
      expect((await consentOf(OC))?.consentTextId).toBe(OT.consentTextId);
    });

    it('TC-008 the PDF columns, the id and the timestamps are never written by a candidate create, grant or not', async () => {
      const C = await freshSession('c11');
      await db.statements.reset();
      for (const extra of [
        { pdfKey: 'consents/forged.pdf' },
        { pdfGeneratedAt: WHEN },
        { copyEmailedAt: WHEN },
        { id: randomUUID() },
      ]) {
        await expect(make(C, { ...signedRow(C), ...extra })).rejects.toThrow(
          OrgScopeViolationError,
        );
      }
      expect(await statementCount()).toBe(0);
      expect(await consentOf(C)).toBeNull();
    });

    it('TC-008 exactly one of signedAt and declinedAt, and the name with a signature: refused before the database', async () => {
      const C = await freshSession('c12');
      await db.statements.reset();
      for (const row of [
        { ...signedRow(C), declinedAt: WHEN },
        { sessionId: C.sessionId, consentTextId: T.consentTextId, ip: '203.0.113.9' },
        { ...signedRow(C), signedName: '' },
        { ...signedRow(C), signedName: undefined },
      ]) {
        await expect(make(C, row)).rejects.toThrow(OrgScopeViolationError);
      }
      expect(await statementCount()).toBe(0);
    });

    it('FR-401 C-30 TC-008 a candidate reads id, consentTextId, signedAt and declinedAt of its consent, and never signedName, ip, userAgent or ageConfirmedAt', async () => {
      const C = await freshSession('c13');
      await make(C, signedRow(C));
      await asCandidate(C, async () => {
        const rows = (await client.consent.findMany({})) as Row[];
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0] as Row).sort()).toEqual(
          ['consentTextId', 'declinedAt', 'id', 'sessionId', 'signedAt'].sort(),
        );
        for (const column of [
          'signedName',
          'ip',
          'userAgent',
          'ageConfirmedAt',
          'pdfKey',
          'pdfGeneratedAt',
          'copyEmailedAt',
        ]) {
          await expect(client.consent.findMany({ select: { [column]: true } })).rejects.toThrow(
            new RegExp(`the column ${column} is not available`),
          );
          await expect(
            client.consent.count({ where: { [column]: { not: null } } }),
          ).rejects.toThrow(new RegExp(`the column ${column} is not available`));
          // Not even under the create grant, which names those columns for writing.
          await grant(create(C), async () => {
            await expect(client.consent.findMany({ select: { [column]: true } })).rejects.toThrow(
              new RegExp(`the column ${column} is not available`),
            );
          });
        }
        // Another candidate's consent is not there at all.
        expect(await client.consent.count({ where: { sessionId: A.sessionId } })).toBe(0);
      });
    });

    it('TC-008 a select of signedName on the create itself throws, and no statement is sent', async () => {
      const C = await freshSession('c14');
      await db.statements.reset();
      await expect(
        asCandidate(C, () =>
          grant(create(C), () =>
            client.consent.create({ data: signedRow(C), select: { signedName: true } }),
          ),
        ),
      ).rejects.toThrow(/the column signedName is not available/);
      expect(await statementCount()).toBe(0);
      expect(await consentOf(C)).toBeNull();
    });

    it('TC-008 every update, upsert and delete of a consent throws for the candidate, under the create grant too, and the row is as it was', async () => {
      const C = await freshSession('c15');
      await make(C, signedRow(C));
      const before = await consentOf(C);
      await db.statements.reset();
      await asCandidate(C, async () => {
        await grant(create(C), async () => {
          const data = { ip: '198.51.100.9', userAgent: 'forged', signedName: 'Forged Name' };
          await expect(
            client.consent.updateMany({ where: { sessionId: C.sessionId }, data }),
          ).rejects.toThrow(/cannot update this row/);
          await expect(
            client.consent.update({
              where: { sessionId: C.sessionId },
              data,
              select: { id: true },
            }),
          ).rejects.toThrow(/cannot update this row/);
          await expect(
            client.consent.updateManyAndReturn({
              where: { sessionId: C.sessionId },
              data,
              select: { id: true },
            }),
          ).rejects.toThrow(/cannot update this row/);
          await expect(
            client.consent.deleteMany({ where: { sessionId: C.sessionId } }),
          ).rejects.toThrow(/a candidate deletes nothing/);
          await expect(
            client.consent.delete({ where: { sessionId: C.sessionId } }),
          ).rejects.toThrow(/a candidate deletes nothing/);
        });
      });
      expect(await statementCount()).toBe(0);
      expect(await consentOf(C)).toEqual(before);
    });

    it('TC-008 the consent-PDF job (SERVICE) writes its own columns without a grant', async () => {
      const C = await freshSession('c16');
      await make(C, signedRow(C));
      const changed = await asService(C, () =>
        client.consent.updateMany({
          where: { sessionId: C.sessionId },
          data: {
            pdfKey: `orgs/${C.orgId}/sessions/${C.sessionId}/consent.pdf`,
            pdfGeneratedAt: WHEN,
          },
        }),
      );
      expect(changed).toEqual({ count: 1 });
      expect((await consentOf(C))?.pdfGeneratedAt).toEqual(WHEN);
    });

    it('FR-401 C-30 TC-008 no CHECK on ageConfirmedAt (D-55): the consent-PDF job (SERVICE) updates a signed row that has none, as for a row signed before C-30', async () => {
      const C = await freshSession('c16a');
      // A row as it was written before C-30: signed, with the typed name, and no age confirmation.
      await owner.consent.create({
        data: {
          sessionId: C.sessionId,
          consentTextId: T.consentTextId,
          signedName: `Synthetic Name ${C.label}`,
          signedAt: WHEN,
        },
      });
      expect((await consentOf(C))?.ageConfirmedAt).toBeNull();
      const sentAt = new Date('2026-10-06T01:00:00.000Z');
      const changed = await asService(C, () =>
        client.consent.updateMany({
          where: { sessionId: C.sessionId },
          data: {
            pdfKey: `orgs/${C.orgId}/sessions/${C.sessionId}/consent.pdf`,
            pdfGeneratedAt: WHEN,
            copyEmailedAt: sentAt,
          },
        }),
      );
      expect(changed).toEqual({ count: 1 });
      expect(await consentOf(C)).toMatchObject({
        pdfGeneratedAt: WHEN,
        copyEmailedAt: sentAt,
        signedAt: WHEN,
        ageConfirmedAt: null,
      });
    });

    it('TC-008 the create and the state transition run one after the other in ONE transaction, each under its own grant, and roll back together', async () => {
      const C = await freshSession('c17');
      await owner.session.update({ where: { id: C.sessionId }, data: { status: 'OPENED' } });
      const transition = (): GrantRequest => ({
        model: 'Session',
        columns: ['status'],
        ids: [C.sessionId],
      });
      // Both grants are used in the same $transaction, one after the other (grants do not nest).
      await asCandidate(C, () =>
        client.$transaction(async (tx) => {
          await grant(create(C), () =>
            tx.consent.create({ data: signedRow(C), select: { id: true } }),
          );
          await grant(transition(), () =>
            tx.session.update({
              where: { id: C.sessionId },
              data: { status: 'CONSENTED' },
              select: { id: true },
            }),
          );
        }),
      );
      expect((await owner.session.findUniqueOrThrow({ where: { id: C.sessionId } })).status).toBe(
        'CONSENTED',
      );
      expect(await consentOf(C)).not.toBeNull();
      // A nested grant is still refused: the two grants of one transaction are sequential.
      await asCandidate(C, async () => {
        await grant(create(C), () => {
          expect(() => orgContext.withGrant(transition(), () => undefined)).toThrow(
            /grants do not nest/,
          );
        });
      });
      // Atomic: a failing second step rolls the consent back.
      const D = await freshSession('c18');
      await owner.session.update({ where: { id: D.sessionId }, data: { status: 'OPENED' } });
      await expect(
        asCandidate(D, () =>
          client.$transaction(async (tx) => {
            await grant(create(D), () =>
              tx.consent.create({ data: signedRow(D), select: { id: true } }),
            );
            await grant(transition(), () =>
              tx.session.update({
                where: { id: A.sessionId },
                data: { status: 'DECLINED' },
                select: { id: true },
              }),
            );
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2025' });
      expect(await consentOf(D)).toBeNull();
      expect((await owner.session.findUniqueOrThrow({ where: { id: D.sessionId } })).status).toBe(
        'OPENED',
      );
    });

    it('TC-008 the create inside a transaction reads the current text outside it (FU-DB-192): it needs a second connection and still finds the committed text', async () => {
      const C = await freshSession('c19');
      await asCandidate(C, () =>
        client.$transaction(async (tx) => {
          await grant(create(C), () =>
            tx.consent.create({ data: signedRow(C), select: { id: true } }),
          );
        }),
      );
      expect(await consentOf(C)).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------------
  // The RUN filter
  // -------------------------------------------------------------------------------------------------
  describe('submissions: results, passed and total only on RUN rows; score never', () => {
    let submitA: string;
    let submitB: string;
    let runB: string;
    const submitResults = [
      { testCaseId: 'hidden-1', passed: false, status: 'WA', timeMs: 5, memoryKb: 9 },
    ];

    beforeAll(async () => {
      submitA = (
        await owner.submission.create({
          data: {
            sessionQuestionId: A.sessionQuestionId,
            kind: 'SUBMIT',
            language: 'cs4-hidden',
            sourceCode: 'x',
            results: submitResults,
            passed: 2,
            total: 5,
            score: 40,
          },
        })
      ).id;
      submitB = (
        await owner.submission.create({
          data: {
            sessionQuestionId: B.sessionQuestionId,
            kind: 'SUBMIT',
            language: 'cs4-hidden',
            sourceCode: 'x',
            results: submitResults,
            passed: 4,
            total: 5,
            score: 80,
          },
        })
      ).id;
      runB = (
        await owner.submission.create({
          data: {
            sessionQuestionId: B.sessionQuestionId,
            kind: 'RUN',
            language: 'cs4-run',
            sourceCode: 'x',
            results: [{ sample: 1 }],
            passed: 1,
            total: 1,
          },
        })
      ).id;
    });

    afterAll(async () => {
      await owner.submission.deleteMany({ where: { id: { in: [submitA, submitB, runB] } } });
    });

    it('TC-008 count({ where: { kind: SUBMIT, passed: N } }) is 0 for the N that is stored: the oracle is closed', async () => {
      await asCandidate(A, async () => {
        for (const passed of [2, 4, 0, 5]) {
          expect(await client.submission.count({ where: { kind: 'SUBMIT', passed } })).toBe(0);
        }
        expect(await client.submission.count({ where: { kind: 'SUBMIT', total: 5 } })).toBe(0);
        expect(
          await client.submission.count({ where: { kind: 'SUBMIT', passed: { gte: 0 } } }),
        ).toBe(0);
        // Existence is not hidden: A knows that it submitted.
        expect(await client.submission.count({ where: { kind: 'SUBMIT' } })).toBe(1);
      });
    });

    it('TC-008 results is never readable on a SUBMIT row: a select returns the RUN rows only, and the SUBMIT row is not in any answer', async () => {
      await asCandidate(A, async () => {
        const rows = (await client.submission.findMany({
          select: { id: true, kind: true, results: true, passed: true, total: true },
        })) as Row[];
        expect(rows.map((r) => r.kind)).toEqual(['RUN']);
        expect(rows.map((r) => r.id)).not.toContain(submitA);
        expect(
          await client.submission.findUnique({
            where: { id: submitA },
            select: { id: true, results: true },
          }),
        ).toBeNull();
        expect(
          await client.submission.findFirst({ where: { id: submitA }, select: { results: true } }),
        ).toBeNull();
        // The same row, with no result column named, is visible: kind and language only.
        expect(
          await client.submission.findUnique({
            where: { id: submitA },
            select: { id: true, kind: true, language: true },
          }),
        ).toEqual({ id: submitA, kind: 'SUBMIT', language: 'cs4-hidden' });
      });
    });

    it('TC-008 aggregates, group-bys and orderings that name those columns see RUN rows only', async () => {
      await asCandidate(A, async () => {
        const sum = await client.submission.aggregate({ _sum: { passed: true, total: true } });
        // A's one RUN row carries the defaults (0 and 0): the SUBMIT row (passed 2, total 5) is not in the sum.
        expect(sum._sum).toEqual({ passed: 0, total: 0 });
        const grouped = (await client.submission.groupBy({
          by: ['kind'],
          _sum: { passed: true },
          orderBy: { kind: 'asc' },
        })) as Row[];
        expect(grouped.map((g) => g.kind)).toEqual(['RUN']);
        const ordered = (await client.submission.findMany({
          select: { id: true, kind: true },
          orderBy: { passed: 'desc' },
        })) as Row[];
        expect(ordered.every((r) => r.kind === 'RUN')).toBe(true);
        const distinct = (await client.submission.findMany({
          select: { kind: true },
          distinct: ['total'],
        })) as Row[];
        expect(distinct.every((r) => r.kind === 'RUN')).toBe(true);
      });
    });

    it("TC-008 B's RUN row is not reached by A's RUN filter (the session filter holds), and A reads its own RUN results back", async () => {
      const own = await asCandidate(A, () =>
        client.submission.create({
          data: {
            sessionQuestionId: A.sessionQuestionId,
            kind: 'RUN',
            language: 'cs4-own-run',
            sourceCode: 'print(1)',
            results: [{ sample: 1, passed: true }],
            passed: 1,
            total: 1,
          },
          select: { id: true, kind: true, results: true, passed: true, total: true },
        }),
      );
      try {
        expect(own).toMatchObject({
          kind: 'RUN',
          passed: 1,
          total: 1,
          results: [{ sample: 1, passed: true }],
        });
        await asCandidate(A, async () => {
          const rows = (await client.submission.findMany({
            where: { language: 'cs4-own-run' },
            select: { id: true, results: true, passed: true },
          })) as Row[];
          expect(rows).toEqual([{ id: own.id, results: [{ sample: 1, passed: true }], passed: 1 }]);
          expect(await client.submission.count({ where: { id: runB, passed: 1 } })).toBe(0);
          const all = (await client.submission.findMany({
            select: { id: true, passed: true },
          })) as Row[];
          expect(all.map((r) => r.id)).not.toContain(runB);
        });
      } finally {
        await owner.submission.delete({ where: { id: own.id } });
      }
    });

    it('TC-008 results, passed and total can be written on a RUN create and not on a SUBMIT create; score and sourceCode are never read', async () => {
      await asCandidate(A, async () => {
        await db.statements.reset();
        await expect(
          client.submission.create({
            data: {
              sessionQuestionId: A.sessionQuestionId,
              kind: 'SUBMIT',
              language: 'python',
              sourceCode: 'x',
              passed: 5,
            },
            select: { id: true },
          }),
        ).rejects.toThrow(/can be written only on a row whose kind is RUN/);
        for (const column of ['score', 'sourceCode']) {
          await expect(client.submission.findMany({ select: { [column]: true } })).rejects.toThrow(
            new RegExp(`the column ${column} is not available`),
          );
          await expect(
            client.submission.findMany({
              select: { id: true, results: true },
              where: { [column]: { not: null } },
            }),
          ).rejects.toThrow(new RegExp(`the column ${column} is not available`));
        }
        expect(await statementCount()).toBe(0);
      });
    });

    it('TC-008 the row a create returns with no select omits results, passed, total, score and sourceCode', async () => {
      const created = await asCandidate(A, () =>
        client.submission.create({
          data: {
            sessionQuestionId: A.sessionQuestionId,
            kind: 'RUN',
            language: 'cs4-bare',
            sourceCode: 'x',
            results: [],
            passed: 1,
            total: 1,
          },
        }),
      );
      try {
        expect(Object.keys(created as Row).sort()).toEqual(
          ['createdAt', 'id', 'kind', 'language', 'sessionQuestionId'].sort(),
        );
      } finally {
        await owner.submission.deleteMany({ where: { language: 'cs4-bare' } });
      }
    });

    it('TC-008 a createManyAndReturn that reads results back is allowed for RUN rows only', async () => {
      const row = (kind: 'RUN' | 'SUBMIT') => ({
        sessionQuestionId: A.sessionQuestionId,
        kind,
        language: 'cs4-many',
        sourceCode: 'x',
      });
      await asCandidate(A, async () => {
        await expect(
          client.submission.createManyAndReturn({
            data: [row('RUN'), row('SUBMIT')],
            select: { id: true, results: true },
          }),
        ).rejects.toThrow(/can be read only on RUN rows/);
        const made = (await client.submission.createManyAndReturn({
          data: [row('RUN')],
          select: { id: true, results: true },
        })) as Row[];
        expect(made).toHaveLength(1);
      });
      await owner.submission.deleteMany({ where: { language: 'cs4-many' } });
    });

    it('TC-008 the job (SERVICE) reads every column of every row: the RUN filter is a CANDIDATE rule', async () => {
      const rows = await asService(A, () =>
        client.submission.findMany({
          where: { kind: 'SUBMIT' },
          select: { id: true, results: true, passed: true, score: true },
        }),
      );
      expect(rows).toMatchObject([{ id: submitA, results: submitResults, passed: 2 }]);
      expect(rows[0]).toHaveProperty('score');
    });
  });

  // -------------------------------------------------------------------------------------------------
  // omit, the facts, FU-DB-199
  // -------------------------------------------------------------------------------------------------
  describe('omit on creates and updates, the facts, and the object keys of an update', () => {
    it('TC-008 a write that returns the row carries the default columns only: no select is needed for it to be safe', async () => {
      await asCandidate(A, async () => {
        const session = (await client.session.update({
          where: { id: A.sessionId },
          data: { lastHeartbeat: WHEN },
        })) as Row;
        expect(Object.keys(session)).not.toContain('lastHeartbeat');
        expect(Object.keys(session)).not.toContain('hmacKeyEnc');
        expect(Object.keys(session)).not.toContain('deviceInfo');
        expect(Object.keys(session)).not.toContain('invitationId');
        expect(session.id).toBe(A.sessionId);
        const many = (await client.session.updateManyAndReturn({
          where: { id: A.sessionId },
          data: { lastHeartbeat: WHEN },
        })) as Row[];
        expect(many).toHaveLength(1);
        expect(Object.keys(many[0] as Row)).not.toContain('hmacKeyEnc');
        const question = (await client.sessionQuestion.update({
          where: { id: A.sessionQuestionId },
          data: { finalCode: 'print(2)' },
        })) as Row;
        expect(Object.keys(question).sort()).toEqual(
          ['answer', 'finalCode', 'finalLanguage', 'id', 'points', 'position', 'sessionId'].sort(),
        );
        const event = (await client.proctorEvent.create({
          data: {
            sessionId: A.sessionId,
            type: 'TAB_SWITCH',
            severity: 'LOW',
            occurredAt: WHEN,
          } as never,
        })) as Row;
        expect(Object.keys(event)).not.toContain('payload');
        expect(Object.keys(event)).not.toContain('severity');
        expect(Object.keys(event)).not.toContain('source');
        await owner.proctorEvent.delete({ where: { id: event.id as bigint } });
      });
      await owner.session.update({ where: { id: A.sessionId }, data: { lastHeartbeat: null } });
      await owner.sessionQuestion.update({
        where: { id: A.sessionQuestionId },
        data: { finalCode: null },
      });
    });

    it('TC-008 the bare rows of upsert and createManyAndReturn carry the default columns only too', async () => {
      const key = `orgs/${A.orgId}/sessions/${A.sessionId}/media/SCREEN/000000/00000000.webm`;
      const id = await chunkId(A);
      await asCandidate(A, async () => {
        const upserted = (await client.mediaChunk.upsert({
          where: { sessionId_stream_seq: { sessionId: A.sessionId, stream: 'SCREEN', seq: 0 } },
          update: { objectKey: key, sizeBytes: 7n },
          create: {
            sessionId: A.sessionId,
            stream: 'SCREEN',
            seq: 99,
            startedAt: WHEN,
            durationMs: 1,
          },
        })) as Row;
        expect(upserted.id).toBe(id);
        expect(Object.keys(upserted).sort()).toEqual(
          ['id', 'segment', 'seq', 'sessionId', 'sizeBytes', 'stream', 'uploadedAt'].sort(),
        );
        const made = (await client.proctorEvent.createManyAndReturn({
          data: [
            { sessionId: A.sessionId, type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN },
          ] as never,
        })) as Row[];
        expect(made).toHaveLength(1);
        expect(Object.keys(made[0] as Row).sort()).toEqual(
          ['batchSeq', 'createdAt', 'durationMs', 'id', 'occurredAt', 'sessionId', 'type'].sort(),
        );
        await owner.proctorEvent.delete({ where: { id: made[0]?.id as bigint } });
      });
      await owner.mediaChunk.update({ where: { id }, data: { sizeBytes: null } });
    });

    it('TC-008 a grant filters its own model only: under a Session grant the other models answer as they do without one', async () => {
      const reads = (): Promise<unknown[]> =>
        Promise.all([
          client.sessionQuestion.count(),
          client.submission.count(),
          client.mediaChunk.count(),
          client.proctorEvent.count(),
          client.organization.count(),
          client.test.count(),
          client.invitation.count(),
          client.candidate.count(),
          client.question.count(),
          client.testSection.count(),
          client.session.count(),
        ]);
      const plain = await asCandidate(A, reads);
      expect(plain.every((n) => typeof n === 'number' && n >= 1)).toBe(true);
      const granted = await asCandidate(A, () =>
        grant({ model: 'Session', columns: ['hmacKeyEnc'], ids: [A.sessionId] }, reads),
      );
      expect(granted).toEqual(plain);
    });

    it('TC-008 every readable column of every model is real: a select of each reaches Postgres and answers', async () => {
      const readable: Array<[string, string[]]> = [
        [
          'session',
          [
            'id',
            'orgId',
            'status',
            'startedAt',
            'deadlineAt',
            'pauseReasons',
            'pausedMs',
            'proctorPausedAt',
            'submittedAt',
            'authEpoch',
          ],
        ],
        [
          'sessionQuestion',
          ['id', 'sessionId', 'position', 'points', 'finalCode', 'finalLanguage', 'answer'],
        ],
        [
          'sessionSection',
          [
            'sessionId',
            'sectionId',
            'position',
            'timeLimitMs',
            'startedAt',
            'deadlineAt',
            'endedAt',
          ],
        ],
        ['submission', ['id', 'sessionQuestionId', 'kind', 'language', 'createdAt']],
        ['identityCheck', ['id', 'sessionId', 'attempt', 'status', 'createdAt']],
        ['mediaChunk', ['id', 'sessionId', 'stream', 'segment', 'seq', 'sizeBytes', 'uploadedAt']],
        ['proctorEventBatch', ['sessionId', 'seq', 'signature', 'eventCount']],
        [
          'proctorEvent',
          ['id', 'sessionId', 'type', 'occurredAt', 'durationMs', 'batchSeq', 'createdAt'],
        ],
        ['keystrokeBatch', ['sessionId', 'sessionQuestionId', 'seq', 'signature', 'startedAt']],
        ['consent', ['id', 'sessionId', 'consentTextId', 'signedAt', 'declinedAt']],
        ['organization', ['id', 'name', 'retentionDays', 'currentConsentTextId']],
        ['candidate', ['id', 'orgId', 'fullName', 'email']],
        [
          'invitation',
          ['id', 'orgId', 'testId', 'candidateId', 'windowStart', 'windowEnd', 'usedAt'],
        ],
        ['test', ['id', 'orgId', 'name', 'description', 'durationMinutes', 'profile']],
        ['testSection', ['id', 'testId', 'title', 'position', 'timeLimitMin']],
        ['question', ['id', 'orgId', 'type']],
      ];
      await asCandidate(A, async () => {
        for (const [model, columns] of readable) {
          const delegate = (
            client as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>
          )[model];
          for (const column of columns) {
            const rows = (await delegate?.findMany?.({
              select: { [column]: true },
              orderBy: { [column]: 'asc' },
            })) as Row[];
            expect({ model, column, ok: Array.isArray(rows) && rows.length >= 1 }).toEqual({
              model,
              column,
              ok: true,
            });
            expect(typeof (await delegate?.count?.({ select: { [column]: true } }))).toBe('object');
          }
        }
      });
    });

    it('TC-008 until the candidate facts are set every query on every model throws, with no statement (CS-4.4)', async () => {
      await db.statements.reset();
      await orgContext.runAsCandidate(A.orgId, A.sessionId, async () => {
        for (const run of [
          () => client.session.findFirst({ select: { id: true } }),
          () =>
            client.session.update({ where: { id: A.sessionId }, data: { lastHeartbeat: WHEN } }),
          () => client.organization.findFirst({ select: { id: true } }),
          () => client.submission.count(),
          () => client.sessionSection.findMany({}),
          () =>
            grant({ model: 'Session', columns: ['hmacKeyEnc'], ids: [A.sessionId] }, () =>
              client.session.findFirst({ select: { hmacKeyEnc: true } }),
            ),
        ]) {
          await expect(run()).rejects.toThrow(/candidate facts are not set/);
        }
      });
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 FU-DB-199: an update by sessionId_stream_seq writes only the object key of that stream and seq', async () => {
      const id = await chunkId(A);
      const keyFor = (stream: string, seq: number): string =>
        `orgs/${A.orgId}/sessions/${A.sessionId}/media/${stream}/000000/${String(seq).padStart(8, '0')}.webm`;
      await owner.mediaChunk.update({ where: { id }, data: { objectKey: null } });
      await db.statements.reset();
      await asCandidate(A, async () => {
        const where = {
          sessionId_stream_seq: { sessionId: A.sessionId, stream: 'SCREEN' as const, seq: 0 },
        };
        await expect(
          client.mediaChunk.update({
            where,
            data: { objectKey: keyFor('SCREEN', 1) },
            select: { id: true },
          }),
        ).rejects.toThrow(/must be an object key under this session's own prefix/);
        await expect(
          client.mediaChunk.update({
            where,
            data: { objectKey: keyFor('WEBCAM', 0) },
            select: { id: true },
          }),
        ).rejects.toThrow(/must be an object key under this session's own prefix/);
        await expect(
          client.mediaChunk.upsert({
            where,
            update: { objectKey: keyFor('SCREEN', 1) },
            create: {
              sessionId: A.sessionId,
              stream: 'SCREEN',
              seq: 5,
              startedAt: WHEN,
              durationMs: 1,
            },
            select: { id: true },
          }),
        ).rejects.toThrow(/must be an object key under this session's own prefix/);
        expect(await statementCount()).toBe(0);
        expect((await owner.mediaChunk.findUniqueOrThrow({ where: { id } })).objectKey).toBeNull();
        await client.mediaChunk.update({
          where,
          data: { objectKey: keyFor('SCREEN', 0) },
          select: { id: true },
        });
      });
      expect((await owner.mediaChunk.findUniqueOrThrow({ where: { id } })).objectKey).toBe(
        keyFor('SCREEN', 0),
      );
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Review of #185: B1 (plain arguments) and S2 (a select that names nothing)
  // -------------------------------------------------------------------------------------------------
  describe('B1: arguments must be plain: an own __proto__ never drops the omit (review of #185; CLAUDE.md rule 3)', () => {
    const plainMessage = /query arguments must be plain objects/;
    /** A JSON body as a request carries it: `__proto__` is an OWN property of the parsed object. */
    const json = (text: string): never => JSON.parse(text) as never;
    const inProto = (selectBody = '{"id":true}'): string => `"__proto__":{"select":${selectBody}}`;
    const findA = (): never => json(`{"where":{"id":"${A.sessionId}"},${inProto()}}`);

    const staff = <R>(fn: () => Promise<R>): Promise<R> =>
      orgContext.runAsUser({ orgId: T.orgId, userId: T.userId, role: T.userRole }, fn);
    const plainOrg = <R>(fn: () => Promise<R>): Promise<R> => orgContext.runInOrg(T.orgId, fn);
    const system = <R>(fn: () => Promise<R>): Promise<R> =>
      orgContext.runSystem('AUTH_BOOTSTRAP', fn);
    const scopes: Array<[string, <R>(fn: () => Promise<R>) => Promise<R>]> = [
      ['CANDIDATE', (fn) => asCandidate(A, fn)],
      ['SERVICE', (fn) => asService(A, fn)],
      ['STAFF', staff],
      ['plain org', plainOrg],
      ['system', system],
    ];

    it('TC-008 premise: the unextended client answers that input with EVERY column, the sealed key included (the exploit is real; this test names it when Prisma changes)', async () => {
      const row = (await owner.session.findFirst(findA())) as Row;
      expect(Object.keys(row)).toEqual(
        expect.arrayContaining(['id', 'hmacKeyEnc', 'invitationId', 'deviceInfo']),
      );
      expect(row.hmacKeyEnc).toBe(sealed(A));
    });

    it.each(scopes)(
      'TC-008 %s: a findFirst with an own __proto__ select is refused, and no statement is sent',
      async (_name, run) => {
        await db.statements.reset();
        const error = await run(() => failure(client.session.findFirst(findA())));
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toMatch(plainMessage);
        expect(await statementCount()).toBe(0);
      },
    );

    it('TC-008 CANDIDATE: findMany, findFirst, findFirstOrThrow and findUnique with the polluted select, on every model that holds a hidden column, are refused with no statement', async () => {
      const where = (model: string): string =>
        model === 'session' ? `"where":{"id":"${A.sessionId}"},` : '';
      await db.statements.reset();
      await asCandidate(A, async () => {
        for (const model of [
          'session',
          'sessionQuestion',
          'submission',
          'mediaChunk',
          'invitation',
          'test',
          'organization',
          'consent',
          'identityCheck',
          'proctorEvent',
        ] as const) {
          const delegate = (
            client as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>
          )[model];
          for (const operation of ['findMany', 'findFirst', 'findFirstOrThrow']) {
            const error = await failure(
              delegate?.[operation]?.(json(`{${where(model)}${inProto()}}`)) as Promise<unknown>,
            );
            expect({ model, operation, refused: error instanceof OrgScopeViolationError }).toEqual({
              model,
              operation,
              refused: true,
            });
          }
        }
        const error = await failure(
          client.session.findUnique(json(`{"where":{"id":"${A.sessionId}"},${inProto()}}`)),
        );
        expect((error as Error).message).toMatch(plainMessage);
      });
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 CANDIDATE: an update with the polluted select is refused, sends nothing, and the row is as it was', async () => {
      await db.statements.reset();
      const error = await asCandidate(A, () =>
        failure(
          client.session.update(
            json(
              `{"where":{"id":"${A.sessionId}"},"data":{"lastHeartbeat":"2026-10-06T00:00:00.000Z"},${inProto()}}`,
            ),
          ),
        ),
      );
      expect(error).toBeInstanceOf(OrgScopeViolationError);
      expect((error as Error).message).toMatch(plainMessage);
      expect(await statementCount()).toBe(0);
      expect(
        (await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).lastHeartbeat,
      ).toBeNull();
    });

    it('TC-008 CANDIDATE: create, createManyAndReturn, updateManyAndReturn and upsert with the polluted select are refused, and no row appears', async () => {
      await db.statements.reset();
      const row = `{"sessionQuestionId":"${A.sessionQuestionId}","kind":"RUN","language":"cs4-proto","sourceCode":"x"}`;
      await asCandidate(A, async () => {
        for (const make of [
          () => client.submission.create(json(`{"data":${row},${inProto()}}`)),
          () => client.submission.createManyAndReturn(json(`{"data":[${row}],${inProto()}}`)),
          () =>
            client.session.updateManyAndReturn(
              json(
                `{"where":{"id":"${A.sessionId}"},"data":{"lastHeartbeat":"2026-10-06T00:00:00.000Z"},${inProto()}}`,
              ),
            ),
          () =>
            client.mediaChunk.upsert(
              json(
                `{"where":{"id":1},"create":{"stream":"SCREEN","seq":77,"startedAt":"2026-10-06T00:00:00.000Z","durationMs":1},"update":{"durationMs":2},${inProto()}}`,
              ),
            ),
        ]) {
          const error = await failure(make());
          expect(error).toBeInstanceOf(OrgScopeViolationError);
          expect((error as Error).message).toMatch(plainMessage);
        }
      });
      expect(await statementCount()).toBe(0);
      expect(await owner.submission.count({ where: { language: 'cs4-proto' } })).toBe(0);
      expect(
        (await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).lastHeartbeat,
      ).toBeNull();
    });

    it('TC-008 CANDIDATE: the grant reads and the consents create with the polluted select are refused too (the key, the accommodations, the ip and the signed name)', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        const key = await failure(
          grant({ model: 'Session', columns: ['hmacKeyEnc'], ids: [A.sessionId] }, () =>
            client.session.findFirst(findA()),
          ),
        );
        expect(key).toBeInstanceOf(OrgScopeViolationError);
        const consent = await failure(
          grant(
            {
              model: 'Consent',
              columns: ['sessionId', 'consentTextId', 'signedName', 'signedAt', 'ip', 'userAgent'],
              ids: [A.sessionId],
            },
            () =>
              client.consent.create(
                json(
                  `{"data":{"sessionId":"${A.sessionId}","consentTextId":"${T.consentTextId}","signedName":"x","signedAt":"2026-10-06T00:00:00.000Z"},${inProto()}}`,
                ),
              ),
          ),
        );
        expect(consent).toBeInstanceOf(OrgScopeViolationError);
        const accommodations = await failure(
          grant({ model: 'Invitation', columns: ['accommodations'], ids: [A.invitationId] }, () =>
            client.invitation.findFirst(json(`{"where":{"id":"${A.invitationId}"},${inProto()}}`)),
          ),
        );
        expect(accommodations).toBeInstanceOf(OrgScopeViolationError);
      });
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 an own __proto__ nested in a where, a select, an orderBy, a data row, a column value or a createMany row is refused in a candidate scope, with no statement and no change', async () => {
      const own = `"__proto__":{"hmacKeyEnc":"k"}`;
      await db.statements.reset();
      await asCandidate(A, async () => {
        for (const make of [
          () => client.session.findFirst(json(`{"where":{"id":"${A.sessionId}",${own}}}`)),
          () => client.session.count(json(`{"where":{"AND":[{${own}}]}}`)),
          () => client.session.findFirst(json(`{"select":{"id":true,${own}}}`)),
          () =>
            client.session.findMany(json(`{"select":{"id":true},"orderBy":[{"id":"asc",${own}}]}`)),
          () =>
            client.session.update(
              json(
                `{"where":{"id":"${A.sessionId}"},"data":{"lastHeartbeat":"2026-10-06T00:00:00.000Z","__proto__":{"status":"PAUSED"}}}`,
              ),
            ),
          () =>
            client.sessionQuestion.update(
              json(
                `{"where":{"id":"${A.sessionQuestionId}"},"data":{"answer":{"a":1,"__proto__":{"b":2}}}}`,
              ),
            ),
          () =>
            client.proctorEventBatch.createMany(
              json(
                `{"data":[{"sessionId":"${A.sessionId}","seq":91,"signature":"c2ln","eventCount":1,"__proto__":{"eventCount":99}}]}`,
              ),
            ),
        ]) {
          const error = await failure(make());
          expect(error).toBeInstanceOf(OrgScopeViolationError);
          expect((error as Error).message).toMatch(plainMessage);
        }
      });
      expect(await statementCount()).toBe(0);
      expect((await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).status).toBe(
        'INVITED',
      );
      expect(
        await owner.proctorEventBatch.count({ where: { sessionId: A.sessionId, seq: 91 } }),
      ).toBe(0);
    });

    it('TC-008 an inherited key (Object.create) is copied to an own key by Prisma before the hook, so the scope checks refuse it: status is not written, a hidden column is not a filter', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        await expect(
          client.session.update({
            where: { id: A.sessionId },
            data: Object.assign(Object.create({ status: 'PAUSED' }) as object, {
              lastHeartbeat: WHEN,
            }),
            select: { id: true },
          }),
        ).rejects.toThrow(/status cannot be written by a candidate update here/);
        await expect(
          client.session.count({ where: Object.create({ hmacKeyEnc: sealed(A) }) as never }),
        ).rejects.toThrow(/the column hmacKeyEnc is not available/);
        await expect(
          client.session.findFirst(Object.create({ select: { hmacKeyEnc: true } }) as never),
        ).rejects.toThrow(/the column hmacKeyEnc is not available/);
      });
      expect(await statementCount()).toBe(0);
      expect((await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).status).toBe(
        'INVITED',
      );
    });

    it('TC-008 controls: null-prototype arguments and a normal select still work (one statement), and a bare read still carries the omit', async () => {
      await db.statements.reset();
      const viaNullProto = await asCandidate(A, () =>
        client.session.findFirst(
          Object.assign(Object.create(null) as object, {
            where: Object.assign(Object.create(null) as object, { id: A.sessionId }),
            select: Object.assign(Object.create(null) as object, { id: true }),
          }) as never,
        ),
      );
      expect(viaNullProto).toEqual({ id: A.sessionId });
      expect(await statementCount()).toBe(1);
      const bare = (await asCandidate(A, () =>
        client.session.findFirst({ where: { id: A.sessionId } }),
      )) as Row;
      expect(Object.keys(bare)).not.toContain('hmacKeyEnc');
    });
  });

  describe('S2: a select that names nothing is refused in a candidate scope (review of #185)', () => {
    const empty = /a select must name at least one column with true/;
    const shapes: Array<[string, Record<string, unknown>]> = [
      ['select: {}', {}],
      ['select: { id: false }', { id: false }],
      ['select: { id: undefined }', { id: undefined }],
      ['select: { id: false, status: false }', { id: false, status: false }],
      ['select: { id: undefined, status: undefined }', { id: undefined, status: undefined }],
    ];

    it.each(shapes)(
      'TC-008 %s: refused by findFirst, findMany, findUnique, update, updateManyAndReturn, create and count, with no statement, so no hidden column can come back',
      async (_label, select) => {
        await db.statements.reset();
        await asCandidate(A, async () => {
          const calls: Array<() => Promise<unknown>> = [
            () => client.session.findFirst({ where: { id: A.sessionId }, select }),
            () => client.session.findMany({ select }),
            () => client.session.findUnique({ where: { id: A.sessionId }, select }),
            () =>
              client.session.update({
                where: { id: A.sessionId },
                data: { lastHeartbeat: WHEN },
                select,
              }),
            () =>
              client.session.updateManyAndReturn({
                where: { id: A.sessionId },
                data: { lastHeartbeat: WHEN },
                select,
              }),
            () =>
              client.submission.create({
                data: {
                  sessionQuestionId: A.sessionQuestionId,
                  kind: 'RUN',
                  language: 'cs4-empty',
                  sourceCode: 'x',
                },
                select,
              } as never),
            () => client.session.count({ select } as never),
          ];
          for (const call of calls) {
            const error = await failure(call());
            expect(error).toBeInstanceOf(OrgScopeViolationError);
            expect((error as Error).message).toMatch(empty);
          }
        });
        expect(await statementCount()).toBe(0);
        expect(await owner.submission.count({ where: { language: 'cs4-empty' } })).toBe(0);
        expect(
          (await owner.session.findUniqueOrThrow({ where: { id: A.sessionId } })).lastHeartbeat,
        ).toBeNull();
      },
    );

    it('TC-008 a select value that is not a boolean is refused, and one true next to false and undefined is a select', async () => {
      await asCandidate(A, async () => {
        for (const value of [1, 'id', null, {}, [], 0]) {
          await expect(
            client.session.findFirst({ select: { id: true, status: value } as never }),
          ).rejects.toThrow(/takes true or false for a scalar column/);
        }
        const row = await client.session.findFirst({
          where: { id: A.sessionId },
          select: { id: true, status: false, authEpoch: undefined },
        });
        expect(row).toEqual({ id: A.sessionId });
      });
    });

    it('TC-008 a hidden column named false in a select is still refused by name (PR 1 rule)', async () => {
      await asCandidate(A, async () => {
        await expect(
          client.session.findFirst({ select: { id: true, hmacKeyEnc: false } }),
        ).rejects.toThrow(/the column hmacKeyEnc is not available/);
      });
    });

    it('TC-008 the rule is a CANDIDATE rule: a plain org scope is not refused by it (Prisma answers)', async () => {
      const error = await orgContext.runInOrg(T.orgId, () =>
        failure(client.session.findFirst({ select: { id: false } })),
      );
      expect(error).not.toBeInstanceOf(OrgScopeViolationError);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Re-review of #185, S1: the operand of a Json filter is a value
  // -------------------------------------------------------------------------------------------------
  describe('S1 (re-review): a compare-and-set on a stored Json document with a nested own __proto__, or nested deep, is not refused (FR-704, NFR-05)', () => {
    const plainMessage = /query arguments must be plain objects/;
    const json = (text: string): never => JSON.parse(text) as never;
    /**
     * A document with own `__proto__` keys at depth 3 and in an array. Prisma strips them on a write, so it gets
     * into the table by raw SQL only (a migration, a support session); Prisma returns them on a read.
     */
    const NESTED_PROTO =
      '{"extraTimePct":25,"notes":{"a":{"b":{"__proto__":{"x":1},"c":[{"__proto__":{"y":2}}]}}}}';
    const deepText = (levels: number): string =>
      '{"next":'.repeat(levels) + '{"leaf":true}' + '}'.repeat(levels);
    const staff = <R>(fn: () => Promise<R>): Promise<R> =>
      orgContext.runAsUser({ orgId: T.orgId, userId: T.userId, role: T.userRole }, fn);
    const ORIGINAL = { extraTimePct: 25, who: 'a' };

    type Target = 'invitations' | 'organizations' | 'sessions';
    const COLUMN = {
      invitations: 'accommodations',
      organizations: 'settings',
      sessions: 'device_info',
    } as const;
    /** Stores `text` as the column's jsonb through raw SQL, exactly as given (own __proto__ keys intact). */
    const storeRaw = (table: Target, id: string, text: string): Promise<number> =>
      owner.$executeRawUnsafe(
        `UPDATE "${table}" SET "${COLUMN[table]}" = $1::jsonb WHERE id = $2::uuid`,
        text,
        id,
      );
    const storedText = async (table: Target, id: string): Promise<string> => {
      const rows = await owner.$queryRawUnsafe<Array<{ t: string }>>(
        `SELECT "${COLUMN[table]}"::text AS t FROM "${table}" WHERE id = $1::uuid`,
        id,
      );
      return rows[0]?.t ?? '';
    };

    afterEach(async () => {
      await owner.invitation.update({
        where: { id: A.invitationId },
        data: { accommodations: ORIGINAL },
      });
      await owner.organization.update({
        where: { id: T.orgId },
        data: { settings: { org: T.label } },
      });
      await owner.session.update({
        where: { id: A.sessionId },
        data: { deviceInfo: { who: 'a', systemCheck: { ok: true } } },
      });
    });

    it('TC-008 precondition: raw SQL stores the own __proto__ keys, Prisma returns them, and Prisma strips them from a write', async () => {
      await storeRaw('invitations', A.invitationId, NESTED_PROTO);
      expect(await storedText('invitations', A.invitationId)).toContain('"__proto__"');
      const read = await owner.invitation.findUniqueOrThrow({ where: { id: A.invitationId } });
      const b = (read.accommodations as { notes: { a: { b: object } } }).notes.a.b;
      expect(Object.hasOwn(b, '__proto__')).toBe(true);
      // A write through Prisma drops them: a stored document with one never comes from the app.
      await owner.invitation.update({
        where: { id: A.invitationId },
        data: { accommodations: JSON.parse(NESTED_PROTO) as never },
      });
      expect(await storedText('invitations', A.invitationId)).not.toContain('"__proto__"');
    });

    it('TC-008 staff scope, the retention shape, a stored document with own __proto__ keys: the compare-and-set is NOT refused, reaches Postgres once, and answers as the unextended client does (Prisma drops the keys from the operand, so it matches nothing: count 0 on both)', async () => {
      await storeRaw('invitations', A.invitationId, NESTED_PROTO);
      const stored = (
        await staff(() =>
          client.invitation.findUniqueOrThrow({
            where: { id: A.invitationId },
            select: { accommodations: true },
          }),
        )
      ).accommodations as never;
      const cas = (run: typeof staff, where: Row) =>
        run(() =>
          client.invitation.updateMany({
            where: where,
            data: { accommodations: { rewritten: true } },
          }),
        );
      await db.statements.reset();
      const viaScope = await cas(staff, { id: A.invitationId, accommodations: { equals: stored } });
      expect(await statementCount()).toBe(1);
      const viaOwner = await owner.invitation.updateMany({
        where: { id: A.invitationId, accommodations: { equals: stored } },
        data: { accommodations: { rewritten: true } },
      });
      expect(viaScope).toEqual(viaOwner);
      expect(viaScope).toEqual({ count: 0 });
      // The row is as it was.
      expect(await storedText('invitations', A.invitationId)).toContain('"__proto__"');
    });

    it.each([100, 500])(
      'TC-008 staff scope, the retention shape, a stored document %s levels deep (past the structure limit of 64): the compare-and-set matches and rewrites the row (count 1, one statement)',
      async (levels) => {
        await owner.invitation.update({
          where: { id: A.invitationId },
          data: { accommodations: JSON.parse(deepText(levels)) as never },
        });
        const read = await staff(() =>
          client.invitation.findUniqueOrThrow({
            where: { id: A.invitationId },
            select: { accommodations: true },
          }),
        );
        await db.statements.reset();
        const won = await staff(() =>
          client.invitation.updateMany({
            where: { id: A.invitationId, accommodations: { equals: read.accommodations as never } },
            data: { accommodations: { rewritten: true } },
          }),
        );
        expect(won).toEqual({ count: 1 });
        expect(await statementCount()).toBe(1);
        expect(
          (await owner.invitation.findUniqueOrThrow({ where: { id: A.invitationId } }))
            .accommodations,
        ).toEqual({ rewritten: true });
      },
    );

    it('TC-008 staff scope, the org settings shape: organizations.settings equals the stored document, 100 levels deep (count 1) and with own __proto__ keys (not refused)', async () => {
      await owner.organization.update({
        where: { id: T.orgId },
        data: { settings: JSON.parse(deepText(100)) as never },
      });
      const deepDoc = (
        await staff(() =>
          client.organization.findUniqueOrThrow({
            where: { id: T.orgId },
            select: { settings: true },
          }),
        )
      ).settings as never;
      expect(
        await staff(() =>
          client.organization.updateMany({
            where: { id: T.orgId, settings: { equals: deepDoc } },
            data: { settings: { org: T.label } },
          }),
        ),
      ).toEqual({ count: 1 });
      await storeRaw('organizations', T.orgId, NESTED_PROTO);
      const protoDoc = JSON.parse(NESTED_PROTO) as never;
      const error = await staff(() =>
        failure(
          client.organization.updateMany({
            where: { id: T.orgId, settings: { equals: protoDoc } },
            data: { settings: { org: T.label } },
          }),
        ),
      );
      expect(error).not.toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 every value operator takes a stored document without a refusal: equals, not, in, notIn, array_contains, array_starts_with, array_ends_with, string_contains, string_starts_with and string_ends_with, deep and with own __proto__ keys', async () => {
      const operands = [JSON.parse(NESTED_PROTO) as never, JSON.parse(deepText(100)) as never];
      await staff(async () => {
        for (const operand of operands) {
          for (const operator of [
            'equals',
            'not',
            'in',
            'notIn',
            'array_contains',
            'array_starts_with',
            'array_ends_with',
            'string_contains',
            'string_starts_with',
            'string_ends_with',
          ]) {
            // Prisma may answer or reject the operator for this document (that is its business); the scope must not.
            const error = await failure(
              client.invitation.count({
                where: { id: A.invitationId, accommodations: { [operator]: operand } as never },
              }),
            );
            expect({ operator, refusedByScope: error instanceof OrgScopeViolationError }).toEqual({
              operator,
              refusedByScope: false,
            });
          }
        }
      });
    });

    it('TC-008 candidate scope, the DeviceInfoService fence: a stored deviceInfo 100 levels deep, or holding a field-reference look-alike (also under a path 33 levels down), is compared and rewritten (count 1, one statement)', async () => {
      const device: GrantRequest = {
        model: 'Session',
        columns: ['deviceInfo'],
        ids: [A.sessionId],
      };
      for (const text of [
        deepText(100),
        '{"capabilities":[{"modelName":"Session","name":"deviceInfo","typeName":"Json","isList":false}],"x":{"modelName":"S","name":"n","typeName":"Json","isList":true}}',
      ]) {
        await owner.session.update({
          where: { id: A.sessionId },
          data: { deviceInfo: JSON.parse(text) as never },
        });
        const read = (await asCandidate(A, () =>
          grant(device, () =>
            client.session.findUniqueOrThrow({
              where: { id: A.sessionId },
              select: { deviceInfo: true },
            }),
          ),
        )) as { deviceInfo: never };
        await db.statements.reset();
        const written = await asCandidate(A, () =>
          grant(device, () =>
            client.session.updateMany({
              where: { id: A.sessionId, deviceInfo: { equals: read.deviceInfo } },
              data: { deviceInfo: { merged: true } },
            }),
          ),
        );
        expect(written).toEqual({ count: 1 });
        expect(await statementCount()).toBe(1);
      }
      // With own __proto__ keys in the document: not refused (Prisma then matches nothing).
      await storeRaw('sessions', A.sessionId, NESTED_PROTO);
      const error = await asCandidate(A, () =>
        grant(device, () =>
          failure(
            client.session.updateMany({
              where: { id: A.sessionId, deviceInfo: { equals: JSON.parse(NESTED_PROTO) as never } },
              data: { deviceInfo: { merged: true } },
            }),
          ),
        ),
      );
      expect(error).not.toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 a polluted where is still refused with the same document in it, in the staff and job scopes, and nothing is sent: the wrapper, the filter object, an AND and the top-level args', async () => {
      await storeRaw('invitations', A.invitationId, NESTED_PROTO);
      const doc = NESTED_PROTO;
      await db.statements.reset();
      for (const make of [
        // the where object itself carries an own __proto__
        () =>
          client.invitation.updateMany(
            json(
              `{"where":{"id":"${A.invitationId}","accommodations":{"equals":${doc}},"__proto__":{"a":1}},"data":{"accommodations":{"x":1}}}`,
            ),
          ),
        // the Json filter object carries one (only its operand is a value)
        () =>
          client.invitation.updateMany(
            json(
              `{"where":{"id":"${A.invitationId}","accommodations":{"equals":${doc},"__proto__":{"a":1}}},"data":{"accommodations":{"x":1}}}`,
            ),
          ),
        // an AND next to the Json filter
        () =>
          client.invitation.updateMany(
            json(
              `{"where":{"AND":[{"accommodations":{"equals":${doc}}},{"__proto__":{"a":1}}]},"data":{"accommodations":{"x":1}}}`,
            ),
          ),
        // the top-level args
        () =>
          client.invitation.updateMany(
            json(
              `{"where":{"id":"${A.invitationId}","accommodations":{"equals":${doc}}},"data":{"accommodations":{"x":1}},"__proto__":{"select":{"id":true}}}`,
            ),
          ),
      ]) {
        for (const run of [staff, (fn: () => Promise<unknown>) => asService(A, fn)]) {
          const error = await run(() => failure(make()));
          expect(error).toBeInstanceOf(OrgScopeViolationError);
          expect((error as Error).message).toMatch(plainMessage);
        }
      }
      expect(await statementCount()).toBe(0);
      expect(await storedText('invitations', A.invitationId)).toContain('"__proto__"');
    });
  });
});
