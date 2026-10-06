// The review fixes S1 (keys behind the filters), S3 (the interim READ control and the CS-4.4 WRITE
// allowlist) and the CS-4.4 rules for proctor_events, on the rewritten arguments. No database. The same
// rules against a real Postgres are in cs4-session-isolation.spec.ts. NFR-04, TC-008.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_EVENT_TYPES, EVENT_TYPES } from '@codeproctor/shared';
import { createPrismaClient } from './create-prisma-client';
import {
  CANDIDATE_INTERIM_DENY,
  COMPOUND_UNIQUES,
  isFieldRef,
  ROW_RETURNING_OPERATIONS,
} from './candidate-interim';
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionActor } from './org-context';
import { SCOPED_OPERATIONS } from './org-scope-args';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { applySessionScope } from './session-scope-args';
import {
  CANDIDATE_MODELS,
  CANDIDATE_OBJECT_KEYS,
  NEVER_WRITTEN_BY_CANDIDATE,
  READ_OPERATIONS,
  SERVER_ONLY_EVENT_TYPES,
  SESSION_SCOPE,
} from './session-scope-map';
import { readModelMetas } from './testing/data-model';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FACTS: CandidateFacts = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  testId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
};

/**
 * keystroke_batches.id is a global identity counter that a candidate may not read (#126 nit 1), so a
 * candidate call on that model names `seq` where the generic tests of the other models name `id`.
 */
function keyed(model: ModelName, args: unknown): unknown {
  if (model !== 'KeystrokeBatch' || typeof args !== 'object' || args === null) return args;
  const given = args as Record<string, unknown>;
  const rename = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k === 'id' ? 'seq' : k, v]))
      : value;
  return {
    ...given,
    ...(given.where === undefined ? {} : { where: rename(given.where) }),
    ...(given.select === undefined ? {} : { select: rename(given.select) }),
  };
}

/** Calls the scope exactly as given: no select is added for the caller. */
function raw(actor: SessionActor, model: ModelName, operation: string, args: unknown) {
  return applySessionScope({
    model,
    rule: ORG_SCOPE[model],
    operation,
    args: actor === 'CANDIDATE' ? keyed(model, args) : args,
    orgId: ORG,
    session: { actor, sessionId: SID },
    facts: FACTS,
  });
}
const asCandidate = (model: ModelName, operation: string, args: unknown) =>
  raw('CANDIDATE', model, operation, args);
/** A candidate call with the arguments exactly as given (no renaming of `id` for keystroke_batches). */
const asCandidateExact = (model: ModelName, operation: string, args: unknown) =>
  applySessionScope({
    model,
    rule: ORG_SCOPE[model],
    operation,
    args,
    orgId: ORG,
    session: { actor: 'CANDIDATE', sessionId: SID },
    facts: FACTS,
  });
const asService = (model: ModelName, operation: string, args: unknown) =>
  raw('SERVICE', model, operation, args);

/** An object key of the scope's own session, in the folder ADR 0013 section 5.7 fixes for the column. */
const OWN_PREFIX = `orgs/${ORG}/sessions/${SID}/`;
const VALID_KEYS: Record<string, string> = {
  objectKey: `${OWN_PREFIX}media/SCREEN/000001/00000001.webm`,
  idImageKey: `${OWN_PREFIX}identity/1/sealed/id-01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg`,
  selfieKey: `${OWN_PREFIX}identity/1/sealed/selfie-01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg`,
  evidenceKey: `${OWN_PREFIX}evidence/01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg`,
};

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
/**
 * Scope keys that ARE hidden: keystroke_batches.id is a global identity counter, so reading it tells a
 * candidate how many batches every candidate of the platform has inserted (#126 nit 1).
 */
