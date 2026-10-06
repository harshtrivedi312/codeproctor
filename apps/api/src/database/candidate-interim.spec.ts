// The review fixes S1 (keys behind the filters), S3 (the interim READ control and the CS-4.4 WRITE
// allowlist) and the CS-4.4 rules for proctor_events, on the rewritten arguments. No database. The same
// rules against a real Postgres are in cs4-session-isolation.spec.ts. NFR-04, TC-008.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CANDIDATE_INTERIM_DENY,
  COMPOUND_UNIQUES,
  ROW_RETURNING_OPERATIONS,
} from './candidate-interim';
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionActor } from './org-context';
import { SCOPED_OPERATIONS } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { applySessionScope } from './session-scope-args';
import { CANDIDATE_MODELS, NEVER_WRITTEN_BY_CANDIDATE, READ_OPERATIONS } from './session-scope-map';
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

/**
 * `data` for a write of `operation`, in the shape that operation takes. An upsert carries `row` in its
 * create branch and `updateRow` (default `row`) in its update branch.
 */
function writeArgs(
  operation: string,
  row: Record<string, unknown>,
  updateRow: Record<string, unknown> = row,
): Record<string, unknown> {
  switch (operation) {
    case 'upsert':
      return { where: { id: 'x' }, create: row, update: updateRow, select: { id: true } };
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

type RuleOf<K extends string> = Extract<
  NonNullable<(typeof CANDIDATE_MODELS)[ModelName]>,
  { kind: K }
>;
const SESSION_RULES = (Object.entries(CANDIDATE_MODELS) as Array<[ModelName, unknown]>).flatMap(
  ([model, rule]) =>
    (rule as { kind: string }).kind === 'session'
      ? [[model, rule as RuleOf<'session'>] as const]
      : [],
);

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
          run('Session', 'upsert', writeArgs('upsert', {}, { invitationId: value })),
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
            asCandidate('SessionQuestion', 'upsert', writeArgs('upsert', {}, { [key]: value })),
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

/**
 * CS-4.4's "Read" column, by Prisma field name, for every model on the CANDIDATE allowlist that a
 * candidate reads. Written out here, apart from candidate-interim.ts, so the two can be compared.
 */
const CS44_READ: Record<string, readonly string[]> = {
  Session: [
    'id',
    'status',
    'startedAt',
    'deadlineAt',
    'pauseReasons',
    'pausedMs',
    'proctorPausedAt',
    'submittedAt',
    'authEpoch',
  ],
  SessionQuestion: [
    'id',
    'sessionId',
    'position',
    'points',
    'finalCode',
    'finalLanguage',
    'answer',
  ],
  SessionSection: [
    'sessionId',
    'sectionId',
    'position',
    'timeLimitMs',
    'startedAt',
    'deadlineAt',
    'endedAt',
  ],
  Submission: ['id', 'sessionQuestionId', 'kind', 'language', 'createdAt'],
  IdentityCheck: ['id', 'attempt', 'status', 'createdAt'],
  MediaChunk: ['id', 'stream', 'segment', 'seq', 'sizeBytes', 'uploadedAt'],
  ProctorEventBatch: ['seq', 'signature', 'eventCount'],
  KeystrokeBatch: ['seq', 'signature', 'startedAt'],
  ProctorEvent: ['id', 'type', 'occurredAt', 'durationMs', 'batchSeq', 'createdAt'],
  Consent: ['id', 'consentTextId', 'signedAt', 'declinedAt'],
  Organization: ['id', 'name', 'retentionDays', 'currentConsentTextId'],
  Candidate: ['id', 'fullName', 'email'],
  Invitation: ['id', 'testId', 'candidateId', 'windowStart', 'windowEnd', 'usedAt'],
  Test: ['id', 'name', 'description', 'durationMinutes', 'profile'],
  TestSection: ['id', 'title', 'position', 'timeLimitMin'],
  Question: ['id', 'type'],
};

/** The ids that tie a row to its own scope: not hidden (see the header of candidate-interim.ts). */
const SCOPE_KEYS = ['id', 'orgId', 'sessionId', 'sessionQuestionId', 'testId', 'sectionId'];

describe('S3: the interim READ control, CANDIDATE_INTERIM_DENY (NFR-04, TC-008)', () => {
  const denyOf = (model: string): readonly string[] =>
    CANDIDATE_INTERIM_DENY[model as ModelName]?.read ?? [];
  const readColumns = Object.keys(CS44_READ).flatMap((model) =>
    denyOf(model).map((column) => [model, column] as const),
  );

  it('TC-008 is the complement of the CS-4.4 read column: every column of every readable model is readable, a scope key, or denied, and none is two of those', async () => {
    const metas = await readModelMetas();
    expect(Object.keys(CS44_READ).sort()).toEqual(
      Object.keys(CANDIDATE_MODELS)
        .filter((m) => CANDIDATE_MODELS[m as ModelName]?.kind !== 'grant-only')
        .sort(),
    );
    for (const [model, readable] of Object.entries(CS44_READ)) {
      const columns = (metas[model]?.fields ?? [])
        .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
        .map((f) => f.name);
      const deny = denyOf(model);
      const keys = SCOPE_KEYS.filter((k) => columns.includes(k) && !readable.includes(k));
      // Every entry is a column of the model.
      for (const column of [...readable, ...deny]) {
        expect(`${model}.${column}:${columns.includes(column)}`).toBe(`${model}.${column}:true`);
      }
      // No column is both readable and denied, and no key is denied.
      expect(deny.filter((c) => readable.includes(c) || SCOPE_KEYS.includes(c))).toEqual([]);
      // Nothing is left unclassified: a new column of the schema fails here until it is.
      const unclassified = columns.filter(
        (c) => !readable.includes(c) && !keys.includes(c) && !deny.includes(c),
      );
      expect({ model, unclassified }).toEqual({ model, unclassified: [] });
    }
  });

  it('TC-008 hides what the review named, and what CS-4.4 keeps from a candidate (the sealed key, the settings, the pass score, the invitation token, the erasure state)', () => {
    const must: Record<string, string[]> = {
      Session: [
        'hmacKeyEnc',
        'deviceInfo',
        'totalScore',
        'riskScore',
        'riskBand',
        'reportKey',
        'invitationId',
        'retentionAnchorAt',
        'clientKind',
        'reportGeneratedAt',
      ],
      Invitation: ['accommodations', 'tokenHash'],
      IdentityCheck: [
        'faceMatchScore',
        'modelId',
        'threshold',
        'reviewReason',
        'manualDecision',
        'reviewedById',
        'reviewedAt',
        'reviewNote',
        'idImageKey',
        'selfieKey',
      ],
      Organization: ['settings'],
      Test: ['settings', 'passScore'],
      Submission: ['score', 'results', 'passed', 'total', 'sourceCode'],
      SessionQuestion: [
        'score',
        'scoringNote',
        'scoring',
        'scoredById',
        'scoredAt',
        'testQuestionId',
      ],
      MediaChunk: ['objectKey'],
      Consent: ['ip', 'userAgent', 'signedName', 'pdfKey'],
      ProctorEvent: ['severity', 'payload', 'evidenceKey', 'confidence'],
      Candidate: ['erasureRequestedAt', 'erasedAt', 'externalRef'],
    };
    for (const [model, columns] of Object.entries(must)) {
      for (const column of columns) expect(denyOf(model)).toContain(column);
    }
  });

  it('TC-008 every model it names is on the CANDIDATE allowlist (an entry for another would be dead)', () => {
    for (const model of Object.keys(CANDIDATE_INTERIM_DENY)) {
      expect(CANDIDATE_MODELS[model as ModelName]).toBeDefined();
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
      for (const operation of ['update', 'updateManyAndReturn']) {
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
        ).toThrow(/the column hmacKeyEnc is not available/);
      }
      for (const operation of ['create', 'createManyAndReturn']) {
        expect(() =>
          asCandidate('ProctorEvent', operation, {
            ...writeArgs(operation, { durationMs: 1 }),
            select: { payload: true },
          }),
        ).toThrow(/the column payload is not available/);
      }
    });
  });

  describe('the read list is refused in select, where, having, orderBy, distinct, by and the aggregates', () => {
    it.each(readColumns)(
      'TC-008 %s.%s: refused everywhere a column can be read, filtered or ordered on',
      (model, column) => {
        const m = model as ModelName;
        const listed = (operation: string, args: Record<string, unknown>): void => {
          expect(() => asCandidate(m, operation, args)).toThrow(
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
          select: { id: true, authEpoch: true },
          where: { AND: [{ id: 'x' }, { OR: [{ authEpoch: { not: null } }] }] },
          orderBy: [{ startedAt: 'asc' }],
          distinct: ['authEpoch'],
        }),
      ).not.toThrow();
      expect(() =>
        asCandidate('Session', 'groupBy', {
          by: ['authEpoch'],
          _count: { _all: true, id: true },
          _max: { startedAt: true },
          having: { _count: { id: { gt: 0 } } },
          orderBy: { _min: { startedAt: 'asc' } },
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
          asService(model as ModelName, 'findMany', {
            select: { [column]: true },
            where: { [column]: { not: null } },
            orderBy: { [column]: 'asc' },
          }),
        ).not.toThrow();
      }
    });
  });

  describe('compound unique selectors are read through (nit 6: findUnique by another unique key)', () => {
    it('TC-008 the table equals the @@unique and @@id of schema.prisma, for the models on the allowlist', () => {
      const schema = readFileSync(resolve(__dirname, '../../../../prisma/schema.prisma'), 'utf8');
      const found: Record<string, string[]> = {};
      for (const block of schema.split(/^model\s+/m).slice(1)) {
        const name = block.slice(0, block.indexOf(' ')).trim();
        if (CANDIDATE_MODELS[name as ModelName]?.kind === 'grant-only') continue;
        if (CANDIDATE_MODELS[name as ModelName] === undefined) continue;
        for (const match of block.matchAll(/@@(?:unique|id)\(\[([^\]]+)\]/g)) {
          const columns = (match[1] ?? '').split(',').map((c) => c.trim());
          if (columns.length > 1) (found[name] ??= []).push(columns.join('_'));
        }
      }
      expect(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]))).toEqual(
        Object.fromEntries(
          Object.entries(COMPOUND_UNIQUES).map(([k, v]) => [k, [...(v ?? [])].sort()]),
        ),
      );
    });

    it('TC-008 a hidden column inside a compound unique selector is refused (orgId_slug on questions)', () => {
      expect(() =>
        asCandidate('Question', 'findUnique', {
          where: { orgId_slug: { orgId: ORG, slug: 'q-b' } },
          select: { id: true },
        }),
      ).toThrow(/the column slug is not available/);
      expect(() =>
        asCandidate('Candidate', 'findUnique', {
          where: { orgId_email: { orgId: ORG, email: 'candidate-b@example.test' } },
          select: { id: true },
        }),
      ).not.toThrow();
    });

    it('TC-008 the compound selectors of the session models pass: their columns are keys or readable', () => {
      for (const [model, where] of [
        ['IdentityCheck', { sessionId_attempt: { sessionId: SID, attempt: 1 } }],
        ['MediaChunk', { sessionId_stream_seq: { sessionId: SID, stream: 'SCREEN', seq: 0 } }],
        ['ProctorEventBatch', { sessionId_seq: { sessionId: SID, seq: 0 } }],
        ['KeystrokeBatch', { sessionId_seq: { sessionId: SID, seq: 0 } }],
        ['SessionSection', { sessionId_sectionId: { sessionId: SID, sectionId: OTHER } }],
      ] as const) {
        expect(() =>
          asCandidate(model, 'findUnique', { where, select: { seq: true } }),
        ).not.toThrow();
      }
    });

    it('TC-008 a unique key that is itself a hidden column is refused (invitations.tokenHash)', () => {
      expect(() =>
        asCandidate('Invitation', 'findUnique', {
          where: { tokenHash: 'any' },
          select: { id: true },
        }),
      ).toThrow(/the column tokenHash is not available/);
    });
  });

  describe('a pathological nesting is refused for its depth, never with a RangeError (nit 3)', () => {
    const nestedArray = (depth: number): unknown => {
      let value: unknown = [{ id: 'x' }];
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };
    const DEEP = 100_000;
    const refusedForDepth = (args: Record<string, unknown>): void => {
      let error: unknown;
      try {
        asCandidate('Session', 'findMany', { select: { id: true }, ...args });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OrgScopeViolationError);
      expect((error as Error).message).toMatch(/nested more than 32 levels deep/);
    };

    it('TC-008 where, having, orderBy, distinct and by count arrays toward the depth', () => {
      refusedForDepth({ where: { AND: nestedArray(DEEP) } });
      refusedForDepth({ where: { OR: nestedArray(DEEP) } });
      refusedForDepth({ where: nestedArray(DEEP) });
      refusedForDepth({ orderBy: nestedArray(DEEP) });
      refusedForDepth({ distinct: nestedArray(DEEP) });
      expect(() =>
        asCandidate('Session', 'groupBy', { by: nestedArray(DEEP), _count: true }),
      ).toThrow(/nested more than 32 levels deep/);
      expect(() =>
        asCandidate('Session', 'groupBy', { by: ['id'], having: { AND: nestedArray(DEEP) } }),
      ).toThrow(/nested more than 32 levels deep/);
    });

    it('TC-008 a deep object nesting too, and the limit itself is not off by one', () => {
      let where: Record<string, unknown> = { id: 'x' };
      for (let i = 0; i < DEEP; i++) where = { NOT: where };
      refusedForDepth({ where });
      const arrays = (depth: number): Record<string, unknown> => ({
        AND: depth === 0 ? [{ id: 'x' }] : [arrays(depth - 1)],
      });
      // Each AND level is an object and an array, so 15 of them stay within the limit of 32.
      expect(() =>
        asCandidate('Session', 'findMany', { select: { id: true }, where: arrays(15) }),
      ).not.toThrow();
      expect(() =>
        asCandidate('Session', 'findMany', { select: { id: true }, where: arrays(17) }),
      ).toThrow(/nested more than 32 levels deep/);
    });
  });
});

