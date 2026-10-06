// ADR 0013 CS-4 (PR 1: the core actors and the session scope) against a real Postgres 16 started by
// Testcontainers, with the real migrations applied by `prisma migrate deploy`. The code under test
// connects as app_user through the real client factory, so the real grants are in force. Fixtures
// and checks use the owner role.
//
// Three candidates (synthetic): A and B in one org, each with a whole chain of its own (candidate,
// invitation, test with section and question, session with questions, submission, consent, identity
// check, media chunk, event batch, event and keystroke batch), and O in another org. What is
// covered, as candidate A (runAsCandidate) and as the session job of A (runAsSessionJob):
//   - cross-candidate: every model a candidate may reach returns only A's rows; B's and O's rows are
//     not found by any read operation, and every write against B's rows is refused or changes nothing
//     (the rows are compared before and after). Positive controls prove A reads and writes its own.
//   - one test per CS-4.3 row, the relation vectors 1 to 5 and the fluent API, creates (stamped
//     session, one scoped existence check on session_questions), immutable session keys, raw SQL, and
//     the SERVICE actor.
//   - review fixes: S1 (keys behind the filters), S2 (wrong facts only narrow), S3 (the interim column
//     control and the proctor_events source filter), S7 (same-tick findUnique of two candidates).
//   - statement counts (pg_stat_statements): entering a scope sends no SQL.
// A CANDIDATE call that returns rows names its select (candidate-interim.ts), so every candidate read
// and write here does. The pure rules are in session-scope-args.spec.ts, candidate-interim.spec.ts and
// org-context-session.spec.ts. NFR-04, TC-008.
import { randomUUID } from 'node:crypto';
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import { OrgScopeError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import { OrgContextService } from './org-context';
import type { CandidateFacts } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { CANDIDATE_INTERIM_DENY } from './candidate-interim';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createCandidateChain, createTenant } from './testing/tenant-fixtures';
import type {
  ChainModel,
  RowSelector,
  SessionChain,
  TenantFixture,
} from './testing/tenant-fixtures';

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;
type Row = Record<string, unknown>;

const CHAIN_MODELS: readonly ChainModel[] = [
  'Organization',
  'Candidate',
  'Invitation',
  'Test',
  'TestSection',
  'Question',
  'Session',
  'SessionQuestion',
  'SessionSection',
  'IdentityCheck',
  'MediaChunk',
  'ProctorEventBatch',
  'ProctorEvent',
  'KeystrokeBatch',
  'Consent',
  'Submission',
];
const SESSION_MODELS = CHAIN_MODELS.slice(6) as readonly ChainModel[];
// Organization has its own test (A and B share it); the other five are filtered per candidate.
const READ_ONLY_MODELS = CHAIN_MODELS.slice(0, 6) as readonly ChainModel[];
const FILTERED_READ_ONLY_MODELS = READ_ONLY_MODELS.filter((m) => m !== 'Organization');
const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

const WHEN = new Date('2026-10-06T00:00:00.000Z');
/**
 * One harmless change per session-path model, a column a candidate may write. Dates are fixed so
 * results are stable.
 */
const TOUCH: Record<string, Row> = {
  Session: { lastHeartbeat: WHEN },
  SessionQuestion: { finalCode: 'print(1)' },
  SessionSection: { startedAt: WHEN },
  IdentityCheck: { livenessPassed: true },
  MediaChunk: { durationMs: 5 },
  ProctorEventBatch: { eventCount: 2 },
  ProctorEvent: { durationMs: 1 },
  KeystrokeBatch: { startedAt: WHEN },
  Consent: { userAgent: 'changed' },
  Submission: { language: 'java' },
};

const text = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

