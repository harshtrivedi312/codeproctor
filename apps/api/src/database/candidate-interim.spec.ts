// The review fixes S1 (keys behind the filters), S3 (the interim column control) and the CS-4.4 rules
// for proctor_events that came with it, on the rewritten arguments. No database. The same rules
// against a real Postgres are in cs4-session-isolation.spec.ts. NFR-04, TC-008.
import { CANDIDATE_INTERIM_DENY, ROW_RETURNING_OPERATIONS } from './candidate-interim';
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionActor } from './org-context';
import { SCOPED_OPERATIONS } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { applySessionScope } from './session-scope-args';
import { CANDIDATE_MODELS, READ_OPERATIONS } from './session-scope-map';
import { readModelMetas } from './testing/data-model';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FACTS: CandidateFacts = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};

/** Calls the scope exactly as given: no select is added for the caller. */
function raw(actor: SessionActor, model: ModelName, operation: string, args: unknown) {
  return applySessionScope({
    model,
    rule: ORG_SCOPE[model],
    operation,
    args,
    orgId: ORG,
    session: { actor, sessionId: SID },
    facts: FACTS,
  });
}
const asCandidate = (model: ModelName, operation: string, args: unknown) =>
  raw('CANDIDATE', model, operation, args);
const asService = (model: ModelName, operation: string, args: unknown) =>
  raw('SERVICE', model, operation, args);

const UPDATES = ['update', 'updateMany', 'updateManyAndReturn'] as const;
const CREATES = ['create', 'createMany', 'createManyAndReturn'] as const;
const WRITES = [...UPDATES, ...CREATES, 'upsert'] as const;

/** `data` for a write of `operation`, in the shape that operation takes. */
function writeArgs(operation: string, row: Record<string, unknown>): Record<string, unknown> {
  switch (operation) {
    case 'upsert':
      return { where: { id: 'x' }, create: row, update: row, select: { id: true } };
    case 'createMany':
      return { data: [row] };
    case 'createManyAndReturn':
      return { data: [row], select: { id: true } };
    case 'create':
      return { data: row, select: { id: true } };
    case 'updateMany':
      return { where: { id: 'x' }, data: row };
    default:
      return { where: { id: 'x' }, data: row, select: { id: true } };
  }
}

describe('S1: keys behind the filters cannot be written (ADR 0013 CS-4.2, CS-4.4; NFR-04, TC-008)', () => {
  describe.each(['CANDIDATE', 'SERVICE'] as const)('actor %s', (actor) => {
    const run = (model: ModelName, operation: string, args: unknown) =>
      raw(actor, model, operation, args);

    it.each([OTHER, SID, { set: OTHER }, { set: SID }, null])(
      'TC-008 sessions.invitationId is a session key: no update writes it (%j)',
      (value) => {
        for (const operation of UPDATES) {
          expect(() =>
            run('Session', operation, writeArgs(operation, { invitationId: value })),
          ).toThrow(/invitationId is a session key/);
        }
        expect(() =>
          run('Session', 'upsert', writeArgs('upsert', { invitationId: value })),
        ).toThrow(OrgScopeViolationError);
      },
    );
  });

  describe('CANDIDATE: session_questions keys feed the questions filter', () => {
    it.each(['questionVersionId', 'testQuestionId', 'variantId'])(
      'TC-008 %s cannot be written by any update, in any form',
      (key) => {
        for (const value of [OTHER, { set: OTHER }, null]) {
          for (const operation of UPDATES) {
            expect(() =>
              asCandidate('SessionQuestion', operation, writeArgs(operation, { [key]: value })),
            ).toThrow(new RegExp(`${key} is a session key`));
          }
          expect(() =>
            asCandidate('SessionQuestion', 'upsert', writeArgs('upsert', { [key]: value })),
          ).toThrow(OrgScopeViolationError);
        }
      },
    );

    it('TC-008 a session job (SERVICE) may still write them: it assigns the questions', () => {
      for (const key of ['questionVersionId', 'testQuestionId', 'variantId']) {
        for (const operation of UPDATES) {
          expect(() =>
            asService('SessionQuestion', operation, writeArgs(operation, { [key]: OTHER })),
          ).not.toThrow();
        }
      }
    });

    it('TC-008 the columns CS-4.4 grants (final_code, final_language, answer) still update', () => {
      for (const operation of UPDATES) {
        expect(() =>
          asCandidate(
            'SessionQuestion',
            operation,
            writeArgs(operation, { finalCode: 'x', finalLanguage: 'python', answer: {} }),
          ),
        ).not.toThrow();
      }
    });
  });

  describe('CANDIDATE: a planted row is refused', () => {
    it.each(['Session', 'SessionQuestion', 'SessionSection'] as const)(
      'TC-008 %s: create, createMany, createManyAndReturn and the create branch of upsert throw',
      (model) => {
        for (const operation of [...CREATES, 'upsert']) {
          expect(() => asCandidate(model, operation, writeArgs(operation, {}))).toThrow(
            OrgScopeViolationError,
          );
        }
        expect(() => asCandidate(model, 'create', writeArgs('create', {}))).toThrow(
          model === 'SessionSection' ? /writes nothing here/ : /cannot create this row/,
        );
      },
    );

    it.each(['Session', 'SessionQuestion', 'SessionSection'] as const)(
      'TC-008 %s: a session job (SERVICE) still creates it',
      (model) => {
        for (const operation of CREATES) {
          expect(() => asService(model, operation, writeArgs(operation, {}))).not.toThrow();
        }
      },
    );

    it('TC-008 session_sections: a candidate writes nothing, sectionId and the deadlines included (CS-4.4 "none")', () => {
      for (const operation of WRITES) {
        for (const row of [
          { sectionId: OTHER },
          { deadlineAt: new Date() },
          { endedAt: new Date() },
        ]) {
          expect(() => asCandidate('SessionSection', operation, writeArgs(operation, row))).toThrow(
            /writes nothing here/,
          );
        }
      }
      // Reads are still allowed.
      for (const operation of READ_OPERATIONS) {
        expect(() =>
          asCandidate('SessionSection', operation, {
            where: { sessionId: SID },
            select: { position: true },
          }),
        ).not.toThrow();
      }
    });
  });
});

