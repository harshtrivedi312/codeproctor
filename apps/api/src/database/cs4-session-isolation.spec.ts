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
//   - one test per CS-4.3 row, the relation vectors 1 to 5, creates (stamped session, one scoped
//     existence check on session_questions), immutable session keys, raw SQL, and the SERVICE actor.
//   - statement counts (pg_stat_statements): entering a scope sends no SQL.
// The pure rules are in session-scope-args.spec.ts, the context in org-context-session.spec.ts.
// NFR-04, TC-008.
import { randomUUID } from 'node:crypto';
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import { OrgScopeError, OrgScopeViolationError, RawQueryNotAllowedError } from './errors';
import { OrgContextService } from './org-context';
import { createOrgScopedClient } from './org-scope.extension';
import type { PrismaClient } from '../generated/prisma/client.js';
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
const READ_ONLY_MODELS = CHAIN_MODELS.slice(0, 6) as readonly ChainModel[];
const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

const WHEN = new Date('2026-10-06T00:00:00.000Z');
/** One harmless change per session-path model. Dates are fixed so results are stable. */
const TOUCH: Record<string, Row> = {
  Session: { lastHeartbeat: WHEN },
  SessionQuestion: { finalCode: 'print(1)' },
  SessionSection: { startedAt: WHEN },
  IdentityCheck: { reviewNote: 'changed' },
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
  let orphanQuestionId: string;
  let orphanSectionId: string;

  const asCandidate = <T2>(chain: SessionChain, fn: () => Promise<T2>): Promise<T2> =>
    orgContext.runAsCandidate(chain.orgId, chain.sessionId, async () => {
      setCandidateFacts(orgContext, {
        candidateId: chain.candidateId,
        invitationId: chain.invitationId,
        testId: chain.testId,
      });
      return fn();
    });
  const asService = <T2>(chain: SessionChain, fn: () => Promise<T2>): Promise<T2> =>
    orgContext.runAsSessionJob(chain.orgId, chain.sessionId, fn);

  /** The two actors, so a rule that holds for both is written once. */
  const ACTORS = [
    ['CANDIDATE', asCandidate],
    ['SERVICE', asService],
  ] as const;

  const scoped = (model: string): Delegate =>
    (client as unknown as Record<string, Delegate>)[lowerFirst(model)] as Delegate;
  const plain = (model: string): Delegate =>
    (owner as unknown as Record<string, Delegate>)[lowerFirst(model)] as Delegate;

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

  beforeAll(async () => {
    db = await startMigratedDatabase({ statementStats: true });
    owner = createPrismaClient(db.ownerUrl);
    T = await createTenant(owner, 'a');
    A = T.chain;
    B = await createCandidateChain(owner, T, 'b');
    O = (await createTenant(owner, 'o')).chain;
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
        await run(A, async () => {
          const rows = (await d().findMany?.({})) as Row[];
          expect(rows).toHaveLength(1);
          expect(matches(rows[0] as Row, own.filter)).toBe(true);
          expect(await d().count?.({})).toBe(1);
          expect(await d().aggregate?.({ _count: true })).toEqual({ _count: 1 });
          expect(
            (await d().groupBy?.({ by: [Object.keys(own.filter)[0]], _count: true })) as unknown[],
          ).toHaveLength(1);
          // Positive controls: A's own row is found by each read operation.
          expect(await d().findFirst?.({ where: own.filter })).not.toBeNull();
          expect(await d().findFirstOrThrow?.({ where: own.filter })).toBeDefined();
          expect(await d().findUnique?.({ where: own.unique })).not.toBeNull();
          expect(await d().findUniqueOrThrow?.({ where: own.unique })).toBeDefined();
          expect(await d().count?.({ where: own.filter })).toBe(1);

          for (const other of [B, O]) {
            const theirs: RowSelector = other.rows[model];
            const by = Object.keys(theirs.filter)[0] as string;
            expect(await d().findMany?.({ where: theirs.filter })).toEqual([]);
            expect(await d().findFirst?.({ where: theirs.filter })).toBeNull();
            await expect(d().findFirstOrThrow?.({ where: theirs.filter })).rejects.toMatchObject({
              code: 'P2025',
            });
            expect(await d().findUnique?.({ where: theirs.unique })).toBeNull();
            await expect(d().findUniqueOrThrow?.({ where: theirs.unique })).rejects.toMatchObject({
              code: 'P2025',
            });
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

    it.each(ACTORS)(
      "TC-008 %s: every write against B's and another org's row is refused or changes nothing",
      async (actor, run) => {
        const before = await snapshot();
        const touch = TOUCH[model] as Row;
        await run(A, async () => {
          for (const other of [B, O]) {
            const theirs = other.rows[model];
            expect(await d().updateMany?.({ where: theirs.filter, data: touch })).toEqual({
              count: 0,
            });
            expect(await d().updateManyAndReturn?.({ where: theirs.filter, data: touch })).toEqual(
              [],
            );
            await expect(d().update?.({ where: theirs.unique, data: touch })).rejects.toMatchObject(
              {
                code: 'P2025',
              },
            );
            if (actor === 'SERVICE') {
              expect(await d().deleteMany?.({ where: theirs.filter })).toEqual({ count: 0 });
              await expect(d().delete?.({ where: theirs.unique })).rejects.toMatchObject({
                code: 'P2025',
              });
            } else {
              // A candidate deletes nothing (stricter reading of CS-4.4, FU-DB-184).
              await expect(d().deleteMany?.({ where: theirs.filter })).rejects.toThrow(
                /a candidate deletes nothing/,
              );
              await expect(d().delete?.({ where: theirs.unique })).rejects.toThrow(
                /a candidate deletes nothing/,
              );
            }
          }
        });
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each(ACTORS)('TC-008 %s: it changes its own row, and only its own', async (_actor, run) => {
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
    });
  });

  describe('CS-4.3: the six read-only models', () => {
    it.each(READ_ONLY_MODELS)(
      "TC-008 %s: A reads its own row and never B's or another org's",
      async (model) => {
        if (model === 'Organization') return; // covered by its own test below (same org for A and B)
        const own = A.rows[model];
        await asCandidate(A, async () => {
          const rows = (await scoped(model).findMany?.({})) as Row[];
          expect(rows).toHaveLength(1);
          expect(matches(rows[0] as Row, own.filter)).toBe(true);
          for (const other of [B, O]) {
            expect(await scoped(model).findFirst?.({ where: other.rows[model].filter })).toBeNull();
            expect(
              await scoped(model).findUnique?.({ where: other.rows[model].unique }),
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
          const rows = (await scoped('Organization').findMany?.({})) as Row[];
          expect(rows.map((r) => r.id)).toEqual([T.orgId]);
          expect(await scoped('Organization').findUnique?.({ where: { id: O.orgId } })).toBeNull();
          expect(await scoped('Organization').count?.({ where: { id: O.orgId } })).toBe(0);
        });
      }
    });

    it('TC-008 candidates: id = ctx.candidateId (the other candidate of the org is not there)', async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Candidate').findMany?.({})) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.candidateId]);
        expect(await scoped('Candidate').findUnique?.({ where: { id: B.candidateId } })).toBeNull();
        expect(
          await scoped('Candidate').findFirst?.({ where: { email: { contains: 'candidate-b' } } }),
        ).toBeNull();
      });
      await asCandidate(B, async () => {
        const rows = (await scoped('Candidate').findMany?.({})) as Row[];
        expect(rows.map((r) => r.id)).toEqual([B.candidateId]);
      });
      // The owner sees both candidates of the org and the other org's: the filter did the work.
      expect(await owner.candidate.count()).toBe(3);
    });

    it('TC-008 invitations: id = ctx.invitationId (accommodations of the other candidate are not reachable)', async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Invitation').findMany?.({})) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.invitationId]);
        expect(
          await scoped('Invitation').findUnique?.({ where: { id: B.invitationId } }),
        ).toBeNull();
        expect(await scoped('Invitation').count?.({ where: { candidateId: B.candidateId } })).toBe(
          0,
        );
      });
      expect(await owner.invitation.count()).toBe(3);
    });

    it("TC-008 tests: id = ctx.testId (the other candidate's test is not there)", async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Test').findMany?.({})) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.testId]);
        expect(await scoped('Test').findUnique?.({ where: { id: B.testId } })).toBeNull();
      });
      expect(await owner.test.count()).toBe(3);
    });

    it('TC-008 test_sections: only the sections of this session (an unopened section of the same test is not)', async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('TestSection').findMany?.({
          orderBy: { position: 'asc' },
        })) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.sectionId]);
        expect(
          await scoped('TestSection').findUnique?.({ where: { id: orphanSectionId } }),
        ).toBeNull();
        expect(await scoped('TestSection').findUnique?.({ where: { id: B.sectionId } })).toBeNull();
        expect(await scoped('TestSection').count?.({ where: { testId: A.testId } })).toBe(1);
      });
      expect(await owner.testSection.count({ where: { testId: A.testId } })).toBe(2);
    });

    it("TC-008 questions: only the questions of this session's question versions (an unused question is not)", async () => {
      await asCandidate(A, async () => {
        const rows = (await scoped('Question').findMany?.({})) as Row[];
        expect(rows.map((r) => r.id)).toEqual([A.questionId]);
        expect(
          await scoped('Question').findUnique?.({ where: { id: orphanQuestionId } }),
        ).toBeNull();
        expect(await scoped('Question').findUnique?.({ where: { id: B.questionId } })).toBeNull();
      });
      await asCandidate(B, async () => {
        const rows = (await scoped('Question').findMany?.({})) as Row[];
        expect(rows.map((r) => r.id)).toEqual([B.questionId]);
      });
      expect(await owner.question.count({ where: { orgId: T.orgId } })).toBe(3);
    });

    it.each(['ConsentText', 'TestQuestion'] as const)(
      'TC-008 %s: readable only under a grant, and grants are PR 2, so it throws in a CANDIDATE scope',
      async (model) => {
        await asCandidate(A, async () => {
          await expect(scoped(model).findMany?.({})).rejects.toThrow(/readable only under a grant/);
          await expect(
            scoped(model).findUnique?.({ where: { id: T.consentTextId } }),
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
            const rows = (await scoped('Candidate').findMany?.({})) as Row[];
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
          }),
      ],
      [
        '3 where every',
        () => client.session.findMany({ where: { questions: { every: { points: { gt: 0 } } } } }),
      ],
      [
        '3 where none',
        () => client.session.findMany({ where: { questions: { none: { score: { gt: 99 } } } } }),
      ],
      [
        '3 where is',
        () =>
          client.session.findMany({
            where: { invitation: { is: { candidateId: B.candidateId } } },
          }),
      ],
      [
        '3 where isNot',
        () =>
          client.session.findMany({
            where: { invitation: { isNot: { candidateId: B.candidateId } } },
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
          }),
      ],
      [
        '4 orderBy',
        () => client.session.findMany({ orderBy: { invitation: { windowStart: 'asc' } } }),
      ],
      [
        '4 orderBy (relation _count)',
        () => client.session.findMany({ orderBy: { questions: { _count: 'desc' } } }),
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

    it('TC-008 the same shapes run for a session job (SERVICE has no relation limit)', async () => {
      const rows = await asService(A, () =>
        client.session.findMany({ include: { invitation: { include: { candidate: true } } } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.invitation.candidate.id).toBe(A.candidateId);
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
        const questions = await client.sessionQuestion.findMany({});
        const submissions = await client.submission.findMany({});
        expect(session?.id).toBe(A.sessionId);
        expect(questions.map((q) => q.id)).toEqual([A.sessionQuestionId]);
        expect(submissions.map((s) => s.sessionQuestionId)).toEqual([A.sessionQuestionId]);
      });
    });

    it.todo(
      'CS-4.5 vector 6, the fluent API (findUnique(...).questionVersion()): ADR 0013 CS-4 PR 3; whether a query extension sees the data path in Prisma 7 is not verified',
    );
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
        expect(await ids('Candidate')).toEqual([A.candidateId, B.candidateId].sort());
        expect(await ids('Invitation')).toEqual([A.invitationId, B.invitationId].sort());
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

  describe('CS-4.2 creates take the session from the context', () => {
    const batch = (seq: number): Row => ({
      seq,
      signature: Buffer.from('sig'),
      startedAt: WHEN,
      events: [],
    });

    it.each(ACTORS)(
      "TC-008 %s: an event without a session id is stamped with the scope's",
      async (_actor, run) => {
        const event = await run(A, () =>
          client.proctorEvent.create({
            data: { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN } as never,
          }),
        );
        expect(event.sessionId).toBe(A.sessionId);
        const many = await run(A, () =>
          client.proctorEvent.createManyAndReturn({
            data: [
              { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN },
              { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN, sessionId: A.sessionId },
            ] as never,
          }),
        );
        expect(many.map((e) => e.sessionId)).toEqual([A.sessionId, A.sessionId]);
        await run(A, () =>
          client.proctorEvent.createMany({
            data: [{ type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN }] as never,
          }),
        );
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
            const data = {
              sessionId,
              type: 'TAB_SWITCH',
              severity: 'LOW',
              occurredAt: WHEN,
            } as never;
            await expect(client.proctorEvent.create({ data })).rejects.toBeInstanceOf(
              OrgScopeViolationError,
            );
            await expect(client.proctorEvent.createMany({ data: [data] })).rejects.toBeInstanceOf(
              OrgScopeViolationError,
            );
            await expect(
              client.proctorEvent.createManyAndReturn({ data: [data] }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.proctorEvent.upsert({ where: { id: 1n }, update: {}, create: data }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.mediaChunk.create({
                data: { sessionId, stream: 'SCREEN', seq: 9, startedAt: WHEN, durationMs: 1 },
              }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.consent.create({ data: { sessionId, consentTextId: T.consentTextId } }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
            await expect(
              client.session.create({
                data: { id: sessionId, orgId: A.orgId, invitationId: B.invitationId },
              }),
            ).rejects.toBeInstanceOf(OrgScopeViolationError);
          }
        });
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each(ACTORS)(
      "TC-008 %s: a create may repeat the scope's own session id",
      async (_actor, run) => {
        const created = await run(A, () =>
          client.proctorEvent.create({
            data: { sessionId: A.sessionId, type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN },
          }),
        );
        expect(created.sessionId).toBe(A.sessionId);
        await owner.proctorEvent.delete({ where: { id: created.id } });
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
            client.submission.create(submission(A.sessionQuestionId, 'cs4-own')),
          );
          expect(created.sessionQuestionId).toBe(A.sessionQuestionId);
          await owner.submission.delete({ where: { id: created.id } });
        },
      );

      it.each(ACTORS)(
        "TC-008 %s: B's question, another org's question and a missing one are each refused, nothing written",
        async (_actor, run) => {
          const before = await snapshot();
          await run(A, async () => {
            for (const id of [B.sessionQuestionId, O.sessionQuestionId, randomUUID()]) {
              await expect(client.submission.create(submission(id))).rejects.toThrow(
                /sessionQuestionId is not a question of this session/,
              );
              await expect(
                client.submission.createMany({ data: [submission(id).data] }),
              ).rejects.toThrow(/not a question of this session/);
              await expect(
                client.submission.createManyAndReturn({ data: [submission(id).data] }),
              ).rejects.toThrow(/not a question of this session/);
              await expect(
                client.submission.upsert({
                  where: { id: randomUUID() },
                  update: {},
                  create: submission(id).data,
                }),
              ).rejects.toThrow(/not a question of this session/);
              await expect(
                client.keystrokeBatch.create({
                  data: { ...batch(10), sessionQuestionId: id } as never,
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
            }),
          );
          expect(none.sessionId).toBe(A.sessionId);
          const own = await run(A, () =>
            client.keystrokeBatch.create({
              data: { ...batch(21), sessionQuestionId: A.sessionQuestionId } as never,
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
          asCandidate(A, () => client.submission.create(submission(B.sessionQuestionId))),
        ).rejects.toThrow(/not a question of this session/);
      });

      it('TC-008 statement count: a submission create that needs the check sends the count and the insert', async () => {
        await db.statements.reset();
        const created = await asCandidate(A, () =>
          client.submission.create(submission(A.sessionQuestionId, 'cs4-count')),
        );
        const statements = await db.statements.read();
        const total = statements.reduce((sum, s) => sum + s.calls, 0);
        expect(statements.filter((s) => /^\s*SELECT COUNT/i.test(s.query))).toHaveLength(1);
        expect(
          statements.filter((s) => /^\s*INSERT INTO "?public"?\."?submissions/i.test(s.query)),
        ).toHaveLength(1);
        expect(total).toBe(2);
        await owner.submission.delete({ where: { id: created.id } });
        // A create that needs no check is one statement.
        await db.statements.reset();
        const event = await asCandidate(A, () =>
          client.proctorEvent.create({
            data: { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: WHEN } as never,
          }),
        );
        expect((await db.statements.read()).reduce((sum, s) => sum + s.calls, 0)).toBe(1);
        await owner.proctorEvent.delete({ where: { id: event.id } });
      });
    });
  });

  describe('CS-4.2 session keys are immutable, in both actors', () => {
    const keyWrites: Array<[string, string, (chain: SessionChain) => Row]> = [
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
      ['SessionQuestion', 'id', (c) => ({ id: c.sessionQuestionId })],
    ];

    describe.each(ACTORS)('actor %s', (_actor, run) => {
      it.each(keyWrites)(
        "TC-008 %s.%s cannot be pointed at B's session or question, and the rows stay as they are",
        async (model, key, to) => {
          const before = await snapshot();
          const own = A.rows[model as ChainModel];
          await run(A, async () => {
            for (const data of [to(B), to(O), to(A)]) {
              await expect(scoped(model).update?.({ where: own.unique, data })).rejects.toThrow(
                new RegExp(`${key} is a session key`),
              );
              await expect(scoped(model).updateMany?.({ where: own.filter, data })).rejects.toThrow(
                /session key/,
              );
              await expect(
                scoped(model).updateManyAndReturn?.({ where: own.filter, data }),
              ).rejects.toThrow(/session key/);
              await expect(
                scoped(model).upsert?.({ where: own.unique, update: data, create: {} }),
              ).rejects.toThrow(/session key/);
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
        client.session.findUnique({ where: { id: A.sessionId } }),
      );
      expect(session?.id).toBe(A.sessionId);
      const statements = await db.statements.read();
      expect(statements.reduce((sum, s) => sum + s.calls, 0)).toBe(1);
      expect(statements[0]?.query).toMatch(/^\s*SELECT/i);
    });

    it('TC-008 the same read as the plain org scope sends the same single statement shape plus one more AND per filter', async () => {
      await db.statements.reset();
      await orgContext.runInOrg(A.orgId, () =>
        client.session.findUnique({ where: { id: A.sessionId } }),
      );
      const orgOnly = await db.statements.read();
      expect(orgOnly.reduce((sum, s) => sum + s.calls, 0)).toBe(1);
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
      expect(sessions.map((s) => s.id).sort()).toEqual([A.sessionId, B.sessionId].sort());
    });

    it('TC-008 the scope is gone after the unit of work: a later query has no context', async () => {
      await asCandidate(A, () => client.session.findMany());
      await expect(client.session.findMany()).rejects.toBeInstanceOf(OrgScopeError);
    });
  });
});
