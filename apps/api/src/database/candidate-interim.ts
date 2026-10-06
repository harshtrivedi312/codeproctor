// The CANDIDATE READ control of ADR 0013 CS-4.4: the read allowlist per model, `omit` for the default
// select, the explicit-only columns (readable only under a grant) and the `submissions` RUN filter.
//
// The file keeps its PR 1 name, "interim", although PR 2 made the control permanent: the consent-access
// scan of Database B (retention/consent-access.spec.ts) pins this path, and renaming it is that spec's
// change (FU-DB-211). Nothing in this file is interim any more.
//
// What it does, for one query in a CANDIDATE scope:
//   1. READ ALLOWLIST. Every column named in `select`, `where`, `having`, `orderBy`, `distinct`, `groupBy`'s
//      `by` and the aggregates (`_count`, `_sum`, `_avg`, `_min`, `_max`, and the `select` of `count`) must
//      be readable: it is in the CS-4.4 read column of the model, or a scope key, or an explicit-only column
//      under a grant that names it, or a RUN column (below). Anything else throws, so a hidden column is no
//      boolean or ordering oracle either (a JSON-path `where` on it included). A compound unique selector
//      (`orgId_slug`) is read through to its columns, and a unique key that is itself hidden
//      (`invitations.tokenHash`, `sessions.invitationId`) cannot be looked up by. A field reference
//      (`client.model.fields.column`) is refused in a `where` and a `having`: it compares one column with
//      another without naming it, and CS-4.4 grants none.
//   2. OMIT. A call that returns rows and names no `select` gets an `omit` of every scalar column of the
//      model that is not in its default select, computed from the generated client's own field list
//      (Prisma.<Model>ScalarFieldEnum). A column that a later migration adds is therefore hidden until
//      someone lists it here, instead of visible until someone denies it. The `omit` is added on EVERY
//      row-returning operation, creates and updates included (ROW_RETURNING_OPERATIONS), so the row a
//      write returns never carries a hidden column either. This replaced PR 1's rule that every such call
//      must name its `select` (FU-DB-190); a caller's own `omit` is merged and ours wins. A `select` and
//      an `omit` together are refused (Prisma refuses them too).
//   3. EXPLICIT-ONLY. `sessions.hmacKeyEnc` and `deviceInfo`, `media_chunks.objectKey`, the two `settings`,
//      `invitations.accommodations` and `session_questions.testQuestionId` are never in the default select
//      and are readable only while a grant (withGrant, org-context.ts) of that model names them. Even under
//      the grant they must be named in `select` ("explicit-only").
//   4. RUN FILTER. `submissions.results`, `passed` and `total` are in no default select. When one appears in
//      `select`, `where`, `having`, `orderBy`, `distinct`, `by` or an aggregate, the query is run with
//      `kind = 'RUN'` ANDed in (the caller gets `runFilter`), so `count({ where: { kind: 'SUBMIT', passed:
//      N } })` is 0 and a SUBMIT row's results can never be read. `score` and `sourceCode` are never readable.
//   5. GATED MODELS (`consent_texts`, `test_questions`) are readable only under the grant of that model,
//      and then only through the grant's columns.
//
// Hidden by this table (not listed, so never readable and always omitted), for the record. consents:
// `signedName`, `ip`, `userAgent` (the grant that creates the row does not change that), `pdfKey`,
// `pdfGeneratedAt`, `copyEmailedAt`. sessions: `invitationId` (the guard reads it outside the candidate
// scope), `clientKind`, the scores and risk, `lastHeartbeat`, `retentionAnchorAt`, the report columns,
// `createdAt`. keystroke_batches: `id` (a global identity counter) and `events`.
//
// Names are Prisma's field names (`hmacKeyEnc`), not column names. A test checks each entry against the
// generated client. Messages name the model, the column and the place, never a value.
import { Prisma } from '../generated/prisma/client.js';
import { deepFreeze } from './deep-freeze';
import { OrgScopeViolationError } from './errors';
import type { ModelName } from './org-scope-map';
import type { GrantView } from './session-scope-map';

type PlainObject = Record<string, unknown>;

