// ADR 0013 CS-4 through the real Prisma client and the real extension, for what is decided before any
// SQL is sent: the CANDIDATE allowlist sweep over every model of the generated client, raw SQL in a
// session scope, the relation vectors, the candidate facts, and the existence check's own rules. The
// client points at a closed port and never connects, so this runs without Docker; a query that is
// ALLOWED fails with a connection error, which tells it apart from a refusal (OrgScopeError). The
// queries that do reach Postgres are in cs4-session-isolation.spec.ts. NFR-04, TC-008.
import { setCandidateFacts } from './candidate-facts';
import { createPrismaClient } from './create-prisma-client';
import {
  OrgContextMissingError,
  OrgScopeError,
  OrgScopeViolationError,
  RawQueryNotAllowedError,
} from './errors';
import { OrgContextService } from './org-context';
import type { ScopeSource, ScopeStore } from './org-context';
import { createOrgScopedClient, orgScopeExtension } from './org-scope.extension';
import { SCOPED_OPERATIONS } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { CANDIDATE_MODELS } from './session-scope-map';
import { readGeneratedModels } from './testing/data-model';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER_SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const SQ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SQ2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const FACTS = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;

/** One harmless column per model, so a candidate read names its select (candidate-interim.ts). */
const KEY_COLUMN: Record<string, string> = {
  SessionSection: 'position',
  ProctorEventBatch: 'seq',
  KeystrokeBatch: 'seq',
};
const selectOf = (model: string): { select: Record<string, true> } => ({
  select: { [KEY_COLUMN[model] ?? 'id']: true },
});

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

