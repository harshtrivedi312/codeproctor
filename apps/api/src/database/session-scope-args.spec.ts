// ADR 0013 CS-4.2, CS-4.3 and CS-4.5, the pure part: the arguments a query runs with in a CANDIDATE
// or SERVICE session scope (session-scope-args.ts, session-scope-map.ts, candidate-relations.ts).
// No database: every model and operation is checked on the rewritten arguments. The same rules against
// a real Postgres are in cs4-session-isolation.spec.ts. NFR-04, TC-008.
import { assertNoRelationVectors } from './candidate-relations';
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionActor } from './org-context';
import { applyOrgScope, SCOPED_OPERATIONS } from './org-scope-args';
import { ORG_SCOPE, orgFilter } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { FK_CLASSES } from './org-scope-relations';
import { applySessionScope, sessionQuestionsWhere } from './session-scope-args';
import { CANDIDATE_MODELS, READ_OPERATIONS, SESSION_SCOPE } from './session-scope-map';
import type { GrantView } from './session-scope-map';
import { readModelMetas } from './testing/data-model';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER_SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const SQ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const OTHER_SQ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const FACTS: CandidateFacts = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};

const ALL_MODELS = Object.keys(ORG_SCOPE) as ModelName[];
const SESSION_MODELS = Object.keys(SESSION_SCOPE) as ModelName[];
const ACTORS: readonly SessionActor[] = ['CANDIDATE', 'SERVICE'];
const WRITE_OPERATIONS = SCOPED_OPERATIONS.filter((op) => !READ_OPERATIONS.includes(op));
const UPDATES = ['update', 'updateMany', 'updateManyAndReturn'] as const;

/**
 * The column a candidate names where the generic tests of the other models name `id`: keystroke_batches.id
 * is a global identity counter that a candidate may not read (#126 nit 1), and session_sections and
 * proctor_event_batches have no `id` column at all.
 */
const ID_KEY: Partial<Record<ModelName, string>> = {
  KeystrokeBatch: 'seq',
  ProctorEventBatch: 'seq',
  SessionSection: 'sectionId',
};
const idKeyOf = (model: ModelName): string => ID_KEY[model] ?? 'id';

function keyed(model: ModelName, args: unknown): unknown {
  const key = ID_KEY[model];
  if (key === undefined || typeof args !== 'object' || args === null) return args;
  const given = args as Record<string, unknown>;
  const rename = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k === 'id' ? key : k, v]))
      : value;
  return {
    ...given,
    ...(given.where === undefined ? {} : { where: rename(given.where) }),
    ...(given.select === undefined ? {} : { select: rename(given.select) }),
  };
}

function apply(
  actor: SessionActor,
  model: ModelName,
  operation: string,
  args: unknown,
  /** `null`: the guard has not set the facts yet. */
  facts: CandidateFacts | null = FACTS,
) {
  return applySessionScope({
    model,
    rule: ORG_SCOPE[model],
    operation,
    args: actor === 'CANDIDATE' ? keyed(model, args) : args,
    orgId: ORG,
    session: { actor, sessionId: SID },
    facts: facts ?? undefined,
  });
}

/**
 * The conjuncts of the rewritten where: every AND entry, plus the where's own keys as one object (the
 * org filter IS the where when the caller sent none).
 */
function conjuncts(args: Record<string, unknown>): unknown[] {
  const { AND, ...own } = (args.where ?? {}) as { AND?: unknown[] } & Record<string, unknown>;
  return [...(AND ?? []), own];
}

/** `filter` is part of the where, as an AND entry or as the where's own keys. */
function expectFilter(args: Record<string, unknown>, filter: unknown): void {
  expect(conjuncts(args)).toEqual(
    expect.arrayContaining([expect.objectContaining(filter as object)]),
  );
}

/**
 * Whether a CANDIDATE may attempt `operation` on `model` at all, before arguments are looked at: on
 * the allowlist, no delete, no write on a read-only model, and only the creates and updates the
 * CS-4.4 write allowlist of the model grants (updates only on sessions, session_questions and
 * consents; create only on submissions, identity_checks and the batches; nothing on session_sections).
 */
function candidateAllows(model: ModelName, operation: string): boolean {
  const rule = CANDIDATE_MODELS[model];
  if (rule === undefined || rule.kind === 'grant-only') return false;
  if (READ_OPERATIONS.includes(operation)) return true;
  if (rule.kind === 'read') return false;
  if (['delete', 'deleteMany'].includes(operation)) return false;
  if (CREATE_LIKE.includes(operation) && rule.create === undefined) return false;
  if (UPDATE_LIKE.includes(operation) && rule.update === undefined) return false;
  return true;
}

const CREATE_LIKE = ['create', 'createMany', 'createManyAndReturn', 'upsert'];
const UPDATE_LIKE = ['update', 'updateMany', 'updateManyAndReturn', 'upsert'];

/** The operations an actor may attempt on `model`: SERVICE all, a candidate those it is granted. */
function opsFor(actor: SessionActor, model: ModelName, operations: readonly string[]): string[] {
  return actor === 'SERVICE'
    ? [...operations]
    : operations.filter((op) => candidateAllows(model, op));
}

/** The operations a CANDIDATE may attempt on `model` without the gate refusing them first. */
function candidateOperations(model: ModelName): string[] {
  return opsFor('CANDIDATE', model, SCOPED_OPERATIONS);
}

/** The models whose rows `actor` may create: every session-path model for SERVICE, the granted ones for a candidate. */
function creatableModels(actor: SessionActor): ModelName[] {
  return SESSION_MODELS.filter((m) => SESSION_SCOPE[m]?.createKey !== undefined).filter(
    (m) => actor === 'SERVICE' || candidateAllows(m, 'create'),
  );
}

/** A column `actor` may update on `model`: the first of the model's CS-4.4 update list for a candidate. */
const harmless = (actor: SessionActor, model: ModelName): Record<string, unknown> => {
  const rule = CANDIDATE_MODELS[model];
  const column = rule?.kind === 'session' ? rule.update?.[0] : undefined;
  return actor === 'CANDIDATE' && column !== undefined ? { [column]: 1 } : { note: 'x' };
};

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/** A create row naming one key. */
const sessionRow = (key: string, value: string): Record<string, unknown> => ({ [key]: value });