/** What a CANDIDATE may read of one model. Every column not named here is hidden. */
export interface CandidateReadRule {
  /** CS-4.4's read column: readable, filterable and in the default select. */
  readonly read: readonly string[];
  /**
   * Scope keys: the ids of the candidate's own org, session and test, which the scope fixes anyway
   * (`orgId`, `sessionId`, `sessionQuestionId`, `testId`, `sectionId`). Readable, filterable and in the
   * default select, although CS-4.4 does not list them (PR 1's choice, FU-DB-195 (k)): a compound unique
   * selector such as `sessionId_stream_seq` names them.
   */
  readonly keys: readonly string[];
  /** Explicit-only (CS-4.4): not in the default select, readable only under a grant that names the column. */
  readonly explicit: readonly string[];
  /** Readable only under the RUN filter: not in the default select, and naming one ANDs `kind = 'RUN'`. */
  readonly runOnly: readonly string[];
}

const readRule = (
  read: string[],
  more: { keys?: string[]; explicit?: string[]; runOnly?: string[] } = {},
): CandidateReadRule => ({
  read,
  keys: more.keys ?? [],
  explicit: more.explicit ?? [],
  runOnly: more.runOnly ?? [],
});

/**
 * The CS-4.4 read column of every model on the CANDIDATE allowlist (18 models). candidate-interim.spec.ts
 * holds its own copy of the ADR's column and fails when this table differs, and when a column of the
 * schema is none of readable, key, explicit, run-only or listed there as hidden.
 */
