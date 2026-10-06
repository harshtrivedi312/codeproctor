// The review fixes S1 (keys behind the filters), S3 (the CS-4.4 READ allowlist, `omit`, the explicit-only
// columns, the RUN filter, and the CS-4.4 WRITE allowlist with its grants) and the CS-4.4 rules for
// proctor_events and consents, on the rewritten arguments. No database. The same rules against a real
// Postgres are in cs4-session-isolation.spec.ts and cs4-columns-grants.spec.ts. NFR-04, TC-008.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_EVENT_TYPES, EVENT_TYPES } from '@codeproctor/shared';
import { MediaStream } from '../generated/prisma/enums.js';
import { createPrismaClient } from './create-prisma-client';
import { deepFreeze } from './deep-freeze';
import {
  CANDIDATE_READ,
  COMPOUND_UNIQUES,
  hiddenColumnsOf,
  isFieldRef,
  readAccess,
  ROW_RETURNING_OPERATIONS,
  scalarColumnsOf,
} from './candidate-interim';
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionActor } from './org-context';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { applySessionScope } from './session-scope-args';
import {
  CANDIDATE_MODELS,
  CANDIDATE_OBJECT_KEYS,
  GRANT_SITES,
  NEVER_WRITTEN_BY_CANDIDATE,
  READ_OPERATIONS,
  SERVER_ONLY_EVENT_TYPES,
  SESSION_SCOPE,
} from './session-scope-map';
import type { GrantView } from './session-scope-map';
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
 * The column a candidate names where the generic tests of the other models name `id`:
 * keystroke_batches.id is a global identity counter that a candidate may not read (#126 nit 1), and
 * session_sections and proctor_event_batches have no `id` column at all.
 */
const ID_KEY: Partial<Record<ModelName, string>> = {
  KeystrokeBatch: 'seq',
  ProctorEventBatch: 'seq',
  SessionSection: 'sectionId',
};

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

/** Calls the scope exactly as given: no select is added for the caller. */
function raw(
  actor: SessionActor,
  model: ModelName,
  operation: string,
  args: unknown,
  grant?: GrantView,
) {
  return applySessionScope({
    model,
    rule: ORG_SCOPE[model],
    operation,
    args: actor === 'CANDIDATE' ? keyed(model, args) : args,
    orgId: ORG,
    session: { actor, sessionId: SID },
    facts: FACTS,
    grant,
  });
}
const asCandidate = (model: ModelName, operation: string, args: unknown, grant?: GrantView) =>
  raw('CANDIDATE', model, operation, args, grant);
/** A candidate call with the arguments exactly as given (no renaming of `id`). */
const asCandidateExact = (model: ModelName, operation: string, args: unknown, grant?: GrantView) =>
  applySessionScope({
    model,
    rule: ORG_SCOPE[model],
    operation,
    args,
    orgId: ORG,
    session: { actor: 'CANDIDATE', sessionId: SID },
    facts: FACTS,
    grant,
  });

/**
 * The grant of one CS-4.4 site, as the extension sees it: by the start of the site name, with all the
 * site's columns unless `columns` narrows them. `ids` default to the scope's own session.
 */
function grantOf(site: string, ids: GrantView['ids'] = [SID], columns?: string[]): GrantView {
  const found = GRANT_SITES.find((s) => s.name.startsWith(site));
  if (found === undefined) throw new Error(`no grant site ${site}`);
  return { model: found.model, columns: columns ?? [...found.columns], ids, mode: found.mode };
}
const asService = (model: ModelName, operation: string, args: unknown, grant?: GrantView) =>
  raw('SERVICE', model, operation, args, grant);

/** An object key of the scope's own session, in the folder ADR 0013 section 5.7 fixes for the column. */
const OWN_PREFIX = `orgs/${ORG}/sessions/${SID}/`;
/** A ULID: 26 characters of Crockford base32 (no I, L, O, U). */
const ULID = '01J9ZQ3K5M7N8P0R2S4T6V8X0Z';
const VALID_KEYS: Record<string, string> = {
  objectKey: `${OWN_PREFIX}media/SCREEN/000000/00000001.webm`,
  idImageKey: `${OWN_PREFIX}identity/1/sealed/id-${ULID}.jpg`,
  selfieKey: `${OWN_PREFIX}identity/1/sealed/selfie-${ULID}.jpg`,
  evidenceKey: `${OWN_PREFIX}evidence/${ULID}.jpg`,
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
 * CS-4.4's "Read" column, by Prisma field name, for every model on the CANDIDATE allowlist (18 models),
 * written out here apart from candidate-interim.ts so the two can be compared:
 *   read      the ADR's read column: readable, filterable, in the default select;
 *   keys      the ids of the candidate's own org, session and test, which the scope fixes anyway (PR 1's
 *             choice, FU-DB-195 (k)): readable and filterable although the ADR does not list them;
 *   explicit  explicit-only: never in the default select, readable only under a grant that names it;
 *   runOnly   readable only under the RUN filter (submissions), never in the default select;
 *   hidden    every other column: never readable, always omitted.
 * `gated` models (consent_texts, test_questions) are readable only under a grant of their own.
 */
interface Cs44Read {
  readonly read: readonly string[];
  readonly keys: readonly string[];
  readonly explicit: readonly string[];
  readonly runOnly: readonly string[];
  readonly hidden: readonly string[];
}
const CS44: Record<string, Cs44Read> = {
  Session: {
    read: [
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
    keys: ['orgId'],
    explicit: ['hmacKeyEnc', 'deviceInfo'],
    runOnly: [],
    hidden: [
      'invitationId',
      'clientKind',
      'totalScore',
      'riskScore',
      'riskBand',
      'lastHeartbeat',
      'retentionAnchorAt',
      'reportKey',
      'reportGeneratedAt',
      'createdAt',
    ],
  },
  SessionQuestion: {
    read: ['id', 'sessionId', 'position', 'points', 'finalCode', 'finalLanguage', 'answer'],
    keys: [],
    explicit: ['testQuestionId'],
    runOnly: [],
    hidden: [
      'questionVersionId',
      'variantId',
      'score',
      'scoring',
      'scoredById',
      'scoredAt',
      'scoringNote',
    ],
  },
  SessionSection: {
    read: [
      'sessionId',
      'sectionId',
      'position',
      'timeLimitMs',
      'startedAt',
      'deadlineAt',
      'endedAt',
    ],
    keys: [],
    explicit: [],
    runOnly: [],
    hidden: [],
  },
  Submission: {
    read: ['id', 'sessionQuestionId', 'kind', 'language', 'createdAt'],
    keys: [],
    explicit: [],
    runOnly: ['results', 'passed', 'total'],
    hidden: ['sourceCode', 'score'],
  },
  IdentityCheck: {
    read: ['id', 'attempt', 'status', 'createdAt'],
    keys: ['sessionId'],
    explicit: [],
    runOnly: [],
    hidden: [
      'idImageKey',
      'selfieKey',
      'faceMatchScore',
      'modelId',
      'threshold',
      'livenessPassed',
      'reviewReason',
      'manualDecision',
      'reviewedById',
      'reviewedAt',
      'reviewNote',
      // ADR 0015 section 4 (the video ID check on a WAIVED row): CS-4.4 lists id, attempt, status and
      // created_at as readable, so the three columns are hidden from a candidate.
      'videoCheckDone',
      'videoCheckById',
      'videoCheckAt',
    ],
  },
  MediaChunk: {
    read: ['id', 'stream', 'segment', 'seq', 'sizeBytes', 'uploadedAt'],
    keys: ['sessionId'],
    explicit: ['objectKey'],
    runOnly: [],
    hidden: ['startedAt', 'durationMs', 'deletedAt'],
  },
  ProctorEventBatch: {
    read: ['seq', 'signature', 'eventCount'],
    keys: ['sessionId'],
    explicit: [],
    runOnly: [],
    hidden: ['receivedAt'],
  },
  KeystrokeBatch: {
    read: ['seq', 'signature', 'startedAt'],
    keys: ['sessionId', 'sessionQuestionId'],
    explicit: [],
    runOnly: [],
    hidden: ['id', 'events'],
  },
  ProctorEvent: {
    read: ['id', 'type', 'occurredAt', 'durationMs', 'batchSeq', 'createdAt'],
    keys: ['sessionId'],
    explicit: [],
    runOnly: [],
    hidden: ['severity', 'source', 'confidence', 'payload', 'evidenceKey'],
  },
  Consent: {
    read: ['id', 'consentTextId', 'signedAt', 'declinedAt'],
    keys: ['sessionId'],
    explicit: [],
    runOnly: [],
    hidden: [
      'signedName',
      'ip',
      'userAgent',
      'ageConfirmedAt',
      'pdfKey',
      'pdfGeneratedAt',
      'copyEmailedAt',
    ],
  },
  Organization: {
    read: ['id', 'name', 'retentionDays', 'currentConsentTextId'],
    keys: [],
    explicit: ['settings'],
    runOnly: [],
    hidden: ['createdAt'],
  },
  Candidate: {
    read: ['id', 'fullName', 'email'],
    keys: ['orgId'],
    explicit: [],
    runOnly: [],
    hidden: ['externalRef', 'erasureRequestedAt', 'erasedAt', 'createdAt'],
  },
  Invitation: {
    read: ['id', 'testId', 'candidateId', 'windowStart', 'windowEnd', 'usedAt'],
    keys: ['orgId'],
    explicit: ['accommodations'],
    runOnly: [],
    hidden: ['tokenHash', 'sentAt', 'createdById', 'createdAt'],
  },
  Test: {
    read: ['id', 'name', 'description', 'durationMinutes', 'profile'],
    keys: ['orgId'],
    explicit: ['settings'],
    runOnly: [],
    hidden: ['passScore', 'createdById', 'createdAt'],
  },
  TestSection: {
    read: ['id', 'title', 'position', 'timeLimitMin'],
    keys: ['testId'],
    explicit: [],
    runOnly: [],
    hidden: [],
  },
  Question: {
    read: ['id', 'type'],
    keys: ['orgId'],
    explicit: [],
    runOnly: [],
    hidden: ['slug', 'tags', 'currentVersionId', 'isArchived', 'createdById', 'createdAt'],
  },
  // Gated models: readable only under the grant of that model, and then through the grant's columns.
  ConsentText: {
    read: ['id', 'version', 'bodyMd', 'legalApprovedAt'],
    keys: [],
    explicit: [],
    runOnly: [],
    hidden: ['orgId', 'legalApprovedBy', 'createdById', 'createdAt'],
  },
  TestQuestion: {
    read: ['id', 'sectionId'],
    keys: [],
    explicit: [],
    runOnly: [],
    hidden: ['questionVersionId', 'randomRule', 'points', 'position'],
  },
};
const GATED: readonly string[] = ['ConsentText', 'TestQuestion'];
const GATED_GRANT: Record<string, GrantView> = {
  ConsentText: grantOf('ConsentService (consent text)', [OTHER]),
  TestQuestion: grantOf('SectionGateService (step 2)', [OTHER]),
};
/** The grant a model needs to be readable at all (none for a model that is not gated). */
const baseGrant = (model: string): GrantView | undefined => GATED_GRANT[model];
/** A readable column to name next to the one under test (`id` is hidden or absent on some models). */
const fillerOf = (model: string): string => CS44[model]?.read[0] ?? 'id';
const MODELS = Object.keys(CS44) as ModelName[];
const READABLE_MODELS = MODELS.filter((m) => !GATED.includes(m));

describe('S3: the CS-4.4 READ allowlist (NFR-04, TC-008)', () => {
  it('TC-008 CANDIDATE_READ is the CS-4.4 read column of the ADR, for exactly the 18 models on the allowlist', () => {
    expect(Object.keys(CANDIDATE_READ).sort()).toEqual(MODELS.slice().sort());
    expect(Object.keys(CANDIDATE_READ).sort()).toEqual(Object.keys(CANDIDATE_MODELS).sort());
    for (const model of MODELS) {
      const rule = CANDIDATE_READ[model];
      expect({
        model,
        read: [...(rule?.read ?? [])].sort(),
        keys: [...(rule?.keys ?? [])].sort(),
        explicit: [...(rule?.explicit ?? [])].sort(),
        runOnly: [...(rule?.runOnly ?? [])].sort(),
      }).toEqual({
        model,
        read: [...(CS44[model]?.read ?? [])].sort(),
        keys: [...(CS44[model]?.keys ?? [])].sort(),
        explicit: [...(CS44[model]?.explicit ?? [])].sort(),
        runOnly: [...(CS44[model]?.runOnly ?? [])].sort(),
      });
    }
  });

  it('TC-008 every column of every model is exactly one of readable, key, explicit-only, RUN-only or hidden, and a new column of the schema fails here until it is classified', async () => {
    const metas = await readModelMetas();
    for (const model of MODELS) {
      const columns = (metas[model]?.fields ?? [])
        .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
        .map((f) => f.name);
      const expected = CS44[model];
      if (expected === undefined) throw new Error('unreachable');
      const classes = [
        expected.read,
        expected.keys,
        expected.explicit,
        expected.runOnly,
        expected.hidden,
      ];
      const listed = classes.flat();
      // No column twice, every entry is a column of the model, and no column of the model is left out.
      expect({ model, twice: listed.filter((c, i) => listed.indexOf(c) !== i) }).toEqual({
        model,
        twice: [],
      });
      expect({ model, unknown: listed.filter((c) => !columns.includes(c)) }).toEqual({
        model,
        unknown: [],
      });
      expect({ model, unclassified: columns.filter((c) => !listed.includes(c)) }).toEqual({
        model,
        unclassified: [],
      });
      // What the extension derives from the generated client agrees.
      expect([...scalarColumnsOf(model)].sort()).toEqual([...columns].sort());
      expect([...hiddenColumnsOf(model)].sort()).toEqual([...expected.hidden].sort());
    }
  });

  it('TC-008 hides what the review named, and what CS-4.4 keeps from a candidate (the sealed key, the settings, the pass score, the invitation token, the erasure state)', () => {
    const must: Record<string, string[]> = {
      Session: [
        'invitationId',
        'totalScore',
        'riskScore',
        'riskBand',
        'reportKey',
        'retentionAnchorAt',
        'clientKind',
        'reportGeneratedAt',
        'lastHeartbeat',
      ],
      Invitation: ['tokenHash'],
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
        'videoCheckDone',
        'videoCheckById',
        'videoCheckAt',
      ],
      Test: ['passScore'],
      Submission: ['score', 'sourceCode'],
      SessionQuestion: ['score', 'scoringNote', 'scoring', 'scoredById', 'scoredAt'],
      Consent: ['ip', 'userAgent', 'signedName', 'ageConfirmedAt', 'pdfKey'],
      ProctorEvent: ['severity', 'payload', 'evidenceKey', 'confidence', 'source'],
      Candidate: ['erasureRequestedAt', 'erasedAt', 'externalRef'],
      KeystrokeBatch: ['id', 'events'],
    };
    for (const [model, columns] of Object.entries(must)) {
      for (const column of columns) expect(hiddenColumnsOf(model as ModelName)).toContain(column);
    }
    // The explicit-only columns and the RUN columns are not hidden: a grant or the RUN filter opens them.
    for (const [model, column] of [
      ['Session', 'hmacKeyEnc'],
      ['Session', 'deviceInfo'],
      ['MediaChunk', 'objectKey'],
      ['Organization', 'settings'],
      ['Test', 'settings'],
      ['Invitation', 'accommodations'],
      ['SessionQuestion', 'testQuestionId'],
      ['Submission', 'results'],
    ] as const) {
      expect(hiddenColumnsOf(model)).not.toContain(column);
    }
  });

  it('TC-008 every model it names is on the CANDIDATE allowlist (an entry for another would be dead)', () => {
    for (const model of Object.keys(CANDIDATE_READ)) {
      expect(CANDIDATE_MODELS[model as ModelName]).toBeDefined();
    }
  });

  describe('omit: the default select is narrowed, so a new column stays hidden until it is listed', () => {
    /** The `omit` a candidate call with no select runs with. */
    const omitOf = (model: ModelName, operation: string, args: Record<string, unknown>) =>
      asCandidate(model, operation, args, baseGrant(model)).args.omit as
        Record<string, unknown> | undefined;
    const expectedOmit = (model: string): string[] => {
      const spec = CS44[model];
      if (spec === undefined) throw new Error('unreachable');
      return [...spec.hidden, ...spec.explicit, ...spec.runOnly].sort();
    };

    it.each(MODELS)(
      'TC-008 %s: every row-returning read with no select runs with omit = every column that is not in the default select',
      (model) => {
        // A gated model's default select is the grant's columns (here all of them).
        const grant = baseGrant(model);
        for (const operation of READ_OPERATIONS.filter((op) =>
          ROW_RETURNING_OPERATIONS.includes(op),
        )) {
          const omit = omitOf(model, operation, { where: { [fillerOf(model)]: 'x' } });
          expect({ model, operation, omit: Object.keys(omit ?? {}).sort() }).toEqual({
            model,
            operation,
            omit: expectedOmit(model),
          });
          expect(Object.values(omit ?? {}).every((v) => v === true)).toBe(true);
          expect(grant === undefined || (CS44[model]?.read ?? []).length > 0).toBe(true);
        }
      },
    );

    it('TC-008 the omit never contains a column of the default select, and every other scalar column is in it', () => {
      for (const model of MODELS) {
        const omit = Object.keys(
          readAccess(model, GATED.includes(model), baseGrant(model)).omit,
        ).sort();
        const spec = CS44[model];
        if (spec === undefined) throw new Error('unreachable');
        const inDefault = [...spec.read, ...spec.keys];
        expect(omit.filter((c) => inDefault.includes(c))).toEqual([]);
        expect([...scalarColumnsOf(model)].filter((c) => !inDefault.includes(c)).sort()).toEqual(
          omit,
        );
      }
    });

    it.each(READABLE_MODELS)(
      'TC-008 %s: a write that returns the row runs with the same omit (creates and updates included)',
      (model) => {
        const rule = CANDIDATE_MODELS[model];
        if (rule?.kind !== 'session') return;
        const calls: Array<[string, Record<string, unknown>]> = [];
        if (rule.update !== undefined) {
          calls.push(
            ['update', writeArgs('update', {}, {})],
            ['updateManyAndReturn', writeArgs('updateManyAndReturn', {})],
          );
        }
        if (rule.create !== undefined) {
          calls.push(
            ['create', writeArgs('create', {})],
            ['createManyAndReturn', writeArgs('createManyAndReturn', {})],
          );
        }
        if (rule.create !== undefined && rule.update !== undefined) {
          calls.push(['upsert', writeArgs('upsert', {}, {})]);
        }
        for (const [operation, args] of calls) {
          const given: Record<string, unknown> = { ...args };
          delete given.select;
          expect({
            model,
            operation,
            omit: Object.keys(omitOf(model, operation, given) ?? {}).sort(),
          }).toEqual({ model, operation, omit: expectedOmit(model) });
        }
      },
    );

    it('TC-008 the omit of an update is the same row shape as a read: a hidden column does not come back from a write', () => {
      const omit = omitOf('Session', 'update', {
        where: { id: 'x' },
        data: { lastHeartbeat: new Date() },
      });
      expect(omit).toMatchObject({ hmacKeyEnc: true, deviceInfo: true, invitationId: true });
      expect(omit).not.toHaveProperty('status');
      expect(omit).not.toHaveProperty('id');
    });

    it('TC-008 a select suppresses the omit (Prisma refuses both together), and a call that returns no rows gets none', () => {
      // A session takes no create, so the rows-returning calls it may make are the reads and the updates.
      for (const operation of [...READ_OPERATIONS, 'update', 'updateManyAndReturn'].filter((op) =>
        ROW_RETURNING_OPERATIONS.includes(op),
      )) {
        const args = writeArgs(operation, {}, {});
        expect(
          asCandidate('Session', operation, { ...args, select: { id: true } }).args,
        ).not.toHaveProperty('omit');
      }
      for (const [operation, args] of [
        ['count', {}],
        ['aggregate', { _count: true }],
        ['groupBy', { by: ['status'], _count: true }],
        ['updateMany', { where: { id: 'x' }, data: { lastHeartbeat: new Date() } }],
      ] as const) {
        expect(asCandidate('Session', operation, args).args).not.toHaveProperty('omit');
      }
      expect(
        asCandidate('ProctorEventBatch', 'createMany', { data: [{ seq: 1, eventCount: 1 }] }).args,
      ).not.toHaveProperty('omit');
    });

    it('TC-008 a caller omit is merged and ours wins: omit: { hmacKeyEnc: false } cannot bring a hidden column back', () => {
      const omit = omitOf('Session', 'findMany', {
        omit: { hmacKeyEnc: false, deviceInfo: false, status: true, invitationId: undefined },
      });
      expect(omit).toMatchObject({ hmacKeyEnc: true, deviceInfo: true, invitationId: true });
      // The caller may hide more.
      expect(omit?.status).toBe(true);
    });

    it('TC-008 select with omit, a select or an omit that is not an object, and an empty omit of nothing hidden: refused or merged', () => {
      expect(() =>
        asCandidate('Session', 'findMany', { select: { id: true }, omit: { status: true } }),
      ).toThrow(/select and omit cannot be used together/);
      for (const bad of [null, true, 'id', 7, [] as unknown[]]) {
        expect(() => asCandidateExact('Session', 'findMany', { select: bad })).toThrow(
          OrgScopeViolationError,
        );
      }
      for (const bad of [null, true, 'id', 7]) {
        expect(() => asCandidateExact('Session', 'findMany', { omit: bad })).toThrow(
          OrgScopeViolationError,
        );
      }
    });

    it('TC-008 SERVICE gets no omit and no select rule: no column limit', () => {
      for (const operation of READ_OPERATIONS) {
        expect(asService('Session', operation, {}).args).not.toHaveProperty('omit');
      }
    });

    it('TC-008 a column the schema gains stays hidden: the omit is computed from the generated client, not from a deny list', async () => {
      await jest.isolateModulesAsync(async () => {
        // A fresh module registry: a copy of the client namespace that this test alone changes.
        const { Prisma } = (await import('../generated/prisma/client.js')) as unknown as {
          Prisma: Record<string, Record<string, string>>;
        };
        const fields = Prisma.SessionScalarFieldEnum as Record<string, string>;
        const original = { ...fields };
        fields.brandNewColumn = 'brandNewColumn';
        try {
          const fresh = await import('./candidate-interim.js');
          const access = fresh.readAccess('Session', false, undefined);
          expect(access.omit.brandNewColumn).toBe(true);
          expect(access.readable.has('brandNewColumn')).toBe(false);
          expect(fresh.hiddenColumnsOf('Session')).toContain('brandNewColumn');
          // And a call that names it is refused, in every place.
          expect(() =>
            fresh.assertCandidateColumns(
              'Session',
              'findMany',
              { select: { brandNewColumn: true } },
              false,
              undefined,
            ),
          ).toThrow(/the column brandNewColumn is not available/);
          expect(() =>
            fresh.assertCandidateColumns(
              'Session',
              'count',
              { where: { brandNewColumn: 1 } },
              false,
              undefined,
            ),
          ).toThrow(/the column brandNewColumn is not available/);
        } finally {
          for (const key of Object.keys(fields)) delete fields[key];
          Object.assign(fields, original);
        }
      });
    });
  });

  describe('the read list is refused in select, where, having, orderBy, distinct, by and the aggregates', () => {
    // Every column a candidate may never name without a grant: the hidden ones, and the explicit-only ones
    // when no grant is active. A gated model is read under its full grant, which still hides the rest.
    const refusedColumns = MODELS.flatMap((model) => [
      ...(CS44[model]?.hidden ?? []).map((column) => [model, column] as const),
      ...(CS44[model]?.explicit ?? []).map((column) => [model, column] as const),
    ]);

    it.each(refusedColumns)(
      'TC-008 %s.%s: refused everywhere a column can be read, filtered or ordered on',
      (model, column) => {
        const m = model;
        const grant = baseGrant(model);
        // The other arguments name a column the candidate may read.
        const key = fillerOf(model);
        const listed = (operation: string, args: Record<string, unknown>): void => {
          expect(() => asCandidateExact(m, operation, args, grant)).toThrow(
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
          // No select at all: the where and orderBy are still checked (the omit is the select).
          listed(operation, { where: { [column]: { not: null } } });
          listed(operation, { orderBy: { [column]: 'asc' } });
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

    it('TC-008 a column that is on the list passes in every one of those places, and so does _all in count', () => {
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
      expect(() =>
        asCandidate('Session', 'count', { select: { _all: true, status: true } }),
      ).not.toThrow();
      // `_all` is not a column of anything else: it is allowed in count's select and `_count` only.
      expect(() => asCandidate('Session', 'findMany', { select: { _all: true } })).toThrow(
        /the column _all is not available/,
      );
    });

    it('TC-008 every readable column of every model passes in select, where, orderBy and the aggregates (no over-refusal)', () => {
      for (const model of MODELS) {
        const spec = CS44[model];
        if (spec === undefined) throw new Error('unreachable');
        const grant = baseGrant(model);
        for (const column of [...spec.read, ...spec.keys]) {
          expect({
            model,
            column,
            ok: tryCall(() =>
              asCandidateExact(
                model,
                'findMany',
                {
                  select: { [column]: true },
                  where: { [column]: { not: null } },
                  orderBy: { [column]: 'asc' },
                  distinct: [column],
                },
                grant,
              ),
            ),
          }).toEqual({ model, column, ok: true });
          expect(() =>
            asCandidateExact(
              model,
              'aggregate',
              { _count: { [column]: true }, _max: { [column]: true } },
              grant,
            ),
          ).not.toThrow();
        }
      }
    });

    it('TC-008 a JSON path filter on a hidden column is refused: its key is the column', () => {
      expect(() =>
        asCandidate('Session', 'findMany', {
          select: { id: true },
          where: { deviceInfo: { path: ['systemCheck', 'ok'], equals: true } },
        }),
      ).toThrow(/the column deviceInfo is not available/);
      expect(() =>
        asCandidate('ProctorEvent', 'findMany', {
          select: { id: true },
          where: { payload: { path: ['x'], equals: true } },
        }),
      ).toThrow(/the column payload is not available/);
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
      for (const [model, column] of refusedColumns) {
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

  describe('compound unique selectors are read through (nit 6: findUnique by another unique key)', () => {
    it('TC-008 the table equals the @@unique and @@id of schema.prisma, for the models on the allowlist', () => {
      const schema = readFileSync(resolve(__dirname, '../../../../prisma/schema.prisma'), 'utf8');
      const found: Record<string, string[]> = {};
      for (const block of schema.split(/^model\s+/m).slice(1)) {
        const name = block.slice(0, block.indexOf(' ')).trim();
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
          asCandidate(model, 'findUnique', { where, select: { [fillerOf(model)]: true } }),
        ).not.toThrow();
        // With no select at all the omit is the selection: the compound key is still read through.
        expect(() => asCandidate(model, 'findUnique', { where })).not.toThrow();
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

    it('TC-008 a compound selector of an unknown model entry is read as one name, which is not a column: refused', () => {
      expect(() =>
        asCandidate('Session', 'findUnique', {
          where: { id_orgId: { id: SID, orgId: ORG } },
          select: { id: true },
        }),
      ).toThrow(/the column id_orgId is not available/);
    });

    it('TC-008 consent_texts orgId_version reads through to orgId, which a grant of the text does not unlock', () => {
      expect(() =>
        asCandidate(
          'ConsentText',
          'findUnique',
          { where: { orgId_version: { orgId: ORG, version: '1' } }, select: { id: true } },
          baseGrant('ConsentText'),
        ),
      ).toThrow(/the column orgId is not available/);
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
const CS44_WRITE: Record<
  string,
  {
    create?: readonly string[];
    update?: readonly string[];
    /** Columns writable only while a grant names them (CS-4.4: the SessionStateService and DeviceInfoService grants). */
    grantedUpdate?: readonly string[];
    /** The one create that needs its grant (CS-4.4, item 9: the consents create under ConsentService). */
    grantedCreate?: readonly string[];
  }
> = {
  Session: {
    update: ['lastHeartbeat'],
    grantedUpdate: ['status', 'pauseReasons', 'submittedAt', 'deviceInfo'],
  },
  SessionQuestion: { update: ['finalCode', 'finalLanguage', 'answer'] },
  SessionSection: {},
  Submission: {
    create: ['sessionQuestionId', 'kind', 'language', 'sourceCode', 'results', 'passed', 'total'],
  },
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
  Consent: {
    grantedCreate: [
      'sessionId',
      'consentTextId',
      'signedName',
      'signedAt',
      'declinedAt',
      'ageConfirmedAt',
      'ip',
      'userAgent',
    ],
  },
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
          : column === 'stream'
            ? 'SCREEN' // the media key of VALID_KEYS names SCREEN, segment 0 (the default), seq 1
            : column === 'segment'
              ? 0
              : (VALID_KEYS[column] ?? 1);

  it('TC-008 the lists in CANDIDATE_MODELS are exactly the CS-4.4 write column', () => {
    expect(SESSION_RULES.map(([model]) => model).sort()).toEqual(Object.keys(CS44_WRITE).sort());
    for (const [model, rule] of SESSION_RULES) {
      expect({
        model,
        create: rule.create,
        update: rule.update,
        grantedUpdate: rule.grantedUpdate,
        grantedCreate: rule.grantedCreate,
      }).toEqual({
        model,
        create: CS44_WRITE[model]?.create,
        update: CS44_WRITE[model]?.update,
        grantedUpdate: CS44_WRITE[model]?.grantedUpdate,
        grantedCreate: CS44_WRITE[model]?.grantedCreate,
      });
    }
  });

  it('TC-008 the lists name real columns, and never id, orgId or a timestamp', () => {
    for (const [model, rule] of SESSION_RULES) {
      for (const column of [
        ...(rule.create ?? []),
        ...(rule.update ?? []),
        ...(rule.grantedUpdate ?? []),
        ...(rule.grantedCreate ?? []),
      ]) {
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
        // results, passed and total are written on a RUN row only (CS-4.4).
        const row = {
          [column]: valueOf(column),
          ...(model === 'Submission' && ['results', 'passed', 'total'].includes(column)
            ? { kind: 'RUN' }
            : {}),
        };
        const listed = rule.create?.includes(column) === true;
        for (const operation of creates()) {
          if (rule.create === undefined) {
            expect(() => asCandidate(model, operation, createArgs(operation, row))).toThrow(
              /cannot create this row|writes nothing here|creates this row only under its create grant/,
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
              /cannot update this row|writes nothing here|creates this row only under its create grant/,
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
    for (const model of ['Session', 'SessionQuestion']) {
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
    ['Submission', 'score'],
    ['IdentityCheck', 'status'],
    ['IdentityCheck', 'manualDecision'],
    ['IdentityCheck', 'reviewNote'],
    ['IdentityCheck', 'videoCheckDone'],
    ['IdentityCheck', 'videoCheckById'],
    ['IdentityCheck', 'videoCheckAt'],
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

  describe('ADR 0015 (waived identity check) in a CANDIDATE scope: CS-4.4 gives the candidate no part of WAIVED or the video check', () => {
    // CS-4.4 grants identity_checks create only, for attempt, id_image_key, selfie_key and
    // liveness_passed, and reads id, attempt, status and created_at. `status` is not writable, so a
    // candidate can never create a WAIVED row (the accommodations path, a staff scope, writes it), and
    // the three video_check_* columns of ADR 0015 section 4 are neither readable nor writable.
    const VIDEO_CHECK = ['videoCheckDone', 'videoCheckById', 'videoCheckAt'] as const;

    it.each([
      ['a bare status', { status: 'WAIVED' }],
      ['the first attempt, as a waived row looks', { attempt: 1, status: 'WAIVED' }],
      ['a second attempt', { attempt: 2, status: 'WAIVED' }],
      ['a set object', { attempt: 1, status: { set: 'WAIVED' } }],
      ['with a video check', { attempt: 1, status: 'WAIVED', videoCheckDone: true }],
      [
        'with the allowed columns beside it',
        { attempt: 1, livenessPassed: true, status: 'WAIVED' },
      ],
    ] as const)(
      'TC-008 FR-305 ADR 0015 4: IdentityCheck status = WAIVED is refused on every write operation (%s)',
      (_label, row) => {
        for (const operation of WRITES) {
          expect(() =>
            asCandidate(
              'IdentityCheck',
              operation,
              operation === 'upsert'
                ? writeArgs(operation, row, row)
                : writeArgs(operation, { ...row }),
            ),
          ).toThrow(OrgScopeViolationError);
        }
        // On a create the refusal names the column, not the model: `status` is the one that is not listed.
        for (const operation of CREATES) {
          expect(() =>
            asCandidate('IdentityCheck', operation, writeArgs(operation, { ...row })),
          ).toThrow(/status cannot be written by a candidate create here|videoCheckDone cannot be/);
        }
      },
    );

    it('TC-008 FR-305 ADR 0015 4: a WAIVED row hidden in the second row of a createMany is refused too, and nothing is stamped', () => {
      for (const operation of ['createMany', 'createManyAndReturn'] as const) {
        expect(() =>
          asCandidate('IdentityCheck', operation, {
            data: [
              { attempt: 1, livenessPassed: true },
              { attempt: 2, status: 'WAIVED' },
            ],
            ...(operation === 'createManyAndReturn' ? { select: { id: true } } : {}),
          }),
        ).toThrow(/status cannot be written by a candidate create here/);
      }
    });

    it('TC-008 FR-305 ADR 0015 4: the create a candidate may send (CS-4.4: attempt, id_image_key, selfie_key, liveness_passed) still passes, so the refusals above are about the columns', () => {
      for (const operation of CREATES) {
        expect(() =>
          asCandidate(
            'IdentityCheck',
            operation,
            writeArgs(operation, {
              attempt: 1,
              idImageKey: `${OWN_PREFIX}identity/1/sealed/id-${ULID}.jpg`,
              selfieKey: `${OWN_PREFIX}identity/1/sealed/selfie-${ULID}.jpg`,
              livenessPassed: true,
            }),
          ),
        ).not.toThrow();
      }
    });

    it.each(VIDEO_CHECK)(
      'TC-008 FR-305 ADR 0015 4: IdentityCheck.%s is hidden: not in the read allowlist, and refused in select, where, orderBy, groupBy and an aggregate',
      (column) => {
        expect(hiddenColumnsOf('IdentityCheck')).toContain(column);
        expect(CANDIDATE_READ.IdentityCheck?.read).not.toContain(column);
        const filter = { [column]: column === 'videoCheckDone' ? true : null };
        for (const operation of ['findMany', 'findFirst', 'findFirstOrThrow', 'count']) {
          expect(() =>
            asCandidate('IdentityCheck', operation, { select: { [column]: true } }),
          ).toThrow(OrgScopeViolationError);
          expect(() => asCandidate('IdentityCheck', operation, { where: filter })).toThrow(
            OrgScopeViolationError,
          );
        }
        expect(() =>
          asCandidate('IdentityCheck', 'findMany', { orderBy: { [column]: 'asc' } }),
        ).toThrow(OrgScopeViolationError);
        expect(() =>
          asCandidate('IdentityCheck', 'groupBy', { by: [column], _count: true }),
        ).toThrow(OrgScopeViolationError);
        expect(() =>
          asCandidate('IdentityCheck', 'aggregate', { _count: { [column]: true } }),
        ).toThrow(OrgScopeViolationError);
        // The one non-hidden shape stays open: the default select omits the column, it does not throw.
        expect(() => asCandidate('IdentityCheck', 'findMany', {})).not.toThrow();
      },
    );

    it('TC-008 FR-305 ADR 0015 4: the readable columns are still exactly id, attempt, status and created_at, so a candidate reads WAIVED as a status and nothing else of the row', () => {
      expect([...(CANDIDATE_READ.IdentityCheck?.read ?? [])].sort()).toEqual(
        ['attempt', 'createdAt', 'id', 'status'].sort(),
      );
      for (const column of ['id', 'attempt', 'status', 'createdAt']) {
        expect(() =>
          asCandidate('IdentityCheck', 'findMany', { select: { [column]: true } }),
        ).not.toThrow();
      }
    });
  });

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
  const MODELS = READABLE_MODELS;
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
    ['MediaChunk', 'objectKey', 'media/SCREEN/000000/00000001.webm'],
    ['IdentityCheck', 'idImageKey', `identity/1/sealed/id-${ULID}.jpg`],
    ['IdentityCheck', 'selfieKey', `identity/1/sealed/selfie-${ULID}.jpg`],
    ['ProctorEvent', 'evidenceKey', `evidence/${ULID}.jpg`],
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
    const rest = 'media/SCREEN/000000/00000001.webm';
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
    const media = own('media/SCREEN/000000/00000001.webm');
    const identity = own(`identity/1/sealed/id-${ULID}.jpg`);
    const evidence = own(`evidence/${ULID}.jpg`);
    expect(() => createWith('MediaChunk', 'objectKey', identity)).toThrow(refusedKey);
    expect(() => createWith('MediaChunk', 'objectKey', evidence)).toThrow(refusedKey);
    expect(() => createWith('MediaChunk', 'objectKey', own('media/SCREEN/1/1.webm'))).toThrow(
      refusedKey,
    );
    expect(() =>
      createWith('MediaChunk', 'objectKey', own('media/SCREEN/000000/00000001.html')),
    ).toThrow(refusedKey);
    expect(() => createWith('IdentityCheck', 'idImageKey', media)).toThrow(refusedKey);
    expect(() => createWith('IdentityCheck', 'idImageKey', evidence)).toThrow(refusedKey);
    // The id image is not the selfie, and the other way round.
    expect(() =>
      createWith('IdentityCheck', 'idImageKey', own(`identity/1/sealed/selfie-${ULID}.jpg`)),
    ).toThrow(refusedKey);
    expect(() =>
      createWith('IdentityCheck', 'selfieKey', own(`identity/1/sealed/id-${ULID}.jpg`)),
    ).toThrow(refusedKey);
    expect(() => createWith('ProctorEvent', 'evidenceKey', media)).toThrow(refusedKey);
    expect(() => createWith('ProctorEvent', 'evidenceKey', identity)).toThrow(refusedKey);
    // The sealed re-check frame belongs to the server-written FACE_MISMATCH row.
    expect(() =>
      createWith('ProctorEvent', 'evidenceKey', own(`evidence/sealed/${ULID}.jpg`)),
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
    const good = own('media/SCREEN/000000/00000001.webm');
    const bad = `orgs/${ORG}/sessions/${OTHER}/media/SCREEN/000000/00000001.webm`;
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
    const secret = `orgs/${ORG}/sessions/${OTHER}/media/SCREEN/000000/00000001.webm`;
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

describe('B2 round 4: sealed identity keys, Crockford ULIDs, the MediaStream enum, keys bound to their row (ADR 0013 section 5.7; NFR-04, TC-008)', () => {
  const own = (rest: string): string => `${OWN_PREFIX}${rest}`;
  const refusedKey = /must be an object key under this session's own prefix/;
  const create = (model: ModelName, row: Record<string, unknown>, operation = 'create') =>
    asCandidate(model, operation, writeArgs(operation, row));
  const media = (stream: string, segment: number, seq: number): string =>
    own(`media/${stream}/${String(segment).padStart(6, '0')}/${String(seq).padStart(8, '0')}.webm`);
  const identity = (attempt: number | string, word: 'id' | 'selfie'): string =>
    own(`identity/${attempt}/sealed/${word}-${ULID}.jpg`);

  it.each([
    ['idImageKey', 'id'],
    ['selfieKey', 'selfie'],
  ] as const)(
    'TC-008 IdentityCheck.%s: the unsealed upload key is refused on every create, the sealed copy passes',
    (column, word) => {
      // ADR 0013 section 5.7: the columns point to the sealed copy only. The upload key can be re-PUT
      // within its 60 s URL and is deleted once sealed.
      const upload = own(`identity/1/${word}-${ULID}.jpg`);
      for (const operation of CREATES) {
        expect(() => create('IdentityCheck', { [column]: upload }, operation)).toThrow(refusedKey);
        expect(() =>
          create('IdentityCheck', { [column]: identity(1, word) }, operation),
        ).not.toThrow();
      }
      // The sealed folder is for the sealed copy: not the evidence one, not a deeper folder.
      for (const key of [
        own(`identity/1/sealed/sealed/${word}-${ULID}.jpg`),
        own(`identity/sealed/1/${word}-${ULID}.jpg`),
        own(`evidence/sealed/${ULID}.jpg`),
        own(`identity/1/sealed/${word}-${ULID}.png`),
        own(`identity/1/sealed/${word}-${ULID}.jpg.bak`),
      ]) {
        expect(() => create('IdentityCheck', { [column]: key })).toThrow(refusedKey);
      }
    },
  );

  it('TC-008 the attempt in an identity key has no leading zero and at most three digits', () => {
    for (const attempt of ['0', '00', '01', '1000', 'x', '-1', '1.5']) {
      expect(() =>
        create('IdentityCheck', { attempt: 1, idImageKey: identity(attempt, 'id') }),
      ).toThrow(refusedKey);
    }
    for (const attempt of [1, 9, 10, 999]) {
      expect(() =>
        create('IdentityCheck', { attempt, idImageKey: identity(attempt, 'id') }),
      ).not.toThrow();
    }
  });

  it.each([
    ['IdentityCheck', 'idImageKey', (u: string) => identity(1, 'id').replace(ULID, u)],
    ['IdentityCheck', 'selfieKey', (u: string) => identity(1, 'selfie').replace(ULID, u)],
    ['ProctorEvent', 'evidenceKey', (u: string) => own(`evidence/${u}.jpg`)],
  ] as const)(
    'TC-008 %s.%s: the name is a ULID of 26 Crockford base32 characters',
    (model, column, keyOf) => {
      expect(() => create(model, { [column]: keyOf(ULID) })).not.toThrow();
      const refused = [
        '01HZZZ', // a short name is not a ULID
        ULID.slice(0, 25),
        `${ULID}0`,
        ULID.toLowerCase(), // Crockford base32 as ULIDs write it is upper case
        `I${ULID.slice(1)}`, // I, L, O and U are not in the alphabet
        `L${ULID.slice(1)}`,
        `O${ULID.slice(1)}`,
        `U${ULID.slice(1)}`,
        `${ULID.slice(0, 25)}_`,
        `${ULID.slice(0, 25)}-`,
        `${ULID.slice(0, 12)}.${ULID.slice(13)}`,
        '',
      ];
      for (const name of refused) {
        expect(() => create(model, { [column]: keyOf(name) })).toThrow(refusedKey);
      }
    },
  );

  it('TC-008 the stream of a media key is the MediaStream enum of the schema, and nothing else', () => {
    expect([...Object.values(MediaStream)].sort()).toEqual(
      ['AUDIO', 'ROOM_SCAN', 'SCREEN', 'SIDE_CAMERA', 'WEBCAM'].sort(),
    );
    for (const stream of Object.values(MediaStream)) {
      expect(() =>
        create('MediaChunk', { stream, seq: 1, objectKey: media(stream, 0, 1) }),
      ).not.toThrow();
    }
    for (const stream of [
      'FOO',
      'screen',
      'Screen',
      'SCREEN ',
      'SCREEN2',
      'SCREEN_',
      'A_B',
      'ROOM-SCAN',
      '',
    ]) {
      expect(() => create('MediaChunk', { objectKey: media(stream, 0, 1) })).toThrow(refusedKey);
    }
  });

  describe('a media key agrees with the stream, segment and seq of its own row', () => {
    const key = media('WEBCAM', 7, 42);

    it('TC-008 a create that carries them: all three must match', () => {
      expect(() =>
        create('MediaChunk', { stream: 'WEBCAM', segment: 7, seq: 42, objectKey: key }),
      ).not.toThrow();
      for (const wrong of [
        { stream: 'SCREEN', segment: 7, seq: 42 },
        { stream: 'WEBCAM', segment: 6, seq: 42 },
        { stream: 'WEBCAM', segment: 7, seq: 41 },
        { stream: 'WEBCAM', segment: 7, seq: 4200 },
        { stream: 'WEBCAM', segment: 7, seq: '42' }, // a string is not the number the key names
        { stream: 'WEBCAM', segment: 7, seq: { increment: 1 } },
        { stream: 1, segment: 7, seq: 42 },
        { stream: 'WEBCAM', segment: 7.5, seq: 42 },
      ]) {
        for (const operation of CREATES) {
          expect(() => create('MediaChunk', { ...wrong, objectKey: key }, operation)).toThrow(
            refusedKey,
          );
        }
      }
    });

    it('TC-008 createMany: one row that does not match refuses the batch', () => {
      expect(() =>
        asCandidate('MediaChunk', 'createMany', {
          data: [
            { stream: 'WEBCAM', segment: 7, seq: 42, objectKey: key },
            { stream: 'WEBCAM', segment: 7, seq: 43, objectKey: key },
          ],
        }),
      ).toThrow(refusedKey);
    });

    it('TC-008 a create that leaves out `segment` gets the schema default 0', () => {
      expect(() =>
        create('MediaChunk', { stream: 'WEBCAM', seq: 42, objectKey: media('WEBCAM', 0, 42) }),
      ).not.toThrow();
      expect(() => create('MediaChunk', { stream: 'WEBCAM', seq: 42, objectKey: key })).toThrow(
        refusedKey,
      );
      // A part of the row that the write does not carry (the stream, which Prisma requires) is not bound.
      expect(() => create('MediaChunk', { seq: 42, segment: 7, objectKey: key })).not.toThrow();
    });

    it.each(['update', 'updateMany', 'updateManyAndReturn'] as const)(
      'TC-008 %s: the values the same write carries are bound, the others are not',
      (operation) => {
        const update = (data: Record<string, unknown>) =>
          asCandidate('MediaChunk', operation, writeArgs(operation, data));
        expect(() => update({ objectKey: key })).not.toThrow(); // nothing to bind against
        expect(() =>
          update({ objectKey: key, stream: 'WEBCAM', segment: 7, seq: 42 }),
        ).not.toThrow();
        expect(() => update({ objectKey: key, seq: { set: 42 } })).not.toThrow();
        expect(() => update({ objectKey: { set: key }, seq: 42 })).not.toThrow();
        for (const wrong of [
          { stream: 'SCREEN' },
          { segment: 8 },
          { seq: 43 },
          { seq: { set: 43 } },
          { seq: { increment: 1 } }, // the row's seq after the update is not known
          { segment: { decrement: 1 } },
        ]) {
          expect(() => update({ objectKey: key, ...wrong })).toThrow(refusedKey);
        }
        // A column that an update leaves out is not defaulted: that is the row's own, unchanged.
        expect(() => update({ objectKey: key, stream: 'WEBCAM' })).not.toThrow();
      },
    );

    it('TC-008 the upsert binds each branch to its own data', () => {
      const good = { stream: 'WEBCAM', segment: 7, seq: 42, objectKey: key };
      expect(() =>
        asCandidate('MediaChunk', 'upsert', writeArgs('upsert', good, { objectKey: key, seq: 42 })),
      ).not.toThrow();
      expect(() =>
        asCandidate('MediaChunk', 'upsert', writeArgs('upsert', good, { objectKey: key, seq: 43 })),
      ).toThrow(refusedKey);
      expect(() =>
        asCandidate(
          'MediaChunk',
          'upsert',
          writeArgs('upsert', { ...good, seq: 43 }, { objectKey: key }),
        ),
      ).toThrow(refusedKey);
    });

    describe('FU-DB-199: an update, and the update branch of an upsert, are bound to the row their where names', () => {
      const UPDATING = ['update', 'updateMany', 'updateManyAndReturn', 'upsert'] as const;
      const call = (
        operation: (typeof UPDATING)[number],
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        actor: 'CANDIDATE' | 'SERVICE' = 'CANDIDATE',
      ) => {
        const args =
          operation === 'upsert'
            ? { where, create: {}, update: data, select: { id: true } }
            : operation === 'updateMany'
              ? { where, data }
              : { where, data, select: { id: true } };
        return actor === 'CANDIDATE'
          ? asCandidate('MediaChunk', operation, args)
          : asService('MediaChunk', operation, args);
      };
      const byKey = (stream: string, seq: number): Record<string, unknown> => ({
        sessionId_stream_seq: { sessionId: SID, stream, seq },
      });

      it.each(UPDATING)(
        'TC-008 %s by sessionId_stream_seq: the key must be the key of that stream and seq',
        (operation) => {
          expect(() => call(operation, byKey('WEBCAM', 42), { objectKey: key })).not.toThrow();
          for (const where of [byKey('WEBCAM', 43), byKey('SCREEN', 42), byKey('AUDIO', 1)]) {
            expect(() => call(operation, where, { objectKey: key })).toThrow(refusedKey);
          }
          // The key written next to a segment: the segment is bound too, when the write carries it.
          expect(() =>
            call(operation, byKey('WEBCAM', 42), { objectKey: key, segment: 7 }),
          ).not.toThrow();
          expect(() =>
            call(operation, byKey('WEBCAM', 42), { objectKey: key, segment: 8 }),
          ).toThrow(refusedKey);
        },
      );

      it.each(UPDATING)(
        'TC-008 %s: plain equality on stream, segment and seq pins them too (bare value or { equals })',
        (operation) => {
          for (const where of [
            { sessionId: SID, stream: 'WEBCAM', seq: 42 },
            { stream: { equals: 'WEBCAM' }, seq: { equals: 42 }, segment: 7 },
            { id: 5n, stream: 'WEBCAM', segment: 7, seq: 42 },
          ]) {
            expect(() => call(operation, where, { objectKey: key })).not.toThrow();
          }
          for (const where of [
            { stream: 'SCREEN' },
            { seq: 43 },
            { seq: { equals: 43 } },
            { segment: 6 },
            { id: 5n, seq: 41 },
          ]) {
            expect(() => call(operation, where, { objectKey: key })).toThrow(refusedKey);
          }
        },
      );

      it.each(UPDATING)(
        'TC-008 %s: what the write carries wins over the where (the row after the update), and a where that names nothing binds nothing',
        (operation) => {
          // The row is moved to seq 42 and written with the key of seq 42: the where only found it.
          expect(() =>
            call(operation, byKey('WEBCAM', 43), { objectKey: key, seq: 42 }),
          ).not.toThrow();
          expect(() => call(operation, byKey('WEBCAM', 42), { objectKey: key, seq: 43 })).toThrow(
            refusedKey,
          );
          expect(() => call(operation, { id: 5n }, { objectKey: key })).not.toThrow();
          expect(() => call(operation, {}, { objectKey: key })).not.toThrow();
        },
      );

      it.each(UPDATING)(
        'TC-008 %s: a where that mentions stream, segment or seq in a form that pins nothing is refused next to a key write',
        (operation) => {
          for (const where of [
            { seq: { gt: 1 } },
            { seq: { in: [42] } },
            { seq: { not: 7 } },
            { stream: { in: ['WEBCAM'] } },
            { segment: { lte: 7 } },
            { seq: { equals: 42, not: 7 } },
            { AND: [{ seq: 42 }] },
            { OR: [{ seq: 42 }, { seq: 43 }] },
            { NOT: { seq: 5 } },
            { AND: [{ OR: [{ stream: 'WEBCAM' }] }] },
            { seq: 42, AND: [{ seq: 42 }] }, // pinned and loose at once: loose wins
            { sessionId_stream_seq: { sessionId: SID, stream: 'WEBCAM', seq: { gt: 1 } } },
          ]) {
            expect(() => call(operation, where, { objectKey: key })).toThrow(refusedKey);
          }
          // The same where is fine when no key is written: only the key is bound.
          for (const where of [{ seq: { gt: 1 } }, { OR: [{ seq: 42 }] }]) {
            expect(() => call(operation, where, { durationMs: 5 })).not.toThrow();
          }
        },
      );

      it('TC-008 the upsert binds its create branch to its own data, and its update branch to the where and the update data', () => {
        const create = { stream: 'WEBCAM', segment: 7, seq: 42, objectKey: key };
        expect(() =>
          asCandidate('MediaChunk', 'upsert', {
            where: byKey('WEBCAM', 42),
            create,
            update: { objectKey: key },
            select: { id: true },
          }),
        ).not.toThrow();
        expect(() =>
          asCandidate('MediaChunk', 'upsert', {
            where: byKey('WEBCAM', 43),
            create,
            update: { objectKey: key },
            select: { id: true },
          }),
        ).toThrow(refusedKey);
        // The where names the row the update branch finds; a create branch is its own row.
        expect(() =>
          asCandidate('MediaChunk', 'upsert', {
            where: byKey('WEBCAM', 43),
            create,
            update: { durationMs: 1 },
            select: { id: true },
          }),
        ).not.toThrow();
      });

      it('TC-008 a create has no where to bind to: only its own data and the schema defaults', () => {
        expect(() =>
          asCandidate('MediaChunk', 'createMany', {
            data: [{ stream: 'WEBCAM', segment: 7, seq: 42, objectKey: key }],
          }),
        ).not.toThrow();
        expect(() =>
          asCandidate('MediaChunk', 'create', {
            where: byKey('WEBCAM', 43),
            data: { stream: 'WEBCAM', segment: 7, seq: 42, objectKey: key },
          }),
        ).not.toThrow();
      });

      it('TC-008 the job is not bound by the where either, and the message never echoes the key', () => {
        for (const operation of UPDATING) {
          expect(() =>
            call(operation, byKey('SCREEN', 1), { objectKey: 'anything' }, 'SERVICE'),
          ).not.toThrow();
        }
        let message = '';
        try {
          call('update', byKey('SCREEN', 1), { objectKey: key });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain('MediaChunk.update');
        expect(message).toContain('objectKey');
        expect(message).not.toContain('orgs/');
        expect(message).not.toContain(SID);
      });
    });

    it('TC-008 the job is not bound: a SERVICE scope writes a key that does not match its row', () => {
      expect(() =>
        asService(
          'MediaChunk',
          'create',
          writeArgs('create', { stream: 'SCREEN', seq: 1, objectKey: key }),
        ),
      ).not.toThrow();
    });
  });

  describe('an identity key agrees with the attempt of its own row', () => {
    it.each(['idImageKey', 'selfieKey'] as const)(
      'TC-008 %s: the attempt of the key is the attempt of the row',
      (column) => {
        const word = column === 'idImageKey' ? 'id' : 'selfie';
        expect(() =>
          create('IdentityCheck', { attempt: 2, [column]: identity(2, word) }),
        ).not.toThrow();
        for (const attempt of [1, 3, '2', { increment: 1 }]) {
          expect(() => create('IdentityCheck', { attempt, [column]: identity(2, word) })).toThrow(
            refusedKey,
          );
        }
        // `attempt` left out is the schema default, 1.
        expect(() => create('IdentityCheck', { [column]: identity(1, word) })).not.toThrow();
        expect(() => create('IdentityCheck', { [column]: identity(2, word) })).toThrow(refusedKey);
      },
    );

    it('TC-008 both keys of one create are bound to the same attempt', () => {
      expect(() =>
        create('IdentityCheck', {
          attempt: 2,
          idImageKey: identity(2, 'id'),
          selfieKey: identity(2, 'selfie'),
        }),
      ).not.toThrow();
      expect(() =>
        create('IdentityCheck', {
          attempt: 2,
          idImageKey: identity(2, 'id'),
          selfieKey: identity(1, 'selfie'),
        }),
      ).toThrow(refusedKey);
    });

    it('TC-008 the job is not bound', () => {
      expect(() =>
        asService('IdentityCheck', 'create', writeArgs('create', { attempt: 2, idImageKey: 'x' })),
      ).not.toThrow();
    });
  });

  it('TC-008 the rules are predicates over private patterns: the table holds no RegExp to compile()', () => {
    const rules = Object.entries(CANDIDATE_OBJECT_KEYS).flatMap(([model, columns]) =>
      Object.entries(columns ?? {}).map(([column, rule]) => ({ model, column, rule })),
    );
    expect(rules).toHaveLength(4);
    for (const { rule } of rules) {
      expect(typeof rule.accepts).toBe('function');
      expect(Object.values(rule).some((v) => v instanceof RegExp)).toBe(false);
    }
    expect(Object.isFrozen(CANDIDATE_OBJECT_KEYS.MediaChunk?.objectKey)).toBe(true);
    expect(Object.isFrozen(CANDIDATE_OBJECT_KEYS.MediaChunk?.objectKey?.binds)).toBe(true);
  });
});

describe('the operand of a Json filter is a value in a candidate where too (re-review of #185, S1: the device-info fence; NFR-04, TC-008)', () => {
  const base = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
  afterAll(async () => {
    await base.$disconnect();
  });
  const DEVICE = grantOf('DeviceInfoService', [SID]);
  const deep = (levels: number): unknown => {
    let value: unknown = { leaf: true };
    for (let i = 0; i < levels; i++) value = { next: value };
    return value;
  };
  const lookAlike = { modelName: 'Session', name: 'deviceInfo', typeName: 'Json', isList: false };
  /** The DeviceInfoService fence: a conditional updateMany whose where holds the document that was read. */
  const fence = (equals: unknown, operator = 'equals') =>
    asCandidate(
      'Session',
      'updateMany',
      {
        where: { id: SID, deviceInfo: { [operator]: equals } },
        data: { deviceInfo: { merged: true } },
      },
      DEVICE,
    );
  const deviceInfoRef = (): unknown =>
    (base as unknown as { session: { fields: Record<string, unknown> } }).session.fields.deviceInfo;

  it('TC-008 a stored document deeper than the limit of 32, or holding a field-reference look-alike, is a value: the fence passes', () => {
    for (const operand of [
      deep(100),
      deep(100_000),
      { capabilities: [lookAlike, { nested: lookAlike }], inner: lookAlike },
      [deep(50)],
      null,
    ]) {
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
        expect({ operator, ok: tryCall(() => fence(operand, operator)) }).toEqual({
          operator,
          ok: true,
        });
      }
    }
  });

  it('TC-008 an operand that IS a field reference, or is shaped exactly like one at its top level, is refused (it cannot be told from one)', () => {
    expect(() => fence(lookAlike)).toThrow(/a field reference \(client/);
  });

  it('TC-008 a field reference AS the operand is still refused, for every value operator, in a where and a having', () => {
    for (const operator of ['equals', 'not', 'in', 'array_contains', 'string_contains']) {
      expect(() => fence(deviceInfoRef(), operator)).toThrow(/a field reference \(client/);
    }
    expect(() =>
      asCandidate(
        'Session',
        'groupBy',
        {
          by: ['status'],
          having: { deviceInfo: { equals: deviceInfoRef() } },
        },
        DEVICE,
      ),
    ).toThrow(/a field reference \(client/);
    // A bare filter value that IS a reference, and a reference in an AND, are refused too.
    expect(() =>
      asCandidate(
        'Session',
        'findMany',
        { where: { deviceInfo: deviceInfoRef() }, select: { id: true } },
        DEVICE,
      ),
    ).toThrow(/a field reference \(client/);
    expect(() =>
      asCandidate(
        'Session',
        'findMany',
        { where: { AND: [{ deviceInfo: { equals: deviceInfoRef() } }] }, select: { id: true } },
        DEVICE,
      ),
    ).toThrow(/a field reference \(client/);
  });

  it('TC-008 everything else is still walked: a path, a mode and another operator, a non-Json column, and a Json column that is not on the grant', () => {
    expect(() =>
      asCandidate(
        'Session',
        'findMany',
        { where: { deviceInfo: { path: [deep(40)], equals: 1 } }, select: { id: true } },
        DEVICE,
      ),
    ).toThrow(/nested more than 32 levels deep/);
    expect(() =>
      asCandidate(
        'Session',
        'findMany',
        { where: { deviceInfo: { gt: lookAlike } }, select: { id: true } },
        DEVICE,
      ),
    ).toThrow(/a field reference \(client/);
    expect(() =>
      asCandidate('Session', 'findMany', {
        where: { status: { equals: deep(40) } },
        select: { id: true },
      }),
    ).toThrow(/nested more than 32 levels deep/);
    expect(() =>
      asCandidate('Session', 'findMany', {
        where: { authEpoch: { not: lookAlike } },
        select: { id: true },
      }),
    ).toThrow(/a field reference \(client/);
    // The read allowlist is untouched: the Json column needs its grant to be named at all.
    expect(() =>
      asCandidate('Session', 'findMany', {
        where: { deviceInfo: { equals: deep(100) } },
        select: { id: true },
      }),
    ).toThrow(/the column deviceInfo is not available/);
  });
});

describe('CS-4.4 consents: ONE create under the ConsentService grant (item 9, ADR 0013 PR #178; FR-401, C-17; NFR-04, TC-008)', () => {
  const CTID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const OTHER_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const GRANT = grantOf('ConsentService (create)', [SID]);
  const signed = {
    sessionId: SID,
    consentTextId: CTID,
    signedName: 'Synthetic Name',
    signedAt: new Date(),
    ageConfirmedAt: new Date(),
    ip: '203.0.113.7',
    userAgent: 'x',
  };
  const declined = {
    sessionId: SID,
    consentTextId: CTID,
    declinedAt: new Date(),
    ip: '203.0.113.7',
    userAgent: 'x',
  };
  const create = (data: Record<string, unknown>, grant: GrantView | undefined = GRANT) =>
    asCandidate('Consent', 'create', { data }, grant);

  it('TC-008 a sign and a decline are one create each: the keys are verified, nothing is stamped, there is no where', () => {
    for (const row of [signed, declined]) {
      const result = create(row);
      expect(result.args.data).toEqual(row);
      expect(result.args).not.toHaveProperty('where');
      // The extension proves the consent text against the org's current one before the insert.
      expect(result.consentTextIds).toEqual([CTID]);
      expect(result.sessionQuestionIds).toEqual([]);
    }
  });

  it('TC-008 the row a create returns omits signedName, ip, userAgent, ageConfirmedAt and the PDF columns, and a select of them throws', () => {
    const omit = create(signed).args.omit as Record<string, true>;
    expect(Object.keys(omit).sort()).toEqual(
      [
        'signedName',
        'ip',
        'userAgent',
        'ageConfirmedAt',
        'pdfKey',
        'pdfGeneratedAt',
        'copyEmailedAt',
      ].sort(),
    );
    for (const column of [
      'signedName',
      'ip',
      'userAgent',
      'ageConfirmedAt',
      'pdfKey',
      'pdfGeneratedAt',
    ]) {
      expect(() =>
        asCandidate('Consent', 'create', { data: signed, select: { [column]: true } }, GRANT),
      ).toThrow(new RegExp(`the column ${column} is not available`));
    }
    expect(
      asCandidate(
        'Consent',
        'create',
        { data: signed, select: { id: true, signedAt: true } },
        GRANT,
      ).args,
    ).not.toHaveProperty('omit');
  });

  it('TC-008 outside the grant a consents create throws, in every operation; a grant of another model or another kind does not open it', () => {
    for (const operation of [...CREATES, 'upsert']) {
      for (const grant of [
        undefined,
        grantOf('KeyService'),
        grantOf('ConsentService (consent text)', [OTHER]),
      ]) {
        expect(() =>
          asCandidate('Consent', operation, writeArgs(operation, signed), grant),
        ).toThrow(/creates this row only under its create grant/);
      }
    }
  });

  it('TC-008 under the grant only `create` is allowed: no batch, no upsert, no update, no delete', () => {
    for (const operation of ['createMany', 'createManyAndReturn']) {
      expect(() => asCandidate('Consent', operation, writeArgs(operation, signed), GRANT)).toThrow(
        /takes only create/,
      );
    }
    expect(() =>
      asCandidate('Consent', 'upsert', writeArgs('upsert', signed, { ip: 'x' }), GRANT),
    ).toThrow(/takes only create/);
    for (const operation of UPDATES) {
      for (const row of [signed, { ip: 'x' }, { signedAt: new Date() }, { pdfKey: 'x' }]) {
        expect(() => asCandidate('Consent', operation, writeArgs(operation, row), GRANT)).toThrow(
          /cannot update this row: CS-4\.4 grants create only/,
        );
      }
    }
    for (const operation of ['delete', 'deleteMany']) {
      expect(() => asCandidate('Consent', operation, { where: { id: 'x' } }, GRANT)).toThrow(
        /a candidate deletes nothing/,
      );
    }
  });

  it('TC-008 the update path of PR 1 is gone: no injected write-once where, on any operation', () => {
    for (const [, rule] of SESSION_RULES) {
      expect(rule).not.toHaveProperty('updateFilter');
    }
    const rule = CANDIDATE_MODELS.Consent;
    expect(rule).toMatchObject({ kind: 'session' });
    expect(rule).not.toHaveProperty('update');
    expect(rule).not.toHaveProperty('create');
  });

  it('TC-008 sessionId and consentTextId are required: missing, null, a non-id and a non-string all throw', () => {
    for (const key of ['sessionId', 'consentTextId']) {
      for (const bad of [undefined, null, 7, 'not-an-id', { set: SID }, [SID]]) {
        const row: Record<string, unknown> = { ...signed };
        if (bad === undefined) delete row[key];
        else row[key] = bad;
        expect(() => create(row)).toThrow(new RegExp(`${key} is required in this create`));
      }
    }
  });

  it('TC-008 a wrong session id throws, and so does a session id that is not in the grant ids', () => {
    expect(() => create({ ...signed, sessionId: OTHER_SESSION })).toThrow(
      /sessionId in the data is not the session of this scope/,
    );
    expect(() => create(signed, grantOf('ConsentService (create)', [OTHER_SESSION]))).toThrow(
      /sessionId in the data is not in the ids of the active grant/,
    );
    // Both ids: the session of the scope is among them. The grant never reaches another session.
    expect(() =>
      create(signed, grantOf('ConsentService (create)', [OTHER_SESSION, SID])),
    ).not.toThrow();
    // Upper case is the same id.
    expect(() => create({ ...signed, sessionId: SID.toUpperCase() })).not.toThrow();
  });

  it('TC-008 a session id other than the scope own fails even when the grant lists it (the context decides)', () => {
    expect(() =>
      create(
        { ...signed, sessionId: OTHER_SESSION },
        grantOf('ConsentService (create)', [OTHER_SESSION]),
      ),
    ).toThrow(/is not the session of this scope/);
  });

  it('TC-008 the consent text id is reported lower-cased, for the extension to check against the current text', () => {
    expect(create({ ...signed, consentTextId: CTID.toUpperCase() }).consentTextIds).toEqual([CTID]);
  });

  it('TC-008 exactly one of signedAt and declinedAt is set (the database CHECK), and signedName comes with signedAt', () => {
    expect(() => create({ ...signed, declinedAt: new Date() })).toThrow(
      /exactly one of signedAt and declinedAt/,
    );
    const neither: Record<string, unknown> = { ...signed };
    delete neither.signedAt;
    delete neither.signedName;
    expect(() => create(neither)).toThrow(/exactly one of signedAt and declinedAt/);
    expect(() => create({ ...signed, signedAt: null, declinedAt: null })).toThrow(
      /exactly one of signedAt and declinedAt/,
    );
    // null counts as not set.
    expect(() => create({ ...declined, signedAt: null })).not.toThrow();
    expect(() => create({ ...signed, declinedAt: null })).not.toThrow();
    for (const name of [undefined, null, '', '   ', 7]) {
      expect(() => create({ ...signed, signedName: name })).toThrow(
        /signedName is required with signedAt/,
      );
    }
  });

  it('TC-008 the written columns are signedName, signedAt, declinedAt, ageConfirmedAt, ip and userAgent, and nothing else', () => {
    for (const column of [
      'pdfKey',
      'pdfGeneratedAt',
      'copyEmailedAt',
      'id',
      'orgId',
      'createdAt',
      'status',
      'session',
      'consentText',
    ]) {
      expect(() => create({ ...signed, [column]: 'x' })).toThrow(OrgScopeViolationError);
    }
    // Every column of the model that is none of the eight is refused, a column set to undefined is not a write.
    expect(() => create({ ...signed, pdfKey: undefined })).not.toThrow();
  });

  it('TC-008 the grant names the columns: a column the grant leaves out is refused, the keys included', () => {
    const narrow = grantOf(
      'ConsentService (create)',
      [SID],
      ['sessionId', 'consentTextId', 'declinedAt', 'userAgent'],
    );
    expect(() => create({ ...declined, ip: undefined }, narrow)).not.toThrow();
    expect(() => create(declined, narrow)).toThrow(/ip cannot be written by a candidate create/);
    expect(() => create(signed, narrow)).toThrow(OrgScopeViolationError);
    const noKeys = grantOf('ConsentService (create)', [SID], ['declinedAt']);
    expect(() => create(declined, noKeys)).toThrow(
      /sessionId cannot be written by a candidate create/,
    );
  });

  it('TC-008 a read of consents under the create grant is not filtered by its ids: the ids constrain the create only', () => {
    for (const operation of READ_OPERATIONS) {
      const { args } = asCandidate(
        'Consent',
        operation,
        { where: { id: 'x' }, select: { id: true } },
        GRANT,
      );
      expect(JSON.stringify(args)).not.toContain('"in"');
    }
  });

  it('FR-401 C-30 TC-008 ageConfirmedAt is written under the create grant, and only while the grant names it (D-55)', () => {
    expect(create(signed).args.data).toHaveProperty('ageConfirmedAt', signed.ageConfirmedAt);
    // The create grant of this model, with its columns but without ageConfirmedAt.
    const without = grantOf(
      'ConsentService (create)',
      [SID],
      GRANT.columns.filter((column) => column !== 'ageConfirmedAt'),
    );
    expect(() => create(signed, without)).toThrow(
      /ageConfirmedAt cannot be written by a candidate create/,
    );
    // Without the grant altogether: the whole create is refused, whatever the columns are.
    expect(() => asCandidate('Consent', 'create', { data: signed }, undefined)).toThrow(
      /creates this row only under its create grant/,
    );
    // The column is neither the session key nor one of the server-set ones: it is plain data of the create.
    const bare: Record<string, unknown> = { ...signed };
    delete bare.ageConfirmedAt;
    expect(() => create(bare)).not.toThrow();
  });

  it('FR-401 C-30 TC-008 a candidate cannot write ageConfirmedAt by any update, and never reads it, in a select, a where or an aggregate', () => {
    for (const operation of UPDATES) {
      expect(() =>
        asCandidate(
          'Consent',
          operation,
          writeArgs(operation, { ageConfirmedAt: new Date() }),
          GRANT,
        ),
      ).toThrow(/cannot update this row: CS-4\.4 grants create only/);
    }
    for (const grant of [undefined, GRANT]) {
      for (const args of [
        { select: { ageConfirmedAt: true } },
        { where: { ageConfirmedAt: { not: null } } },
        { orderBy: { ageConfirmedAt: 'asc' } },
        { select: { id: true }, where: { ageConfirmedAt: null } },
      ]) {
        expect(() => asCandidate('Consent', 'findMany', args, grant)).toThrow(
          /the column ageConfirmedAt is not available/,
        );
      }
      expect(() =>
        asCandidate('Consent', 'count', { where: { ageConfirmedAt: { not: null } } }, grant),
      ).toThrow(/the column ageConfirmedAt is not available/);
      expect(() =>
        asCandidate('Consent', 'aggregate', { _max: { ageConfirmedAt: true } }, grant),
      ).toThrow(/the column ageConfirmedAt is not available/);
      // No select: the default omit names it, so no row carries it.
      expect(
        (asCandidate('Consent', 'findMany', {}, grant).args.omit as Record<string, true>)
          .ageConfirmedAt,
      ).toBe(true);
    }
  });

  it('TC-008 a candidate reads id, consentTextId, signedAt and declinedAt of its row, and never the other columns (the grant changes nothing)', () => {
    for (const grant of [undefined, GRANT]) {
      expect(() =>
        asCandidate(
          'Consent',
          'findFirst',
          { select: { id: true, consentTextId: true, signedAt: true, declinedAt: true } },
          grant,
        ),
      ).not.toThrow();
      for (const column of [
        'signedName',
        'ip',
        'userAgent',
        'ageConfirmedAt',
        'pdfKey',
        'pdfGeneratedAt',
        'copyEmailedAt',
      ]) {
        expect(() =>
          asCandidate('Consent', 'findFirst', { select: { [column]: true } }, grant),
        ).toThrow(new RegExp(`the column ${column} is not available`));
        expect(() =>
          asCandidate('Consent', 'count', { where: { [column]: { not: null } } }, grant),
        ).toThrow(new RegExp(`the column ${column} is not available`));
      }
    }
  });

  it('TC-008 SERVICE writes a consent without a grant: the consent-PDF job writes pdfKey and the rest', () => {
    expect(() =>
      asService(
        'Consent',
        'update',
        writeArgs('update', { pdfKey: 'x', pdfGeneratedAt: new Date() }),
      ),
    ).not.toThrow();
    expect(asService('Consent', 'create', writeArgs('create', signed)).consentTextIds).toEqual([]);
  });

  it('TC-008 the error messages name the model, the operation and the column, never a value', () => {
    let message = '';
    try {
      create({ ...signed, sessionId: OTHER_SESSION });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Consent.create');
    expect(message).not.toContain(OTHER_SESSION);
    expect(message).not.toContain('Synthetic Name');
  });
});

describe('nit 4: a candidate create cannot carry an event type only the server writes (#126)', () => {
  const event = (type: unknown) => ({ type, severity: 'LOW', occurredAt: new Date() });

  it('TC-008 the list is exactly EVENT_TYPES minus CLIENT_EVENT_TYPES of packages/shared: 12 types', () => {
    const notClient = EVENT_TYPES.filter(
      (type) => !(CLIENT_EVENT_TYPES as readonly string[]).includes(type),
    );
    expect([...SERVER_ONLY_EVENT_TYPES].sort()).toEqual([...notClient].sort());
    expect(SERVER_ONLY_EVENT_TYPES).toHaveLength(12);
    for (const type of ['IDENTITY_MANUAL_REVIEW', 'RESUME_OTP_FAILED']) {
      expect(SERVER_ONLY_EVENT_TYPES).toContain(type);
    }
  });

  it('TC-008 FACE_MISMATCH is still a type the browser may send (ADR 0013 section 5.6: accepted from older clients until ADR 0010 is amended), stamped CLIENT', () => {
    expect(SERVER_ONLY_EVENT_TYPES).not.toContain('FACE_MISMATCH');
    expect(CLIENT_EVENT_TYPES as readonly string[]).toContain('FACE_MISMATCH');
    for (const operation of CREATES) {
      const { args } = asCandidate(
        'ProctorEvent',
        operation,
        writeArgs(operation, event('FACE_MISMATCH')),
      );
      const rows = (Array.isArray(args.data) ? args.data : [args.data]) as Array<{
        type: string;
        source: string;
      }>;
      expect(rows.map((row) => ({ type: row.type, source: row.source }))).toEqual([
        { type: 'FACE_MISMATCH', source: 'CLIENT' },
      ]);
    }
    // A candidate cannot send it as a SERVER row.
    expect(() =>
      asCandidate('ProctorEvent', 'create', {
        data: { ...event('FACE_MISMATCH'), source: 'SERVER' },
        select: { id: true },
      }),
    ).toThrow(/source must be CLIENT/);
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
    for (const type of CLIENT_EVENT_TYPES) {
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
    if (typeof value !== 'object' || value === null) return;
    if (!Object.isFrozen(value)) bad.push(path);
    for (const key of Reflect.ownKeys(value)) {
      frozenDeep((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`, bad);
    }
  };

  it.each([
    ['SESSION_SCOPE', SESSION_SCOPE],
    ['CANDIDATE_MODELS', CANDIDATE_MODELS],
    ['CANDIDATE_READ', CANDIDATE_READ],
    ['GRANT_SITES', GRANT_SITES],
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

  it('TC-008 no table holds a RegExp, because freezing one does not stop RegExp.prototype.compile', () => {
    const found: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value instanceof RegExp) found.push(path);
      if (typeof value !== 'object' || value === null) return;
      for (const key of Reflect.ownKeys(value)) {
        walk((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`);
      }
    };
    for (const [name, table] of Object.entries({
      SESSION_SCOPE,
      CANDIDATE_MODELS,
      CANDIDATE_READ,
      GRANT_SITES,
      COMPOUND_UNIQUES,
      NEVER_WRITTEN_BY_CANDIDATE,
      CANDIDATE_OBJECT_KEYS,
      SERVER_ONLY_EVENT_TYPES,
      READ_OPERATIONS,
      ROW_RETURNING_OPERATIONS,
    })) {
      walk(table, name);
    }
    expect(found).toEqual([]);
    // Why: freezing a RegExp does not stop compile() from rewriting it (what the engine does to the
    // pattern before the throw is an engine detail, so it is not asserted: FU-DB-200). deepFreeze
    // refuses one, and a table cannot be given one by mistake.
    expect(() => deepFreeze({ pattern: /x/ })).toThrow(/RegExp/);
    expect(() => deepFreeze([[/x/]])).toThrow(/RegExp/);
  });

  it('TC-008 a write to a table throws, and the tables are as they were', () => {
    const dump = (): string =>
      JSON.stringify([
        CANDIDATE_MODELS,
        CANDIDATE_READ,
        GRANT_SITES,
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
      (CANDIDATE_READ as unknown as Record<string, { read: string[] }>).Session?.read.pop(),
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