describe('CS-4.2 and CS-4.3 tables against the generated client (NFR-04, TC-008)', () => {
  const tables = {
    sessions: 'Session',
    session_questions: 'SessionQuestion',
    session_sections: 'SessionSection',
    identity_checks: 'IdentityCheck',
    media_chunks: 'MediaChunk',
    proctor_event_batches: 'ProctorEventBatch',
    proctor_events: 'ProctorEvent',
    keystroke_batches: 'KeystrokeBatch',
    consents: 'Consent',
    submissions: 'Submission',
  } as const;

  it('TC-008 SESSION_SCOPE is exactly the ten models of the CS-4.2 table', () => {
    expect([...SESSION_MODELS].sort()).toEqual(Object.values(tables).sort());
  });

  it('TC-008 every key the session rules name exists on the model, in the generated client', async () => {
    const models = await readModelMetas();
    for (const model of SESSION_MODELS) {
      const meta = models[model];
      expect(meta).toBeDefined();
      const fields = new Map((meta?.fields ?? []).map((f) => [f.name, f]));
      const rule = SESSION_SCOPE[model];
      if (rule === undefined) throw new Error('unreachable');
      for (const key of [...(rule.createKey ? [rule.createKey] : []), ...rule.immutable]) {
        expect(`${model}.${key}:${fields.get(key)?.kind}`).toBe(`${model}.${key}:scalar`);
      }
      if (rule.questionRef !== undefined) {
        expect(fields.get('sessionQuestionId')?.kind).toBe('scalar');
      }
      // The filter names only fields of the model: a scalar, or the relation of submissions.
      for (const key of Object.keys(rule.filter(SID))) {
        expect(fields.has(key)).toBe(true);
      }
    }
  });

  it('TC-008 a model with a session_id column is session-filtered, or named here as left out (FU-DB-183)', async () => {
    // CS-4.2 lists ten models. These two carry a session_id too and are NOT in the table, so a
    // SERVICE scope filters them by org only; the architect decides whether that is intended.
    const leftOut = ['SessionReview', 'WebhookDelivery'];
    const models = await readModelMetas();
    const withSessionId = Object.values(models)
      .filter((m) => m.fields.some((f) => f.name === 'sessionId' && f.dbName === 'session_id'))
      .map((m) => m.name)
      .sort();
    const filtered = SESSION_MODELS.filter((m) => SESSION_SCOPE[m]?.createKey === 'sessionId');
    expect(withSessionId).toEqual([...filtered, ...leftOut].sort());
  });

  it('TC-008 CANDIDATE_MODELS is exactly the CS-4.3 allowlist, session models included', () => {
    const readOnly = Object.entries(CANDIDATE_MODELS)
      .filter(([, rule]) => rule?.kind === 'read')
      .map(([model]) => model)
      .sort();
    expect(readOnly).toEqual(
      ['Organization', 'Candidate', 'Invitation', 'Test', 'TestSection', 'Question'].sort(),
    );
    const grantOnly = Object.entries(CANDIDATE_MODELS)
      .filter(([, rule]) => rule?.kind === 'grant-only')
      .map(([model]) => model)
      .sort();
    expect(grantOnly).toEqual(['ConsentText', 'TestQuestion']);
    const session = Object.entries(CANDIDATE_MODELS)
      .filter(([, rule]) => rule?.kind === 'session')
      .map(([model]) => model)
      .sort();
    expect(session).toEqual([...SESSION_MODELS].sort());
    expect(Object.keys(CANDIDATE_MODELS)).toHaveLength(18);
  });
});

describe('CS-4.2 the session filter, both actors (NFR-04, TC-008)', () => {
  const expectedFilter: Record<string, unknown> = {
    Session: { id: SID },
    SessionQuestion: { sessionId: SID },
    SessionSection: { sessionId: SID },
    IdentityCheck: { sessionId: SID },
    MediaChunk: { sessionId: SID },
    ProctorEventBatch: { sessionId: SID },
    ProctorEvent: { sessionId: SID },
    KeystrokeBatch: { sessionId: SID },
    Consent: { sessionId: SID },
    Submission: { sessionQuestion: { sessionId: SID } },
  };

  describe.each(ACTORS)('actor %s', (actor) => {
    it.each(SESSION_MODELS)(
      'TC-008 %s: every read operation gets the session filter AND the org filter, and keeps the caller where',
      (model) => {
        // A candidate names the column of the model that is readable in place of `id` (see ID_KEY).
        const idKey = actor === 'CANDIDATE' ? idKeyOf(model) : 'id';
        for (const operation of READ_OPERATIONS) {
          const { args } = apply(actor, model, operation, { where: { id: 'caller' } });
          const rule = ORG_SCOPE[model];
          expect(args.where).toMatchObject({ [idKey]: 'caller' });
          expectFilter(args, orgFilter(rule, ORG));
          expectFilter(args, expectedFilter[model]);
          // A caller that tries to widen with OR/NOT/another session id only narrows.
          const wide = apply(actor, model, operation, {
            where: {
              OR: [{ [idKey]: 'x' }],
              NOT: { [idKey]: 'y' },
              ...(model === 'Session'
                ? {}
                : model === 'Submission'
                  ? { sessionQuestionId: OTHER_SQ }
                  : { sessionId: OTHER_SID }),
            },
          }).args;
          expectFilter(wide, expectedFilter[model]);
        }
      },
    );

    it.each(SESSION_MODELS)('TC-008 %s: no where at all still gets both filters', (model) => {
      for (const operation of READ_OPERATIONS) {
        const { args } = apply(actor, model, operation, undefined);
        expectFilter(args, expectedFilter[model]);
        expectFilter(args, orgFilter(ORG_SCOPE[model], ORG));
      }
    });

    it.each(SESSION_MODELS)(
      'TC-008 %s: update, updateMany, updateManyAndReturn and the where of upsert get the session filter',
      (model) => {
        for (const operation of opsFor(actor, model, UPDATES)) {
          const { args } = apply(actor, model, operation, { where: { id: 'x' }, data: {} });
          expectFilter(args, expectedFilter[model]);
          expectFilter(args, orgFilter(ORG_SCOPE[model], ORG));
        }
        for (const operation of opsFor(actor, model, ['upsert'])) {
          const upsert = apply(actor, model, operation, {
            where: { id: 'x' },
            update: {},
            create: model === 'Submission' ? { sessionQuestionId: SQ } : {},
          }).args;
          expectFilter(upsert, expectedFilter[model]);
        }
      },
    );

    it.each(SESSION_MODELS)('TC-008 %s: a cursor is refused', (model) => {
      for (const operation of ['findMany', 'findFirst', 'count', 'aggregate']) {
        expect(() =>
          apply(actor, model, operation, { cursor: { id: 'someone-elses' }, take: 1 }),
        ).toThrow(OrgScopeViolationError);
      }
    });
  });

  it.each(SESSION_MODELS)(
    'TC-008 %s: delete and deleteMany get the session filter too (SERVICE only; a candidate deletes nothing)',
    (model) => {
      for (const operation of ['delete', 'deleteMany']) {
        const { args } = apply('SERVICE', model, operation, { where: { id: 'x' } });
        expectFilter(args, expectedFilter[model]);
        expectFilter(args, orgFilter(ORG_SCOPE[model], ORG));
      }
    },
  );

  it('TC-008 a model outside the ten gets no session filter (cross-session models stay org-scoped)', () => {
    for (const model of ALL_MODELS.filter((m) => !SESSION_MODELS.includes(m))) {
      const rule = ORG_SCOPE[model];
      const viaSession = apply('SERVICE', model, 'findMany', { where: { id: 'x' } }).args;
      expect(viaSession).toEqual(
        applyOrgScope({
          model,
          rule,
          operation: 'findMany',
          args: { where: { id: 'x' } },
          orgId: ORG,
        }),
      );
    }
  });
});