export const CANDIDATE_READ: Readonly<Partial<Record<ModelName, CandidateReadRule>>> = deepFreeze({
  Session: readRule(
    [
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
    { keys: ['orgId'], explicit: ['hmacKeyEnc', 'deviceInfo'] },
  ),
  SessionQuestion: readRule(
    ['id', 'sessionId', 'position', 'points', 'finalCode', 'finalLanguage', 'answer'],
    { explicit: ['testQuestionId'] },
  ),
  SessionSection: readRule([
    'sessionId',
    'sectionId',
    'position',
    'timeLimitMs',
    'startedAt',
    'deadlineAt',
    'endedAt',
  ]),
  Submission: readRule(['id', 'sessionQuestionId', 'kind', 'language', 'createdAt'], {
    runOnly: ['results', 'passed', 'total'],
  }),
  IdentityCheck: readRule(['id', 'attempt', 'status', 'createdAt'], { keys: ['sessionId'] }),
  MediaChunk: readRule(['id', 'stream', 'segment', 'seq', 'sizeBytes', 'uploadedAt'], {
    keys: ['sessionId'],
    explicit: ['objectKey'],
  }),
  ProctorEventBatch: readRule(['seq', 'signature', 'eventCount'], { keys: ['sessionId'] }),
  ProctorEvent: readRule(['id', 'type', 'occurredAt', 'durationMs', 'batchSeq', 'createdAt'], {
    keys: ['sessionId'],
  }),
  KeystrokeBatch: readRule(['seq', 'signature', 'startedAt'], {
    keys: ['sessionId', 'sessionQuestionId'],
  }),
  Consent: readRule(['id', 'consentTextId', 'signedAt', 'declinedAt'], { keys: ['sessionId'] }),
  Organization: readRule(['id', 'name', 'retentionDays', 'currentConsentTextId'], {
    explicit: ['settings'],
  }),
  Candidate: readRule(['id', 'fullName', 'email'], { keys: ['orgId'] }),
  Invitation: readRule(['id', 'testId', 'candidateId', 'windowStart', 'windowEnd', 'usedAt'], {
    keys: ['orgId'],
    explicit: ['accommodations'],
  }),
  Test: readRule(['id', 'name', 'description', 'durationMinutes', 'profile'], {
    keys: ['orgId'],
    explicit: ['settings'],
  }),
  TestSection: readRule(['id', 'title', 'position', 'timeLimitMin'], { keys: ['testId'] }),
  Question: readRule(['id', 'type'], { keys: ['orgId'] }),
  // Gated models (CS-4.3): readable only under the grant of that model, and then only the grant's columns.
  ConsentText: readRule(['id', 'version', 'bodyMd', 'legalApprovedAt']),
  TestQuestion: readRule(['id', 'sectionId']),
});

/**
 * The compound unique selectors of the models on the CANDIDATE allowlist (`@@unique` and `@@id` of
 * schema.prisma, named `a_b` by Prisma). A `where` that names one is read through to its columns, so
 * `orgId_slug: { orgId, slug }` is not a way round the allowlist. candidate-interim.spec.ts checks the
 * table against schema.prisma.
 */
export const COMPOUND_UNIQUES: Readonly<Partial<Record<ModelName, readonly string[]>>> = deepFreeze(
  {
    Candidate: ['orgId_email', 'id_orgId'],
    Invitation: ['id_orgId'],
    Test: ['id_orgId'],
    Question: ['orgId_slug'],
    ConsentText: ['orgId_version'],
    SessionSection: ['sessionId_sectionId', 'sessionId_position'],
    IdentityCheck: ['sessionId_attempt'],
    MediaChunk: ['sessionId_stream_seq'],
    ProctorEventBatch: ['sessionId_seq'],
    KeystrokeBatch: ['sessionId_seq'],
  },
);

/** The operations whose result carries rows: they get the default `omit` unless they name a `select`. */
export const ROW_RETURNING_OPERATIONS: readonly string[] = deepFreeze([
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
]);

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const scalarCache = new Map<string, readonly string[]>();

/**
 * Every scalar column of `model` (Prisma field names, enums and foreign keys included, relations not), from
 * the generated client's own `<Model>ScalarFieldEnum`. The default `omit` is computed from it, so a column
 * the schema gains is hidden until it is listed in CANDIDATE_READ.
 */
export function scalarColumnsOf(model: string): readonly string[] {
  const known = scalarCache.get(model);
  if (known !== undefined) return known;
  const fields = (Prisma as unknown as Record<string, unknown>)[`${model}ScalarFieldEnum`];
  if (!isPlainObject(fields)) {
    throw new OrgScopeViolationError(`${model}: the generated client lists no scalar fields.`);
  }
  const columns = Object.freeze(Object.values(fields).map(String));
  scalarCache.set(model, columns);
  return columns;
}

/** What one query may name, and what its default select leaves out. */
export interface ReadAccess {
  /** Columns that may appear in select, where, having, orderBy, distinct, by and the aggregates. */
  readonly readable: ReadonlySet<string>;
  /** The RUN columns: naming one ANDs `kind = 'RUN'`. */
  readonly runOnly: ReadonlySet<string>;
  /** Every scalar column that is not in the default select, as an `omit`. */
  readonly omit: Readonly<Record<string, true>>;
}

/**
 * The columns a CANDIDATE may name on `model` in this query. `gated`: the model is readable only under a
 * grant (consent_texts, test_questions), so only the grant's columns count. A grant of ANOTHER model, or a
 * create grant (which unlocks no read), adds nothing.
 */
export function readAccess(
  model: ModelName,
  gated: boolean,
  grant: GrantView | undefined,
): ReadAccess {
  const rule = CANDIDATE_READ[model];
  if (rule === undefined) {
    throw new OrgScopeViolationError(
      `${model}: no CANDIDATE read rule (apps/api/src/database/candidate-interim.ts).`,
    );
  }
  const unlocked = new Set(
    grant !== undefined && grant.model === model && grant.mode === 'rows' ? grant.columns : [],
  );
  const inDefault = gated
    ? new Set(rule.read.filter((column) => unlocked.has(column)))
    : new Set([...rule.read, ...rule.keys]);
  const readable = new Set([
    ...inDefault,
    ...rule.explicit.filter((column) => unlocked.has(column)),
    ...rule.runOnly,
  ]);
  const omit: Record<string, true> = {};
  for (const column of scalarColumnsOf(model)) {
    if (!inDefault.has(column)) omit[column] = true;
  }
  return { readable, runOnly: new Set(rule.runOnly), omit };
}

/** The scalar columns of `model` that no candidate ever reads (neither listed nor explicit nor RUN). */
export function hiddenColumnsOf(model: ModelName): readonly string[] {
  const rule = CANDIDATE_READ[model];
  const listed = new Set([
    ...(rule?.read ?? []),
    ...(rule?.keys ?? []),
    ...(rule?.explicit ?? []),
    ...(rule?.runOnly ?? []),
  ]);
  return scalarColumnsOf(model).filter((column) => !listed.has(column));
}

function refuse(model: string, operation: string, field: string, where: string) {
  return new OrgScopeViolationError(
    `${model}.${operation}: the column ${field} is not available to a candidate in ${where} ` +
      '(ADR 0013 CS-4.4 read allowlist; an explicit-only column needs the grant that names it).',
  );
}

/**
 * A Prisma field reference (`client.model.fields.column`), as the runtime builds it: an object with the
 * own properties `modelName`, `name`, `typeName`, `isList` and `isEnum`, and a `_toGraphQLInputType` method.
 * Either mark is enough, so a look-alike that carries the four properties is refused too (fail closed).
 * A column name is never a field reference: it is a key, and its value is a filter or a scalar.
 */
export function isFieldRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v._toGraphQLInputType === 'function' ||
    (typeof v.modelName === 'string' &&
      typeof v.name === 'string' &&
      typeof v.typeName === 'string' &&
      typeof v.isList === 'boolean')
  );
}