const HIDDEN_KEYS: Record<string, readonly string[]> = { KeystrokeBatch: ['id'] };

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
      const hiddenKeys = HIDDEN_KEYS[model] ?? [];
      const keys = SCOPE_KEYS.filter(
        (k) => columns.includes(k) && !readable.includes(k) && !hiddenKeys.includes(k),
      );
      // Every entry is a column of the model.
      for (const column of [...readable, ...deny]) {
        expect(`${model}.${column}:${columns.includes(column)}`).toBe(`${model}.${column}:true`);
      }
      // No column is both readable and denied, and no key is denied.
      expect(
        deny.filter(
          (c) => readable.includes(c) || (SCOPE_KEYS.includes(c) && !hiddenKeys.includes(c)),
        ),
      ).toEqual([]);
      expect(hiddenKeys.filter((c) => !deny.includes(c))).toEqual([]);
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
      KeystrokeBatch: ['id', 'events'],
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
        // The column under test is named as it is (no renaming of `id`), and the other arguments name a key
        // the candidate may read: `id`, or `seq` where `id` is hidden.
        const key = m === 'KeystrokeBatch' ? 'seq' : 'id';
        const listed = (operation: string, args: Record<string, unknown>): void => {
          expect(() => asCandidateExact(m, operation, args)).toThrow(
            new RegExp(`the column ${column} is not available to a candidate`),
          );
        };
        for (const operation of READ_OPERATIONS.filter((op) =>
          ROW_RETURNING_OPERATIONS.includes(op),
        )) {
          listed(operation, { where: { [key]: 'x' }, select: { [key]: true, [column]: true } });
          listed(operation, { where: { [key]: 'x' }, select: { [column]: false, [key]: true } });
          listed(operation, { select: { [key]: true }, where: { [column]: { not: null } } });
          listed(operation, {
            select: { [key]: true },
            where: { AND: [{ [key]: 'x' }, { [column]: 1 }] },
          });
          listed(operation, {
            select: { [key]: true },
            where: { OR: [{ [key]: 'x' }, { NOT: { [column]: { equals: 1 } } }] },
          });
          listed(operation, { select: { [key]: true }, orderBy: { [column]: 'asc' } });
          listed(operation, {
            select: { [key]: true },
            orderBy: [{ [key]: 'asc' }, { [column]: 'desc' }],
          });
          listed(operation, { select: { [key]: true }, distinct: [column] });
          listed(operation, { select: { [key]: true }, distinct: column });
        }
        // count: its select, where and orderBy.
        listed('count', { select: { [column]: true } });
        listed('count', { where: { [column]: 1 } });
        listed('count', { orderBy: { [column]: 'asc' } });
        // aggregate: every aggregate, where, orderBy.
        for (const aggregate of ['_count', '_sum', '_avg', '_min', '_max']) {
          listed('aggregate', { [aggregate]: { [column]: true } });
          listed('groupBy', { by: [key], [aggregate]: { [column]: true } });
        }
        listed('aggregate', { _count: true, where: { [column]: 1 } });
        listed('aggregate', { _count: true, orderBy: { [column]: 'asc' } });
        // groupBy: by (array and string), having, orderBy by an aggregate.
        listed('groupBy', { by: [column], _count: true });
        listed('groupBy', { by: column, _count: true });
        listed('groupBy', { by: [key], _count: true, having: { [column]: { gt: 1 } } });
        listed('groupBy', { by: [key], _count: true, having: { _avg: { [column]: { gt: 1 } } } });
        listed('groupBy', { by: [key], _count: true, orderBy: { _min: { [column]: 'asc' } } });
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
          : (VALID_KEYS[column] ?? 1);

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
          evidenceKey: VALID_KEYS.evidenceKey,
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