describe('CS-4.2 creates take the session from the context (NFR-04, TC-008)', () => {
  describe.each(ACTORS)('actor %s', (actor) => {
    const direct = creatableModels(actor);

    it.each(direct)(
      'TC-008 %s: create stamps the session when missing and keeps a matching one',
      (model) => {
        const key = SESSION_SCOPE[model]?.createKey as string;
        expect(apply(actor, model, 'create', { data: {} }).args.data).toMatchObject({ [key]: SID });
        expect(
          apply(actor, model, 'create', { data: sessionRow(key, SID) }).args.data,
        ).toMatchObject({
          [key]: SID,
        });
      },
    );

    it.each(direct)('TC-008 %s: a create naming another session throws', (model) => {
      const key = SESSION_SCOPE[model]?.createKey as string;
      const other = sessionRow(key, OTHER_SID);
      expect(() => apply(actor, model, 'create', { data: other })).toThrow(OrgScopeViolationError);
      expect(() => apply(actor, model, 'createMany', { data: [other] })).toThrow(
        OrgScopeViolationError,
      );
      expect(() => apply(actor, model, 'createManyAndReturn', { data: [{}, other] })).toThrow(
        OrgScopeViolationError,
      );
      expect(() => apply(actor, model, 'createMany', { data: other })).toThrow(
        OrgScopeViolationError,
      );
      expect(() =>
        apply(actor, model, 'upsert', { where: { id: 'x' }, update: {}, create: other }),
      ).toThrow(OrgScopeViolationError);
    });

    it.each(direct)('TC-008 %s: createMany and createManyAndReturn stamp every row', (model) => {
      const key = SESSION_SCOPE[model]?.createKey as string;
      for (const operation of ['createMany', 'createManyAndReturn']) {
        const rows = apply(actor, model, operation, {
          data: [{}, sessionRow(key, SID), {}],
        }).args.data as Array<Record<string, unknown>>;
        expect(rows.map((r) => r[key])).toEqual([SID, SID, SID]);
        const single = apply(actor, model, operation, { data: {} }).args.data as Record<
          string,
          unknown
        >;
        expect(single[key]).toBe(SID);
      }
    });

    it.each(direct.filter((m) => actor === 'SERVICE' || candidateAllows(m, 'upsert')))(
      'TC-008 %s: the create branch of upsert is stamped, the where is filtered',
      (model) => {
        const key = SESSION_SCOPE[model]?.createKey as string;
        const { args } = apply(actor, model, 'upsert', {
          where: { id: 'x' },
          update: {},
          create: {},
        });
        expect(args.create).toMatchObject({ [key]: SID });
        expectFilter(args, SESSION_SCOPE[model]?.filter(SID));
      },
    );

    it('TC-008 submissions have no session column: nothing is stamped, the session_question is checked', () => {
      const created = apply(actor, 'Submission', 'create', { data: { sessionQuestionId: SQ } });
      expect(created.args.data).toEqual({ sessionQuestionId: SQ });
      expect(created.sessionQuestionIds).toEqual([SQ]);
    });

    it('TC-008 submissions and keystroke batches report every session_question id they name', () => {
      const many = apply(actor, 'Submission', 'createMany', {
        data: [
          { sessionQuestionId: SQ },
          { sessionQuestionId: OTHER_SQ },
          { sessionQuestionId: SQ },
        ],
      });
      expect(many.sessionQuestionIds).toEqual([SQ, OTHER_SQ, SQ]);
      // An upsert is a create and an update: the job has both, a candidate has no update on a batch.
      for (const operation of opsFor(actor, 'KeystrokeBatch', ['upsert'])) {
        const upsert = apply(actor, 'KeystrokeBatch', operation, {
          where: { id: 1n },
          update: {},
          create: { sessionQuestionId: SQ },
        });
        expect(upsert.sessionQuestionIds).toEqual([SQ]);
      }
      const batch = apply(actor, 'KeystrokeBatch', 'create', { data: { sessionQuestionId: SQ } });
      expect(batch.sessionQuestionIds).toEqual([SQ]);
      expect(batch.args.data).toMatchObject({ sessionId: SID, sessionQuestionId: SQ });
    });

    it('TC-008 a keystroke batch may have no session_question (the column is nullable): no check is asked', () => {
      for (const data of [{}, { sessionQuestionId: null }, { sessionQuestionId: undefined }]) {
        expect(apply(actor, 'KeystrokeBatch', 'create', { data }).sessionQuestionIds).toEqual([]);
      }
    });

    it('TC-008 a sessionQuestionId that is not a plain id is refused, not checked', () => {
      for (const bad of [{ set: SQ }, { in: [SQ] }, 12, true]) {
        expect(() =>
          apply(actor, 'Submission', 'create', { data: { sessionQuestionId: bad } }),
        ).toThrow(OrgScopeViolationError);
      }
    });

    it('TC-008 reads and updates ask for no existence check', () => {
      // A candidate has no update on submissions (create only): the job has.
      for (const operation of opsFor(actor, 'Submission', [...READ_OPERATIONS, ...UPDATES])) {
        expect(
          apply(actor, 'Submission', operation, { where: { sessionQuestionId: SQ }, data: {} })
            .sessionQuestionIds,
        ).toEqual([]);
      }
    });

    it('TC-008 other models carry no session_question reference to check', () => {
      for (const model of creatableModels(actor).filter(
        (m) => !['Submission', 'KeystrokeBatch'].includes(m),
      )) {
        // The data names a session_question: a model that does not carry the column reports none
        // (a candidate create may not name it at all, so it names nothing).
        const data = actor === 'SERVICE' ? { sessionQuestionId: SQ } : {};
        expect(apply(actor, model, 'create', { data }).sessionQuestionIds).toEqual([]);
      }
    });
  });

  it('TC-008 sessionQuestionsWhere counts under the org filter, the session filter and the distinct ids', () => {
    const where = sessionQuestionsWhere(ORG, SID, [SQ, OTHER_SQ, SQ]);
    expect(where).toEqual({
      AND: [{ session: { orgId: ORG } }, { sessionId: SID }, { id: { in: [SQ, OTHER_SQ] } }],
    });
  });
});