/**
 * CS-4.4's "Write" column as the review states it, by Prisma field name. Written out here, apart from
 * session-scope-map.ts, so the two can be compared: a widened or a mistyped list fails this test as
 * well as the behaviour tests below. `sessionId` and `sessionQuestionId` are the session keys a typed
 * create must carry (Prisma's unchecked create input requires them); `sessionId` must match the scope.
 */
const CS44_WRITE: Record<string, { create?: readonly string[]; update?: readonly string[] }> = {
  Session: { update: ['lastHeartbeat'] },
  SessionQuestion: { update: ['finalCode', 'finalLanguage', 'answer'] },
  SessionSection: {},
  Submission: { create: ['sessionQuestionId', 'kind', 'language', 'sourceCode'] },
  IdentityCheck: {
    create: ['sessionId', 'attempt', 'idImageKey', 'selfieKey', 'livenessPassed'],
  },
  MediaChunk: {
    create: [
      'sessionId',
      'stream',
      'segment',
      'seq',
      'startedAt',
      'durationMs',
      'sizeBytes',
      'uploadedAt',
      'objectKey',
    ],
    update: [
      'stream',
      'segment',
      'seq',
      'startedAt',
      'durationMs',
      'sizeBytes',
      'uploadedAt',
      'objectKey',
    ],
  },
  ProctorEventBatch: { create: ['sessionId', 'seq', 'signature', 'eventCount'] },
  KeystrokeBatch: {
    create: ['sessionId', 'sessionQuestionId', 'seq', 'signature', 'startedAt', 'events'],
  },
  ProctorEvent: {
    create: [
      'sessionId',
      'type',
      'occurredAt',
      'durationMs',
      'confidence',
      'payload',
      'evidenceKey',
      'batchSeq',
      'severity',
      'source',
    ],
    update: ['durationMs'],
  },
  Consent: { update: ['signedName', 'signedAt', 'declinedAt', 'ip', 'userAgent'] },
};