describe('B1: a field reference is refused in a where and a having (#126 round 3; NFR-04, TC-008)', () => {
  const base = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
  afterAll(async () => {
    await base.$disconnect();
  });
  const lower = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);
  /** client.<model>.fields.<column>, the real object Prisma hands to the extension. */
  const ref = (model: string, column: string): unknown =>
    (base as unknown as Record<string, { fields: Record<string, unknown> }>)[lower(model)]?.fields[
      column
    ];
  const MODELS = Object.keys(CS44_READ) as ModelName[];
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
  const refused = /a field reference \(client\.<model>\.fields\.<column>\) in (where|having)/;

  it('TC-008 isFieldRef recognises the runtime object, and nothing a filter is made of', () => {
    const real = ref('SessionQuestion', 'score');
    expect(isFieldRef(real)).toBe(true);
    expect(isFieldRef({ modelName: 'X', name: 'y', typeName: 'Int', isList: false })).toBe(true);
    expect(isFieldRef({ _toGraphQLInputType: () => undefined })).toBe(true);
    for (const plain of [
      { equals: 1 },
      { name: 'Test A' },
      { name: { equals: 'x' }, modelName: 'y' },
      { path: ['a'], equals: 1 },
      [],
      null,
      undefined,
      'score',
      1,
      new Date(),
    ]) {
      expect(isFieldRef(plain)).toBe(false);
    }
  });

  it('TC-008 the two queries of the review: points = fields.score, and createdAt < fields.reviewedAt, are refused, in where and in having', () => {
    const points = { points: { equals: ref('SessionQuestion', 'score') } };
    const created = { createdAt: { lt: ref('IdentityCheck', 'reviewedAt') } };
    for (const operation of ['count', 'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique']) {
      expect(() =>
        asCandidate('SessionQuestion', operation, { where: points, select: { id: true } }),
      ).toThrow(refused);
      expect(() =>
        asCandidate('IdentityCheck', operation, { where: created, select: { id: true } }),
      ).toThrow(refused);
    }
    expect(() =>
      asCandidate('SessionQuestion', 'aggregate', { where: points, _count: true }),
    ).toThrow(refused);
    expect(() =>
      asCandidate('SessionQuestion', 'groupBy', { by: ['position'], _count: true, having: points }),
    ).toThrow(/field reference .* in having/);
    expect(() =>
      asCandidate('IdentityCheck', 'groupBy', { by: ['attempt'], _count: true, having: created }),
    ).toThrow(/field reference .* in having/);
    // updates carry a where too
    expect(() =>
      asCandidate('SessionQuestion', 'updateMany', { where: points, data: { finalCode: 'x' } }),
    ).toThrow(refused);
  });

  it('TC-008 every column of every readable model, as a reference, in every operator and nesting, is refused', () => {
    for (const model of MODELS) {
      const key = model === 'KeystrokeBatch' ? 'seq' : 'id';
      for (const column of columnsOf[model] ?? []) {
        const r = ref(model, column);
        expect({ model, column, isRef: isFieldRef(r) }).toEqual({ model, column, isRef: true });
        const shapes: Array<Record<string, unknown>> = [
          { [key]: { equals: r } },
          { [key]: { lt: r } },
          { [key]: { gte: r } },
          { [key]: { in: [r] } },
          { [key]: { notIn: [1, r] } },
          { [key]: { not: r } },
          { [key]: { not: { equals: r } } },
          { AND: [{ [key]: 'x' }, { [key]: { equals: r } }] },
          { OR: [{ NOT: { [key]: { equals: r } } }] },
          { NOT: [{ AND: [{ [key]: { gt: r } }] }] },
        ];
        for (const where of shapes) {
          expect(() => asCandidate(model, 'count', { where })).toThrow(refused);
        }
        expect(() =>
          asCandidate(model, 'groupBy', {
            by: [key],
            _count: true,
            having: { [key]: { equals: r } },
          }),
        ).toThrow(/field reference .* in having/);
      }
    }
  });

  it('TC-008 the refusal names no column and no value', () => {
    let message = '';
    try {
      asCandidate('SessionQuestion', 'count', {
        where: { points: { equals: ref('SessionQuestion', 'score') } },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SessionQuestion.count');
    expect(message).not.toContain('score');
  });

  it('TC-008 a Date, a byte array and an ordinary filter are leaves and pass; a SERVICE scope is not limited', () => {
    expect(() =>
      asCandidate('Session', 'count', {
        where: {
          startedAt: { gte: new Date(), lt: new Date() },
          pausedMs: { in: [1n, 2n] },
          authEpoch: { not: { equals: 3 } },
        },
      }),
    ).not.toThrow();
    expect(() =>
      asCandidate('ProctorEventBatch', 'count', {
        where: { signature: { equals: Buffer.alloc(1_000_000) } },
      }),
    ).not.toThrow();
    expect(() =>
      asService('SessionQuestion', 'count', {
        where: { points: { equals: ref('SessionQuestion', 'score') } },
      }),
    ).not.toThrow();
  });

  it('TC-008 a reference buried deeper than the limit is refused for its depth', () => {
    let where: Record<string, unknown> = { points: { equals: ref('SessionQuestion', 'score') } };
    for (let i = 0; i < 100_000; i++) where = { NOT: where };
    expect(() => asCandidate('SessionQuestion', 'count', { where })).toThrow(
      /nested more than 32 levels deep/,
    );
  });
});

describe('B2: object keys stay inside the session prefix (ADR 0013 section 5.7; NFR-04, TC-008)', () => {
  const OTHER_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
  const KEY_COLUMNS: Array<[ModelName, string, string]> = [
    ['MediaChunk', 'objectKey', 'media/SCREEN/000001/00000001.webm'],
    ['IdentityCheck', 'idImageKey', 'identity/1/sealed/id-01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg'],
    ['IdentityCheck', 'selfieKey', 'identity/2/selfie-01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg'],
    ['ProctorEvent', 'evidenceKey', 'evidence/01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg'],
  ];
  const own = (rest: string): string => `${OWN_PREFIX}${rest}`;
  const createWith = (model: ModelName, column: string, value: unknown) =>
    asCandidate(model, 'create', writeArgs('create', { [column]: value }));
  const refusedKey = /must be an object key under this session's own prefix/;

  it.each(KEY_COLUMNS)(
    "TC-008 %s.%s: the session's own prefix and folder pass, on a create",
    (model, column, rest) => {
      expect(() => createWith(model, column, own(rest))).not.toThrow();
      expect(() =>
        asCandidate(model, 'createMany', writeArgs('createMany', { [column]: own(rest) })),
      ).not.toThrow();
      expect(() => createWith(model, column, null)).not.toThrow(); // nothing to point out of the prefix
    },
  );

  it('TC-008 media_chunks.objectKey passes on an update too, as a bare value and as { set }', () => {
    const rest = 'media/SCREEN/000001/00000001.webm';
    for (const value of [own(rest), { set: own(rest) }]) {
      for (const operation of UPDATES) {
        expect(() =>
          asCandidate('MediaChunk', operation, writeArgs(operation, { objectKey: value })),
        ).not.toThrow();
      }
    }
  });

  it.each(KEY_COLUMNS)(
    "TC-008 %s.%s: B's prefix, another org's, another case and a bare prefix are refused",
    (model, column, rest) => {
      const refusedKeys = [
        `orgs/${ORG}/sessions/${OTHER}/${rest}`, // another session of the same org (B)
        `orgs/${ORG}/sessions/${OTHER_SESSION}/${rest}`,
        `orgs/${OTHER_ORG}/sessions/${SID}/${rest}`, // another org, this session id
        `orgs/${OTHER_ORG}/sessions/${OTHER}/${rest}`,
        `orgs/${ORG.toUpperCase()}/sessions/${SID.toUpperCase()}/${rest}`, // the ids are lower case
        `orgs/${ORG}/consents/${SID}/${rest}`, // outside the session prefix
        `orgs/${ORG}/sessions/${SID}`, // the prefix itself, no folder
        `orgs/${ORG}/sessions/${SID}/`,
        rest, // a session-relative name is not the full key
        `/${own(rest)}`,
        `s3://bucket/${own(rest)}`,
        `x${own(rest)}`,
      ];
      for (const key of refusedKeys) {
        expect(() => createWith(model, column, key)).toThrow(refusedKey);
        expect(() =>
          asCandidate(
            model,
            'createManyAndReturn',
            writeArgs('createManyAndReturn', { [column]: key }),
          ),
        ).toThrow(OrgScopeViolationError);
      }
    },
  );

  it.each(KEY_COLUMNS)(
    '%s.%s: traversal, empty segments, backslashes and control characters are refused (TC-008)',
    (model, column, rest) => {
      const folder = rest.split('/')[0] as string;
      const tail = rest.slice(folder.length + 1);
      const traversal = [
        own(`${folder}/../${tail}`),
        own(`../${rest}`),
        own(`${folder}/./${tail}`),
        own(`${folder}//${tail}`),
        own(`${rest}/..`),
        `${OWN_PREFIX}../sessions/${OTHER}/${rest}`,
        own(`${folder}\\${tail}`),
        own(`${rest}\u0000`),
        own(`${folder}/${tail}\n`),
        own(`${rest}%2e%2e`),
        `${OWN_PREFIX}${rest}/../../${OTHER}/${rest}`,
      ];
      for (const key of traversal) {
        expect(() => createWith(model, column, key)).toThrow(refusedKey);
      }
    },
  );

  it('TC-008 the folder of section 5.7 is enforced: a media key is not an identity key, and evidence has no sealed folder', () => {
    const media = own('media/SCREEN/000001/00000001.webm');
    const identity = own('identity/1/sealed/id-01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg');
    const evidence = own('evidence/01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg');
    expect(() => createWith('MediaChunk', 'objectKey', identity)).toThrow(refusedKey);
    expect(() => createWith('MediaChunk', 'objectKey', evidence)).toThrow(refusedKey);
    expect(() => createWith('MediaChunk', 'objectKey', own('media/SCREEN/1/1.webm'))).toThrow(
      refusedKey,
    );
    expect(() =>
      createWith('MediaChunk', 'objectKey', own('media/SCREEN/000001/00000001.html')),
    ).toThrow(refusedKey);
    expect(() => createWith('IdentityCheck', 'idImageKey', media)).toThrow(refusedKey);
    expect(() => createWith('IdentityCheck', 'idImageKey', evidence)).toThrow(refusedKey);
    // The id image is not the selfie, and the other way round.
    expect(() =>
      createWith('IdentityCheck', 'idImageKey', own('identity/1/selfie-01HZZZ.jpg')),
    ).toThrow(refusedKey);
    expect(() => createWith('IdentityCheck', 'selfieKey', own('identity/1/id-01HZZZ.jpg'))).toThrow(
      refusedKey,
    );
    expect(() => createWith('ProctorEvent', 'evidenceKey', media)).toThrow(refusedKey);
    expect(() => createWith('ProctorEvent', 'evidenceKey', identity)).toThrow(refusedKey);
    // The sealed re-check frame belongs to the server-written FACE_MISMATCH row.
    expect(() =>
      createWith(
        'ProctorEvent',
        'evidenceKey',
        own('evidence/sealed/01HZZZZZZZZZZZZZZZZZZZZZZZ.jpg'),
      ),
    ).toThrow(refusedKey);
    expect(() => createWith('ProctorEvent', 'evidenceKey', own('evidence/x.png'))).toThrow(
      refusedKey,
    );
  });

  it('TC-008 a value that is not a string is refused, null only on a create, undefined is not a write', () => {
    for (const value of [1, true, {}, [], { other: 'x' }, { set: 1 }, { set: null }]) {
      expect(() => createWith('MediaChunk', 'objectKey', value)).toThrow(refusedKey);
    }
    for (const operation of UPDATES) {
      expect(() =>
        asCandidate('MediaChunk', operation, writeArgs(operation, { objectKey: null })),
      ).toThrow(refusedKey);
      expect(() =>
        asCandidate('MediaChunk', operation, writeArgs(operation, { objectKey: undefined })),
      ).not.toThrow();
    }
    expect(() => createWith('MediaChunk', 'objectKey', undefined)).not.toThrow();
  });

  it('TC-008 the upsert checks both branches', () => {
    const good = own('media/SCREEN/000001/00000001.webm');
    const bad = `orgs/${ORG}/sessions/${OTHER}/media/SCREEN/000001/00000001.webm`;
    expect(() =>
      asCandidate('MediaChunk', 'upsert', writeArgs('upsert', { objectKey: good })),
    ).not.toThrow();
    expect(() =>
      asCandidate(
        'MediaChunk',
        'upsert',
        writeArgs('upsert', { objectKey: good }, { objectKey: bad }),
      ),
    ).toThrow(refusedKey);
    expect(() =>
      asCandidate(
        'MediaChunk',
        'upsert',
        writeArgs('upsert', { objectKey: bad }, { objectKey: good }),
      ),
    ).toThrow(refusedKey);
  });

  it('TC-008 the refusal names the model and the column, never the key', () => {
    let message = '';
    const secret = `orgs/${ORG}/sessions/${OTHER}/media/SCREEN/000001/00000001.webm`;
    try {
      createWith('MediaChunk', 'objectKey', secret);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('MediaChunk.create');
    expect(message).toContain('objectKey');
    expect(message).not.toContain(OTHER);
    expect(message).not.toContain('orgs/');
  });

  it('TC-008 the job (SERVICE) writes any key: the rule is a CANDIDATE rule', () => {
    for (const [model, column] of KEY_COLUMNS) {
      expect(() =>
        asService(model, 'create', writeArgs('create', { [column]: 'anything/at/all' })),
      ).not.toThrow();
    }
  });

  it('TC-008 every column a candidate may write whose name ends in Key has a rule (a new key column fails here)', () => {
    const writable = SESSION_RULES.flatMap(([model, rule]) =>
      [...(rule.create ?? []), ...(rule.update ?? [])]
        .filter((column) => /Key$/.test(column))
        .map((column) => `${model}.${column}`),
    );
    const covered = Object.entries(CANDIDATE_OBJECT_KEYS).flatMap(([model, columns]) =>
      Object.keys(columns ?? {}).map((column) => `${model}.${column}`),
    );
    expect([...new Set(writable)].sort()).toEqual([...new Set(covered)].sort());
    expect(covered.sort()).toEqual([
      'IdentityCheck.idImageKey',
      'IdentityCheck.selfieKey',
      'MediaChunk.objectKey',
      'ProctorEvent.evidenceKey',
    ]);
  });
});

describe('B3: consents are written once (FR-401, C-17; NFR-04, TC-008)', () => {
  const signed = {
    signedName: 'Synthetic Name',
    signedAt: new Date(),
    ip: '203.0.113.7',
    userAgent: 'x',
  };

  it('TC-008 a candidate update carries signedAt = null AND declinedAt = null, on top of the session filter', () => {
    for (const operation of UPDATES) {
      const { args } = asCandidate('Consent', operation, writeArgs(operation, signed));
      const where = args.where as { AND: unknown[] };
      expect(where.AND).toContainEqual({ signedAt: null, declinedAt: null });
      expect(where.AND).toContainEqual({ sessionId: SID });
    }
  });

  it('TC-008 a read is not narrowed by it, and neither is the job', () => {
    for (const operation of READ_OPERATIONS.filter((op) => ROW_RETURNING_OPERATIONS.includes(op))) {
      const { args } = asCandidate('Consent', operation, {
        where: { id: 'x' },
        select: { id: true, signedAt: true },
      });
      expect((args.where as { AND: unknown[] }).AND).not.toContainEqual({
        signedAt: null,
        declinedAt: null,
      });
    }
    for (const operation of UPDATES) {
      const { args } = asService('Consent', operation, writeArgs(operation, signed));
      expect((args.where as { AND: unknown[] }).AND).not.toContainEqual({
        signedAt: null,
        declinedAt: null,
      });
    }
  });

  it('TC-008 the other models take no such filter', () => {
    for (const [model, rule] of SESSION_RULES) {
      expect({ model, updateFilter: rule.updateFilter }).toEqual({
        model,
        updateFilter: model === 'Consent' ? { signedAt: null, declinedAt: null } : undefined,
      });
    }
  });

  it('TC-008 a candidate cannot create the row (consentTextId is server-set), and cannot upsert it', () => {
    for (const operation of [...CREATES, 'upsert']) {
      expect(() =>
        asCandidate('Consent', operation, writeArgs(operation, { signedName: 'x' })),
      ).toThrow(/cannot create this row: CS-4\.4 grants updates only/);
    }
  });
});

describe('nit 4: a candidate create cannot carry an event type only the server writes (#126)', () => {
  const event = (type: unknown) => ({ type, severity: 'LOW', occurredAt: new Date() });

  it('TC-008 the list is every type the browser may not send, and FACE_MISMATCH (a server re-check, ADR 0013 section 5.6)', () => {
    const notClient = EVENT_TYPES.filter(
      (type) => !(CLIENT_EVENT_TYPES as readonly string[]).includes(type),
    );
    expect([...SERVER_ONLY_EVENT_TYPES].sort()).toEqual([...notClient, 'FACE_MISMATCH'].sort());
    for (const type of ['FACE_MISMATCH', 'IDENTITY_MANUAL_REVIEW', 'RESUME_OTP_FAILED']) {
      expect(SERVER_ONLY_EVENT_TYPES).toContain(type);
    }
  });

  it('TC-008 each server-only type is refused on every create, and every type the browser may send passes', () => {
    for (const type of SERVER_ONLY_EVENT_TYPES) {
      for (const operation of CREATES) {
        expect(() =>
          asCandidate('ProctorEvent', operation, writeArgs(operation, event(type))),
        ).toThrow(/names a value that only the server writes/);
      }
      expect(() =>
        asCandidate('ProctorEvent', 'upsert', {
          where: { id: 1n },
          create: event(type),
          update: { durationMs: 1 },
          select: { id: true },
        }),
      ).toThrow(/names a value that only the server writes/);
      expect(() =>
        asCandidate('ProctorEvent', 'createMany', { data: [event('TAB_SWITCH'), event(type)] }),
      ).toThrow(/names a value that only the server writes/);
      // The job writes them.
      expect(() =>
        asService('ProctorEvent', 'create', writeArgs('create', event(type))),
      ).not.toThrow();
    }
    for (const type of CLIENT_EVENT_TYPES.filter((t) => t !== 'FACE_MISMATCH')) {
      expect(() =>
        asCandidate('ProctorEvent', 'create', writeArgs('create', event(type))),
      ).not.toThrow();
    }
  });

  it('TC-008 the message names no value', () => {
    let message = '';
    try {
      asCandidate('ProctorEvent', 'create', writeArgs('create', event('IDENTITY_MANUAL_REVIEW')));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('ProctorEvent.create');
    expect(message).not.toContain('IDENTITY_MANUAL_REVIEW');
  });
});

describe('nit 3: the scope tables are frozen at runtime (#126)', () => {
  const frozenDeep = (value: unknown, path: string, bad: string[]): void => {
    if (typeof value !== 'object' || value === null || value instanceof RegExp) return;
    if (!Object.isFrozen(value)) bad.push(path);
    for (const key of Reflect.ownKeys(value)) {
      frozenDeep((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`, bad);
    }
  };

  it.each([
    ['SESSION_SCOPE', SESSION_SCOPE],
    ['CANDIDATE_MODELS', CANDIDATE_MODELS],
    ['CANDIDATE_INTERIM_DENY', CANDIDATE_INTERIM_DENY],
    ['COMPOUND_UNIQUES', COMPOUND_UNIQUES],
    ['NEVER_WRITTEN_BY_CANDIDATE', NEVER_WRITTEN_BY_CANDIDATE],
    ['CANDIDATE_OBJECT_KEYS', CANDIDATE_OBJECT_KEYS],
    ['SERVER_ONLY_EVENT_TYPES', SERVER_ONLY_EVENT_TYPES],
    ['READ_OPERATIONS', READ_OPERATIONS],
    ['ROW_RETURNING_OPERATIONS', ROW_RETURNING_OPERATIONS],
  ])('TC-008 %s is frozen all the way down', (name, table) => {
    const bad: string[] = [];
    frozenDeep(table, name, bad);
    expect(bad).toEqual([]);
  });

  it('TC-008 a write to a table throws, and the tables are as they were', () => {
    const dump = (): string =>
      JSON.stringify([
        CANDIDATE_MODELS,
        CANDIDATE_INTERIM_DENY,
        COMPOUND_UNIQUES,
        NEVER_WRITTEN_BY_CANDIDATE,
      ]);
    const snapshot = dump();
    const models = CANDIDATE_MODELS as unknown as Record<string, { update: string[] }>;
    expect(() => models.Session?.update.push('status')).toThrow(TypeError);
    expect(() => {
      (models.Session as unknown as { update: string[] }).update = ['status'];
    }).toThrow(TypeError);
    expect(() => {
      (CANDIDATE_MODELS as unknown as Record<string, unknown>).User = { kind: 'read' };
    }).toThrow(TypeError);
    expect(() => {
      delete (CANDIDATE_MODELS as unknown as Record<string, unknown>).Session;
    }).toThrow(TypeError);
    expect(() =>
      (CANDIDATE_INTERIM_DENY as unknown as Record<string, { read: string[] }>).Session?.read.pop(),
    ).toThrow(TypeError);
    expect(() => (NEVER_WRITTEN_BY_CANDIDATE as string[]).pop()).toThrow(TypeError);
    expect(() =>
      (COMPOUND_UNIQUES as unknown as Record<string, string[]>).Question?.push('x'),
    ).toThrow(TypeError);
    expect(() => {
      (
        SESSION_SCOPE as unknown as Record<string, { immutable: string[] }>
      ).Session?.immutable.pop();
    }).toThrow(TypeError);
    expect(dump()).toBe(snapshot);
  });
});