/**
 * Refuses a field reference anywhere in a `where` or a `having`, through every operator and every
 * nesting (`equals`, `in`, `not: { lt }`, `AND`, `OR`, `NOT`, arrays). Pure, no query. A value that is
 * a Date or a byte array is a leaf. Arrays and objects count toward the depth.
 */
function assertNoFieldRefs(
  model: ModelName,
  operation: string,
  value: unknown,
  place: string,
  depth: number,
): void {
  if (isFieldRef(value)) {
    throw new OrgScopeViolationError(
      `${model}.${operation}: a field reference (client.<model>.fields.<column>) in ${place} is ` +
        'refused in a CANDIDATE scope: it compares a column without naming it, and CS-4.4 grants ' +
        'none (ADR 0013 CS-4.4).',
    );
  }
  if (typeof value !== 'object' || value === null) return;
  if (value instanceof Date || ArrayBuffer.isView(value)) return;
  if (depth > MAX_DEPTH) throw tooDeep(model, operation, `a ${place}`);
  const inner = Array.isArray(value) ? value : Object.values(value);
  for (const item of inner) assertNoFieldRefs(model, operation, item, place, depth + 1);
}

// A where nests AND, OR and NOT, and arrays. Anything beyond this is refused, as in candidate-relations.ts.
const MAX_DEPTH = 32;

function tooDeep(model: string, operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(
    `${model}.${operation}: ${what} nested more than ${MAX_DEPTH} levels deep is refused in a ` +
      'CANDIDATE scope.',
  );
}

/**
 * The field names a where or having mentions: its own keys, through AND, OR, NOT and `_avg`-style
 * keys, and through the compound unique selectors of the model. Arrays count toward the depth.
 */
function whereFields(
  model: ModelName,
  operation: string,
  value: unknown,
  into: Set<string>,
  depth: number,
): void {
  if ((Array.isArray(value) || isPlainObject(value)) && depth > MAX_DEPTH) {
    throw tooDeep(model, operation, 'a where');
  }
  if (Array.isArray(value)) {
    for (const item of value) whereFields(model, operation, item, into, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  const compound = COMPOUND_UNIQUES[model] ?? [];
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      whereFields(model, operation, inner, into, depth + 1);
    } else if (compound.includes(key) && isPlainObject(inner)) {
      for (const field of Object.keys(inner)) into.add(field); // orgId_slug: { orgId, slug }
    } else if (key.startsWith('_') && isPlainObject(inner)) {
      for (const field of Object.keys(inner)) into.add(field); // having: { _avg: { riskScore: ... } }
    } else into.add(key);
  }
}

/**
 * The field names a `where` mentions (through AND, OR, NOT and the compound unique selectors), for the
 * object-key binding of session-scope-args.ts. Same walk, same depth limit as the read check.
 */
export function whereFieldNames(model: ModelName, operation: string, where: unknown): Set<string> {
  const into = new Set<string>();
  whereFields(model, operation, where, into, 0);
  return into;
}