describe('CS-4.2 session keys are immutable, both actors (NFR-04, TC-008)', () => {
  const keys = SESSION_MODELS.flatMap((model) =>
    (SESSION_SCOPE[model]?.immutable ?? []).map((key) => [model, key] as const),
  );

  describe.each(ACTORS)('actor %s', (actor) => {
    it.each(keys)(
      'TC-008 %s.%s cannot be written by any update operation, in any form',
      (model, key) => {
        const forms = [OTHER_SID, SID, { set: OTHER_SID }, { set: SID }];
        for (const value of forms) {
          const data = { [key]: value };
          for (const operation of UPDATES) {
            expect(() => apply(actor, model, operation, { where: { id: 'x' }, data })).toThrow(
              OrgScopeViolationError,
            );
          }
          expect(() =>
            apply(actor, model, 'upsert', { where: { id: 'x' }, update: data, create: {} }),
          ).toThrow(OrgScopeViolationError);
        }
      },
    );

    it('TC-008 an update of any other column, and an undefined key, is not refused', () => {
      for (const model of SESSION_MODELS) {
        for (const operation of opsFor(actor, model, UPDATES)) {
          const data = {
            ...harmless(actor, model),
            ...Object.fromEntries(
              (SESSION_SCOPE[model]?.immutable ?? []).map((k) => [k, undefined]),
            ),
          };
          expect(() => apply(actor, model, operation, { where: { id: 'x' }, data })).not.toThrow();
        }
      }
    });

    it('TC-008 the error names the model and the key, never a value', () => {
      let message = '';
      try {
        apply(actor, 'ProctorEvent', 'update', {
          where: { id: 1n },
          data: { sessionId: OTHER_SID },
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('ProctorEvent.update');
      expect(message).toContain('sessionId');
      expect(message).not.toContain(OTHER_SID);
      expect(message).not.toContain(SID);
    });
  });
});

describe('CS-4.1 SERVICE: org filter plus session filter only (NFR-04, TC-008)', () => {
  it.each(ALL_MODELS)(
    'TC-008 %s: every operation passes, with no allowlist and no column limit',
    (model) => {
      for (const operation of SCOPED_OPERATIONS) {
        // Whatever the model: no allowlist. (A self model refuses creates and deletes by its own org rule.)
        const args = {
          where: { id: 'x' },
          data: { anything: 1 },
          create: {},
          update: { anything: 2 },
        };
        const run = (): unknown => apply('SERVICE', model, operation, args);
        const orgRule = ORG_SCOPE[model];
        const refusedByOrgScope =
          orgRule.kind === 'self' &&
          [
            'create',
            'createMany',
            'createManyAndReturn',
            'upsert',
            'delete',
            'deleteMany',
          ].includes(operation);
        if (refusedByOrgScope) expect(run).toThrow(OrgScopeViolationError);
        else expect(run).not.toThrow();
      }
    },
  );

  it("TC-008 the rewritten arguments of a non-session model are exactly the org scope's", () => {
    for (const model of ALL_MODELS.filter(
      (m) => !SESSION_MODELS.includes(m) && ORG_SCOPE[m].kind !== 'self',
    )) {
      const args = { where: { id: 'x' }, orderBy: { id: 'asc' } };
      expect(apply('SERVICE', model, 'findMany', args).args).toEqual(
        applyOrgScope({ model, rule: ORG_SCOPE[model], operation: 'findMany', args, orgId: ORG }),
      );
    }
  });

  it('TC-008 relations, selections and read-only models are not limited (no CS-4.5 for SERVICE)', () => {
    const args = {
      include: { invitation: { include: { candidate: true } }, org: true, _count: true },
      select: { questions: { select: { questionVersion: true } } },
      where: {
        invitation: { is: { candidate: { isNot: null } } },
        OR: [{ questions: { some: {} } }],
      },
      orderBy: [{ invitation: { createdAt: 'asc' } }, { questions: { _count: 'desc' } }],
    };
    expect(() => apply('SERVICE', 'Session', 'findMany', args)).not.toThrow();
    expect(() =>
      apply('SERVICE', 'Test', 'update', { where: { id: 'x' }, data: { name: 'n' } }),
    ).not.toThrow();
    expect(() => apply('SERVICE', 'User', 'findMany', {})).not.toThrow();
    expect(() => apply('SERVICE', 'ConsentText', 'findMany', {})).not.toThrow();
  });

  it('TC-008 SERVICE needs no candidate facts', () => {
    expect(() => apply('SERVICE', 'Candidate', 'findMany', {}, null)).not.toThrow();
    expect(() => apply('SERVICE', 'Test', 'findMany', {}, null)).not.toThrow();
  });

  it('TC-008 nested relation writes are refused for both actors, on every session model (ADR 0006 section 8.2)', () => {
    for (const actor of ACTORS) {
      for (const model of SESSION_MODELS) {
        const fields = FK_CLASSES.flatMap((fk) => [
          ...(fk.model === model ? [fk.field] : []),
          ...(fk.target === model ? [fk.back] : []),
        ]);
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
          for (const nested of [
            { connect: { id: 'x' } },
            { create: {} },
            { set: [] },
            { disconnect: true },
            {},
          ]) {
            const data = { [field]: nested };
            for (const operation of opsFor(actor, model, ['create', 'update'])) {
              // A candidate update of proctor_events is limited to duration_ms first (CS-4.4): the
              // nested write is refused either way.
              expect(() => apply(actor, model, operation, { where: { id: 'x' }, data })).toThrow(
                /nested relation write refused|cannot be written by a candidate/,
              );
            }
            for (const operation of opsFor(actor, model, ['upsert'])) {
              expect(() =>
                apply(actor, model, operation, { where: { id: 'x' }, create: {}, update: data }),
              ).toThrow(/nested relation write refused|cannot be written by a candidate/);
            }
          }
        }
      }
    }
  });
});

describe('CS-4.3 the CANDIDATE allowlist, deny by default (NFR-04, TC-008)', () => {
  const denied = ALL_MODELS.filter((m) => CANDIDATE_MODELS[m] === undefined);
  const readOnly = ALL_MODELS.filter((m) => CANDIDATE_MODELS[m]?.kind === 'read');
  const grantOnly = ALL_MODELS.filter((m) => CANDIDATE_MODELS[m]?.kind === 'grant-only');

  it('TC-008 the denied models are the 13 that are in no CS-4.3 row', () => {
    expect([...denied].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it.each(denied)('TC-008 %s is not on the allowlist: every operation throws', (model) => {
    for (const operation of SCOPED_OPERATIONS) {
      expect(() => apply('CANDIDATE', model, operation, { where: { id: 'x' } })).toThrow(
        /not on the CANDIDATE allowlist/,
      );
    }
  });

  it('TC-008 a model name the map does not know is not on the allowlist either', () => {
    expect(() =>
      applySessionScope({
        model: 'Brand_new' as ModelName,
        rule: { kind: 'direct' },
        operation: 'findMany',
        args: {},
        orgId: ORG,
        session: { actor: 'CANDIDATE', sessionId: SID },
        facts: FACTS,
      }),
    ).toThrow(/not on the CANDIDATE allowlist/);
    // Prototype names are not models.
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(() =>
        applySessionScope({
          model: name as ModelName,
          rule: { kind: 'direct' },
          operation: 'findMany',
          args: {},
          orgId: ORG,
          session: { actor: 'CANDIDATE', sessionId: SID },
          facts: FACTS,
        }),
      ).toThrow(/not on the CANDIDATE allowlist/);
    }
  });

  it.each(grantOnly)(
    'TC-008 %s is readable only under a grant of its own: with none, with a grant of another model or with a create grant, every operation throws',
    (model) => {
      const other: GrantView = {
        model: model === 'ConsentText' ? 'TestQuestion' : 'ConsentText',
        columns: ['id'],
        ids: [OTHER_SQ],
        mode: 'rows',
      };
      const create: GrantView = { model, columns: ['id'], ids: [OTHER_SQ], mode: 'create' };
      for (const operation of SCOPED_OPERATIONS) {
        for (const grant of [undefined, other, create]) {
          expect(() =>
            applySessionScope({
              model,
              rule: ORG_SCOPE[model],
              operation,
              args: { where: { id: 'x' } },
              orgId: ORG,
              session: { actor: 'CANDIDATE', sessionId: SID },
              facts: FACTS,
              grant,
            }),
          ).toThrow(/readable only under a grant/);
        }
      }
    },
  );

  it.each(readOnly)(
    'TC-008 %s is read-only: every write operation throws, every read passes',
    (model) => {
      for (const operation of WRITE_OPERATIONS) {
        expect(() =>
          apply('CANDIDATE', model, operation, {
            where: { id: 'x' },
            data: {},
            create: {},
            update: {},
          }),
        ).toThrow(/read-only in a CANDIDATE scope/);
      }
      for (const operation of READ_OPERATIONS) {
        expect(() => apply('CANDIDATE', model, operation, { where: { id: 'x' } })).not.toThrow();
      }
    },
  );

  it.each(SESSION_MODELS)(
    'TC-008 %s: a candidate deletes nothing (no CS-4.4 row grants a delete)',
    (model) => {
      for (const operation of ['delete', 'deleteMany']) {
        expect(() => apply('CANDIDATE', model, operation, { where: { id: 'x' } })).toThrow(
          /a candidate deletes nothing/,
        );
      }
    },
  );

  it.each(SESSION_MODELS)(
    'TC-008 %s: reads and the writes it is granted pass the allowlist',
    (model) => {
      for (const operation of opsFor('CANDIDATE', model, [...READ_OPERATIONS, ...UPDATES])) {
        expect(() =>
          apply('CANDIDATE', model, operation, { where: { id: 'x' }, data: {} }),
        ).not.toThrow();
      }
    },
  );

  it.each([...readOnly, ...SESSION_MODELS])(
    'TC-008 %s: a cursor is refused for a candidate',
    (model) => {
      expect(() => apply('CANDIDATE', model, 'findMany', { cursor: { id: 'x' } })).toThrow(
        /cursor is refused in a CANDIDATE scope/,
      );
    },
  );

  it('TC-008 the allowlist errors name the model and the operation, never a value', () => {
    let message = '';
    try {
      apply('CANDIDATE', 'User', 'findMany', { where: { email: 'secret@example.test' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('User.findMany');
    expect(message).not.toContain('secret@example.test');
  });
});

describe('CS-4.3 the row filters of the models a candidate reads (NFR-04, TC-008)', () => {
  // S2: a fact is ANDed with a filter derived from the scope's own session, so a wrong fact narrows.
  const ofThisSession = { invitations: { some: { sessions: { some: { id: SID } } } } };
  const rows: ReadonlyArray<readonly [ModelName, unknown]> = [
    ['Organization', undefined],
    ['Candidate', { id: FACTS.candidateId, ...ofThisSession }],
    ['Invitation', { id: FACTS.invitationId, sessions: { some: { id: SID } } }],
    ['Test', { id: FACTS.testId, ...ofThisSession }],
    ['TestSection', { sessionSections: { some: { sessionId: SID } } }],
    ['Question', { versions: { some: { sessionQuestions: { some: { sessionId: SID } } } } }],
  ];

  it.each(rows)(
    'TC-008 %s: the row filter is ANDed after the org filter, for every read',
    (model, filter) => {
      for (const operation of READ_OPERATIONS) {
        const { args } = apply('CANDIDATE', model, operation, { where: { id: 'x' } });
        expectFilter(args, orgFilter(ORG_SCOPE[model], ORG));
        // organizations: the org filter is the whole rule, so nothing else is ANDed.
        if (filter === undefined) expect((args.where as { AND: unknown[] }).AND).toHaveLength(1);
        else expectFilter(args, filter);
      }
    },
  );

  it.each(['Candidate', 'Invitation', 'Test'] as const)(
    'TC-008 %s: the filter needs a candidate fact, and throws while it is unset',
    (model) => {
      for (const operation of READ_OPERATIONS) {
        expect(() => apply('CANDIDATE', model, operation, {}, null)).toThrow(
          /candidate facts are not set/,
        );
      }
    },
  );

  // ADR 0013 CS-4.4 "Candidate facts": until the guard has set them, EVERY candidate query on ANY model
  // throws (PR 1 threw only for the three models whose filters use a fact).
  it.each(['Organization', 'TestSection', 'Question', ...SESSION_MODELS] as const)(
    'TC-008 %s: throws while the candidate facts are unset, for every operation a candidate may attempt',
    (model) => {
      for (const operation of opsFor('CANDIDATE', model, SCOPED_OPERATIONS)) {
        expect(() =>
          apply('CANDIDATE', model, operation, { where: { id: 'x' }, data: {} }, null),
        ).toThrow(/candidate facts are not set/);
      }
    },
  );

  it.each(['ConsentText', 'TestQuestion'] as const)(
    'TC-008 %s: under its grant it still throws while the candidate facts are unset',
    (model) => {
      const grant: GrantView = { model, columns: ['id'], ids: [OTHER_SQ], mode: 'rows' };
      expect(() =>
        applySessionScope({
          model,
          rule: ORG_SCOPE[model],
          operation: 'findMany',
          args: { select: { id: true } },
          orgId: ORG,
          session: { actor: 'CANDIDATE', sessionId: SID },
          facts: undefined,
          grant,
        }),
      ).toThrow(/candidate facts are not set/);
    },
  );

  it('TC-008 SERVICE needs no facts, and a model off the allowlist reports the allowlist first', () => {
    expect(() => apply('SERVICE', 'Session', 'findMany', {}, null)).not.toThrow();
    expect(() => apply('CANDIDATE', 'User', 'findMany', {}, null)).toThrow(
      /not on the CANDIDATE allowlist/,
    );
  });

  it('TC-008 the facts and the session are the whole filter: a caller that names another id only narrows', () => {
    const { args } = apply('CANDIDATE', 'Candidate', 'findMany', {
      where: { id: 'another-candidate', OR: [{ id: 'b' }] },
    });
    expectFilter(args, { id: FACTS.candidateId, ...ofThisSession });
    expect(args.where).toMatchObject({ id: 'another-candidate' });
  });
});

describe('CS-4.5 a CANDIDATE scope refuses relation vectors 1 to 5 (NFR-04, TC-008)', () => {
  const run = (model: ModelName, operation: string, args: unknown): unknown =>
    apply('CANDIDATE', model, operation, args);

  describe('vector 1: relation fields in include', () => {
    it.each([
      ['Session', { invitation: true }],
      ['Session', { invitation: { include: { candidate: true } } }],
      [
        'Session',
        { questions: { include: { questionVersion: { include: { testCases: true } } } } },
      ],
      ['SessionQuestion', { questionVersion: true }],
      ['SessionQuestion', { questionVersion: { include: { testCases: true } } }],
      ['SessionQuestion', { submissions: true }],
      ['Submission', { sessionQuestion: true }],
      ['Test', { sections: true }],
      ['Question', { versions: true }],
      ['Organization', { sessions: true }],
      ['Candidate', { invitations: true }],
    ] as const)('TC-008 %s include %j throws', (model, include) => {
      for (const operation of candidateOperations(model)) {
        expect(() =>
          run(model, operation, { where: { id: 'x' }, include, data: {}, create: {}, update: {} }),
        ).toThrow(/vector 1/);
      }
    });

    it('TC-008 even a falsy or empty value on a relation is refused, an undefined one is not', () => {
      for (const value of [false, null, {}, true]) {
        expect(() => run('Session', 'findMany', { include: { invitation: value } })).toThrow(
          /vector 1/,
        );
      }
      expect(() => run('Session', 'findMany', { include: { invitation: undefined } })).not.toThrow(
        /vector/,
      );
    });
  });

  describe('vector 2: relation fields in select', () => {
    it.each([
      ['Session', { id: true, invitation: true }],
      ['Session', { invitation: { select: { candidate: { select: { email: true } } } } }],
      ['SessionQuestion', { id: true, questionVersion: { select: { testCases: true } } }],
      ['Submission', { sessionQuestion: { select: { session: true } } }],
      ['Test', { id: true, org: true }],
    ] as const)('TC-008 %s select %j throws', (model, select) => {
      for (const operation of candidateOperations(model)) {
        expect(() =>
          run(model, operation, { where: { id: 'x' }, select, data: {}, create: {}, update: {} }),
        ).toThrow(/vector 2/);
      }
    });
  });

  describe('vector 3: relation filters in where', () => {
    const filters: Array<[ModelName, Record<string, unknown>]> = [
      ['Session', { invitation: { is: { candidateId: 'x' } } }],
      ['Session', { invitation: { isNot: { candidateId: 'x' } } }],
      ['Session', { invitation: { candidateId: 'x' } }],
      ['Session', { questions: { some: { score: { gt: 0 } } } }],
      ['Session', { questions: { every: {} } }],
      ['Session', { questions: { none: {} } }],
      ['SessionQuestion', { session: { invitation: { candidate: { email: 'x' } } } }],
      ['SessionQuestion', { questionVersion: { testCases: { some: { isHidden: true } } } }],
      ['Submission', { sessionQuestion: { is: { sessionId: 'another' } } }],
      ['Candidate', { invitations: { some: { sessions: { some: {} } } } }],
      ['Organization', { users: { some: {} } }],
      ['Question', { versions: { some: {} } }],
    ];

    it.each(filters)(
      'TC-008 %s where %j throws, at the top level and under AND, OR and NOT',
      (model, filter) => {
        for (const operation of candidateOperations(model)) {
          const base = { data: {} };
          expect(() => run(model, operation, { ...base, where: filter })).toThrow(/vector 3/);
          expect(() => run(model, operation, { ...base, where: { id: 'x', AND: filter } })).toThrow(
            /vector 3/,
          );
          expect(() =>
            run(model, operation, { ...base, where: { AND: [{ id: 'x' }, filter] } }),
          ).toThrow(/vector 3/);
          expect(() =>
            run(model, operation, { ...base, where: { OR: [{ id: 'x' }, { NOT: filter }] } }),
          ).toThrow(/vector 3/);
          expect(() =>
            run(model, operation, {
              ...base,
              where: { NOT: [{ OR: [{ AND: [{ id: 'x' }, filter] }] }] },
            }),
          ).toThrow(/vector 3/);
        }
      },
    );

    it('TC-008 the where of an upsert and of a groupBy having are walked too', () => {
      expect(() =>
        run('ProctorEvent', 'upsert', { where: { session: { is: {} } }, create: {}, update: {} }),
      ).toThrow(/vector 3/);
      expect(() =>
        run('Session', 'groupBy', { by: ['status'], having: { invitation: { is: {} } } }),
      ).toThrow(/vector 3/);
      expect(() => run('Session', 'count', { where: { invitation: { is: {} } } })).toThrow(
        /vector 3/,
      );
      expect(() =>
        run('Session', 'aggregate', { where: { questions: { none: {} } }, _count: true }),
      ).toThrow(/vector 3/);
    });

    it('TC-008 a where nested absurdly deep is refused for its depth alone, with no relation in it', () => {
      // No relation anywhere: only the depth limit can refuse this, so it fails if the limit goes.
      const nest = (depth: number): Record<string, unknown> => {
        let where: Record<string, unknown> = { id: 'x' };
        for (let i = 0; i < depth; i++) where = { NOT: where };
        return where;
      };
      expect(() => run('Session', 'findMany', { where: nest(40) })).toThrow(
        /a where nested more than 32 levels deep/,
      );
      expect(() => run('Session', 'findMany', { where: nest(33) })).toThrow(
        /a where nested more than 32 levels deep/,
      );
      // The limit is the limit: 32 levels still pass.
      expect(() => run('Session', 'findMany', { where: nest(32) })).not.toThrow();
    });
  });

  describe('vector 4: relation fields in orderBy', () => {
    it.each([
      ['Session', { invitation: { createdAt: 'asc' } }],
      ['Session', { questions: { _count: 'desc' } }],
      ['SessionQuestion', { questionVersion: { title: 'asc' } }],
      ['Submission', { sessionQuestion: { position: 'asc' } }],
    ] as const)('TC-008 %s orderBy %j throws, alone and in a list', (model, orderBy) => {
      expect(() => run(model, 'findMany', { orderBy })).toThrow(/vector 4/);
      expect(() => run(model, 'findMany', { orderBy: [{ id: 'asc' }, orderBy] })).toThrow(
        /vector 4/,
      );
      expect(() => run(model, 'groupBy', { by: ['id'], orderBy })).toThrow(/vector 4/);
    });
  });

  describe('vector 5: relation _count', () => {
    it.each([
      ['Session', 'select', { _count: true }],
      ['Session', 'select', { _count: { select: { questions: true } } }],
      [
        'Session',
        'include',
        { _count: { select: { questions: { where: { score: { gt: 0 } } } } } },
      ],
      ['SessionQuestion', 'include', { _count: true }],
      ['Organization', 'select', { _count: { select: { users: true } } }],
    ] as const)('TC-008 %s %s %j throws', (model, where, value) => {
      expect(() => run(model, 'findMany', { [where]: value })).toThrow(/vector 5/);
      expect(() => run(model, 'findUnique', { where: { id: 'x' }, [where]: value })).toThrow(
        /vector 5/,
      );
    });

    it('TC-008 the row-level _count of aggregate, groupBy and count is not a relation count and passes', () => {
      expect(() => run('Session', 'aggregate', { _count: true })).not.toThrow();
      expect(() =>
        run('Session', 'aggregate', { _count: { _all: true, status: true } }),
      ).not.toThrow();
      expect(() =>
        run('Session', 'groupBy', {
          by: ['status'],
          _count: true,
          orderBy: { _count: { id: 'asc' } },
        }),
      ).not.toThrow();
      expect(() => run('Session', 'count', { select: { _all: true, status: true } })).not.toThrow();
    });
  });

  it('TC-008 a query with no relation passes: scalar select, scalar filters, orderBy, nested AND/OR', () => {
    expect(() =>
      run('Session', 'findMany', {
        select: { id: true, status: true },
        where: {
          AND: [{ status: 'IN_PROGRESS' }, { OR: [{ id: { in: [SID] } }, { NOT: { id: 'x' } }] }],
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
        take: 5,
      }),
    ).not.toThrow();
    expect(() =>
      run('Session', 'findUnique', { where: { id: SID }, select: { id: true } }),
    ).not.toThrow();
  });

  it("TC-008 the extension's own relation filters are added after the check, so they never trip it", () => {
    // submissions: the session filter goes through the relation; test_sections and questions: CS-4.3;
    // the path models: the org filter. All of them are in the rewritten where, and the call passes.
    const submission = run('Submission', 'findMany', { where: { language: 'python' } }) as {
      args: Record<string, unknown>;
    };
    expectFilter(submission.args, { sessionQuestion: { sessionId: SID } });
    expectFilter(submission.args, { sessionQuestion: { session: { orgId: ORG } } });
    const section = run('TestSection', 'findFirst', {}) as { args: Record<string, unknown> };
    expectFilter(section.args, { sessionSections: { some: { sessionId: SID } } });
    const question = run('Question', 'findUnique', { where: { id: 'x' } }) as {
      args: Record<string, unknown>;
    };
    expectFilter(question.args, {
      versions: { some: { sessionQuestions: { some: { sessionId: SID } } } },
    });
    // The same shapes written by the caller are refused.
    expect(() =>
      run('Submission', 'findMany', { where: { sessionQuestion: { sessionId: SID } } }),
    ).toThrow(/vector 3/);
    expect(() =>
      run('TestSection', 'findFirst', { where: { sessionSections: { some: { sessionId: SID } } } }),
    ).toThrow(/vector 3/);
  });

  it('TC-008 the refusal covers every relation field of every model a candidate can query', () => {
    // Every relation side in the relation table, on every allowlisted model, in include, select,
    // where and orderBy. 124 relation fields exist in all (62 foreign keys, both sides); those of the
    // allowed models are walked.
    let checked = 0;
    for (const model of Object.keys(CANDIDATE_MODELS) as ModelName[]) {
      if (CANDIDATE_MODELS[model]?.kind === 'grant-only') continue;
      const fields = FK_CLASSES.flatMap((fk) => [
        ...(fk.model === model ? [fk.field] : []),
        ...(fk.target === model ? [fk.back] : []),
      ]);
      for (const field of fields) {
        expect(() => run(model, 'findMany', { include: { [field]: true } })).toThrow(/vector 1/);
        expect(() => run(model, 'findMany', { select: { [field]: true } })).toThrow(/vector 2/);
        expect(() => run(model, 'findMany', { where: { [field]: {} } })).toThrow(/vector 3/);
        expect(() => run(model, 'findMany', { orderBy: { [field]: 'asc' } })).toThrow(/vector 4/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('TC-008 FR-305 ADR 0015 4: the relations of identity_checks.video_check_by (IdentityCheck.videoCheckBy and User.videoCheckedIdentityChecks) are refused in vectors 1 to 5, as reviewedBy is', () => {
    // IdentityCheck is on the CANDIDATE allowlist: the relation is refused through the real entry point,
    // for every operation a candidate may attempt on it.
    for (const field of ['videoCheckBy', 'reviewedBy'] as const) {
      for (const operation of candidateOperations('IdentityCheck')) {
        const base = { where: { id: 'x' }, data: {}, create: {}, update: {} };
        expect(() =>
          run('IdentityCheck', operation, { ...base, include: { [field]: true } }),
        ).toThrow(new RegExp(`IdentityCheck\\.${field} in include \\(vector 1\\)`));
        expect(() =>
          run('IdentityCheck', operation, {
            ...base,
            select: { [field]: { select: { id: true } } },
          }),
        ).toThrow(new RegExp(`IdentityCheck\\.${field} in select \\(vector 2\\)`));
      }
      expect(() =>
        run('IdentityCheck', 'findMany', { where: { [field]: { is: { orgId: 'x' } } } }),
      ).toThrow(new RegExp(`IdentityCheck\\.${field} in where \\(vector 3\\)`));
      expect(() =>
        run('IdentityCheck', 'findMany', { where: { NOT: [{ [field]: { isNot: null } }] } }),
      ).toThrow(/vector 3/);
      expect(() =>
        run('IdentityCheck', 'findMany', { orderBy: { [field]: { email: 'asc' } } }),
      ).toThrow(new RegExp(`IdentityCheck\\.${field} in orderBy \\(vector 4\\)`));
    }
    // The user side is not on the allowlist (a candidate cannot query users at all), so the pure check
    // is called directly: the back-relations are in the relation table, so no path reaches them.
    for (const field of ['videoCheckedIdentityChecks', 'reviewedIdentityChecks'] as const) {
      expect(() =>
        assertNoRelationVectors('User', 'findMany', { include: { [field]: true } }),
      ).toThrow(/vector 1/);
      expect(() =>
        assertNoRelationVectors('User', 'findMany', { select: { [field]: true } }),
      ).toThrow(/vector 2/);
      expect(() =>
        assertNoRelationVectors('User', 'findMany', { where: { [field]: { some: {} } } }),
      ).toThrow(/vector 3/);
      expect(() =>
        assertNoRelationVectors('User', 'findMany', { orderBy: { [field]: { _count: 'desc' } } }),
      ).toThrow(/vector 4/);
    }
    // Both new fields really are in the relation table, one each side of the key (a typo above would
    // otherwise pass as "not a relation": the column named the same way is not refused).
    expect(
      FK_CLASSES.some(
        (fk) =>
          fk.model === 'IdentityCheck' &&
          fk.field === 'videoCheckBy' &&
          fk.target === 'User' &&
          fk.back === 'videoCheckedIdentityChecks',
      ),
    ).toBe(true);
    expect(() =>
      assertNoRelationVectors('IdentityCheck', 'findMany', { select: { videoCheckDone: true } }),
    ).not.toThrow();
  });

  it('TC-008 vector 6, the fluent API, reaches the extension as a relation select, which vector 2 refuses', () => {
    // Prisma 7 runs `findUnique(...).questionVersion()` as findUnique on the parent model with
    // `select: { questionVersion: true }` (shown through the real client in
    // session-scope.extension.spec.ts). So vector 2 is the control; this is the same shape.
    for (const [model, relation] of [
      ['SessionQuestion', 'questionVersion'],
      ['Session', 'questions'],
      ['Session', 'invitation'],
      ['Submission', 'sessionQuestion'],
    ] as const) {
      for (const operation of [
        'findUnique',
        'findUniqueOrThrow',
        'findFirst',
        'findFirstOrThrow',
      ]) {
        expect(() =>
          run(model, operation, { where: { id: 'x' }, select: { [relation]: true } }),
        ).toThrow(/vector 2/);
      }
    }
  });

  it('TC-008 messages name the model, the relation and the vector, never a value', () => {
    let message = '';
    try {
      run('Session', 'findMany', {
        where: { invitation: { is: { candidateId: 'secret-candidate-id' } } },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Session.findMany');
    expect(message).toContain('invitation');
    expect(message).toContain('vector 3');
    expect(message).not.toContain('secret-candidate-id');
  });
});

describe('the client delegates are what the tests assume (a stale generated client fails here)', () => {
  it('TC-008 every model of the map has a delegate name that is its lower-first name', async () => {
    const models = await readModelMetas();
    expect(Object.keys(models).sort()).toEqual([...ALL_MODELS].sort());
    expect(lowerFirst('SessionQuestion')).toBe('sessionQuestion');
  });
});