describe('S3: the WRITE allowlist of CS-4.4, exhaustive over the columns of every model (NFR-04, TC-008)', () => {
  let columnsOf: Record<string, string[]> = {};

  beforeAll(async () => {
    const metas = await readModelMetas();
    columnsOf = Object.fromEntries(
      Object.entries(metas).map(([name, meta]) => [
        name,
        meta.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name),
      ]),
    );
  });

  /** A value that passes every check except the column's own. */
  const valueOf = (column: string): unknown =>
    column === 'sessionId'
      ? SID
      : column === 'source'
        ? 'CLIENT'
        : column === 'sessionQuestionId'
          ? OTHER
          : 1;

  it('TC-008 the lists in CANDIDATE_MODELS are exactly the CS-4.4 write column', () => {
    expect(SESSION_RULES.map(([model]) => model).sort()).toEqual(Object.keys(CS44_WRITE).sort());
    for (const [model, rule] of SESSION_RULES) {
      expect({ model, create: rule.create, update: rule.update }).toEqual({
        model,
        create: CS44_WRITE[model]?.create,
        update: CS44_WRITE[model]?.update,
      });
    }
  });

  it('TC-008 the lists name real columns, and never id, orgId or a timestamp', () => {
    for (const [model, rule] of SESSION_RULES) {
      for (const column of [...(rule.create ?? []), ...(rule.update ?? [])]) {
        expect(`${model}.${column}:${columnsOf[model]?.includes(column)}`).toBe(
          `${model}.${column}:true`,
        );
        expect(NEVER_WRITTEN_BY_CANDIDATE).not.toContain(column);
      }
    }
    expect(NEVER_WRITTEN_BY_CANDIDATE).toEqual(['id', 'orgId', 'createdAt', 'updatedAt']);
  });

  describe.each(SESSION_RULES)('%s', (model, rule) => {
    const creates = (): string[] =>
      rule.update === undefined ? [...CREATES] : [...CREATES, 'upsert'];
    const updates = (): string[] =>
      rule.create === undefined ? [...UPDATES] : [...UPDATES, 'upsert'];
    const createArgs = (operation: string, row: Record<string, unknown>) =>
      operation === 'upsert' ? writeArgs(operation, row, {}) : writeArgs(operation, row);
    const updateArgs = (operation: string, row: Record<string, unknown>) =>
      operation === 'upsert' ? writeArgs(operation, {}, row) : writeArgs(operation, row);

    it('TC-008 create: a listed column passes, every other column of the model throws', () => {
      for (const column of columnsOf[model] ?? []) {
        const row = { [column]: valueOf(column) };
        const listed = rule.create?.includes(column) === true;
        for (const operation of creates()) {
          if (rule.create === undefined) {
            expect(() => asCandidate(model, operation, createArgs(operation, row))).toThrow(
              /cannot create this row|writes nothing here/,
            );
          } else if (listed) {
            expect({
              model,
              column,
              operation,
              ok: tryCall(() => asCandidate(model, operation, createArgs(operation, row))),
            }).toEqual({ model, column, operation, ok: true });
          } else {
            expect(() => asCandidate(model, operation, createArgs(operation, row))).toThrow(
              /is never written by a candidate|cannot be written by a candidate create here/,
            );
          }
        }
      }
    });

    it('TC-008 update: a listed column passes, every other column of the model throws', () => {
      for (const column of columnsOf[model] ?? []) {
        const row = { [column]: valueOf(column) };
        const listed = rule.update?.includes(column) === true;
        for (const operation of updates()) {
          if (rule.update === undefined) {
            expect(() => asCandidate(model, operation, updateArgs(operation, row))).toThrow(
              /cannot update this row|writes nothing here/,
            );
          } else if (listed) {
            expect({
              model,
              column,
              operation,
              ok: tryCall(() => asCandidate(model, operation, updateArgs(operation, row))),
            }).toEqual({ model, column, operation, ok: true });
          } else {
            expect(() => asCandidate(model, operation, updateArgs(operation, row))).toThrow(
              /is never written by a candidate|cannot be written by a candidate update here|is a session key/,
            );
          }
        }
      }
    });

    it('TC-008 a row naming a listed and an unlisted column throws, whatever the order', () => {
      const unlisted = (columnsOf[model] ?? []).find(
        (c) => !(rule.create ?? []).includes(c) && !(rule.update ?? []).includes(c),
      );
      if (unlisted === undefined) return;
      for (const [listedList, kind] of [
        [rule.create, 'create'],
        [rule.update, 'update'],
      ] as const) {
        const first = listedList?.[0];
        if (first === undefined) continue;
        for (const row of [
          { [first]: valueOf(first), [unlisted]: 1 },
          { [unlisted]: 1, [first]: valueOf(first) },
        ]) {
          for (const operation of kind === 'create' ? CREATES : UPDATES) {
            expect(() => asCandidate(model, operation, writeArgs(operation, row))).toThrow(
              OrgScopeViolationError,
            );
          }
        }
      }
    });

    it('TC-008 a column set to undefined is not a write', () => {
      const unlisted = (columnsOf[model] ?? []).find(
        (c) => !(rule.create ?? []).includes(c) && !(rule.update ?? []).includes(c),
      );
      if (unlisted === undefined) return;
      for (const operation of [
        ...(rule.create !== undefined ? ['create'] : []),
        ...(rule.update !== undefined ? ['updateMany'] : []),
      ]) {
        expect(() =>
          asCandidate(model, operation, writeArgs(operation, { [unlisted]: undefined })),
        ).not.toThrow();
      }
    });

    it('TC-008 SERVICE writes any column: the allowlist is a CANDIDATE rule', () => {
      // `sessionId`, `id`, `invitationId` and `sessionQuestionId` are session keys for an update (both
      // actors) and `orgId` is the org's (ADR 0006 8.2); every other column is open to the job.
      for (const column of (columnsOf[model] ?? []).filter(
        (c) => !['sessionId', 'id', 'orgId', 'invitationId', 'sessionQuestionId'].includes(c),
      )) {
        expect(() =>
          asService(model, 'updateMany', writeArgs('updateMany', { [column]: 1 })),
        ).not.toThrow();
      }
    });
  });

  it('TC-008 an update on each create-only model throws, whatever the column', () => {
    for (const model of ['Submission', 'IdentityCheck', 'ProctorEventBatch', 'KeystrokeBatch']) {
      for (const column of columnsOf[model] ?? []) {
        for (const operation of [...UPDATES, 'upsert']) {
          expect(() =>
            asCandidate(
              model as ModelName,
              operation,
              operation === 'upsert'
                ? writeArgs(operation, {}, { [column]: valueOf(column) })
                : writeArgs(operation, { [column]: valueOf(column) }),
            ),
          ).toThrow(/cannot update this row: CS-4\.4 grants create only/);
        }
      }
    }
  });

  it('TC-008 a create on each update-only model throws', () => {
    for (const model of ['Session', 'SessionQuestion', 'Consent']) {
      for (const operation of [...CREATES, 'upsert']) {
        expect(() => asCandidate(model as ModelName, operation, writeArgs(operation, {}))).toThrow(
          /cannot create this row: CS-4\.4 grants updates only/,
        );
      }
    }
  });

  it.each([
    ['SessionQuestion', 'points'],
    ['SessionQuestion', 'scoring'],
    ['SessionQuestion', 'scoredById'],
    ['SessionQuestion', 'scoredAt'],
    ['SessionQuestion', 'position'],
    ['Session', 'retentionAnchorAt'],
    ['Session', 'clientKind'],
    ['Session', 'reportGeneratedAt'],
    ['Session', 'status'],
    ['Session', 'pauseReasons'],
    ['Session', 'submittedAt'],
    ['Session', 'deviceInfo'],
    ['Session', 'authEpoch'],
    ['Session', 'deadlineAt'],
    ['Session', 'startedAt'],
    ['Session', 'pausedMs'],
    ['Session', 'hmacKeyEnc'],
    ['Session', 'riskScore'],
    ['Submission', 'results'],
    ['Submission', 'passed'],
    ['Submission', 'total'],
    ['Submission', 'score'],
    ['IdentityCheck', 'status'],
    ['IdentityCheck', 'manualDecision'],
    ['IdentityCheck', 'reviewNote'],
    ['Consent', 'consentTextId'],
    ['Consent', 'pdfKey'],
    ['Consent', 'pdfGeneratedAt'],
    ['MediaChunk', 'deletedAt'],
    ['ProctorEventBatch', 'receivedAt'],
  ] as const)(
    'TC-008 %s.%s cannot be written by a candidate, in any write operation',
    (model, column) => {
      for (const operation of WRITES) {
        for (const value of [1, 'x', null, { set: 1 }]) {
          expect(() =>
            asCandidate(
              model,
              operation,
              operation === 'upsert'
                ? writeArgs(operation, { [column]: value }, { [column]: value })
                : writeArgs(operation, { [column]: value }),
            ),
          ).toThrow(OrgScopeViolationError);
        }
      }
    },
  );

  it('TC-008 id, orgId and the timestamps are never written, on a create or an update, and a create naming an id is no longer an existence oracle (nit 7)', () => {
    for (const [model, rule] of SESSION_RULES) {
      for (const column of NEVER_WRITTEN_BY_CANDIDATE) {
        if (!(columnsOf[model] ?? []).includes(column)) continue;
        if (rule.create !== undefined) {
          for (const operation of CREATES) {
            expect(() =>
              asCandidate(model, operation, writeArgs(operation, { [column]: 'x' })),
            ).toThrow(/is never written by a candidate/);
          }
        }
        if (rule.update !== undefined) {
          for (const operation of UPDATES) {
            expect(() =>
              asCandidate(model, operation, writeArgs(operation, { [column]: 'x' })),
            ).toThrow(/is never written by a candidate|is a session key/);
          }
        }
      }
    }
    expect(() =>
      asCandidate('Submission', 'create', {
        data: { id: OTHER, sessionQuestionId: OTHER, kind: 'RUN', language: 'x', sourceCode: 'x' },
        select: { id: true },
      }),
    ).toThrow(/id is never written by a candidate/);
  });

  it('TC-008 the consent row: the five CS-4.4 columns update, consentTextId and pdfKey are refused', () => {
    for (const operation of UPDATES) {
      expect(() =>
        asCandidate(
          'Consent',
          operation,
          writeArgs(operation, {
            signedName: 'x',
            signedAt: new Date(),
            declinedAt: null,
            ip: '127.0.0.1',
            userAgent: 'x',
          }),
        ),
      ).not.toThrow();
      for (const column of ['consentTextId', 'pdfKey']) {
        expect(() =>
          asCandidate('Consent', operation, writeArgs(operation, { [column]: 'x' })),
        ).toThrow(/cannot be written by a candidate update here/);
      }
    }
  });

  it('TC-008 the submission create: kind is RUN or SUBMIT (the enum), and the rest is the CS-4.4 list', () => {
    for (const kind of ['RUN', 'SUBMIT']) {
      for (const operation of CREATES) {
        expect(() =>
          asCandidate(
            'Submission',
            operation,
            writeArgs(operation, {
              sessionQuestionId: OTHER,
              kind,
              language: 'python',
              sourceCode: 'x',
            }),
          ),
        ).not.toThrow();
      }
    }
  });

  it('TC-008 the error names the model, the column and the list, never a value', () => {
    let message = '';
    try {
      asCandidate('SessionQuestion', 'update', writeArgs('update', { points: 999999 }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SessionQuestion.update');
    expect(message).toContain('points');
    expect(message).toContain('finalCode, finalLanguage, answer');
    expect(message).not.toContain('999999');
  });
});

/** `true` when `fn` does not throw, else the message it threw (so a failure says why). */
function tryCall(fn: () => unknown): true | string {
  try {
    fn();
    return true;
  } catch (error) {
    return (error as Error).message;
  }
}

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
        ).toThrow(
          new RegExp(
            `${key} (cannot be written by a candidate update here|is never written by a candidate)`,
          ),
        );
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