describe('session scopes through the real client, without a database (ADR 0013 CS-4; NFR-04, TC-008)', () => {
  const orgContext = new OrgContextService();
  const base = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
  const client = createOrgScopedClient(base, orgContext);

  afterAll(async () => {
    await base.$disconnect();
  });

  function delegate(c: unknown, model: string): Delegate {
    return (c as Record<string, Delegate>)[lowerFirst(model)] as Delegate;
  }

  const asCandidate = <T>(fn: () => Promise<T>): Promise<T> =>
    orgContext.runAsCandidate(ORG, SID, async () => {
      setCandidateFacts(orgContext, FACTS);
      return fn();
    });
  const asService = <T>(fn: () => Promise<T>): Promise<T> =>
    orgContext.runAsSessionJob(ORG, SID, fn);

  /** A refusal by the scope. Anything else (a connection error to the closed port) means "allowed". */
  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  }
  async function isRefused(promise: Promise<unknown>): Promise<boolean> {
    return (await refusal(promise)) instanceof OrgScopeError;
  }

  describe('CS-4.8 every model of the generated client: not on the allowlist, it throws in a CANDIDATE scope', () => {
    let models: string[] = [];

    beforeAll(async () => {
      models = Object.keys(await readGeneratedModels()).sort();
    });

    it('TC-008 the sweep covers the models of the generated client, which the scope map and the allowlist know', () => {
      expect(models).toHaveLength(31);
      expect(models).toEqual(Object.keys(ORG_SCOPE).sort());
      // Every allowlisted name is a model of the client (a rename would silently allow nothing).
      for (const model of Object.keys(CANDIDATE_MODELS)) expect(models).toContain(model);
    });

    it('TC-008 each model not on the CS-4.3 allowlist throws for every operation, before any query', async () => {
      const denied = models.filter((m) => CANDIDATE_MODELS[m as ModelName] === undefined);
      expect(denied).toHaveLength(13);
      for (const model of denied) {
        for (const operation of SCOPED_OPERATIONS) {
          const run = (): Promise<unknown> =>
            asCandidate(
              () =>
                delegate(client, model)[operation]?.({
                  where: { id: 'x' },
                  data: {},
                  create: {},
                  update: {},
                }) as Promise<unknown>,
            );
          await expect(run()).rejects.toThrow(
            `${model}.${operation}: this model is not on the CANDIDATE allowlist`,
          );
        }
      }
    });

    it('TC-008 the two grant-only models throw for every operation until grants exist (ADR 0013 CS-4 PR 2)', async () => {
      for (const model of ['ConsentText', 'TestQuestion']) {
        for (const operation of SCOPED_OPERATIONS) {
          await expect(
            asCandidate(
              () =>
                delegate(client, model)[operation]?.({ where: { id: 'x' } }) as Promise<unknown>,
            ),
          ).rejects.toThrow(/readable only under a grant/);
        }
      }
    });

    it('TC-008 unknown operations (findRaw, aggregateRaw) are refused in a session scope too', async () => {
      for (const operation of ['findRaw', 'aggregateRaw']) {
        for (const run of [asCandidate, asService]) {
          await expect(
            run(() => delegate(client, 'Session')[operation]?.({}) as Promise<unknown>),
          ).rejects.toThrow(/unknown operation/);
        }
      }
    });

    it('TC-008 read-only models refuse every write for a candidate; SERVICE has no such limit', async () => {
      for (const model of [
        'Organization',
        'Candidate',
        'Invitation',
        'Test',
        'TestSection',
        'Question',
      ]) {
        for (const operation of SCOPED_OPERATIONS.filter(
          (op) => !/^(find|count|aggregate|groupBy)/.test(op),
        )) {
          await expect(
            asCandidate(
              () =>
                delegate(client, model)[operation]?.({
                  where: { id: 'x' },
                  data: {},
                  create: {},
                  update: {},
                }) as Promise<unknown>,
            ),
          ).rejects.toThrow(/read-only in a CANDIDATE scope/);
        }
      }
      // SERVICE: the same update on `tests` is not refused by the scope (it reaches the closed port).
      expect(
        await isRefused(
          asService(
            () =>
              delegate(client, 'Test').updateMany?.({
                where: {},
                data: { name: 'n' },
              }) as Promise<unknown>,
          ),
        ),
      ).toBe(false);
    });
  });

  describe('allowed queries are not over-refused (controls: they reach the closed port)', () => {
    it('TC-008 a candidate reads its own session, and every session-path model, scalar columns only', async () => {
      for (const model of [
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
        'Organization',
        'Candidate',
        'Invitation',
        'Test',
        'TestSection',
        'Question',
      ]) {
        const error = await refusal(
          asCandidate(
            () => delegate(client, model).findMany?.(selectOf(model)) as Promise<unknown>,
          ),
        );
        expect(error).toBeDefined();
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });

    it('TC-008 SERVICE reads every model (org filter plus session filter, no allowlist)', async () => {
      for (const model of Object.keys(ORG_SCOPE)) {
        const error = await refusal(
          asService(() => delegate(client, model).findMany?.({}) as Promise<unknown>),
        );
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });
  });

  describe('CS-4.2 raw SQL is refused in a session scope, inside runRawSql too (ADR 0006 section 8.5)', () => {
    const raw = {
      $queryRaw: (c: typeof client) => c.$queryRaw`SELECT 1`,
      $executeRaw: (c: typeof client) => c.$executeRaw`SELECT 1`,
      $queryRawUnsafe: (c: typeof client) => c.$queryRawUnsafe('SELECT 1'),
      $executeRawUnsafe: (c: typeof client) => c.$executeRawUnsafe('SELECT 1'),
    };

    describe.each(Object.entries(raw))('%s', (_name, call) => {
      it.each([
        ['CANDIDATE', asCandidate],
        ['SERVICE', asService],
      ] as const)('TC-008 refused for a %s with no hatch', async (_actor, run) => {
        await expect(run(() => call(client) as Promise<unknown>)).rejects.toBeInstanceOf(
          RawQueryNotAllowedError,
        );
      });

      it.each([
        ['CANDIDATE', asCandidate],
        ['SERVICE', asService],
      ] as const)('TC-008 refused for a %s inside runRawSql', async (_actor, run) => {
        const inner = run(() =>
          orgContext.runRawSql('a reviewed raw statement that must still be refused', () =>
            call(client),
          ),
        );
        await expect(inner).rejects.toBeInstanceOf(RawQueryNotAllowedError);
        await expect(inner).rejects.toThrow(/session scope/);
      });

      it('TC-008 refused by the extension itself, whatever opened the hatch (a store with both)', async () => {
        const store: ScopeStore = {
          scope: {
            kind: 'org',
            orgId: ORG,
            session: { actor: 'SERVICE', sessionId: SID },
          },
          rawSqlReason: 'a hatch that no entry point can open inside a session scope',
        };
        const forged: ScopeSource = { current: () => store, candidateFacts: () => undefined };
        const forgedClient = createOrgScopedClient(base, forged);
        await expect(call(forgedClient)).rejects.toBeInstanceOf(RawQueryNotAllowedError);
      });

      it('TC-008 still allowed in a plain org scope with the hatch (a control: the refusal is the session)', async () => {
        const error = await refusal(
          orgContext.runInOrg(ORG, () =>
            orgContext.runRawSql('a reviewed raw statement for the control', () => call(client)),
          ),
        );
        expect(error).not.toBeInstanceOf(OrgScopeError);
      });
    });
  });

  describe('CS-4.5 the relation vectors, through the real client', () => {
    it('TC-008 each vector throws before any query, for a candidate', async () => {
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['include', () => client.session.findMany({ include: { invitation: true } })],
        [
          'include from sessionQuestion to questionVersion and its testCases',
          () =>
            client.sessionQuestion.findMany({
              include: { questionVersion: { include: { testCases: true } } },
            }),
        ],
        [
          'include from session to other candidates',
          () =>
            client.session.findMany({ include: { invitation: { include: { candidate: true } } } }),
        ],
        ['select', () => client.session.findMany({ select: { id: true, invitation: true } })],
        [
          'where relation filter',
          () => client.session.findMany({ where: { invitation: { is: { candidateId: 'x' } } } }),
        ],
        [
          'where some',
          () => client.session.findMany({ where: { questions: { some: { score: { gt: 0 } } } } }),
        ],
        [
          'orderBy',
          () => client.session.findMany({ orderBy: { invitation: { createdAt: 'asc' } } }),
        ],
        [
          '_count',
          () => client.session.findMany({ select: { _count: { select: { questions: true } } } }),
        ],
        [
          'on findUnique',
          () => client.session.findUnique({ where: { id: SID }, include: { org: true } }),
        ],
        [
          'on update',
          () =>
            client.session.update({
              where: { id: SID },
              data: { authEpoch: 1 },
              include: { org: true },
            }),
        ],
      ];
      for (const [name, call] of calls) {
        const error = await refusal(asCandidate(call));
        expect({ name, refused: error instanceof OrgScopeViolationError }).toEqual({
          name,
          refused: true,
        });
        expect((error as Error).message).toMatch(/CS-4\.5/);
      }
    });

    it('TC-008 the same shapes are not refused for SERVICE (CS-4.1: no relation limit)', async () => {
      const error = await refusal(
        asService(() =>
          client.session.findMany({ include: { invitation: { include: { candidate: true } } } }),
        ),
      );
      expect(error).not.toBeInstanceOf(OrgScopeError);
    });

    it('TC-008 outside a session scope the shapes are not refused either (org scope, rule (i) review item)', async () => {
      const error = await refusal(
        orgContext.runInOrg(ORG, () => client.session.findMany({ include: { invitation: true } })),
      );
      expect(error).not.toBeInstanceOf(OrgScopeError);
    });

    it('TC-008 nested relation writes throw for both actors (ADR 0006 section 8.2)', async () => {
      const nested: Array<() => Promise<unknown>> = [
        () =>
          client.proctorEvent.create({
            data: {
              type: 'TAB_SWITCH',
              severity: 'LOW',
              occurredAt: new Date(),
              session: { connect: { id: OTHER_SID } },
            },
            select: { id: true },
          }),
        () =>
          client.sessionQuestion.update({
            where: { id: SQ },
            data: { submissions: { create: { kind: 'RUN', language: 'python', sourceCode: 'x' } } },
            select: { id: true },
          }),
        () =>
          client.session.update({
            where: { id: SID },
            data: { invitation: { connect: { id: FACTS.invitationId } } },
            select: { id: true },
          }),
      ];
      for (const call of nested) {
        // The job: the nested-write refusal of every scope (ADR 0006 section 8.2).
        await expect(asService(call)).rejects.toThrow(/nested relation write refused/);
        // A candidate: the write allowlist refuses a relation key first (it is not a listed column),
        // and the nested-write refusal is behind it. Either way nothing is written.
        await expect(asCandidate(call)).rejects.toThrow(
          /nested relation write refused|cannot be written by a candidate/,
        );
      }
    });
  });

  describe('CS-4.4 the candidate facts decide the injected filters', () => {
    it('TC-008 candidates, invitations and tests throw while the facts are unset, and read once they are set', async () => {
      for (const model of ['Candidate', 'Invitation', 'Test']) {
        await expect(
          orgContext.runAsCandidate(
            ORG,
            SID,
            () => delegate(client, model).findMany?.(selectOf(model)) as Promise<unknown>,
          ),
        ).rejects.toThrow(/candidate facts are not set/);
        const error = await refusal(
          asCandidate(
            () => delegate(client, model).findMany?.(selectOf(model)) as Promise<unknown>,
          ),
        );
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });

    it('TC-008 the other models need no fact', async () => {
      for (const model of ['Organization', 'TestSection', 'Question', 'Session']) {
        const error = await refusal(
          orgContext.runAsCandidate(
            ORG,
            SID,
            () => delegate(client, model).findMany?.(selectOf(model)) as Promise<unknown>,
          ),
        );
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }
    });

    it('TC-008 no context at all still throws OrgContextMissingError (the session scope adds no way around it)', async () => {
      await expect(client.session.findMany()).rejects.toBeInstanceOf(OrgContextMissingError);
    });
  });

  describe('CS-4.2 the existence check of a create (stubbed lookup; the real one is in cs4-session-isolation.spec.ts)', () => {
    function withLookup(count: jest.Mock<Promise<number>, [Record<string, unknown>]>) {
      return base.$extends(orgScopeExtension(orgContext, count));
    }
    const submission = (id: string) => ({
      data: { sessionQuestionId: id, kind: 'RUN' as const, language: 'python', sourceCode: 'x' },
      select: { id: true as const },
    });

    it('TC-008 a submission or keystroke batch create asks ONE scoped primary-key question, then runs', async () => {
      const count = jest.fn<Promise<number>, [Record<string, unknown>]>().mockResolvedValue(1);
      const scoped = withLookup(count);
      const error = await refusal(asCandidate(() => scoped.submission.create(submission(SQ))));
      expect(error).not.toBeInstanceOf(OrgScopeError); // reached the closed port: the check passed
      expect(count).toHaveBeenCalledTimes(1);
      expect(count).toHaveBeenCalledWith({
        AND: [{ session: { orgId: ORG } }, { sessionId: SID }, { id: { in: [SQ] } }],
      });
    });

    it('TC-008 a miss throws, names no id, and the create never reaches the database', async () => {
      const count = jest.fn<Promise<number>, [Record<string, unknown>]>().mockResolvedValue(0);
      const scoped = withLookup(count);
      for (const run of [asCandidate, asService]) {
        const error = await refusal(run(() => scoped.submission.create(submission(SQ))));
        expect(error).toBeInstanceOf(OrgScopeViolationError);
        expect((error as Error).message).toContain(
          'sessionQuestionId is not a question of this session',
        );
        expect((error as Error).message).not.toContain(SQ);
        const keystroke = await refusal(
          run(() =>
            scoped.keystrokeBatch.create({
              // `sessionId` is stamped by the scope; the typed input asks for it.
              data: {
                sessionQuestionId: SQ,
                seq: 1,
                signature: Buffer.from('s'),
                startedAt: new Date(),
                events: [],
              } as never,
              select: { seq: true },
            }),
          ),
        );
        expect(keystroke).toBeInstanceOf(OrgScopeViolationError);
        expect((keystroke as Error).message).toContain('not a question of this session');
      }
    });

    it('TC-008 createMany asks once for all its rows, and every distinct id must be found', async () => {
      const rows = [SQ, SQ2, SQ].map((id) => submission(id).data);
      const count = jest.fn<Promise<number>, [Record<string, unknown>]>().mockResolvedValue(2);
      const scoped = withLookup(count);
      const ok = await refusal(asCandidate(() => scoped.submission.createMany({ data: rows })));
      expect(ok).not.toBeInstanceOf(OrgScopeError);
      expect(count).toHaveBeenCalledTimes(1);
      expect(count).toHaveBeenCalledWith({
        AND: [{ session: { orgId: ORG } }, { sessionId: SID }, { id: { in: [SQ, SQ2] } }],
      });
      count.mockResolvedValue(1); // one of the two distinct ids is not in this session
      const miss = await refusal(asCandidate(() => scoped.submission.createMany({ data: rows })));
      expect(miss).toBeInstanceOf(OrgScopeViolationError);
    });

    it('TC-008 no question is asked for a refused create, a null reference, a read or an update (each outcome pinned)', async () => {
      const count = jest.fn<Promise<number>, [Record<string, unknown>]>().mockResolvedValue(1);
      const scoped = withLookup(count);
      const batch = {
        seq: 1,
        signature: Buffer.from('s'),
        startedAt: new Date(),
        events: [],
      };

      // A create naming another session is refused by the session rule, before any lookup.
      const wrongSession = await refusal(
        asCandidate(() =>
          scoped.keystrokeBatch.create({
            data: { ...batch, sessionId: OTHER_SID, sessionQuestionId: SQ },
            select: { seq: true },
          }),
        ),
      );
      expect(wrongSession).toBeInstanceOf(OrgScopeViolationError);
      expect((wrongSession as Error).message).toMatch(/not the session of this scope/);

      // A null reference is a valid create with nothing to prove: it reaches the closed port, so
      // the error is the driver's and not the scope's.
      const nullRef = await refusal(
        asCandidate(() =>
          scoped.keystrokeBatch.create({
            data: { ...batch, sessionQuestionId: null } as never,
            select: { seq: true },
          }),
        ),
      );
      expect(nullRef).toBeDefined();
      expect(nullRef).not.toBeInstanceOf(OrgScopeError);

      // A read and an update ask nothing either; both are allowed and reach the closed port.
      const allowedCalls: Array<() => Promise<unknown>> = [
        () => scoped.submission.findMany({ select: { id: true } }),
        () => scoped.sessionQuestion.updateMany({ where: {}, data: { finalCode: 'x' } }),
        () =>
          scoped.proctorEvent.create({
            data: { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: new Date() } as never,
            select: { id: true },
          }),
      ];
      for (const call of allowedCalls) {
        const error = await refusal(asCandidate(call));
        expect(error).toBeDefined();
        expect(error).not.toBeInstanceOf(OrgScopeError);
      }

      // A submission is create only for a candidate: its update is refused, before any lookup.
      const rewrite = await refusal(
        asCandidate(() => scoped.submission.updateMany({ where: {}, data: { language: 'x' } })),
      );
      expect(rewrite).toBeInstanceOf(OrgScopeViolationError);
      expect((rewrite as Error).message).toMatch(
        /cannot update this row: CS-4\.4 grants create only/,
      );

      // A create that names a column off the CS-4.4 write list is refused before any lookup.
      const hidden = await refusal(
        asCandidate(() =>
          scoped.submission.create({
            data: { ...submission(SQ).data, score: 1 },
            select: { id: true },
          }),
        ),
      );
      expect(hidden).toBeInstanceOf(OrgScopeViolationError);
      expect((hidden as Error).message).toMatch(
        /score cannot be written by a candidate create here/,
      );

      expect(count).not.toHaveBeenCalled();
    });

    it('TC-008 an extension built with no lookup fails closed on a create that needs one', async () => {
      const scoped = base.$extends(orgScopeExtension(orgContext));
      await expect(asCandidate(() => scoped.submission.create(submission(SQ)))).rejects.toThrow(
        /no session_questions lookup is configured/,
      );
    });

    it('TC-008 a failing lookup is rethrown as it is (through scrubPrismaError), and the create does not run', async () => {
      const failure = new Error('connection lost');
      const count = jest
        .fn<Promise<number>, [Record<string, unknown>]>()
        .mockRejectedValue(failure);
      const scoped = withLookup(count);
      const error = await refusal(asCandidate(() => scoped.submission.create(submission(SQ))));
      // The very error of the lookup: had the create run, the closed port would have answered instead.
      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(OrgScopeError);
      expect(count).toHaveBeenCalledTimes(1);
    });
  });

  describe('nit 5: the CANDIDATE allowlist runs before the `unscoped` early return', () => {
    // No model is unscoped today, so one is made so for the test (the map is a plain object).
    const unscoped = {
      kind: 'unscoped',
      reason: 'a model that is global on purpose (test only)',
    } as const;

    it('TC-008 an unscoped model that is not on the allowlist throws the allowlist error, not a pass-through', async () => {
      const restore = jest.replaceProperty(ORG_SCOPE, 'AuditLog', unscoped);
      try {
        for (const operation of SCOPED_OPERATIONS) {
          await expect(
            asCandidate(
              () =>
                delegate(client, 'AuditLog')[operation]?.({
                  where: {},
                  data: {},
                  select: { id: true },
                }) as Promise<unknown>,
            ),
          ).rejects.toThrow(/AuditLog\.\w+: this model is not on the CANDIDATE allowlist/);
        }
      } finally {
        restore.restore();
      }
    });

    it('TC-008 an unscoped model that IS on the allowlist has no row filter, so it fails closed for a candidate', async () => {
      const restore = jest.replaceProperty(ORG_SCOPE, 'Test', unscoped);
      try {
        await expect(
          asCandidate(() => client.test.findMany({ select: { id: true } })),
        ).rejects.toThrow(/an unscoped model has no CANDIDATE row filter/);
      } finally {
        restore.restore();
      }
    });

    it('TC-008 every other actor still passes an unscoped model through (a control: the refusal is the candidate rule)', async () => {
      const restore = jest.replaceProperty(ORG_SCOPE, 'AuditLog', unscoped);
      try {
        for (const run of [
          asService,
          <T>(fn: () => Promise<T>): Promise<T> => orgContext.runInOrg(ORG, fn),
          <T>(fn: () => Promise<T>): Promise<T> => orgContext.runSystem('BACKGROUND_JOB', fn),
          <T>(fn: () => Promise<T>): Promise<T> => fn(),
        ]) {
          const error = await refusal(run(() => client.auditLog.findMany({})));
          expect(error).toBeDefined();
          expect(error).not.toBeInstanceOf(OrgScopeError);
        }
      } finally {
        restore.restore();
      }
    });
  });

  describe('CS-4.5 vector 6, the fluent API, through the real client (S6)', () => {
    // Prisma 7 runs `findUnique(...).questions()` as a findUnique on the PARENT model with
    // `select: { questions: true }`, so vector 2 sees a relation in select and refuses it. These
    // tests pin that on Prisma 7.10, so a release that changes the shape breaks the build.
    it('TC-008 a fluent relation call throws as a relation select, for every find operation', async () => {
      const calls: Array<[string, () => Promise<unknown>, RegExp]> = [
        [
          'findUnique(...).questions()',
          () => client.session.findUnique({ where: { id: SID } }).questions(),
          /Session\.questions in select \(vector 2\)/,
        ],
        [
          'findUniqueOrThrow(...).invitation()',
          () => client.session.findUniqueOrThrow({ where: { id: SID } }).invitation(),
          /Session\.invitation in select \(vector 2\)/,
        ],
        [
          'findFirst(...).org()',
          () => client.session.findFirst({ where: { id: SID } }).org(),
          /Session\.org in select \(vector 2\)/,
        ],
        [
          'findFirstOrThrow(...).questions()',
          () => client.session.findFirstOrThrow({ where: { id: SID } }).questions(),
          /Session\.questions in select \(vector 2\)/,
        ],
        [
          'a sessionQuestion to its questionVersion',
          () => client.sessionQuestion.findUnique({ where: { id: SQ } }).questionVersion(),
          /SessionQuestion\.questionVersion in select \(vector 2\)/,
        ],
        [
          'a sessionQuestion to its questionVersion and on to its testCases (a chain)',
          () =>
            client.sessionQuestion
              .findUnique({ where: { id: SQ } })
              .questionVersion()
              .testCases(),
          /SessionQuestion\.questionVersion in select \(vector 2\)/,
        ],
        [
          'a session to its invitation and on to its candidate (a chain)',
          () =>
            client.session
              .findUnique({ where: { id: SID } })
              .invitation()
              .candidate(),
          /Session\.invitation in select \(vector 2\)/,
        ],
        [
          'a to-many with its own arguments',
          () => client.session.findUnique({ where: { id: SID } }).questions({ take: 1 }),
          /Session\.questions in select \(vector 2\)/,
        ],
      ];
      for (const [name, call, message] of calls) {
        const error = await refusal(asCandidate(call));
        expect({ name, refused: error instanceof OrgScopeViolationError }).toEqual({
          name,
          refused: true,
        });
        expect((error as Error).message).toMatch(message);
        expect((error as Error).message).toMatch(/CS-4\.5/);
      }
    });

    it('TC-008 the same call is not refused for SERVICE (CS-4.1: no relation limit)', async () => {
      const error = await refusal(
        asService(() => client.session.findUnique({ where: { id: SID } }).questions()),
      );
      expect(error).toBeDefined();
      expect(error).not.toBeInstanceOf(OrgScopeError);
    });
  });
});