describe('ADR 0013 CS-4: candidate and session-job scopes against Postgres (NFR-04, TC-008)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let base: PrismaClient;
  let client: ReturnType<typeof createOrgScopedClient>;
  const orgContext = new OrgContextService();
  /** Org 1, candidate A (the tenant's own chain). */
  let T: TenantFixture;
  let A: SessionChain;
  /** Org 1, candidate B. */
  let B: SessionChain;
  /** Org 2, candidate O. */
  let O: SessionChain;
  /** Org 1, candidate C, who sits the SAME test as A (nit 6): the test filters cannot tell A from C. */
  let C: SessionChain;
  let orphanQuestionId: string;
  let orphanSectionId: string;

  const factsOf = (chain: SessionChain): CandidateFacts => ({
    candidateId: chain.candidateId,
    invitationId: chain.invitationId,
    testId: chain.testId,
  });

  /** A candidate scope as the guard builds it: facts first, then everything else. */
  const asCandidate = <T2>(chain: SessionChain, fn: () => Promise<T2>): Promise<T2> =>
    orgContext.runAsCandidate(chain.orgId, chain.sessionId, async () => {
      setCandidateFacts(orgContext, factsOf(chain));
      return fn();
    });
  /** A candidate scope whose guard set `facts` (which can be wrong). */
  const asCandidateWith = <T2>(
    chain: SessionChain,
    facts: CandidateFacts,
    fn: () => Promise<T2>,
  ): Promise<T2> =>
    orgContext.runAsCandidate(chain.orgId, chain.sessionId, async () => {
      setCandidateFacts(orgContext, facts);
      return fn();
    });
  const asService = <T2>(chain: SessionChain, fn: () => Promise<T2>): Promise<T2> =>
    orgContext.runAsSessionJob(chain.orgId, chain.sessionId, fn);

  /** The two actors, so a rule that holds for both is written once. */
  const ACTORS = [
    ['CANDIDATE', asCandidate],
    ['SERVICE', asService],
  ] as const;
  /**
   * CS-4.4 grants a candidate an UPDATE on these (session_questions: three columns; consents: five;
   * media_chunks; proctor_events: durationMs; sessions: lastHeartbeat). The other session models are
   * create only (submissions, identity_checks, the two batch tables) or take no write at all
   * (session_sections), so only the job updates their rows.
   */
  const CANDIDATE_UPDATES: readonly ChainModel[] = [
    'Session',
    'SessionQuestion',
    'MediaChunk',
    'ProctorEvent',
    'Consent',
  ];
  const NO_CANDIDATE_UPDATE = SESSION_MODELS.filter((m) => !CANDIDATE_UPDATES.includes(m));
  const writersOf = (model: ChainModel) =>
    ACTORS.filter(([actor]) => actor === 'SERVICE' || CANDIDATE_UPDATES.includes(model));
  // consents are written once (B3): a candidate update reaches no row, so "it changes its own row" is
  // for the job there, and the write-once test below shows the candidate's 0 rows.
  const ownWritersOf = (model: ChainModel) =>
    ACTORS.filter(
      ([actor]) =>
        actor === 'SERVICE' || (CANDIDATE_UPDATES.includes(model) && model !== 'Consent'),
    );

  const scoped = (model: string): Delegate =>
    (client as unknown as Record<string, Delegate>)[lowerFirst(model)] as Delegate;
  const plain = (model: string): Delegate =>
    (owner as unknown as Record<string, Delegate>)[lowerFirst(model)] as Delegate;

  /** The select a candidate call names: the columns of the row's own key, so the rows can be told apart. */
  const S = (model: ChainModel): { select: Record<string, true> } => ({
    select: Object.fromEntries(Object.keys(A.rows[model].filter).map((key) => [key, true])),
  });
  const ID = { select: { id: true as const } };

  /** Every row of every model a CS-4 scope can reach, as text, so a test can prove nothing changed. */
  async function snapshot(): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const model of CHAIN_MODELS) {
      result[model] = ((await plain(model).findMany?.({})) as unknown[]).map(text).sort();
    }
    return result;
  }

  /** True when `row` has every key of `filter` with an equal value. */
  const matches = (row: Row, filter: Row): boolean =>
    Object.entries(filter).every(([key, value]) => row[key] === value);

  const statementCount = async (): Promise<number> =>
    (await db.statements.read()).reduce((sum, s) => sum + s.calls, 0);

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    T = await createTenant(owner, 'a');
    A = T.chain;
    B = await createCandidateChain(owner, T, 'b');
    O = (await createTenant(owner, 'o')).chain;
    C = await createCandidateChain(owner, T, 'c', { shareTestWith: A });
    // Rows of org 1 that no session of the candidate reaches: a question no session uses, and a
    // section of A's test that has no session_sections row (it has not been opened).
    const orphan = await owner.question.create({ data: { orgId: T.orgId, slug: 'q-orphan' } });
    orphanQuestionId = orphan.id;
    await owner.questionVersion.create({
      data: {
        questionId: orphan.id,
        version: 1,
        title: 'Unused',
        statementMd: 'Unused.',
        difficulty: 'EASY',
        allowedLanguages: ['python'],
      },
    });
    const section = await owner.testSection.create({
      data: { testId: A.testId, title: 'Not opened', position: 1 },
    });
    orphanSectionId = section.id;
    base = createPrismaClient(db.appUserUrl);
    client = createOrgScopedClient(base, orgContext);
  });

  afterAll(async () => {
    await base?.$disconnect();
    await owner?.$disconnect();
    await db?.stop();
  });

  describe('the fixtures are what the tests assume', () => {
    it('TC-008 two candidates in one org share nothing but the org, and a third sits in another org', () => {
      expect(A.orgId).toBe(B.orgId);
      expect(O.orgId).not.toBe(A.orgId);
      for (const key of [
        'candidateId',
        'invitationId',
        'testId',
        'sectionId',
        'questionId',
        'sessionId',
        'sessionQuestionId',
      ] as const) {
        expect(new Set([A[key], B[key], O[key]]).size).toBe(3);
      }
    });
  });

  describe.each(SESSION_MODELS)('%s (a session-path model)', (model) => {
    const d = (): Delegate => scoped(model);

    it.each(ACTORS)(
      "TC-008 %s: reads only its own session's rows; B's and another org's rows are not found by any read operation",
      async (_actor, run) => {
        const own = A.rows[model];
        const sel = S(model);
        await run(A, async () => {
          const rows = (await d().findMany?.({ ...sel })) as Row[];
          expect(rows).toHaveLength(1);
          expect(matches(rows[0] as Row, own.filter)).toBe(true);
          expect(await d().count?.({})).toBe(1);
          expect(await d().aggregate?.({ _count: true })).toEqual({ _count: 1 });
          expect(
            (await d().groupBy?.({ by: [Object.keys(own.filter)[0]], _count: true })) as unknown[],
          ).toHaveLength(1);
          // Positive controls: A's own row is found by each read operation.
          expect(await d().findFirst?.({ where: own.filter, ...sel })).not.toBeNull();
          expect(await d().findFirstOrThrow?.({ where: own.filter, ...sel })).toBeDefined();
          expect(await d().findUnique?.({ where: own.unique, ...sel })).not.toBeNull();
          expect(await d().findUniqueOrThrow?.({ where: own.unique, ...sel })).toBeDefined();
          expect(await d().count?.({ where: own.filter })).toBe(1);

          for (const other of [B, O]) {
            const theirs: RowSelector = other.rows[model];
            const by = Object.keys(theirs.filter)[0] as string;
            expect(await d().findMany?.({ where: theirs.filter, ...sel })).toEqual([]);
            expect(await d().findFirst?.({ where: theirs.filter, ...sel })).toBeNull();
            await expect(
              d().findFirstOrThrow?.({ where: theirs.filter, ...sel }),
            ).rejects.toMatchObject({ code: 'P2025' });
            expect(await d().findUnique?.({ where: theirs.unique, ...sel })).toBeNull();
            await expect(
              d().findUniqueOrThrow?.({ where: theirs.unique, ...sel }),
            ).rejects.toMatchObject({ code: 'P2025' });
            expect(await d().count?.({ where: theirs.filter })).toBe(0);
            expect(await d().aggregate?.({ where: theirs.filter, _count: true })).toEqual({
              _count: 0,
            });
            expect(await d().groupBy?.({ by: [by], where: theirs.filter, _count: true })).toEqual(
              [],
            );
          }
        });
      },
    );

    it.each(writersOf(model))(
      "TC-008 %s: every write against B's and another org's row is refused or changes nothing",
      async (actor, run) => {
        const before = await snapshot();
        const touch = TOUCH[model] as Row;
        const sel = S(model);
        await run(A, async () => {
          for (const other of [B, O]) {
            const theirs = other.rows[model];
            expect(await d().updateMany?.({ where: theirs.filter, data: touch })).toEqual({
              count: 0,
            });
            expect(
              await d().updateManyAndReturn?.({ where: theirs.filter, data: touch, ...sel }),
            ).toEqual([]);
            await expect(
              d().update?.({ where: theirs.unique, data: touch, ...sel }),
            ).rejects.toMatchObject({ code: 'P2025' });
            if (actor === 'SERVICE') {
              expect(await d().deleteMany?.({ where: theirs.filter })).toEqual({ count: 0 });
              await expect(d().delete?.({ where: theirs.unique, ...sel })).rejects.toMatchObject({
                code: 'P2025',
              });
            } else {
              // A candidate deletes nothing (stricter reading of CS-4.4, FU-DB-184).
              await expect(d().deleteMany?.({ where: theirs.filter })).rejects.toThrow(
                /a candidate deletes nothing/,
              );
              await expect(d().delete?.({ where: theirs.unique, ...sel })).rejects.toThrow(
                /a candidate deletes nothing/,
              );
            }
          }
        });
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each(ownWritersOf(model))(
      '%s: it changes its own row, and only its own (TC-008)',
      async (_actor, run) => {
        const own = A.rows[model];
        const touch = TOUCH[model] as Row;
        const original = (await plain(model).findFirst?.({ where: own.filter })) as Row;
        const before = await snapshot();
        await run(A, async () => {
          expect(await d().updateMany?.({ where: own.filter, data: touch })).toEqual({ count: 1 });
        });
        const after = await snapshot();
        // Exactly one row of this model differs from before: A's. No other model changed.
        expect(after[model]?.filter((row) => !before[model]?.includes(row))).toHaveLength(1);
        expect(before[model]?.filter((row) => !after[model]?.includes(row))).toHaveLength(1);
        for (const other of CHAIN_MODELS.filter((m) => m !== model)) {
          expect(after[other]).toEqual(before[other]);
        }
        const now = (await plain(model).findFirst?.({ where: own.filter })) as Row;
        expect(Object.fromEntries(Object.keys(touch).map((k) => [k, now[k]]))).toEqual(touch);
        // Put the fixture back, so the next test starts from it again.
        await plain(model).updateMany?.({
          where: own.filter,
          data: Object.fromEntries(Object.keys(touch).map((k) => [k, original[k]])),
        });
        expect(await snapshot()).toEqual(before);
      },
    );
  });

  describe.each(NO_CANDIDATE_UPDATE)(
    '%s: a candidate cannot update the row (create only, or no write)',
    (model) => {
      it("TC-008 every update operation is refused for B's row and for its own, and nothing changes", async () => {
        const before = await snapshot();
        const touch = TOUCH[model] as Row;
        const sel = S(model);
        await asCandidate(A, async () => {
          for (const chain of [A, B, O]) {
            const row = chain.rows[model];
            const refused = /cannot update this row|writes nothing here/;
            await expect(
              scoped(model).update?.({ where: row.unique, data: touch, ...sel }),
            ).rejects.toThrow(refused);
            await expect(
              scoped(model).updateMany?.({ where: row.filter, data: touch }),
            ).rejects.toThrow(refused);
            await expect(
              scoped(model).updateManyAndReturn?.({ where: row.filter, data: touch, ...sel }),
            ).rejects.toThrow(refused);
            await expect(
              scoped(model).upsert?.({ where: row.unique, update: touch, create: {}, ...sel }),
            ).rejects.toThrow(/cannot (create|update) this row|writes nothing here/);
          }
        });
        expect(await snapshot()).toEqual(before);
      });
    },
  );

  describe('CS-4.3: the six read-only models', () => {
    it.each(FILTERED_READ_ONLY_MODELS)(
      "TC-008 %s: A reads its own row and never B's or another org's",
      async (model) => {
        const own = A.rows[model];
        const sel = S(model);
        await asCandidate(A, async () => {
          const rows = (await scoped(model).findMany?.({ ...sel })) as Row[];
          expect(rows).toHaveLength(1);
          expect(matches(rows[0] as Row, own.filter)).toBe(true);
          for (const other of [B, O]) {
            expect(
              await scoped(model).findFirst?.({ where: other.rows[model].filter, ...sel }),
            ).toBeNull();
            expect(
              await scoped(model).findUnique?.({ where: other.rows[model].unique, ...sel }),
            ).toBeNull();
            expect(await scoped(model).count?.({ where: other.rows[model].filter })).toBe(0);
          }
        });
      },
    );

    it.each(READ_ONLY_MODELS)(
      'TC-008 %s: every write operation is refused, and nothing changes',
      async (model) => {
        const before = await snapshot();
        const own = A.rows[model];
        await asCandidate(A, async () => {
          for (const operation of [
            'create',
            'createMany',
            'createManyAndReturn',
            'update',
            'updateMany',
            'updateManyAndReturn',
            'upsert',
            'delete',
            'deleteMany',
          ]) {
            await expect(
              scoped(model)[operation]?.({
                where: own.unique,
                data: {},
                create: {},
                update: {},
                ...ID,
              }),
            ).rejects.toThrow(/read-only in a CANDIDATE scope/);
          }
        });
        expect(await snapshot()).toEqual(before);
      },
    );

    it('TC-008 organizations: id = ctx.orgId (A and B see their org, never the other one)', async () => {
      for (const chain of [A, B]) {
        await asCandidate(chain, async () => {
          const rows = (await scoped('Organization').findMany?.({ ...ID })) as Row[];
          expect(rows.map((r) => r.id)).toEqual([T.orgId]);
          expect(
            await scoped('Organization').findUnique?.({ where: { id: O.orgId }, ...ID }),
          ).toBeNull();
          expect(await scoped('Organization').count?.({ where: { id: O.orgId } })).toBe(0);
        });
      }
    });

    it('TC-008 candidates: id = ctx.candidateId (the other candidate of the org is not there)', async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Candidate').findMany?.({ ...ID })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.candidateId]);
        expect(
          await scoped('Candidate').findUnique?.({ where: { id: B.candidateId }, ...ID }),
        ).toBeNull();
        expect(
          await scoped('Candidate').findFirst?.({
            where: { email: { contains: 'candidate-b' } },
            ...ID,
          }),
        ).toBeNull();
      });
      await asCandidate(B, async () => {
        const rows = (await scoped('Candidate').findMany?.({ ...ID })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([B.candidateId]);
      });
      // The owner sees both candidates of the org and the other org's: the filter did the work.
      expect(await owner.candidate.count()).toBe(4); // A, B and C in the org, O in the other
    });

    it('TC-008 invitations: id = ctx.invitationId (accommodations of the other candidate are not reachable)', async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Invitation').findMany?.({ ...ID })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.invitationId]);
        expect(
          await scoped('Invitation').findUnique?.({ where: { id: B.invitationId }, ...ID }),
        ).toBeNull();
        expect(await scoped('Invitation').count?.({ where: { candidateId: B.candidateId } })).toBe(
          0,
        );
      });
      expect(await owner.invitation.count()).toBe(4);
    });

    it("TC-008 tests: id = ctx.testId (the other candidate's test is not there)", async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Test').findMany?.({ ...ID })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.testId]);
        expect(await scoped('Test').findUnique?.({ where: { id: B.testId }, ...ID })).toBeNull();
      });
      expect(await owner.test.count()).toBe(3);
    });

    it('TC-008 test_sections: only the sections of this session (an unopened section of the same test is not)', async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('TestSection').findMany?.({
          ...ID,
          orderBy: { position: 'asc' },
        })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.sectionId]);
        expect(
          await scoped('TestSection').findUnique?.({ where: { id: orphanSectionId }, ...ID }),
        ).toBeNull();
        expect(
          await scoped('TestSection').findUnique?.({ where: { id: B.sectionId }, ...ID }),
        ).toBeNull();
        expect(await scoped('TestSection').count?.({ where: { testId: A.testId } })).toBe(1);
      });
      expect(await owner.testSection.count({ where: { testId: A.testId } })).toBe(2);
    });

    it("TC-008 questions: only the questions of this session's question versions (an unused question is not)", async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Question').findMany?.({ ...ID })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.questionId]);
        expect(
          await scoped('Question').findUnique?.({ where: { id: orphanQuestionId }, ...ID }),
        ).toBeNull();
        expect(
          await scoped('Question').findUnique?.({ where: { id: B.questionId }, ...ID }),
        ).toBeNull();
      });
      await asCandidate(B, async () => {
        const rows = (await scoped('Question').findMany?.({ ...ID })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([B.questionId]);
      });
      expect(await owner.question.count({ where: { orgId: T.orgId } })).toBe(3);
    });

    it.each(['ConsentText', 'TestQuestion'] as const)(
      'TC-008 %s: readable only under a grant, and grants are PR 2, so it throws in a CANDIDATE scope',
      async (model) => {
        await asCandidate(A, async () => {
          await expect(scoped(model).findMany?.({ ...ID })).rejects.toThrow(
            /readable only under a grant/,
          );
          await expect(
            scoped(model).findUnique?.({ where: { id: T.consentTextId }, ...ID }),
          ).rejects.toThrow(/readable only under a grant/);
        });
        // (The same rows are readable for a session job: no allowlist.)
        await asService(A, async () => {
          expect(((await scoped(model).findMany?.({})) as unknown[]).length).toBeGreaterThan(0);
        });
      },
    );

    it("TC-008 the candidate facts are per scope: A's facts never leak into B's scope, and concurrent scopes stay apart", async () => {
      const read = (chain: SessionChain, delay: number): Promise<string[]> =>
        asCandidate(chain, async () => {
          const seen: string[] = [];
          for (let i = 0; i < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            const rows = (await scoped('Candidate').findMany?.({ ...ID })) as Row[];
            seen.push(...rows.map((r) => r.id as string));
          }
          return seen;
        });
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          i % 2 === 0 ? read(A, 1 + (i % 3)) : read(B, 1 + (i % 4)),
        ),
      );
      results.forEach((seen, i) => {
        const expected = i % 2 === 0 ? A.candidateId : B.candidateId;
        expect(seen).toEqual([expected, expected, expected]);
      });
    });
  });

  describe('S2: a wrong fact can only narrow, never widen (DL-31, FU-DB-185)', () => {
    const readFacts = async (chain: SessionChain, facts: CandidateFacts) =>
      asCandidateWith(chain, facts, async () => ({
        candidates: ((await client.candidate.findMany({ ...ID })) as Row[]).map((r) => r.id),
        invitations: ((await client.invitation.findMany({ ...ID })) as Row[]).map((r) => r.id),
        tests: ((await client.test.findMany({ ...ID })) as Row[]).map((r) => r.id),
        candidateCount: await client.candidate.count(),
        invitationCount: await client.invitation.count(),
        testCount: await client.test.count(),
      }));

    it("TC-008 a guard that sets B's facts in A's scope (same org) reads nothing", async () => {
      expect(await readFacts(A, factsOf(B))).toEqual({
        candidates: [],
        invitations: [],
        tests: [],
        candidateCount: 0,
        invitationCount: 0,
        testCount: 0,
      });
      expect(await readFacts(B, factsOf(A))).toEqual({
        candidates: [],
        invitations: [],
        tests: [],
        candidateCount: 0,
        invitationCount: 0,
        testCount: 0,
      });
    });

    it("TC-008 a guard that sets another org's candidate facts reads nothing either", async () => {
      expect(await readFacts(A, factsOf(O))).toEqual({
        candidates: [],
        invitations: [],
        tests: [],
        candidateCount: 0,
        invitationCount: 0,
        testCount: 0,
      });
    });

    it('TC-008 one wrong fact narrows only its own model: the right ones still read', async () => {
      const mixed = await readFacts(A, {
        candidateId: A.candidateId,
        invitationId: B.invitationId,
        testId: A.testId,
      });
      expect(mixed.candidates).toEqual([A.candidateId]);
      expect(mixed.invitations).toEqual([]);
      expect(mixed.tests).toEqual([A.testId]);
      const swapped = await readFacts(A, {
        candidateId: B.candidateId,
        invitationId: A.invitationId,
        testId: B.testId,
      });
      expect(swapped.candidates).toEqual([]);
      expect(swapped.invitations).toEqual([A.invitationId]);
      expect(swapped.tests).toEqual([]);
    });

    it("TC-008 the right facts read the candidate's own rows (the control)", async () => {
      expect(await readFacts(A, factsOf(A))).toMatchObject({
        candidates: [A.candidateId],
        invitations: [A.invitationId],
        tests: [A.testId],
        candidateCount: 1,
        invitationCount: 1,
        testCount: 1,
      });
    });

    it('TC-008 the guard recipe (DL-31 option a): read the session and its invitation in runInOrg, then enter runAsCandidate and set the facts before any other query', async () => {
      // 1. The only org-wide read, in trusted guard code: two selects, in a plain org scope.
      const loaded = await orgContext.runInOrg(A.orgId, async () => {
        const session = await client.session.findUnique({
          where: { id: A.sessionId },
          select: { invitationId: true },
        });
        const invitation = await client.invitation.findUnique({
          where: { id: session?.invitationId ?? '' },
          select: { id: true, candidateId: true, testId: true },
        });
        return invitation;
      });
      expect(loaded).toEqual({
        id: A.invitationId,
        candidateId: A.candidateId,
        testId: A.testId,
      });
      // 2. Leave that scope, enter the candidate scope and set the facts first.
      const rows = await orgContext.runAsCandidate(A.orgId, A.sessionId, async () => {
        setCandidateFacts(orgContext, {
          candidateId: loaded?.candidateId ?? '',
          invitationId: loaded?.id ?? '',
          testId: loaded?.testId ?? '',
        });
        return client.candidate.findMany({ ...ID });
      });
      expect((rows as Row[]).map((r) => r.id)).toEqual([A.candidateId]);
    });
  });

  describe('S1: keys behind the filters cannot be written (ADR 0013 CS-4.2, CS-4.4)', () => {
    /** What the candidate can reach through the filters that follow these keys. */
    const reach = (chain: SessionChain) =>
      asCandidate(chain, async () => ({
        questions: ((await client.question.findMany({ ...ID })) as Row[]).map((r) => r.id).sort(),
        sections: ((await client.testSection.findMany({ ...ID })) as Row[]).map((r) => r.id).sort(),
        candidates: ((await client.candidate.findMany({ ...ID })) as Row[]).map((r) => r.id),
        invitations: ((await client.invitation.findMany({ ...ID })) as Row[]).map((r) => r.id),
        tests: ((await client.test.findMany({ ...ID })) as Row[]).map((r) => r.id),
      }));
    const REACH_A = () => ({
      questions: [A.questionId],
      sections: [A.sectionId],
      candidates: [A.candidateId],
      invitations: [A.invitationId],
      tests: [A.testId],
    });

    it('TC-008 pin: the keys really do feed the filters (written by the OWNER, a repointed row widens what the candidate reads)', async () => {
      // This is the attack the immutability prevents. It is done as the owner, outside any scope, to
      // show that the filters follow the keys, and undone.
      const sq = await owner.sessionQuestion.findUniqueOrThrow({
        where: { id: A.sessionQuestionId },
      });
      await owner.sessionQuestion.update({
        where: { id: A.sessionQuestionId },
        data: { questionVersionId: B.questionVersionId },
      });
      const section = await owner.sessionSection.create({
        data: { sessionId: A.sessionId, sectionId: B.sectionId, position: 5 },
      });
      try {
        const widened = await reach(A);
        expect(widened.questions).toEqual([B.questionId]);
        expect(widened.sections.sort()).toEqual([A.sectionId, B.sectionId].sort());
      } finally {
        await owner.sessionSection.delete({
          where: { sessionId_sectionId: { sessionId: A.sessionId, sectionId: B.sectionId } },
        });
        await owner.sessionQuestion.update({
          where: { id: A.sessionQuestionId },
          data: { questionVersionId: sq.questionVersionId },
        });
      }
      expect(section.sectionId).toBe(B.sectionId);
      expect(await reach(A)).toEqual(REACH_A());
    });

    describe.each(ACTORS)('actor %s', (actor, run) => {
      it("TC-008 sessions.invitationId cannot be pointed at B's invitation, and nothing changes", async () => {
        const before = await snapshot();
        await run(A, async () => {
          for (const value of [
            B.invitationId,
            O.invitationId,
            A.invitationId,
            { set: B.invitationId },
          ]) {
            const data = { invitationId: value } as never;
            await expect(
              client.session.update({ where: { id: A.sessionId }, data, ...ID }),
            ).rejects.toThrow(/invitationId is a session key/);
            await expect(
              client.session.updateMany({ where: { id: A.sessionId }, data }),
            ).rejects.toThrow(/invitationId is a session key/);
            await expect(
              client.session.updateManyAndReturn({ where: { id: A.sessionId }, data, ...ID }),
            ).rejects.toThrow(/invitationId is a session key/);
            await expect(
              client.session.upsert({
                where: { id: A.sessionId },
                update: data,
                create: {} as never,
                ...ID,
              }),
            ).rejects.toThrow(OrgScopeViolationError);
          }
        });
        expect(await snapshot()).toEqual(before);
        expect(actor).toBeDefined();
      });
    });

    it.each(['questionVersionId', 'testQuestionId', 'variantId'] as const)(
      "TC-008 CANDIDATE: session_questions.%s cannot be repointed to B's rows, and the questions filter does not widen",
      async (key) => {
        const before = await snapshot();
        const to = {
          questionVersionId: B.questionVersionId,
          testQuestionId: B.testQuestionId,
          variantId: null,
        }[key];
        await asCandidate(A, async () => {
          const data = { [key]: to } as never;
          await expect(
            client.sessionQuestion.update({
              where: { id: A.sessionQuestionId },
              data,
              ...ID,
            }),
          ).rejects.toThrow(new RegExp(`${key} is a session key`));
          await expect(
            client.sessionQuestion.updateMany({ where: { id: A.sessionQuestionId }, data }),
          ).rejects.toThrow(/session key/);
          await expect(
            client.sessionQuestion.updateManyAndReturn({
              where: { id: A.sessionQuestionId },
              data,
              ...ID,
            }),
          ).rejects.toThrow(/session key/);
        });
        expect(await snapshot()).toEqual(before);
        expect(await reach(A)).toEqual(REACH_A());
      },
    );

    it('TC-008 SERVICE may write them (the job that assigns the questions), CANDIDATE may write what CS-4.4 grants', async () => {
      await asService(A, async () => {
        const row = await client.sessionQuestion.update({
          where: { id: A.sessionQuestionId },
          data: { questionVersionId: A.questionVersionId, variantId: null },
        });
        expect(row.questionVersionId).toBe(A.questionVersionId);
      });
      await asCandidate(A, async () => {
        const row = await client.sessionQuestion.update({
          where: { id: A.sessionQuestionId },
          data: { finalCode: 'print(2)', finalLanguage: 'python', answer: { a: 1 } },
          select: { id: true, finalCode: true, finalLanguage: true, answer: true },
        });
        expect(row).toEqual({
          id: A.sessionQuestionId,
          finalCode: 'print(2)',
          finalLanguage: 'python',
          answer: { a: 1 },
        });
      });
      await owner.sessionQuestion.update({
        where: { id: A.sessionQuestionId },
        data: { finalCode: null, finalLanguage: null, answer: Prisma.DbNull },
      });
    });

    it("TC-008 CANDIDATE: a planted session_question (naming B's question version) is refused, so the questions filter does not widen", async () => {
      const before = await snapshot();
      await asCandidate(A, async () => {
        const data = {
          sessionId: A.sessionId,
          testQuestionId: A.testQuestionId,
          questionVersionId: B.questionVersionId,
          position: 7,
          points: 1,
        };
        await expect(client.sessionQuestion.create({ data, ...ID })).rejects.toThrow(
          /cannot create this row/,
        );
        await expect(client.sessionQuestion.createMany({ data: [data] })).rejects.toThrow(
          /cannot create this row/,
        );
        await expect(
          client.sessionQuestion.createManyAndReturn({ data: [data], ...ID }),
        ).rejects.toThrow(/cannot create this row/);
        await expect(
          client.sessionQuestion.upsert({
            where: { id: randomUUID() },
            update: {},
            create: data,
            ...ID,
          }),
        ).rejects.toThrow(/cannot create this row/);
        // A planted session as well: it has no CS-4.4 create either.
        await expect(
          client.session.create({
            data: { id: A.sessionId, orgId: A.orgId, invitationId: B.invitationId },
            ...ID,
          }),
        ).rejects.toThrow(/cannot create this row/);
      });
      expect(await snapshot()).toEqual(before);
      expect(await reach(A)).toEqual(REACH_A());
    });

    it('TC-008 CANDIDATE: session_sections takes no write at all (CS-4.4 "none"): a planted or repointed row is refused, so the test_sections filter does not widen', async () => {
      const before = await snapshot();
      await asCandidate(A, async () => {
        const planted = { sessionId: A.sessionId, sectionId: B.sectionId, position: 9 };
        await expect(
          client.sessionSection.create({ data: planted, select: { position: true } }),
        ).rejects.toThrow(/writes nothing here/);
        await expect(client.sessionSection.createMany({ data: [planted] })).rejects.toThrow(
          /writes nothing here/,
        );
        await expect(
          client.sessionSection.upsert({
            where: { sessionId_sectionId: { sessionId: A.sessionId, sectionId: B.sectionId } },
            update: {},
            create: planted,
            select: { position: true },
          }),
        ).rejects.toThrow(/writes nothing here/);
        // The key, the deadlines and the timestamps of the row it has.
        const own = { sessionId_sectionId: { sessionId: A.sessionId, sectionId: A.sectionId } };
        for (const data of [
          { sectionId: B.sectionId },
          { deadlineAt: new Date('2030-01-01T00:00:00Z') },
          { endedAt: WHEN },
          { startedAt: WHEN },
          { timeLimitMs: 1n },
          { position: 3 },
        ]) {
          await expect(
            client.sessionSection.update({ where: own, data, select: { position: true } }),
          ).rejects.toThrow(/writes nothing here/);
          await expect(
            client.sessionSection.updateMany({ where: { sessionId: A.sessionId }, data }),
          ).rejects.toThrow(/writes nothing here/);
        }
      });
      expect(await snapshot()).toEqual(before);
      expect(await reach(A)).toEqual(REACH_A());
    });

    it('TC-008 SERVICE still opens and closes sections (the job writes the deadlines)', async () => {
      await asService(A, async () => {
        const r = await client.sessionSection.updateMany({
          where: { sessionId: A.sessionId },
          data: { startedAt: WHEN, deadlineAt: WHEN, endedAt: WHEN },
        });
        expect(r.count).toBe(1);
        await client.sessionSection.updateMany({
          where: { sessionId: A.sessionId },
          data: { startedAt: null, deadlineAt: null, endedAt: null },
        });
      });
    });
  });

  describe('S3: the interim column control (candidate-interim.ts), against the real database', () => {
    it('TC-008 every model a candidate reads names its select: a bare read throws, and nothing reaches Postgres', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        for (const model of CHAIN_MODELS) {
          for (const operation of ['findMany', 'findFirst', 'findFirstOrThrow']) {
            await expect(scoped(model)[operation]?.({})).rejects.toThrow(
              /needs an explicit select/,
            );
          }
          await expect(scoped(model).findUnique?.({ where: A.rows[model].unique })).rejects.toThrow(
            /needs an explicit select/,
          );
          await expect(
            scoped(model).findUniqueOrThrow?.({ where: A.rows[model].unique }),
          ).rejects.toThrow(/needs an explicit select/);
        }
      });
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 a select returns exactly the columns named: the hidden ones are not in the row', async () => {
      await owner.session.update({
        where: { id: A.sessionId },
        data: { hmacKeyEnc: 'sealed-key-not-real', riskScore: 77 },
      });
      try {
        const row = await asCandidate(A, () =>
          client.session.findUniqueOrThrow({
            where: { id: A.sessionId },
            select: { id: true, status: true, authEpoch: true },
          }),
        );
        expect(Object.keys(row).sort()).toEqual(['authEpoch', 'id', 'status']);
        expect(JSON.stringify(row)).not.toContain('sealed-key-not-real');
      } finally {
        await owner.session.update({
          where: { id: A.sessionId },
          data: { hmacKeyEnc: null, riskScore: null },
        });
      }
    });

    it.each(
      Object.entries(CANDIDATE_INTERIM_DENY).flatMap(([model, deny]) =>
        (deny?.read ?? []).map((column) => [model, column] as const),
      ),
    )(
      'TC-008 %s.%s: refused in select, where, orderBy and the aggregates, and no statement reaches Postgres',
      async (model, column) => {
        await db.statements.reset();
        await asCandidate(A, async () => {
          const d = scoped(model);
          // keystroke_batches.id is itself hidden, so that model is probed through seq.
          const key = model === 'KeystrokeBatch' ? 'seq' : 'id';
          const only = { select: { [key]: true } };
          for (const args of [
            { select: { [key]: true, [column]: true } },
            { ...only, where: { [column]: { not: null } } },
            { ...only, orderBy: { [column]: 'asc' } },
            { ...only, distinct: [column] },
          ]) {
            await expect(d.findMany?.(args)).rejects.toThrow(
              new RegExp(`the column ${column} is not available to a candidate`),
            );
          }
          await expect(d.count?.({ where: { [column]: { not: null } } })).rejects.toThrow(
            /is not available to a candidate/,
          );
          await expect(d.aggregate?.({ _max: { [column]: true } })).rejects.toThrow(
            /is not available to a candidate/,
          );
          await expect(d.groupBy?.({ by: [column], _count: true })).rejects.toThrow(
            /is not available to a candidate/,
          );
        });
        expect(await statementCount()).toBe(0);
      },
    );

    it('TC-008 no boolean oracle: a filter on a hidden column cannot tell A whether a value matches', async () => {
      await owner.session.update({ where: { id: A.sessionId }, data: { riskScore: 77 } });
      try {
        await asCandidate(A, async () => {
          await expect(client.session.count({ where: { riskScore: { gte: 50 } } })).rejects.toThrow(
            /riskScore is not available/,
          );
          await expect(
            client.session.count({ where: { deviceInfo: { path: ['x'], equals: 1 } } }),
          ).rejects.toThrow(/deviceInfo is not available/);
        });
      } finally {
        await owner.session.update({ where: { id: A.sessionId }, data: { riskScore: null } });
      }
    });

    it('TC-008 the hidden-test outcome of a SUBMIT row is neither readable nor countable (the CS-4.4 oracle), until the RUN filter of PR 2', async () => {
      const submit = await owner.submission.create({
        data: {
          sessionQuestionId: A.sessionQuestionId,
          kind: 'SUBMIT',
          language: 'cs4-hidden',
          sourceCode: 'x',
          results: [{ testCaseId: 'hidden-1', passed: false }],
          passed: 2,
          total: 5,
          score: 40,
        },
      });
      try {
        await asCandidate(A, async () => {
          const d = scoped('Submission');
          for (const column of ['results', 'passed', 'total', 'score']) {
            await expect(d.findMany?.({ select: { id: true, [column]: true } })).rejects.toThrow(
              new RegExp(`the column ${column} is not available to a candidate`),
            );
          }
          // `count({ where: { kind: 'SUBMIT', passed: N } })` is the oracle CS-4.4 closes.
          await expect(d.count?.({ where: { kind: 'SUBMIT', passed: 2 } })).rejects.toThrow(
            /the column passed is not available/,
          );
          await expect(d.aggregate?.({ _sum: { passed: true, total: true } })).rejects.toThrow(
            /is not available to a candidate/,
          );
          await expect(d.findMany?.({ ...ID, orderBy: { passed: 'desc' } })).rejects.toThrow(
            /the column passed is not available/,
          );
          // What a candidate may know about its own submissions: that they exist, and their kind.
          const rows = (await d.findMany?.({
            where: { kind: 'SUBMIT' },
            select: { id: true, kind: true, language: true },
          })) as Row[];
          expect(rows).toEqual([{ id: submit.id, kind: 'SUBMIT', language: 'cs4-hidden' }]);
        });
      } finally {
        await owner.submission.delete({ where: { id: submit.id } });
      }
    });

    it.each([
      // Session: lastHeartbeat only. The state columns come with PR 2's grants.
      ['Session', 'status', { status: 'SUBMITTED' }],
      ['Session', 'authEpoch', { authEpoch: 9 }],
      ['Session', 'pauseReasons', { pauseReasons: ['PROCTOR'] }],
      ['Session', 'submittedAt', { submittedAt: WHEN }],
      ['Session', 'startedAt', { startedAt: WHEN }],
      ['Session', 'deadlineAt', { deadlineAt: new Date('2031-01-01T00:00:00Z') }],
      ['Session', 'pausedMs', { pausedMs: 0n }],
      ['Session', 'hmacKeyEnc', { hmacKeyEnc: 'x' }],
      ['Session', 'deviceInfo', { deviceInfo: { a: 1 } }],
      ['Session', 'totalScore', { totalScore: 100 }],
      ['Session', 'riskScore', { riskScore: 0 }],
      ['Session', 'riskBand', { riskBand: 'LOW' }],
      ['Session', 'reportKey', { reportKey: 'k' }],
      ['Session', 'retentionAnchorAt', { retentionAnchorAt: WHEN }],
      ['Session', 'clientKind', { clientKind: 'WEB' }],
      ['Session', 'reportGeneratedAt', { reportGeneratedAt: WHEN }],
      // SessionQuestion: finalCode, finalLanguage and answer only.
      ['SessionQuestion', 'points', { points: 1000 }],
      ['SessionQuestion', 'scoring', { scoring: 'MANUAL' }],
      ['SessionQuestion', 'scoredById', { scoredById: randomUUID() }],
      ['SessionQuestion', 'scoredAt', { scoredAt: WHEN }],
      ['SessionQuestion', 'score', { score: 100 }],
      ['SessionQuestion', 'scoringNote', { scoringNote: 'x' }],
      ['SessionQuestion', 'position', { position: 9 }],
      // Create-only models: an update of any column, the ones a create may carry included.
      ['Submission', 'sourceCode', { sourceCode: 'rewritten after the submit' }],
      ['Submission', 'language', { language: 'java' }],
      ['Submission', 'kind', { kind: 'SUBMIT' }],
      ['Submission', 'score', { score: 100 }],
      ['Submission', 'results', { results: [] }],
      ['Submission', 'passed', { passed: 3 }],
      ['Submission', 'total', { total: 3 }],
      ['IdentityCheck', 'livenessPassed', { livenessPassed: true }],
      ['IdentityCheck', 'status', { status: 'PASSED' }],
      ['IdentityCheck', 'manualDecision', { manualDecision: 'APPROVED' }],
      ['IdentityCheck', 'reviewReason', { reviewReason: 'FACE_MISMATCH' }],
      ['IdentityCheck', 'reviewedById', { reviewedById: randomUUID() }],
      ['IdentityCheck', 'reviewNote', { reviewNote: 'x' }],
      ['IdentityCheck', 'faceMatchScore', { faceMatchScore: 1 }],
      ['ProctorEventBatch', 'eventCount', { eventCount: 99 }],
      ['ProctorEventBatch', 'signature', { signature: Buffer.from('forged') }],
      ['KeystrokeBatch', 'events', { events: [] }],
      ['KeystrokeBatch', 'startedAt', { startedAt: WHEN }],
      // Consent: signedName, signedAt, declinedAt, ip and userAgent only.
      ['Consent', 'consentTextId', { consentTextId: randomUUID() }],
      ['Consent', 'pdfKey', { pdfKey: 'consents/forged.pdf' }],
      ['Consent', 'pdfGeneratedAt', { pdfGeneratedAt: WHEN }],
      // ProctorEvent: durationMs only.
      ['ProctorEvent', 'payload', { payload: { a: 1 } }],
      ['ProctorEvent', 'severity', { severity: 'LOW' }],
      // MediaChunk: not the deletion mark.
      ['MediaChunk', 'deletedAt', { deletedAt: WHEN }],
    ] as const)(
      'TC-008 CANDIDATE: %s.%s cannot be updated, and the row is as it was (the job can)',
      async (model, column, data) => {
        const before = await snapshot();
        const own = A.rows[model];
        const refused = new RegExp(
          `${column} cannot be written by a candidate update here|cannot update this row`,
        );
        await asCandidate(A, async () => {
          const d = scoped(model);
          await expect(d.update?.({ where: own.unique, data, ...S(model) })).rejects.toThrow(
            refused,
          );
          await expect(d.updateMany?.({ where: own.filter, data })).rejects.toThrow(refused);
          await expect(
            d.updateManyAndReturn?.({ where: own.filter, data, ...S(model) }),
          ).rejects.toThrow(refused);
        });
        expect(await snapshot()).toEqual(before);
      },
    );

    it('TC-008 CANDIDATE: a create carries only the CS-4.4 columns, and never an id, the org or a timestamp', async () => {
      const before = await snapshot();
      await asCandidate(A, async () => {
        for (const data of [
          { attempt: 5, status: 'PASSED' },
          { attempt: 5, faceMatchScore: 1 },
          { attempt: 5, reviewNote: 'x' },
          { attempt: 5, createdAt: WHEN },
          { attempt: 5, id: randomUUID() },
        ]) {
          await expect(client.identityCheck.create({ data: data as never, ...ID })).rejects.toThrow(
            /cannot be written by a candidate create here|is never written by a candidate/,
          );
        }
        const submit = {
          sessionQuestionId: A.sessionQuestionId,
          kind: 'SUBMIT',
          language: 'python',
          sourceCode: 'x',
        } as const;
        for (const extra of [{ score: 100 }, { results: [] }, { passed: 1 }, { total: 1 }]) {
          await expect(
            client.submission.create({ data: { ...submit, ...extra }, ...ID }),
          ).rejects.toThrow(/cannot be written by a candidate create here/);
        }
        await expect(
          client.submission.create({ data: { ...submit, createdAt: WHEN }, ...ID }),
        ).rejects.toThrow(/createdAt is never written by a candidate/);
      });
      expect(await snapshot()).toEqual(before);
    });

    it('TC-008 CANDIDATE: what CS-4.4 grants is written, and the columns of the row that came back are the ones it names', async () => {
      // submissions: create only, with sessionQuestionId, kind, language and sourceCode.
      const created = await asCandidate(A, () =>
        client.submission.create({
          data: {
            sessionQuestionId: A.sessionQuestionId,
            kind: 'SUBMIT',
            language: 'cs4-grant',
            sourceCode: 'print(1)',
          },
          select: { id: true, kind: true, language: true },
        }),
      );
      expect(created).toMatchObject({ kind: 'SUBMIT', language: 'cs4-grant' });
      await owner.submission.delete({ where: { id: created.id } });
      // identity_checks: create only.
      const check = await asCandidate(A, () =>
        client.identityCheck.create({
          data: {
            sessionId: A.sessionId,
            attempt: 2,
            idImageKey: `orgs/${A.orgId}/sessions/${A.sessionId}/identity/2/sealed/id-01HZZZ.jpg`,
            selfieKey: `orgs/${A.orgId}/sessions/${A.sessionId}/identity/2/sealed/selfie-01HZZZ.jpg`,
            livenessPassed: true,
          },
          select: { id: true, attempt: true, status: true },
        }),
      );
      expect(check).toMatchObject({ attempt: 2, status: 'PENDING' });
      await owner.identityCheck.delete({ where: { id: check.id } });
      // consents: a candidate cannot change a signed or declined one (B3, tested below).
      // media_chunks: create and update.
      const chunk = await asCandidate(A, () =>
        client.mediaChunk.create({
          data: {
            sessionId: A.sessionId,
            stream: 'WEBCAM',
            seq: 42,
            startedAt: WHEN,
            durationMs: 1,
          },
          select: { id: true, seq: true },
        }),
      );
      const updated = await asCandidate(A, () =>
        client.mediaChunk.update({
          where: { id: chunk.id },
          data: {
            sizeBytes: 123n,
            uploadedAt: WHEN,
            objectKey: `orgs/${A.orgId}/sessions/${A.sessionId}/media/WEBCAM/000000/00000042.webm`,
          },
          select: { id: true, sizeBytes: true, uploadedAt: true },
        }),
      );
      expect(updated.sizeBytes).toBe(123n);
      await owner.mediaChunk.delete({ where: { id: chunk.id } });
      // sessions: lastHeartbeat.
      const beat = await asCandidate(A, () =>
        client.session.update({
          where: { id: A.sessionId },
          data: { lastHeartbeat: WHEN },
          select: { id: true, status: true },
        }),
      );
      expect(beat.id).toBe(A.sessionId);
      await owner.session.update({ where: { id: A.sessionId }, data: { lastHeartbeat: null } });
    });

    it('TC-008 an id in a create is refused before the database, so the answer does not tell whether the id exists (nit 7)', async () => {
      // A create naming another candidate's submission id used to answer P2002 (exists) or succeed (does
      // not). Now it answers the same refusal either way, and the statement never reaches Postgres.
      const messages: string[] = [];
      await db.statements.reset();
      await asCandidate(A, async () => {
        for (const id of [
          B.rows.Submission.filter.id as string,
          A.rows.Submission.filter.id as string,
          randomUUID(),
        ]) {
          const error = await client.submission
            .create({
              data: {
                id,
                sessionQuestionId: A.sessionQuestionId,
                kind: 'RUN',
                language: 'python',
                sourceCode: 'x',
              },
              ...ID,
            })
            .then(
              () => undefined,
              (e: unknown) => e,
            );
          expect(error).toBeInstanceOf(OrgScopeViolationError);
          messages.push((error as Error).message);
        }
      });
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toMatch(/id is never written by a candidate/);
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 SERVICE writes and reads those columns (no column limit): the control for the list above', async () => {
      await asService(A, async () => {
        const row = await client.session.update({
          where: { id: A.sessionId },
          data: { riskScore: 5, status: 'OPENED', authEpoch: 1 },
          select: { riskScore: true, status: true, authEpoch: true, hmacKeyEnc: true },
        });
        expect(row).toEqual({ riskScore: 5, status: 'OPENED', authEpoch: 1, hmacKeyEnc: null });
        await client.session.update({
          where: { id: A.sessionId },
          data: { riskScore: null, status: 'INVITED', authEpoch: 0 },
        });
      });
    });

    describe('proctor_events: source = CLIENT only (CS-4.4)', () => {
      const serverEvent = (chain: SessionChain) =>
        owner.proctorEvent.create({
          data: {
            sessionId: chain.sessionId,
            type: 'IDENTITY_MANUAL_REVIEW',
            severity: 'HIGH',
            source: 'SERVER',
            occurredAt: WHEN,
            payload: { similarity: 0.12 },
          },
        });

      it('TC-008 SERVER events are invisible to a candidate in every read operation, and visible to the job', async () => {
        const hidden = await serverEvent(A);
        const hiddenOfB = await serverEvent(B);
        try {
          await asCandidate(A, async () => {
            const rows = (await client.proctorEvent.findMany({
              select: { id: true, type: true },
            })) as Row[];
            expect(rows.map((r) => r.id)).toEqual([A.rows.ProctorEvent.filter.id]);
            expect(await client.proctorEvent.count()).toBe(1);
            // `source` is not readable or filterable by a candidate: the SERVER rows are not a question
            // it can ask (CS-4.4 hides the column), and they are not in any answer either.
            await expect(
              client.proctorEvent.count({ where: { source: 'SERVER' } }),
            ).rejects.toThrow(/the column source is not available/);
            expect(await client.proctorEvent.count({ where: { id: hidden.id } })).toBe(0);
            expect(
              await client.proctorEvent.findUnique({ where: { id: hidden.id }, ...ID }),
            ).toBeNull();
            expect(
              await client.proctorEvent.findFirst({
                where: { type: 'IDENTITY_MANUAL_REVIEW' },
                ...ID,
              }),
            ).toBeNull();
            expect(await client.proctorEvent.aggregate({ _count: true })).toEqual({ _count: 1 });
            await expect(
              client.proctorEvent.groupBy({ by: ['source'], _count: true }),
            ).rejects.toThrow(/the column source is not available/);
            expect(await client.proctorEvent.groupBy({ by: ['type'], _count: true })).toEqual([
              { type: 'TAB_SWITCH', _count: 1 },
            ]);
          });
          await asService(A, async () => {
            expect(await client.proctorEvent.count()).toBe(2);
            expect(await client.proctorEvent.count({ where: { source: 'SERVER' } })).toBe(1);
          });
        } finally {
          await owner.proctorEvent.deleteMany({ where: { id: { in: [hidden.id, hiddenOfB.id] } } });
        }
      });

      it('TC-008 a candidate cannot update a SERVER event (not found), and cannot change a CLIENT one except its duration', async () => {
        const hidden = await serverEvent(A);
        const before = await snapshot();
        try {
          await asCandidate(A, async () => {
            expect(
              await client.proctorEvent.updateMany({
                where: { id: hidden.id },
                data: { durationMs: 99 },
              }),
            ).toEqual({ count: 0 });
            await expect(
              client.proctorEvent.update({
                where: { id: hidden.id },
                data: { durationMs: 99 },
                ...ID,
              }),
            ).rejects.toMatchObject({ code: 'P2025' });
            const own = { id: A.rows.ProctorEvent.filter.id as bigint };
            for (const data of [
              { payload: { a: 1 } },
              { severity: 'LOW' },
              { source: 'SERVER' },
              { type: 'TAB_SWITCH' },
              { evidenceKey: 'k' },
              { confidence: 0.1 },
              { occurredAt: WHEN },
              { batchSeq: 4 },
            ] as const) {
              await expect(client.proctorEvent.update({ where: own, data, ...ID })).rejects.toThrow(
                /cannot be written by a candidate update here/,
              );
            }
          });
          expect((await snapshot()).ProctorEvent).toEqual(before.ProctorEvent);
        } finally {
          await owner.proctorEvent.delete({ where: { id: hidden.id } });
        }
      });

      it('TC-008 a candidate create carries source = CLIENT: stamped by the scope, and SERVER is refused', async () => {
        const created = await asCandidate(A, () =>
          client.proctorEvent.create({
            data: { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN } as never,
            select: { id: true },
          }),
        );
        // `source` and `sessionId` are not columns a candidate reads: the owner looks.
        const stored = await owner.proctorEvent.findUniqueOrThrow({ where: { id: created.id } });
        expect(stored.source).toBe('CLIENT');
        expect(stored.sessionId).toBe(A.sessionId);
        await owner.proctorEvent.delete({ where: { id: created.id } });
        const before = await snapshot();
        await asCandidate(A, async () => {
          for (const source of ['SERVER', 'client', null]) {
            const data = {
              type: 'TAB_SWITCH',
              severity: 'LOW',
              occurredAt: WHEN,
              source,
            } as never;
            await expect(client.proctorEvent.create({ data, ...ID })).rejects.toThrow(
              /source must be CLIENT/,
            );
            await expect(client.proctorEvent.createMany({ data: [data] })).rejects.toThrow(
              /source must be CLIENT/,
            );
            await expect(
              client.proctorEvent.createManyAndReturn({ data: [data], ...ID }),
            ).rejects.toThrow(/source must be CLIENT/);
          }
        });
        expect(await snapshot()).toEqual(before);
      });

      it('TC-008 a candidate updates the duration of its own CLIENT event (the 5.9 pairing still works)', async () => {
        const own = { id: A.rows.ProctorEvent.filter.id as bigint };
        const row = await asCandidate(A, () =>
          client.proctorEvent.update({
            where: own,
            data: { durationMs: 1234 },
            select: { id: true, durationMs: true },
          }),
        );
        expect(row.durationMs).toBe(1234);
        await owner.proctorEvent.update({ where: own, data: { durationMs: null } });
      });
    });
  });

  describe('CS-4.5: relation vectors 1 to 5 in a CANDIDATE scope', () => {
    const vectors: Array<[string, () => Promise<unknown>]> = [
      [
        '1 include (session to its invitation and the other candidates of the org)',
        () =>
          client.session.findMany({ include: { invitation: { include: { candidate: true } } } }),
      ],
      [
        '1 include (session to org, which holds every candidate)',
        () => client.session.findFirst({ include: { org: { include: { candidates: true } } } }),
      ],
      [
        '1 include (sessionQuestion to questionVersion and its testCases)',
        () =>
          client.sessionQuestion.findMany({
            include: { questionVersion: { include: { testCases: true } } },
          }),
      ],
      [
        '1 include (sessionQuestion to variant)',
        () =>
          client.sessionQuestion.findMany({
            include: { variant: { include: { testCaseOverrides: true } } },
          }),
      ],
      [
        '2 select',
        () =>
          client.sessionQuestion.findMany({
            select: { id: true, questionVersion: { select: { referenceSolution: true } } },
          }),
      ],
      [
        '2 select (test to its sections)',
        () => client.test.findMany({ select: { id: true, sections: true } }),
      ],
      [
        '3 where some',
        () =>
          client.session.findMany({
            where: { questions: { some: { finalCode: { contains: 'a' } } } },
            ...ID,
          }),
      ],
      [
        '3 where every',
        () =>
          client.session.findMany({
            where: { questions: { every: { points: { gt: 0 } } } },
            ...ID,
          }),
      ],
      [
        '3 where none',
        () =>
          client.session.findMany({
            where: { questions: { none: { score: { gt: 99 } } } },
            ...ID,
          }),
      ],
      [
        '3 where is',
        () =>
          client.session.findMany({
            where: { invitation: { is: { candidateId: B.candidateId } } },
            ...ID,
          }),
      ],
      [
        '3 where isNot',
        () =>
          client.session.findMany({
            where: { invitation: { isNot: { candidateId: B.candidateId } } },
            ...ID,
          }),
      ],
      [
        '3 where (plain relation object, an oracle on another candidate)',
        () =>
          client.session.count({
            where: { invitation: { candidate: { email: { startsWith: 'candidate-b' } } } },
          }),
      ],
      [
        '3 where (under NOT and OR)',
        () =>
          client.sessionQuestion.findMany({
            where: {
              OR: [{ NOT: { questionVersion: { testCases: { some: { isHidden: true } } } } }],
            },
            ...ID,
          }),
      ],
      [
        '4 orderBy',
        () => client.session.findMany({ orderBy: { invitation: { windowStart: 'asc' } }, ...ID }),
      ],
      [
        '4 orderBy (relation _count)',
        () => client.session.findMany({ orderBy: { questions: { _count: 'desc' } }, ...ID }),
      ],
      [
        '5 _count',
        () => client.session.findMany({ select: { _count: { select: { questions: true } } } }),
      ],
      [
        '5 _count (include)',
        () => client.test.findMany({ include: { _count: { select: { sections: true } } } }),
      ],
    ];

    it.each(vectors)(
      'TC-008 vector %s throws, and no statement reaches Postgres',
      async (_name, call) => {
        await db.statements.reset();
        await expect(asCandidate(A, call)).rejects.toBeInstanceOf(OrgScopeViolationError);
        await expect(asCandidate(A, call)).rejects.toThrow(/CS-4\.5/);
        expect(await db.statements.read()).toEqual([]);
      },
    );

    it('TC-008 vector 6, the fluent API: each call reaches the extension as a relation select and throws, and no statement reaches Postgres (S6)', async () => {
      const fluent: Array<[string, () => Promise<unknown>]> = [
        [
          'session.questions()',
          () => client.session.findUnique({ where: { id: A.sessionId } }).questions(),
        ],
        [
          'session.invitation()',
          () => client.session.findUniqueOrThrow({ where: { id: A.sessionId } }).invitation(),
        ],
        ['session.org()', () => client.session.findFirst({ where: { id: A.sessionId } }).org()],
        [
          'sessionQuestion.questionVersion().testCases()',
          () =>
            client.sessionQuestion
              .findUnique({ where: { id: A.sessionQuestionId } })
              .questionVersion()
              .testCases(),
        ],
        [
          'session.invitation().candidate() (the other candidates through a chain)',
          () =>
            client.session
              .findUnique({ where: { id: A.sessionId } })
              .invitation()
              .candidate(),
        ],
      ];
      await db.statements.reset();
      for (const [name, call] of fluent) {
        const error = await asCandidate(A, call).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect({ name, refused: error instanceof OrgScopeViolationError }).toEqual({
          name,
          refused: true,
        });
        expect((error as Error).message).toMatch(/\(vector 2\)/);
      }
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 the same shapes run for a session job (SERVICE has no relation limit)', async () => {
      const rows = await asService(A, () =>
        client.session.findMany({ include: { invitation: { include: { candidate: true } } } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.invitation.candidate.id).toBe(A.candidateId);
      const fluent = await asService(A, () =>
        client.session.findUnique({ where: { id: A.sessionId } }).questions(),
      );
      expect(fluent?.map((q) => q.id)).toEqual([A.sessionQuestionId]);
    });

    it("TC-008 the extension's own relation filters are not refused: the submission, section and question reads work", async () => {
      await asCandidate(A, async () => {
        expect(await client.submission.count()).toBe(1);
        expect(await client.testSection.count()).toBe(1);
        expect(await client.question.count()).toBe(1);
      });
    });

    it('TC-008 each model is loaded with its own scoped call instead (what CS-4.5 asks services to do)', async () => {
      await asCandidate(A, async () => {
        const session = await client.session.findUnique({
          where: { id: A.sessionId },
          select: { id: true },
        });
        const questions = await client.sessionQuestion.findMany({ ...ID });
        const submissions = await client.submission.findMany({
          select: { sessionQuestionId: true },
        });
        expect(session?.id).toBe(A.sessionId);
        expect(questions.map((q) => q.id)).toEqual([A.sessionQuestionId]);
        expect(submissions.map((s) => s.sessionQuestionId)).toEqual([A.sessionQuestionId]);
      });
    });
  });

  describe('every model not on the CS-4.3 allowlist throws against the database too', () => {
    const denied = [
      'User',
      'RefreshToken',
      'AuditLog',
      'QuestionVersion',
      'TestCase',
      'QuestionVariant',
      'VariantTestCase',
      'AiReferenceSolution',
      'SessionReview',
      'FlagDecision',
      'Appeal',
      'WebhookEndpoint',
      'WebhookDelivery',
    ];

    it.each(denied)(
      'TC-008 %s: findMany, count and updateMany throw, and nothing reaches Postgres',
      async (model) => {
        await db.statements.reset();
        await asCandidate(A, async () => {
          for (const operation of ['findMany', 'count', 'updateMany', 'deleteMany', 'create']) {
            await expect(scoped(model)[operation]?.({ data: {} })).rejects.toThrow(
              /not on the CANDIDATE allowlist/,
            );
          }
        });
        expect(await db.statements.read()).toEqual([]);
      },
    );
  });

  describe('CS-4.1: SERVICE (runAsSessionJob) sees the org filter plus the session filter, nothing more', () => {
    it("TC-008 cross-session models stay org-scoped: tests, candidates, questions and invitations of the whole org, never another org's", async () => {
      await asService(A, async () => {
        const ids = async (model: string): Promise<string[]> =>
          ((await scoped(model).findMany?.({})) as Row[]).map((r) => r.id as string).sort();
        expect(await ids('Test')).toEqual([A.testId, B.testId].sort());
        expect(await ids('Candidate')).toEqual(
          [A.candidateId, B.candidateId, C.candidateId].sort(),
        );
        expect(await ids('Invitation')).toEqual(
          [A.invitationId, B.invitationId, C.invitationId].sort(),
        );
        expect(await ids('Question')).toEqual(
          [A.questionId, B.questionId, orphanQuestionId].sort(),
        );
        expect(await ids('TestSection')).toEqual(
          [A.sectionId, B.sectionId, orphanSectionId].sort(),
        );
        expect(await ids('Organization')).toEqual([T.orgId]);
        expect(await ids('User')).toEqual([T.userId]);
        // No allowlist: models a candidate may not touch are open to the job (org-scoped).
        expect(await ids('ConsentText')).toEqual([T.consentTextId]);
      });
    });

    it("TC-008 session-path models: only the job's session, though the org holds two candidates", async () => {
      for (const [chain, other] of [
        [A, B],
        [B, A],
      ] as const) {
        await asService(chain, async () => {
          for (const model of SESSION_MODELS) {
            const rows = (await scoped(model).findMany?.({})) as Row[];
            expect(rows).toHaveLength(1);
            expect(matches(rows[0] as Row, chain.rows[model].filter)).toBe(true);
            expect(await scoped(model).count?.({ where: other.rows[model].filter })).toBe(0);
          }
        });
      }
    });

    it("TC-008 no column limit: a job writes any column of its own session's rows (the status, the key, the epoch)", async () => {
      await asService(A, async () => {
        const r = await client.session.updateMany({
          where: { id: A.sessionId },
          data: { authEpoch: 3, hmacKeyEnc: 'not-a-real-key', status: 'OPENED' },
        });
        expect(r.count).toBe(1);
        await client.session.updateMany({
          where: { id: A.sessionId },
          data: { authEpoch: 0, hmacKeyEnc: null, status: 'INVITED' },
        });
      });
    });

    it("TC-008 pin (FU-DB-183): session_reviews and webhook_deliveries are not on the CS-4.2 list, so a job sees the whole org's", async () => {
      // CS-4.2 names ten models. Both of these carry a session_id and are filtered by org only. The
      // fixture gives A a review and a delivery and B none.
      await asService(B, async () => {
        expect(await client.sessionReview.count()).toBe(1);
        expect(await client.webhookDelivery.count()).toBe(1);
      });
    });

    it('TC-008 SERVICE reads a candidate-hidden model only inside its own org', async () => {
      await asService(O, async () => {
        expect(((await client.user.findMany()) as Row[]).map((u) => u.id)).toEqual([
          (await owner.user.findFirstOrThrow({ where: { orgId: O.orgId } })).id,
        ]);
      });
    });
  });

  describe('nit 6: two candidates who sit the same test, and findUnique by the other unique keys', () => {
    it("TC-008 C shares A's test, section, test question and question, and has a session, invitation and candidate of its own", () => {
      expect(C.testId).toBe(A.testId);
      expect(C.sectionId).toBe(A.sectionId);
      expect(C.testQuestionId).toBe(A.testQuestionId);
      expect(C.questionId).toBe(A.questionId);
      expect(C.questionVersionId).toBe(A.questionVersionId);
      for (const key of [
        'candidateId',
        'invitationId',
        'sessionId',
        'sessionQuestionId',
      ] as const) {
        expect(C[key]).not.toBe(A[key]);
      }
    });

    it("TC-008 both read the one shared test, section and question, and nothing of each other's session", async () => {
      for (const chain of [A, C]) {
        await asCandidate(chain, async () => {
          expect(((await client.test.findMany({ ...ID })) as Row[]).map((r) => r.id)).toEqual([
            A.testId,
          ]);
          expect(
            ((await client.testSection.findMany({ ...ID })) as Row[]).map((r) => r.id),
          ).toEqual([A.sectionId]);
          expect(((await client.question.findMany({ ...ID })) as Row[]).map((r) => r.id)).toEqual([
            A.questionId,
          ]);
          // The candidate, the invitation and the session are each their own.
          expect(((await client.candidate.findMany({ ...ID })) as Row[]).map((r) => r.id)).toEqual([
            chain.candidateId,
          ]);
          expect(((await client.invitation.findMany({ ...ID })) as Row[]).map((r) => r.id)).toEqual(
            [chain.invitationId],
          );
          expect(((await client.session.findMany({ ...ID })) as Row[]).map((r) => r.id)).toEqual([
            chain.sessionId,
          ]);
          for (const model of SESSION_MODELS) {
            const other = chain === A ? C : A;
            expect(await scoped(model).count?.({ where: other.rows[model].filter })).toBe(0);
            expect(await scoped(model).count?.({ where: chain.rows[model].filter })).toBe(1);
          }
        });
      }
    });

    it("TC-008 the shared test does not leak the other candidate: C's facts in A's scope read the shared test and nothing else", async () => {
      const read = await asCandidateWith(A, factsOf(C), async () => ({
        candidates: await client.candidate.count(),
        invitations: await client.invitation.count(),
        tests: ((await client.test.findMany({ ...ID })) as Row[]).map((r) => r.id),
      }));
      // The test is A's too, so it reads; C's candidate and invitation are not A's session's.
      expect(read).toEqual({ candidates: 0, invitations: 0, tests: [A.testId] });
    });

    // [model, label, the where for a chain, the column to select]
    const lookups: Array<[ChainModel, string, (chain: SessionChain) => Row, string]> = [
      ['Consent', 'sessionId (a unique column)', (c) => ({ sessionId: c.sessionId }), 'id'],
      [
        'IdentityCheck',
        'sessionId_attempt (a compound)',
        (c) => ({ sessionId_attempt: { sessionId: c.sessionId, attempt: 1 } }),
        'id',
      ],
      [
        'MediaChunk',
        'sessionId_stream_seq (a compound)',
        (c) => ({ sessionId_stream_seq: { sessionId: c.sessionId, stream: 'SCREEN', seq: 0 } }),
        'id',
      ],
      [
        'ProctorEventBatch',
        'sessionId_seq (a compound id)',
        (c) => ({ sessionId_seq: { sessionId: c.sessionId, seq: 0 } }),
        'seq',
      ],
      [
        'KeystrokeBatch',
        'sessionId_seq (a compound)',
        (c) => ({ sessionId_seq: { sessionId: c.sessionId, seq: 0 } }),
        'seq',
      ],
      [
        'SessionSection',
        'sessionId_sectionId (a compound id)',
        (c) => ({ sessionId_sectionId: { sessionId: c.sessionId, sectionId: c.sectionId } }),
        'position',
      ],
      [
        'Candidate',
        'orgId_email (a compound)',
        (c) => ({ orgId_email: { orgId: c.orgId, email: `candidate-${c.label}@example.test` } }),
        'id',
      ],
      [
        'Candidate',
        'id_orgId (a compound)',
        (c) => ({ id_orgId: { id: c.candidateId, orgId: c.orgId } }),
        'id',
      ],
      [
        'Invitation',
        'id_orgId (a compound)',
        (c) => ({ id_orgId: { id: c.invitationId, orgId: c.orgId } }),
        'id',
      ],
      [
        'Test',
        'id_orgId (a compound)',
        (c) => ({ id_orgId: { id: c.testId, orgId: c.orgId } }),
        'id',
      ],
    ];

    it.each(lookups)(
      "TC-008 %s by %s: A finds its own row, and neither B's nor C's nor another org's",
      async (model, _label, where, column) => {
        const d = scoped(model);
        const select = { select: { [column]: true } };
        await asCandidate(A, async () => {
          expect(await d.findUnique?.({ where: where(A), ...select })).not.toBeNull();
          // The shared test is A's too (C sits it), so only its own lookups differ by candidate.
          for (const other of [B, C, O]) {
            const shared = model === 'Test' && other === C;
            const found = await d.findUnique?.({ where: where(other), ...select });
            expect({ other: other.label, found: found !== null }).toEqual({
              other: other.label,
              found: shared,
            });
          }
        });
        await asService(A, async () => {
          expect(await d.findUnique?.({ where: where(A) })).not.toBeNull();
        });
      },
    );

    it('TC-008 the same lookups in one tick, two candidates and a job, each answered by its own scope', async () => {
      for (const [model, , where, column] of lookups.filter(([m]) => m !== 'Test')) {
        const d = scoped(model);
        const select = { select: { [column]: true } };
        const results = await Promise.all([
          asCandidate(A, () => d.findUnique?.({ where: where(A), ...select }) as Promise<unknown>),
          asCandidate(B, () => d.findUnique?.({ where: where(A), ...select }) as Promise<unknown>),
          asCandidate(C, () => d.findUnique?.({ where: where(C), ...select }) as Promise<unknown>),
          asCandidate(A, () => d.findUnique?.({ where: where(C), ...select }) as Promise<unknown>),
          asService(B, () => d.findUnique?.({ where: where(A) }) as Promise<unknown>),
        ]);
        // The job of B's session sees A's row only where the model is org-level (candidates and
        // invitations are filtered by the org alone for the job), never on a session-path model.
        const orgLevel = model === 'Candidate' || model === 'Invitation';
        expect({ model, found: results.map((r) => r !== null) }).toEqual({
          model,
          found: [true, false, true, false, orgLevel],
        });
      }
    });

    it("TC-008 a unique key that is a hidden column is refused, own row and another's alike: no oracle (tokenHash, invitationId, slug)", async () => {
      const own = await owner.invitation.findUniqueOrThrow({ where: { id: A.invitationId } });
      const other = await owner.invitation.findUniqueOrThrow({ where: { id: B.invitationId } });
      await db.statements.reset();
      await asCandidate(A, async () => {
        for (const tokenHash of [own.tokenHash, other.tokenHash, 'unknown-hash']) {
          await expect(
            client.invitation.findUnique({ where: { tokenHash }, ...ID }),
          ).rejects.toThrow(/the column tokenHash is not available/);
        }
        await expect(
          client.session.findUnique({ where: { invitationId: B.invitationId }, ...ID }),
        ).rejects.toThrow(/the column invitationId is not available/);
        await expect(
          client.question.findUnique({
            where: { orgId_slug: { orgId: T.orgId, slug: 'q-b' } },
            ...ID,
          }),
        ).rejects.toThrow(/the column slug is not available/);
      });
      expect(await statementCount()).toBe(0);
    });
  });

  describe('B1: a field reference is refused, in where and in having, with no statement (#126 round 3)', () => {
    const fieldsOf = (model: 'sessionQuestion' | 'identityCheck') =>
      (client[model] as unknown as { fields: Record<string, unknown> }).fields;

    it("TC-008 the oracle is real on the owner's client: points = fields.score counts the rows whose score equals their points", async () => {
      await owner.sessionQuestion.update({
        where: { id: A.sessionQuestionId },
        data: { score: 100 },
      });
      try {
        const plainFields = (owner.sessionQuestion as unknown as { fields: Record<string, never> })
          .fields;
        // points is 100 in the fixture: a hidden score of 100 is found without naming `score`.
        expect(
          await owner.sessionQuestion.count({
            where: { id: A.sessionQuestionId, points: { equals: plainFields.score as never } },
          }),
        ).toBe(1);
        await db.statements.reset();
        await asCandidate(A, async () => {
          await expect(
            client.sessionQuestion.count({
              where: { points: { equals: fieldsOf('sessionQuestion').score as never } },
            }),
          ).rejects.toThrow(/a field reference .* in where/);
        });
        expect(await statementCount()).toBe(0);
      } finally {
        await owner.sessionQuestion.update({
          where: { id: A.sessionQuestionId },
          data: { score: null },
        });
      }
    });

    it('TC-008 both queries of the review, and the same through having: refused, and 0 statements reach Postgres', async () => {
      const points = { points: { equals: fieldsOf('sessionQuestion').score as never } };
      const created = { createdAt: { lt: fieldsOf('identityCheck').reviewedAt as never } };
      await db.statements.reset();
      await asCandidate(A, async () => {
        await expect(client.sessionQuestion.count({ where: points })).rejects.toThrow(
          /a field reference .* in where/,
        );
        await expect(client.identityCheck.count({ where: created })).rejects.toThrow(
          /a field reference .* in where/,
        );
        await expect(
          client.sessionQuestion.groupBy({ by: ['position'], _count: true, having: points }),
        ).rejects.toThrow(/a field reference .* in having/);
        await expect(
          client.identityCheck.groupBy({ by: ['attempt'], _count: true, having: created }),
        ).rejects.toThrow(/a field reference .* in having/);
        await expect(
          client.sessionQuestion.findMany({ where: points, select: { id: true } }),
        ).rejects.toThrow(/a field reference/);
        await expect(
          client.sessionQuestion.updateMany({ where: points, data: { finalCode: 'x' } }),
        ).rejects.toThrow(/a field reference/);
        // A reference to a column the candidate may read is refused too: CS-4.4 grants none.
        await expect(
          client.sessionQuestion.count({
            where: { position: { equals: fieldsOf('sessionQuestion').position as never } },
          }),
        ).rejects.toThrow(/a field reference/);
      });
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 the job is not limited: the same query runs for a SERVICE scope', async () => {
      const count = await asService(A, () =>
        client.sessionQuestion.count({
          where: { points: { equals: fieldsOf('sessionQuestion').score as never } },
        }),
      );
      expect(count).toBe(0);
    });
  });

  describe('B2: object keys stay inside the session prefix (ADR 0013 section 5.7, ADR 0004 section 9.2)', () => {
    const prefixOf = (chain: SessionChain): string =>
      `orgs/${chain.orgId}/sessions/${chain.sessionId}/`;
    const media = (chain: SessionChain, seq: number): string =>
      `${prefixOf(chain)}media/SCREEN/000000/${String(seq).padStart(8, '0')}.webm`;

    it("TC-008 a media chunk: the session's own prefix is stored; B's prefix, another org's and traversal are refused, and nothing is written", async () => {
      const before = await snapshot();
      await asCandidate(A, async () => {
        for (const objectKey of [
          media(B, 50), // another candidate, same org
          media(O, 50), // another org
          `${prefixOf(A)}media/../../${B.sessionId}/media/SCREEN/000000/00000050.webm`,
          `${prefixOf(A)}media/SCREEN//000000/00000050.webm`,
          `/${media(A, 50)}`,
          `${prefixOf(A)}evidence/01HZZZ.jpg`,
          `orgs/${A.orgId}/consents/${A.sessionId}/01HZZZ.pdf`,
        ]) {
          await expect(
            client.mediaChunk.create({
              data: {
                sessionId: A.sessionId,
                stream: 'SCREEN',
                seq: 50,
                startedAt: WHEN,
                durationMs: 1,
                objectKey,
              },
              ...ID,
            }),
          ).rejects.toThrow(/objectKey must be an object key under this session's own prefix/);
          await expect(
            client.mediaChunk.updateMany({
              where: { id: A.rows.MediaChunk.filter.id as bigint },
              data: { objectKey },
            }),
          ).rejects.toThrow(/objectKey must be an object key/);
        }
      });
      expect(await snapshot()).toEqual(before);
      const created = await asCandidate(A, () =>
        client.mediaChunk.create({
          data: {
            sessionId: A.sessionId,
            stream: 'SCREEN',
            seq: 50,
            startedAt: WHEN,
            durationMs: 1,
            objectKey: media(A, 50),
          },
          ...ID,
        }),
      );
      const stored = await owner.mediaChunk.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored.objectKey).toBe(media(A, 50));
      // An update to the other candidate's prefix is refused; the stored key is as it was.
      await asCandidate(A, async () => {
        await expect(
          client.mediaChunk.update({
            where: { id: created.id },
            data: { objectKey: media(B, 50) },
            ...ID,
          }),
        ).rejects.toThrow(/objectKey must be an object key/);
        const moved = await client.mediaChunk.update({
          where: { id: created.id },
          data: { objectKey: media(A, 51) },
          ...ID,
        });
        expect(moved.id).toBe(created.id);
      });
      expect(
        (await owner.mediaChunk.findUniqueOrThrow({ where: { id: created.id } })).objectKey,
      ).toBe(media(A, 51));
      await owner.mediaChunk.delete({ where: { id: created.id } });
    });

    it('TC-008 the identity keys and the event evidence key: the same prefix rule, each in its own folder', async () => {
      const before = await snapshot();
      await asCandidate(A, async () => {
        await expect(
          client.identityCheck.create({
            data: {
              sessionId: A.sessionId,
              attempt: 2,
              idImageKey: `${prefixOf(B)}identity/2/sealed/id-01HZZZ.jpg`,
            },
            ...ID,
          }),
        ).rejects.toThrow(/idImageKey must be an object key/);
        await expect(
          client.identityCheck.create({
            data: {
              sessionId: A.sessionId,
              attempt: 2,
              selfieKey: `${prefixOf(O)}identity/2/sealed/selfie-01HZZZ.jpg`,
            },
            ...ID,
          }),
        ).rejects.toThrow(/selfieKey must be an object key/);
        await expect(
          client.proctorEvent.create({
            data: {
              type: 'TAB_SWITCH',
              severity: 'LOW',
              occurredAt: WHEN,
              evidenceKey: `${prefixOf(B)}evidence/01HZZZ.jpg`,
            } as never,
            ...ID,
          }),
        ).rejects.toThrow(/evidenceKey must be an object key/);
      });
      expect(await snapshot()).toEqual(before);
      const check = await asCandidate(A, () =>
        client.identityCheck.create({
          data: {
            sessionId: A.sessionId,
            attempt: 2,
            idImageKey: `${prefixOf(A)}identity/2/sealed/id-01HZZZ.jpg`,
            selfieKey: `${prefixOf(A)}identity/2/sealed/selfie-01HZZZ.jpg`,
          },
          ...ID,
        }),
      );
      await owner.identityCheck.delete({ where: { id: check.id } });
      const event = await asCandidate(A, () =>
        client.proctorEvent.create({
          data: {
            type: 'TAB_SWITCH',
            severity: 'LOW',
            occurredAt: WHEN,
            evidenceKey: `${prefixOf(A)}evidence/01HZZZ.jpg`,
          } as never,
          ...ID,
        }),
      );
      await owner.proctorEvent.delete({ where: { id: event.id } });
    });

    it("TC-008 the job writes any key (the rule is the candidate's)", async () => {
      const created = await asService(A, () =>
        client.mediaChunk.create({
          data: {
            sessionId: A.sessionId,
            stream: 'SCREEN',
            seq: 60,
            startedAt: WHEN,
            durationMs: 1,
            objectKey: 'anything/the/job/writes',
          },
          ...ID,
        }),
      );
      await owner.mediaChunk.delete({ where: { id: created.id } });
    });
  });

  describe('B3: consents are written once (FR-401, C-17)', () => {
    it('TC-008 a candidate cannot rewrite its signed consent, nor a declined one: 0 rows, and the row is as it was; the job can', async () => {
      // C declines (the database CHECK: exactly one of signed_at and declined_at is set).
      const declined = await owner.consent.findUniqueOrThrow({
        where: { id: C.rows.Consent.filter.id as string },
      });
      await owner.consent.update({
        where: { id: declined.id },
        data: { signedAt: null, signedName: null, declinedAt: WHEN },
      });
      const before = await snapshot();
      try {
        for (const [chain, row] of [
          [A, A.rows.Consent],
          [C, C.rows.Consent],
        ] as const) {
          await asCandidate(chain, async () => {
            const data = { signedName: 'Forged Name', ip: '198.51.100.9', userAgent: 'forged' };
            expect(await client.consent.updateMany({ where: row.filter, data })).toEqual({
              count: 0,
            });
            expect(
              await client.consent.updateManyAndReturn({ where: row.filter, data, ...ID }),
            ).toEqual([]);
            await expect(
              client.consent.update({ where: row.unique as never, data, ...ID }),
            ).rejects.toMatchObject({
              code: 'P2025',
            });
            // A signed or declined consent cannot be turned into the other either.
            expect(
              await client.consent.updateMany({
                where: row.filter,
                data: { declinedAt: WHEN, signedAt: null },
              }),
            ).toEqual({ count: 0 });
            // Reading it is not narrowed: the candidate still sees that it signed (or declined).
            const seen = (await client.consent.findMany({
              select: { id: true, signedAt: true, declinedAt: true },
            })) as Row[];
            expect(seen).toHaveLength(1);
            expect(seen[0]?.id).toBe(row.filter.id);
          });
        }
        expect(await snapshot()).toEqual(before);
        // The job is not limited by it.
        const changed = await asService(A, () =>
          client.consent.updateMany({
            where: A.rows.Consent.filter,
            data: { userAgent: 'job-update' },
          }),
        );
        expect(changed).toEqual({ count: 1 });
      } finally {
        await owner.consent.update({
          where: { id: declined.id },
          data: {
            signedName: declined.signedName,
            signedAt: declined.signedAt,
            declinedAt: declined.declinedAt,
          },
        });
        await owner.consent.update({
          where: { id: A.rows.Consent.filter.id as string },
          data: { userAgent: null },
        });
      }
    });

    it('TC-008 no row is ever in the state the update reaches: the database refuses a consent that is neither signed nor declined (so a candidate cannot sign by update, and cannot create the row)', async () => {
      await expect(
        owner.consent.update({
          where: { id: A.rows.Consent.filter.id as string },
          data: { signedAt: null, signedName: null },
        }),
      ).rejects.toThrow(/consents_check/);
      await asCandidate(A, async () => {
        await expect(
          client.consent.create({
            data: { sessionId: A.sessionId, consentTextId: T.consentTextId },
            ...ID,
          }),
        ).rejects.toThrow(/cannot create this row: CS-4\.4 grants updates only/);
      });
    });
  });

  describe('nit 4 and nit 1 against the database', () => {
    it('TC-008 a candidate create of a server-only event type is refused with no statement, and a browser type is stored as CLIENT', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        for (const type of [
          'FACE_MISMATCH',
          'IDENTITY_MANUAL_REVIEW',
          'RESUME_OTP_FAILED',
          'DISCONNECTED',
        ]) {
          await expect(
            client.proctorEvent.create({
              data: { type, severity: 'HIGH', occurredAt: WHEN } as never,
              ...ID,
            }),
          ).rejects.toThrow(/names a value that only the server writes/);
        }
      });
      expect(await statementCount()).toBe(0);
      const created = await asCandidate(A, () =>
        client.proctorEvent.create({
          data: { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN } as never,
          ...ID,
        }),
      );
      const stored = await owner.proctorEvent.findUniqueOrThrow({ where: { id: created.id } });
      expect({ type: stored.type, source: stored.source }).toEqual({
        type: 'TAB_SWITCH',
        source: 'CLIENT',
      });
      await owner.proctorEvent.delete({ where: { id: created.id } });
    });

    it('TC-008 keystroke_batches.id is not readable (an insert-volume leak): a candidate reads its batches by seq, the job sees the id', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        await expect(client.keystrokeBatch.findMany({ select: { id: true } })).rejects.toThrow(
          /the column id is not available/,
        );
        await expect(
          client.keystrokeBatch.findUnique({ where: { id: 1n }, select: { seq: true } }),
        ).rejects.toThrow(/the column id is not available/);
        await expect(client.keystrokeBatch.aggregate({ _max: { id: true } })).rejects.toThrow(
          /the column id is not available/,
        );
        await expect(
          client.keystrokeBatch.findMany({ select: { seq: true }, orderBy: { id: 'desc' } }),
        ).rejects.toThrow(/the column id is not available/);
      });
      expect(await statementCount()).toBe(0);
      await asCandidate(A, async () => {
        const rows = await client.keystrokeBatch.findMany({ select: { seq: true } });
        expect(rows).toEqual([{ seq: 0 }]);
      });
      await asService(A, async () => {
        const rows = await client.keystrokeBatch.findMany({ select: { id: true } });
        expect(rows).toHaveLength(1);
      });
    });
  });

  describe('S7: same-tick findUnique of two candidates in one org (Prisma batches findUnique calls)', () => {
    // Prisma's dataloader merges findUnique calls issued in the same tick with the same shape into
    // one query. The extension runs per call, before any batching, and adds a different filter for
    // each scope, so a call must never be answered with another call's row.
    it.each(['findUnique', 'findUniqueOrThrow'] as const)(
      "TC-008 %s: every call gets its own scope's answer, however many are in flight",
      async (operation) => {
        const call = (
          run: (chain: SessionChain, fn: () => Promise<unknown>) => Promise<unknown>,
          as: SessionChain,
          id: string,
        ) =>
          run(as, async () => {
            const d = scoped('Session');
            try {
              return await d[operation]?.({ where: { id }, ...ID });
            } catch (error) {
              return (error as { code?: string }).code ?? 'error';
            }
          });
        const missing = operation === 'findUnique' ? null : 'P2025';
        for (let round = 0; round < 8; round++) {
          const results = await Promise.all([
            call(asCandidate, A, A.sessionId),
            call(asCandidate, B, A.sessionId),
            call(asCandidate, A, B.sessionId),
            call(asCandidate, B, B.sessionId),
            call(asService, A, B.sessionId),
            call(asService, B, A.sessionId),
            call(asService, A, A.sessionId),
            call(asCandidate, A, O.sessionId),
          ]);
          const ids = results.map((r) => (r !== null && typeof r === 'object' ? (r as Row).id : r));
          expect(ids).toEqual([
            A.sessionId,
            missing,
            missing,
            B.sessionId,
            missing,
            missing,
            A.sessionId,
            missing,
          ]);
        }
      },
    );

    it('TC-008 the same on a model read by facts: two candidates ask for the same candidate id in one tick', async () => {
      const ask = (as: SessionChain, id: string) =>
        asCandidate(as, () => client.candidate.findUnique({ where: { id }, ...ID }));
      const results = await Promise.all([
        ask(A, A.candidateId),
        ask(B, A.candidateId),
        ask(A, B.candidateId),
        ask(B, B.candidateId),
      ]);
      expect(results.map((r) => r?.id ?? null)).toEqual([A.candidateId, null, null, B.candidateId]);
    });
  });

  describe('CS-4.2 creates take the session from the context', () => {
    const batch = (seq: number): Row => ({
      seq,
      signature: Buffer.from('sig'),
      startedAt: WHEN,
      events: [],
    });
    const eventData = (extra: Row = {}) =>
      ({ type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN, ...extra }) as never;

    it.each(ACTORS)(
      "TC-008 %s: an event without a session id is stamped with the scope's",
      async (_actor, run) => {
        const event = await run(A, () =>
          client.proctorEvent.create({
            data: eventData(),
            ...ID,
            select: { id: true, sessionId: true },
          }),
        );
        expect(event.sessionId).toBe(A.sessionId);
        const many = await run(A, () =>
          client.proctorEvent.createManyAndReturn({
            data: [eventData(), eventData({ sessionId: A.sessionId })],
            select: { id: true, sessionId: true },
          }),
        );
        expect(many.map((e) => e.sessionId)).toEqual([A.sessionId, A.sessionId]);
        await run(A, () => client.proctorEvent.createMany({ data: [eventData()] }));
        expect(
          await owner.proctorEvent.count({ where: { sessionId: A.sessionId } }),
        ).toBeGreaterThanOrEqual(4);
        await owner.proctorEvent.deleteMany({
          where: { sessionId: A.sessionId, id: { not: A.rows.ProctorEvent.filter.id as bigint } },
        });
      },
    );

    it.each(ACTORS)(
      "TC-008 %s: a create that names B's session or another org's throws, and nothing is written",
      async (_actor, run) => {
        const before = await snapshot();
        await run(A, async () => {
          for (const sessionId of [B.sessionId, O.sessionId, randomUUID()]) {
            const data = eventData({ sessionId });
            await expect(client.proctorEvent.create({ data, ...ID })).rejects.toBeInstanceOf(
              OrgScopeViolationError,
            );
            await expect(client.proctorEvent.createMany({ data: [data] })).rejects.toBeInstanceOf(
              OrgScopeViolationError,
            );
            await expect(
              client.proctorEvent.createManyAndReturn({ data: [data], ...ID }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.proctorEvent.upsert({
                where: { id: 1n },
                update: { durationMs: 1 },
                create: data,
                ...ID,
              }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.mediaChunk.create({
                data: { sessionId, stream: 'SCREEN', seq: 9, startedAt: WHEN, durationMs: 1 },
                ...ID,
              }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.consent.create({
                data: { sessionId, consentTextId: T.consentTextId },
                ...ID,
              }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.session.create({
                data: { id: sessionId, orgId: A.orgId, invitationId: B.invitationId },
                ...ID,
              }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
          }
        });
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each(ACTORS)(
      "TC-008 %s: a create may repeat the scope's own session id, in any case",
      async (_actor, run) => {
        for (const sessionId of [A.sessionId, A.sessionId.toUpperCase()]) {
          const created = await run(A, () =>
            client.proctorEvent.create({
              data: eventData({ sessionId }),
              select: { id: true, sessionId: true },
            }),
          );
          expect(created.sessionId).toBe(A.sessionId);
          await owner.proctorEvent.delete({ where: { id: created.id } });
        }
      },
    );

    describe('the existence check on session_questions (submissions and keystroke batches)', () => {
      const submission = (sessionQuestionId: string, language = 'python') => ({
        data: { sessionQuestionId, kind: 'RUN' as const, language, sourceCode: 'print(1)' },
      });

      it.each(ACTORS)(
        'TC-008 %s: a submission for its own question is created',
        async (_actor, run) => {
          const created = await run(A, () =>
            client.submission.create({
              ...submission(A.sessionQuestionId, 'cs4-own'),
              select: { id: true, sessionQuestionId: true },
            }),
          );
          expect(created.sessionQuestionId).toBe(A.sessionQuestionId);
          await owner.submission.delete({ where: { id: created.id } });
        },
      );

      it.each(ACTORS)(
        "TC-008 %s: B's question, another org's question and a missing one are each refused, nothing written",
        async (actor, run) => {
          const before = await snapshot();
          await run(A, async () => {
            for (const id of [B.sessionQuestionId, O.sessionQuestionId, randomUUID()]) {
              await expect(client.submission.create({ ...submission(id), ...ID })).rejects.toThrow(
                /sessionQuestionId is not a question of this session/,
              );
              await expect(
                client.submission.createMany({ data: [submission(id).data] }),
              ).rejects.toThrow(/not a question of this session/);
              await expect(
                client.submission.createManyAndReturn({ data: [submission(id).data], ...ID }),
              ).rejects.toThrow(/not a question of this session/);
              // A candidate has no update on submissions (create only), so its upsert is refused as
              // an update; the job's upsert runs the existence check on the create branch.
              await expect(
                client.submission.upsert({
                  where: { id: randomUUID() },
                  update: { language: 'x' },
                  create: submission(id).data,
                  ...ID,
                }),
              ).rejects.toThrow(
                actor === 'CANDIDATE'
                  ? /cannot update this row: CS-4\.4 grants create only/
                  : /not a question of this session/,
              );
              await expect(
                client.keystrokeBatch.create({
                  data: { ...batch(10), sessionQuestionId: id } as never,
                  select: { seq: true },
                }),
              ).rejects.toThrow(/not a question of this session/);
              await expect(
                client.keystrokeBatch.createMany({
                  data: [{ ...batch(10), sessionQuestionId: id }] as never,
                }),
              ).rejects.toThrow(/not a question of this session/);
            }
          });
          expect(await snapshot()).toEqual(before);
        },
      );

      it.each(ACTORS)(
        'TC-008 %s: a createMany with one bad row writes none of its rows',
        async (_actor, run) => {
          const before = await snapshot();
          await run(A, async () => {
            await expect(
              client.submission.createMany({
                data: [submission(A.sessionQuestionId).data, submission(B.sessionQuestionId).data],
              }),
            ).rejects.toThrow(/not a question of this session/);
          });
          expect(await snapshot()).toEqual(before);
        },
      );

      it.each(ACTORS)(
        'TC-008 %s: a keystroke batch may have no question, and may name its own',
        async (_actor, run) => {
          const none = await run(A, () =>
            client.keystrokeBatch.create({
              data: { ...batch(20), sessionQuestionId: null } as never,
              select: { seq: true, sessionId: true },
            }),
          );
          expect(none.sessionId).toBe(A.sessionId);
          const own = await run(A, () =>
            client.keystrokeBatch.create({
              data: { ...batch(21), sessionQuestionId: A.sessionQuestionId } as never,
              select: { seq: true, sessionQuestionId: true },
            }),
          );
          expect(own.sessionQuestionId).toBe(A.sessionQuestionId);
          await owner.keystrokeBatch.deleteMany({
            where: { sessionId: A.sessionId, seq: { in: [20, 21] } },
          });
        },
      );

      it('TC-008 the check is scoped: a question of the same org but another session is not enough', async () => {
        // B's question exists, in A's org. The check runs under the session filter, so it is a miss.
        expect(
          await owner.sessionQuestion.count({
            where: { id: B.sessionQuestionId, session: { orgId: A.orgId } },
          }),
        ).toBe(1);
        await expect(
          asCandidate(A, () =>
            client.submission.create({ ...submission(B.sessionQuestionId), ...ID }),
          ),
        ).rejects.toThrow(/not a question of this session/);
      });

      it('TC-008 the same question id in another case is the same question: it is found, once', async () => {
        const created = await asCandidate(A, () =>
          client.submission.create({
            ...submission(A.sessionQuestionId.toUpperCase(), 'cs4-case'),
            select: { id: true, sessionQuestionId: true },
          }),
        );
        expect(created.sessionQuestionId).toBe(A.sessionQuestionId);
        await owner.submission.delete({ where: { id: created.id } });
      });

      it('TC-008 statement count: a submission create that needs the check sends the count and the insert (2)', async () => {
        await db.statements.reset();
        const created = await asCandidate(A, () =>
          client.submission.create({
            ...submission(A.sessionQuestionId, 'cs4-count'),
            select: { id: true },
          }),
        );
        const statements = await db.statements.read();
        expect(statements.filter((s) => /^\s*SELECT COUNT/i.test(s.query))).toHaveLength(1);
        expect(
          statements.filter((s) => /^\s*INSERT INTO "?public"?\."?submissions/i.test(s.query)),
        ).toHaveLength(1);
        expect(await statementCount()).toBe(2);
        await owner.submission.delete({ where: { id: created.id } });
        // A create that needs no check is one statement.
        await db.statements.reset();
        const event = await asCandidate(A, () =>
          client.proctorEvent.create({ data: eventData(), select: { id: true } }),
        );
        expect(await statementCount()).toBe(1);
        await owner.proctorEvent.delete({ where: { id: event.id } });
      });

      it('TC-008 statement count: a createMany of 3 rows is 2 statements, one count and one insert, whatever the number of rows', async () => {
        // S5: pinned, not only reported. The distinct session_question ids are counted once.
        const rows = [1, 2, 3].map(() => submission(A.sessionQuestionId, 'cs4-many').data);
        await db.statements.reset();
        const result = await asCandidate(A, () => client.submission.createMany({ data: rows }));
        expect(result).toEqual({ count: 3 });
        const statements = await db.statements.read();
        expect(statements.filter((s) => /^\s*SELECT COUNT/i.test(s.query))).toHaveLength(1);
        expect(
          statements.filter((s) => /^\s*INSERT INTO "?public"?\."?submissions/i.test(s.query)),
        ).toHaveLength(1);
        expect(await statementCount()).toBe(2);
        // 30 rows are still 2 statements.
        const many = Array.from(
          { length: 30 },
          () => submission(A.sessionQuestionId, 'cs4-many').data,
        );
        await db.statements.reset();
        await asService(A, () => client.submission.createMany({ data: many }));
        expect(await statementCount()).toBe(2);
        await owner.submission.deleteMany({ where: { language: 'cs4-many' } });
      });
    });
  });

  describe("upsert against the other candidate's row", () => {
    it("TC-008 SERVICE: the where cannot reach B's row, and the create branch (stamped with A's session) collides with it, leaving it unchanged", async () => {
      const before = await snapshot();
      await asService(A, async () => {
        // The where is filtered, so B's row is not matched; the create then names B's primary key and
        // the database refuses it. A submission, a consent (one per session) and a session question.
        await expect(
          client.submission.upsert({
            where: { id: B.rows.Submission.filter.id as string },
            update: { language: 'changed' },
            create: {
              id: B.rows.Submission.filter.id as string,
              sessionQuestionId: A.sessionQuestionId,
              kind: 'RUN',
              language: 'python',
              sourceCode: 'x',
            },
            ...ID,
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
        await expect(
          client.consent.upsert({
            where: { id: B.rows.Consent.filter.id as string },
            update: { userAgent: 'changed' },
            create: {
              sessionId: A.sessionId,
              consentTextId: T.consentTextId,
              signedName: 'Candidate a',
              signedAt: WHEN,
            },
            ...ID,
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
        await expect(
          client.sessionQuestion.upsert({
            where: { id: B.sessionQuestionId },
            update: { position: 9 },
            create: {
              id: B.sessionQuestionId,
              sessionId: A.sessionId,
              testQuestionId: A.testQuestionId,
              questionVersionId: A.questionVersionId,
              position: 5,
              points: 1,
            },
            ...ID,
          }),
        ).rejects.toMatchObject({ code: 'P2002' });
      });
      expect(await snapshot()).toEqual(before);
    });

    it("TC-008 CANDIDATE: an upsert is refused on every model it could reach B's row through, before the database", async () => {
      const before = await snapshot();
      await db.statements.reset();
      await asCandidate(A, async () => {
        await expect(
          client.submission.upsert({
            where: { id: B.rows.Submission.filter.id as string },
            update: { language: 'changed' },
            create: {
              id: B.rows.Submission.filter.id as string,
              sessionQuestionId: A.sessionQuestionId,
              kind: 'RUN',
              language: 'python',
              sourceCode: 'x',
            },
            ...ID,
          }),
        ).rejects.toThrow(/cannot update this row: CS-4\.4 grants create only/);
        await expect(
          client.consent.upsert({
            where: { id: B.rows.Consent.filter.id as string },
            update: { userAgent: 'changed' },
            create: { sessionId: A.sessionId, signedName: 'Candidate a' } as never,
            ...ID,
          }),
        ).rejects.toThrow(/cannot create this row: CS-4\.4 grants updates only/);
        await expect(
          client.sessionQuestion.upsert({
            where: { id: B.sessionQuestionId },
            update: { position: 9 },
            create: {
              id: B.sessionQuestionId,
              sessionId: A.sessionId,
              testQuestionId: A.testQuestionId,
              questionVersionId: A.questionVersionId,
              position: 5,
              points: 1,
            },
            ...ID,
          }),
        ).rejects.toThrow(/cannot create this row/);
        // media_chunks and proctor_events have both a create and an update: a create that names B's
        // primary key is refused for the id itself (nit 7), not answered with P2002.
        await expect(
          client.mediaChunk.upsert({
            where: { id: B.rows.MediaChunk.filter.id as bigint },
            update: { durationMs: 1 },
            create: {
              id: B.rows.MediaChunk.filter.id as bigint,
              sessionId: A.sessionId,
              stream: 'SCREEN',
              seq: 77,
              startedAt: WHEN,
              durationMs: 1,
            },
            ...ID,
          }),
        ).rejects.toThrow(/id is never written by a candidate/);
      });
      expect(await snapshot()).toEqual(before);
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 CANDIDATE: an upsert of its own row where both branches are granted updates it (media_chunks)', async () => {
      const chunk = await asCandidate(A, () =>
        client.mediaChunk.upsert({
          where: { id: A.rows.MediaChunk.filter.id as bigint },
          update: { sizeBytes: 321n },
          create: {
            sessionId: A.sessionId,
            stream: 'SCREEN',
            seq: 78,
            startedAt: WHEN,
            durationMs: 1,
          },
          select: { id: true, sizeBytes: true },
        }),
      );
      expect(chunk.sizeBytes).toBe(321n);
      await owner.mediaChunk.update({ where: { id: chunk.id }, data: { sizeBytes: null } });
    });

    it('TC-008 SERVICE: an update of its own row (consents) changes it', async () => {
      const own = A.rows.Consent.filter.id as string;
      const original = await owner.consent.findUniqueOrThrow({ where: { id: own } });
      const row = await asService(A, () =>
        client.consent.update({
          where: { id: own },
          data: { userAgent: 'cs4-update' },
          select: { id: true, signedAt: true },
        }),
      );
      expect(row.id).toBe(own);
      expect((await owner.consent.findUniqueOrThrow({ where: { id: own } })).userAgent).toBe(
        'cs4-update',
      );
      await owner.consent.update({ where: { id: own }, data: { userAgent: original.userAgent } });
    });

    it('TC-008 SERVICE: an upsert of its own row updates it', async () => {
      const own = A.rows.Consent.filter.id as string;
      const original = await owner.consent.findUniqueOrThrow({ where: { id: own } });
      const row = await asService(A, () =>
        client.consent.upsert({
          where: { id: own },
          update: { userAgent: 'cs4-upsert' },
          create: { sessionId: A.sessionId, consentTextId: T.consentTextId },
          select: { id: true, userAgent: true },
        }),
      );
      expect(row.userAgent).toBe('cs4-upsert');
      await owner.consent.update({ where: { id: own }, data: { userAgent: original.userAgent } });
    });
  });

  describe('CS-4.2 session keys are immutable, in both actors', () => {
    const keyWrites: Array<[ChainModel, string, (chain: SessionChain) => Row]> = [
      ['SessionQuestion', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['SessionSection', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['IdentityCheck', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['MediaChunk', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['ProctorEventBatch', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['ProctorEvent', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['KeystrokeBatch', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['KeystrokeBatch', 'sessionQuestionId', (c) => ({ sessionQuestionId: c.sessionQuestionId })],
      ['Consent', 'sessionId', (c) => ({ sessionId: c.sessionId })],
      ['Submission', 'sessionQuestionId', (c) => ({ sessionQuestionId: c.sessionQuestionId })],
      ['Session', 'id', (c) => ({ id: c.sessionId })],
      ['Session', 'invitationId', (c) => ({ invitationId: c.invitationId })],
      ['SessionQuestion', 'id', (c) => ({ id: c.sessionQuestionId })],
    ];

    describe.each(ACTORS)('actor %s', (actor, run) => {
      it.each(keyWrites)(
        "TC-008 %s.%s cannot be pointed at B's session or question, and the rows stay as they are",
        async (model, key, to) => {
          const before = await snapshot();
          const own = A.rows[model];
          // A candidate has no write at all on session_sections (CS-4.4 "none") and no update on the
          // create-only models, which refuse first; elsewhere the key itself is refused.
          const refused =
            actor === 'CANDIDATE' && NO_CANDIDATE_UPDATE.includes(model)
              ? /cannot update this row|writes nothing here/
              : new RegExp(`${key} is a session key`);
          // An upsert needs both a create and an update: only media_chunks and proctor_events have both.
          const refusedUpsert =
            actor === 'CANDIDATE' && model !== 'MediaChunk' && model !== 'ProctorEvent'
              ? /cannot (create|update) this row|writes nothing here/
              : /session key/;
          await run(A, async () => {
            for (const data of [to(B), to(O), to(A)]) {
              await expect(
                scoped(model).update?.({ where: own.unique, data, ...S(model) }),
              ).rejects.toThrow(refused);
              await expect(scoped(model).updateMany?.({ where: own.filter, data })).rejects.toThrow(
                refused,
              );
              await expect(
                scoped(model).updateManyAndReturn?.({ where: own.filter, data, ...S(model) }),
              ).rejects.toThrow(refused);
              // An upsert needs both a create and an update: a candidate has no create on sessions and
              // session_questions and no update on the create-only models, so that refuses first there.
              await expect(
                scoped(model).upsert?.({
                  where: own.unique,
                  update: data,
                  create: {},
                  ...S(model),
                }),
              ).rejects.toThrow(refusedUpsert);
            }
          });
          expect(await snapshot()).toEqual(before);
        },
      );
    });
  });

  describe('CS-4.2 raw SQL is refused in a session scope, even inside runRawSql', () => {
    it.each(ACTORS)('TC-008 %s: no raw statement reaches Postgres', async (_actor, run) => {
      await db.statements.reset();
      await run(A, async () => {
        await expect(client.$queryRaw`SELECT 1 AS cs4_raw_probe`).rejects.toBeInstanceOf(
          RawQueryNotAllowedError,
        );
        await expect(client.$executeRaw`SELECT 1 AS cs4_raw_probe`).rejects.toBeInstanceOf(
          RawQueryNotAllowedError,
        );
        await expect(client.$queryRawUnsafe('SELECT 1 AS cs4_raw_probe')).rejects.toBeInstanceOf(
          RawQueryNotAllowedError,
        );
        await expect(
          orgContext.runRawSql(
            'a reviewed raw statement that must still be refused',
            () => client.$queryRaw`SELECT 1 AS cs4_raw_probe`,
          ),
        ).rejects.toThrow(/session scope/);
      });
      expect(await db.statements.read()).toEqual([]);
    });
  });

  describe('NFR-04 entering a scope sends no SQL; a read is one statement', () => {
    it('TC-008 runAsCandidate, runAsSessionJob, detachForSessionJob, nesting and the facts setter send nothing', async () => {
      await db.statements.reset();
      await asCandidate(A, async () => {
        await orgContext.runInOrg(A.orgId, () => Promise.resolve());
      });
      await asService(A, async () => {
        await orgContext.runInOrg(A.orgId, () => Promise.resolve());
      });
      await orgContext.detachForSessionJob(() =>
        orgContext.runAsSessionJob(A.orgId, A.sessionId, () => Promise.resolve()),
      );
      expect(await db.statements.read()).toEqual([]);
    });

    it('TC-008 a candidate read of its own session is one statement, and a refusal is none', async () => {
      await db.statements.reset();
      const session = await asCandidate(A, () =>
        client.session.findUnique({ where: { id: A.sessionId }, ...ID }),
      );
      expect(session?.id).toBe(A.sessionId);
      const statements = await db.statements.read();
      expect(await statementCount()).toBe(1);
      expect(statements[0]?.query).toMatch(/^\s*SELECT/i);
      await db.statements.reset();
      await expect(
        asCandidate(A, () => client.session.findUnique({ where: { id: A.sessionId } })),
      ).rejects.toThrow(/needs an explicit select/);
      expect(await statementCount()).toBe(0);
    });

    it('TC-008 the same read in a plain org scope is also one statement, and differs by exactly the session filter', async () => {
      // S5: the statement text is compared, not only its count. WHERE (id = $1 AND (org_id = $2
      // [AND id = $3])): the candidate's statement has the session filter, the org scope's has not.
      const read = (run: (fn: () => Promise<unknown>) => Promise<unknown>): Promise<string> =>
        (async () => {
          await db.statements.reset();
          await run(() => client.session.findUnique({ where: { id: A.sessionId }, ...ID }));
          const statements = await db.statements.read();
          expect(statements).toHaveLength(1);
          expect(statements[0]?.calls).toBe(1);
          return (statements[0] as { query: string }).query;
        })();
      const orgOnly = await read((fn) => orgContext.runInOrg(A.orgId, fn));
      const candidate = await read((fn) => asCandidate(A, fn));
      const normalise = (sql: string): string => sql.replace(/\s+/g, ' ');
      expect(normalise(orgOnly)).toContain(
        'WHERE ("public"."sessions"."id" = $1 AND "public"."sessions"."org_id" = $2) LIMIT $3 OFFSET $4',
      );
      expect(normalise(candidate)).toContain(
        'WHERE ("public"."sessions"."id" = $1 AND ("public"."sessions"."org_id" = $2 AND "public"."sessions"."id" = $3)) LIMIT $4 OFFSET $5',
      );
      // Same SELECT list: only the WHERE differs.
      const select = (sql: string): string => normalise(sql).split(' WHERE ')[0] as string;
      expect(select(candidate)).toBe(select(orgOnly));
    });
  });

  describe('actors and nesting seen from the database layer', () => {
    it('TC-008 a query in a refused nested scope never runs: runAsUser or runSystem inside a candidate scope', async () => {
      await db.statements.reset();
      await asCandidate(A, () => {
        expect(() =>
          orgContext.runAsUser({ orgId: A.orgId, userId: T.userId, role: 'RECRUITER' }, () =>
            client.session.findMany(),
          ),
        ).toThrow(OrgScopeViolationError);
        expect(() =>
          orgContext.runSystem('BACKGROUND_JOB', () => client.session.findMany()),
        ).toThrow(OrgScopeViolationError);
        expect(() =>
          orgContext.runAsSessionJob(A.orgId, A.sessionId, () => client.session.findMany()),
        ).toThrow(OrgScopeViolationError);
        expect(() => orgContext.detachForSessionJob(() => client.session.findMany())).toThrow(
          OrgScopeViolationError,
        );
        return Promise.resolve();
      });
      expect(await db.statements.read()).toEqual([]);
    });

    it('TC-008 runAsCandidate inside runInOrg or runSystem is refused, and no query runs', async () => {
      await db.statements.reset();
      const run = (): Promise<unknown> =>
        orgContext.runAsCandidate(A.orgId, A.sessionId, () => client.session.findMany());
      expect(() => orgContext.runInOrg(A.orgId, run)).toThrow(OrgScopeViolationError);
      expect(() => orgContext.runSystem('AUTH_BOOTSTRAP', run)).toThrow(OrgScopeViolationError);
      expect(() =>
        orgContext.runAsUser({ orgId: A.orgId, userId: T.userId, role: 'RECRUITER' }, run),
      ).toThrow(OrgScopeViolationError);
      expect(await db.statements.read()).toEqual([]);
    });

    it('TC-008 a plain org scope still reads every session of the org (the session scope does not leak outward)', async () => {
      const sessions = await orgContext.runInOrg(A.orgId, () => client.session.findMany());
      expect(sessions.map((s) => s.id).sort()).toEqual(
        [A.sessionId, B.sessionId, C.sessionId].sort(),
      );
    });

    it('TC-008 the scope is gone after the unit of work: a later query has no context', async () => {
      await asCandidate(A, () => client.session.findMany({ ...ID }));
      await expect(client.session.findMany()).rejects.toBeInstanceOf(OrgScopeError);
    });

    it('TC-008 ids in another case enter the same scope: the filters match, and nothing leaks', async () => {
      const rows = await orgContext.runAsCandidate(
        A.orgId.toUpperCase(),
        A.sessionId.toUpperCase(),
        async () => {
          setCandidateFacts(orgContext, {
            candidateId: A.candidateId.toUpperCase(),
            invitationId: A.invitationId.toUpperCase(),
            testId: A.testId.toUpperCase(),
          });
          return {
            sessions: await client.session.findMany({ ...ID }),
            candidates: await client.candidate.findMany({ ...ID }),
            invitations: await client.invitation.findMany({ ...ID }),
          };
        },
      );
      expect(rows.sessions.map((s) => s.id)).toEqual([A.sessionId]);
      expect(rows.candidates.map((c) => c.id)).toEqual([A.candidateId]);
      expect(rows.invitations.map((i) => i.id)).toEqual([A.invitationId]);
    });
  });
});