describe('S3: the interim column control, CANDIDATE_INTERIM_DENY (NFR-04, TC-008)', () => {
  const denyEntries = Object.entries(CANDIDATE_INTERIM_DENY) as Array<
    [ModelName, { read: readonly string[]; write: readonly string[] }]
  >;
  const readColumns = denyEntries.flatMap(([model, deny]) =>
    deny.read.map((column) => [model, column] as const),
  );
  const writeOnlyColumns = denyEntries.flatMap(([model, deny]) =>
    deny.write.filter((c) => !deny.read.includes(c)).map((column) => [model, column] as const),
  );

  it('TC-008 names exactly the columns of the review, each a scalar of its model in the generated client', async () => {
    const asObject = Object.fromEntries(denyEntries.map(([model, deny]) => [model, deny.read]));
    expect(asObject).toEqual({
      Session: ['hmacKeyEnc', 'deviceInfo', 'totalScore', 'riskScore', 'riskBand', 'reportKey'],
      Invitation: ['accommodations'],
      IdentityCheck: [
        'faceMatchScore',
        'modelId',
        'threshold',
        'reviewReason',
        'manualDecision',
        'reviewedById',
        'reviewedAt',
        'reviewNote',
      ],
      Organization: ['settings'],
      Test: ['settings'],
      Submission: ['score', 'results', 'passed', 'total'],
      SessionQuestion: ['score', 'scoringNote'],
    });
    expect(Object.fromEntries(writeOnlyColumns.map(([m, c]) => [`${m}.${c}`, true]))).toEqual({
      'Session.status': true,
      'Session.pauseReasons': true,
      'Session.submittedAt': true,
      'Session.authEpoch': true,
      'Session.startedAt': true,
      'Session.deadlineAt': true,
      'Session.pausedMs': true,
      'IdentityCheck.status': true,
    });
    const models = await readModelMetas();
    for (const [model, deny] of denyEntries) {
      const fields = new Map((models[model]?.fields ?? []).map((f) => [f.name, f.kind]));
      for (const column of deny.write) {
        // An enum column is a scalar too (Prisma calls its kind `enum`).
        expect(['scalar', 'enum']).toContain(fields.get(column));
      }
    }
  });

  it('TC-008 every model it names is on the CANDIDATE allowlist (an entry for another would be dead)', () => {
    for (const [model] of denyEntries) {
      expect(CANDIDATE_MODELS[model]).toBeDefined();
    }
  });

  describe('every call that returns rows names its select', () => {
    const models = Object.keys(CANDIDATE_MODELS).filter(
      (m) => CANDIDATE_MODELS[m as ModelName]?.kind !== 'grant-only',
    ) as ModelName[];

    it('TC-008 the row-returning operations are exactly the ones that carry rows', () => {
      expect([...ROW_RETURNING_OPERATIONS].sort()).toEqual(
        [
          'findUnique',
          'findUniqueOrThrow',
          'findFirst',
          'findFirstOrThrow',
          'findMany',
          'create',
          'createManyAndReturn',
          'update',
          'updateManyAndReturn',
          'upsert',
          'delete',
        ].sort(),
      );
      // Everything else in SCOPED_OPERATIONS returns a count or an aggregate.
      expect(
        SCOPED_OPERATIONS.filter((op) => !ROW_RETURNING_OPERATIONS.includes(op)).sort(),
      ).toEqual(['aggregate', 'count', 'createMany', 'deleteMany', 'groupBy', 'updateMany'].sort());
    });

    it.each(models)(
      'TC-008 %s: no select, an empty select and a null select are all refused for every row-returning call it may make',
      (model) => {
        for (const operation of ROW_RETURNING_OPERATIONS) {
          if (['delete'].includes(operation)) continue; // refused before: a candidate deletes nothing
          const base = (): Record<string, unknown> => {
            const args = writeArgs(operation, {});
            delete args.select;
            return args;
          };
          for (const select of [undefined, {}, null, true, [], 'id']) {
            const args = { ...base(), ...(select === undefined ? {} : { select }) };
            // Only operations this model allows reach the select rule.
            const allowed = (() => {
              try {
                asCandidate(model, operation, { ...base(), select: { id: true } });
                return true;
              } catch {
                return false;
              }
            })();
            if (!allowed) continue;
            expect(() => asCandidate(model, operation, args)).toThrow(/needs an explicit select/);
          }
        }
      },
    );

    it.each(models)('TC-008 %s: a select that names a column passes', (model) => {
      for (const operation of READ_OPERATIONS.filter((op) =>
        ROW_RETURNING_OPERATIONS.includes(op),
      )) {
        expect(() =>
          asCandidate(model, operation, { where: { id: 'x' }, select: { id: true } }),
        ).not.toThrow();
      }
    });

    it('TC-008 count, aggregate, groupBy, updateMany and createMany return no rows and need no select', () => {
      expect(() => asCandidate('Session', 'count', {})).not.toThrow();
      expect(() => asCandidate('Session', 'aggregate', { _count: true })).not.toThrow();
      expect(() =>
        asCandidate('Session', 'groupBy', { by: ['status'], _count: true }),
      ).not.toThrow();
      expect(() =>
        asCandidate('SessionQuestion', 'updateMany', {
          where: { id: 'x' },
          data: { finalCode: 'x' },
        }),
      ).not.toThrow();
      expect(() =>
        asCandidate('ProctorEventBatch', 'createMany', { data: [{ seq: 1, eventCount: 1 }] }),
      ).not.toThrow();
    });

    it('TC-008 SERVICE needs no select: no column limit', () => {
      for (const operation of ROW_RETURNING_OPERATIONS) {
        expect(() => asService('Session', operation, writeArgs(operation, {}))).not.toThrow();
        const args = writeArgs(operation, {});
        delete args.select;
        expect(() => asService('Session', operation, args)).not.toThrow();
      }
    });

    it('TC-008 a write that returns the row cannot read a hidden column back either', () => {
      for (const operation of [
        'update',
        'upsert',
        'create',
        'updateManyAndReturn',
        'createManyAndReturn',
      ]) {
        expect(() =>
          asCandidate('ProctorEvent', operation, {
            ...writeArgs(operation, { durationMs: 1 }),
            select: { id: true },
          }),
        ).not.toThrow();
        expect(() =>
          asCandidate('Session', operation, {
            ...writeArgs(operation, { lastHeartbeat: new Date() }),
            select: { hmacKeyEnc: true },
          }),
        ).toThrow();
      }
    });
  });

  describe('the read list is refused in select, where, having, orderBy, distinct, by and the aggregates', () => {
    it.each(readColumns)(
      'TC-008 %s.%s: refused everywhere a column can be read, filtered or ordered on',
      (model, column) => {
        const listed = (operation: string, args: Record<string, unknown>): void => {
          expect(() => asCandidate(model, operation, args)).toThrow(
            new RegExp(`the column ${column} is not available to a candidate`),
          );
        };
        for (const operation of READ_OPERATIONS.filter((op) =>
          ROW_RETURNING_OPERATIONS.includes(op),
        )) {
          listed(operation, { where: { id: 'x' }, select: { id: true, [column]: true } });
          listed(operation, { where: { id: 'x' }, select: { [column]: false, id: true } });
          listed(operation, { select: { id: true }, where: { [column]: { not: null } } });
          listed(operation, {
            select: { id: true },
            where: { AND: [{ id: 'x' }, { [column]: 1 }] },
          });
          listed(operation, {
            select: { id: true },
            where: { OR: [{ id: 'x' }, { NOT: { [column]: { equals: 1 } } }] },
          });
          listed(operation, { select: { id: true }, orderBy: { [column]: 'asc' } });
          listed(operation, {
            select: { id: true },
            orderBy: [{ id: 'asc' }, { [column]: 'desc' }],
          });
          listed(operation, { select: { id: true }, distinct: [column] });
          listed(operation, { select: { id: true }, distinct: column });
        }
        // count: its select, where and orderBy.
        listed('count', { select: { [column]: true } });
        listed('count', { where: { [column]: 1 } });
        listed('count', { orderBy: { [column]: 'asc' } });
        // aggregate: every aggregate, where, orderBy.
        for (const aggregate of ['_count', '_sum', '_avg', '_min', '_max']) {
          listed('aggregate', { [aggregate]: { [column]: true } });
          listed('groupBy', { by: ['id'], [aggregate]: { [column]: true } });
        }
        listed('aggregate', { _count: true, where: { [column]: 1 } });
        listed('aggregate', { _count: true, orderBy: { [column]: 'asc' } });
        // groupBy: by (array and string), having, orderBy by an aggregate.
        listed('groupBy', { by: [column], _count: true });
        listed('groupBy', { by: column, _count: true });
        listed('groupBy', { by: ['id'], _count: true, having: { [column]: { gt: 1 } } });
        listed('groupBy', { by: ['id'], _count: true, having: { _avg: { [column]: { gt: 1 } } } });
        listed('groupBy', { by: ['id'], _count: true, orderBy: { _min: { [column]: 'asc' } } });
      },
    );

    it('TC-008 a column that is not on the list passes in every one of those places', () => {
      expect(() =>
        asCandidate('Session', 'findMany', {
          select: { id: true, lastHeartbeat: true },
          where: { AND: [{ id: 'x' }, { OR: [{ lastHeartbeat: { not: null } }] }] },
          orderBy: [{ createdAt: 'asc' }],
          distinct: ['lastHeartbeat'],
        }),
      ).not.toThrow();
      expect(() =>
        asCandidate('Session', 'groupBy', {
          by: ['lastHeartbeat'],
          _count: { _all: true, id: true },
          _max: { createdAt: true },
          having: { _count: { id: { gt: 0 } } },
          orderBy: { _min: { createdAt: 'asc' } },
        }),
      ).not.toThrow();
    });

    it('TC-008 a JSON path filter on a hidden column is refused: its key is the column', () => {
      expect(() =>
        asCandidate('Session', 'findMany', {
          select: { id: true },
          where: { deviceInfo: { path: ['systemCheck', 'ok'], equals: true } },
        }),
      ).toThrow(/the column deviceInfo is not available/);
    });

    it('TC-008 the message names the model, the column and the place, never a value', () => {
      let message = '';
      try {
        asCandidate('Session', 'findMany', {
          select: { id: true },
          where: { hmacKeyEnc: 'secret-key-value' },
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Session.findMany');
      expect(message).toContain('hmacKeyEnc');
      expect(message).toContain('where');
      expect(message).not.toContain('secret-key-value');
    });

    it('TC-008 SERVICE is not limited by the list', () => {
      for (const [model, column] of readColumns) {
        expect(() =>
          asService(model, 'findMany', {
            select: { [column]: true },
            where: { [column]: { not: null } },
            orderBy: { [column]: 'asc' },
          }),
        ).not.toThrow();
      }
    });
  });

  describe('the write list is refused in the data of every write', () => {
    it.each([...readColumns, ...writeOnlyColumns])(
      'TC-008 %s.%s is refused in create, createMany, createManyAndReturn, update, updateMany, updateManyAndReturn and upsert',
      (model, column) => {
        for (const operation of WRITES) {
          // Models and operations the candidate may not use at all are refused earlier, which is fine.
          for (const value of ['x', 1, null, { set: 'x' }]) {
            expect(() =>
              asCandidate(model, operation, writeArgs(operation, { [column]: value })),
            ).toThrow(OrgScopeViolationError);
          }
        }
        // Where the model allows the operation, the refusal is this rule's.
        const rule = CANDIDATE_MODELS[model];
        if (rule?.kind === 'session' && rule.writes !== 'none') {
          for (const operation of UPDATES) {
            expect(() =>
              asCandidate(model, operation, writeArgs(operation, { [column]: 'x' })),
            ).toThrow(/is not available to a candidate in a write|is a session key/);
          }
        }
      },
    );

    it('TC-008 an undefined value is not a write', () => {
      for (const [model, column] of [...readColumns, ...writeOnlyColumns]) {
        if (CANDIDATE_MODELS[model]?.kind !== 'session') continue;
        const rule = CANDIDATE_MODELS[model];
        if (rule?.kind === 'session' && rule.writes === 'none') continue;
        expect(() =>
          asCandidate(model, 'updateMany', { where: { id: 'x' }, data: { [column]: undefined } }),
        ).not.toThrow();
      }
    });

    it.each([
      ['Session', { lastHeartbeat: new Date() }],
      ['SessionQuestion', { finalCode: 'x', finalLanguage: 'python', answer: { a: 1 } }],
      ['MediaChunk', { uploadedAt: new Date(), sizeBytes: 1n }],
      ['Consent', { signedName: 'x', signedAt: new Date(), ip: '127.0.0.1', userAgent: 'x' }],
      ['IdentityCheck', { attempt: 1, idImageKey: 'k', selfieKey: 'k', livenessPassed: true }],
    ] as const)('TC-008 %s: what CS-4.4 grants still writes (%j)', (model, row) => {
      for (const operation of UPDATES) {
        const rule = CANDIDATE_MODELS[model];
        if (rule?.kind === 'session' && rule.writes === 'any') {
          expect(() => asCandidate(model, operation, writeArgs(operation, row))).not.toThrow();
        }
      }
    });
  });
});

describe('CS-4.4: proctor_events (NFR-04, TC-008)', () => {
  const event = (extra: Record<string, unknown> = {}) => ({
    type: 'TAB_SWITCH',
    severity: 'LOW',
    occurredAt: new Date(),
    ...extra,
  });

  it('TC-008 every read, update and upsert where is filtered to source = CLIENT, on top of the session', () => {
    const readLike = [
      ...READ_OPERATIONS.map((op) => [op, { where: { id: 1n }, select: { id: true } }] as const),
      ['update', { where: { id: 1n }, data: { durationMs: 1 }, select: { id: true } }] as const,
      ['updateMany', { where: { id: 1n }, data: { durationMs: 1 } }] as const,
      [
        'updateManyAndReturn',
        { where: { id: 1n }, data: { durationMs: 1 }, select: { id: true } },
      ] as const,
      [
        'upsert',
        { where: { id: 1n }, update: { durationMs: 1 }, create: event(), select: { id: true } },
      ] as const,
    ];
    for (const [operation, args] of readLike) {
      const { args: out } = asCandidate('ProctorEvent', operation, args);
      const where = out.where as { AND: unknown[] };
      expect(where.AND).toContainEqual({ source: 'CLIENT' });
      expect(where.AND).toContainEqual({ sessionId: SID });
    }
  });

  it('TC-008 SERVICE sees every source (it writes the SERVER events)', () => {
    const { args } = asService('ProctorEvent', 'findMany', { where: { id: 1n } });
    expect((args.where as { AND: unknown[] }).AND).not.toContainEqual({ source: 'CLIENT' });
    expect(() =>
      asService('ProctorEvent', 'create', { data: event({ source: 'SERVER' }) }),
    ).not.toThrow();
    expect(() =>
      asService('ProctorEvent', 'updateMany', {
        where: {},
        data: { payload: {}, source: 'SERVER' },
      }),
    ).not.toThrow();
  });

  it('TC-008 a create carries source = CLIENT: stamped when missing, refused when it is anything else', () => {
    for (const operation of ['create', 'createManyAndReturn'] as const) {
      const out = asCandidate('ProctorEvent', operation, writeArgs(operation, event())).args;
      const rows = Array.isArray(out.data) ? out.data : [out.data];
      expect(rows.map((r: { source: string }) => r.source)).toEqual(['CLIENT']);
    }
    const many = asCandidate('ProctorEvent', 'createMany', {
      data: [event(), event({ source: 'CLIENT' })],
    });
    expect((many.args.data as Array<{ source: string }>).map((r) => r.source)).toEqual([
      'CLIENT',
      'CLIENT',
    ]);
    const upsertArgs = (create: Record<string, unknown>) => ({
      where: { id: 1n },
      create,
      update: { durationMs: 1 },
      select: { id: true },
    });
    const upsert = asCandidate('ProctorEvent', 'upsert', upsertArgs(event()));
    expect((upsert.args.create as { source: string }).source).toBe('CLIENT');

    for (const source of ['SERVER', 'client', null, { set: 'CLIENT' }, 1]) {
      for (const operation of CREATES) {
        expect(() =>
          asCandidate('ProctorEvent', operation, writeArgs(operation, event({ source }))),
        ).toThrow(/source must be CLIENT/);
      }
      expect(() =>
        asCandidate('ProctorEvent', 'createMany', { data: [event(), event({ source })] }),
      ).toThrow(/source must be CLIENT/);
      expect(() => asCandidate('ProctorEvent', 'upsert', upsertArgs(event({ source })))).toThrow(
        /source must be CLIENT/,
      );
    }
  });

  it('TC-008 an update writes durationMs only: any other column throws, undefined ones do not count', () => {
    for (const operation of UPDATES) {
      expect(() =>
        asCandidate('ProctorEvent', operation, writeArgs(operation, { durationMs: 5 })),
      ).not.toThrow();
      expect(() =>
        asCandidate(
          'ProctorEvent',
          operation,
          writeArgs(operation, { durationMs: 5, payload: undefined }),
        ),
      ).not.toThrow();
      for (const key of [
        'payload',
        'severity',
        'confidence',
        'evidenceKey',
        'type',
        'occurredAt',
        'batchSeq',
        'source',
        'createdAt',
      ]) {
        expect(() =>
          asCandidate(
            'ProctorEvent',
            operation,
            writeArgs(operation, { durationMs: 5, [key]: 'x' }),
          ),
        ).toThrow(new RegExp(`${key} cannot be written by a candidate update here`));
      }
    }
    expect(() =>
      asCandidate('ProctorEvent', 'upsert', {
        where: { id: 1n },
        create: event(),
        update: { payload: {} },
        select: { id: true },
      }),
    ).toThrow(/payload cannot be written/);
  });

  it('TC-008 the create columns CS-4.4 lists are all allowed on create', () => {
    expect(() =>
      asCandidate(
        'ProctorEvent',
        'create',
        writeArgs('create', {
          type: 'TAB_SWITCH',
          occurredAt: new Date(),
          durationMs: 1,
          confidence: 0.5,
          payload: { a: 1 },
          evidenceKey: 'k',
          batchSeq: 1,
          severity: 'LOW',
        }),
      ),
    ).not.toThrow();
  });
});

describe('ids are lower-cased on entry, in the session scope too (nit 4)', () => {
  it('TC-008 a create naming the scope session in another case is accepted, another session is not', () => {
    const upper = SID.toUpperCase();
    expect(() =>
      asCandidate('ProctorEvent', 'create', writeArgs('create', event({ sessionId: upper }))),
    ).not.toThrow();
    expect(() =>
      asCandidate('ProctorEvent', 'create', writeArgs('create', event({ sessionId: OTHER }))),
    ).toThrow(/not the session of this scope/);
  });

  function event(extra: Record<string, unknown>): Record<string, unknown> {
    return { type: 'TAB_SWITCH', severity: 'LOW', occurredAt: new Date(), ...extra };
  }
});