/** The field names an orderBy mentions, including `{ _min: { field: 'asc' } }` (groupBy). */
function orderByFields(
  model: ModelName,
  operation: string,
  value: unknown,
  into: Set<string>,
  depth: number,
): void {
  if (Array.isArray(value) && depth > MAX_DEPTH) throw tooDeep(model, operation, 'an orderBy');
  if (Array.isArray(value)) {
    for (const item of value) orderByFields(model, operation, item, into, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if (key.startsWith('_') && isPlainObject(inner)) {
      for (const field of Object.keys(inner)) into.add(field);
    } else into.add(key);
  }
}

function listFields(
  model: ModelName,
  operation: string,
  value: unknown,
  into: Set<string>,
  depth: number,
): void {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) throw tooDeep(model, operation, 'a field list');
    for (const item of value) listFields(model, operation, item, into, depth + 1);
  }
}

/** What the column check decided for one query. */
export interface ColumnVerdict {
  /**
   * The `omit` the query must run with: every scalar column that is not in the default select. Set only
   * for a row-returning call that names no `select`; the caller's own `omit` is merged, ours wins.
   */
  readonly omit: Record<string, true> | undefined;
  /** True when `results`, `passed` or `total` is named anywhere: AND `kind = 'RUN'` into the query. */
  readonly runFilter: boolean;
}

/**
 * The read control for a CANDIDATE scope. Pure: it reads the caller's arguments (after CS-4.5 has refused
 * relations, so `select` holds scalar fields only) and sends no query. The write columns are checked
 * separately, against the CS-4.4 write allowlist (session-scope-args.ts).
 */
export function assertCandidateColumns(
  model: ModelName,
  operation: string,
  args: PlainObject,
  gated: boolean,
  grant: GrantView | undefined,
): ColumnVerdict {
  const access = readAccess(model, gated, grant);
  let runFilter = false;
  const check = (fields: Iterable<string>, where: string, allowAll = false): void => {
    for (const field of fields) {
      if (allowAll && field === '_all') continue;
      if (!access.readable.has(field)) throw refuse(model, operation, field, where);
      if (access.runOnly.has(field)) runFilter = true;
    }
  };

  // 1. The selection: a `select` of readable columns, or the default `omit` (below).
  const named = args.select;
  if (named !== undefined && !isPlainObject(named)) {
    throw new OrgScopeViolationError(
      `${model}.${operation}: select must be an object (ADR 0013 CS-4.4).`,
    );
  }
  if (named !== undefined && args.omit !== undefined) {
    throw new OrgScopeViolationError(
      `${model}.${operation}: select and omit cannot be used together in a CANDIDATE scope.`,
    );
  }
  if (args.omit !== undefined && !isPlainObject(args.omit)) {
    throw new OrgScopeViolationError(
      `${model}.${operation}: omit must be an object (ADR 0013 CS-4.4).`,
    );
  }
  if (named !== undefined) check(Object.keys(named), 'select', operation === 'count');

  // 2. The read list in every place a column can be filtered or ordered on.
  assertNoFieldRefs(model, operation, args.where, 'where', 0);
  assertNoFieldRefs(model, operation, args.having, 'having', 0);
  const where = new Set<string>();
  whereFields(model, operation, args.where, where, 0);
  check(where, 'where');
  const having = new Set<string>();
  whereFields(model, operation, args.having, having, 0);
  check(having, 'having');
  const ordered = new Set<string>();
  orderByFields(model, operation, args.orderBy, ordered, 0);
  check(ordered, 'orderBy');
  for (const key of ['distinct', 'by'] as const) {
    const listed = new Set<string>();
    listFields(model, operation, args[key], listed, 0);
    check(listed, key === 'by' ? 'groupBy' : key);
  }
  for (const key of ['_count', '_sum', '_avg', '_min', '_max'] as const) {
    if (isPlainObject(args[key])) check(Object.keys(args[key]), key, key === '_count');
  }

  const omit =
    named === undefined && ROW_RETURNING_OPERATIONS.includes(operation)
      ? { ...(isPlainObject(args.omit) ? (args.omit as Record<string, true>) : {}), ...access.omit }
      : undefined;
  return { omit, runFilter };
}
