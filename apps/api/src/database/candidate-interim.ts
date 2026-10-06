// INTERIM READ safety for a CANDIDATE scope (ADR 0013 CS-4.4 is PR 2; rule 3 of CLAUDE.md).
//
// The WRITE side is no longer interim: it is CS-4.4's "Write" column as an allowlist, in
// session-scope-map.ts (anything not listed throws, and so does an update on a create-only model).
// What is interim here is the READ side. PR 1 has no `omit` and no grants, so until PR 2 builds the
// CS-4.4 read allowlists, a CANDIDATE scope fails closed like this:
//
//   1. Every call that returns rows names an explicit `select` (no default all-columns result):
//      findUnique, findUniqueOrThrow, findFirst, findFirstOrThrow, findMany, create,
//      createManyAndReturn, update, updateManyAndReturn, upsert and delete. A new column therefore
//      stays hidden until a route lists it. `include` is refused by CS-4.5 (candidate-relations.ts).
//   2. No field reference (`client.model.fields.column`) anywhere in a `where` or a `having`: it
//      compares one column with another without naming the other, so `{ points: { equals: fields.score } }`
//      would test a hidden column. CS-4.4 grants none, so every one is refused, whichever column it names.
//   3. CANDIDATE_INTERIM_DENY, per model, is refused in `select`, `where`, `having`, `orderBy`,
//      `distinct`, `by` (groupBy), the aggregates (`_count`, `_sum`, `_avg`, `_min`, `_max`) and the
//      `select` of `count`, so a hidden column cannot act as a boolean or ordering oracle either. A
//      compound unique selector (`orgId_slug`) is read through to its columns.
//
// The deny list is the COMPLEMENT of CS-4.4's read column, model by model: every column of a model on the
// CANDIDATE allowlist is either readable by CS-4.4, or a key that ties the row to its own scope (below), or
// named here. candidate-interim.spec.ts holds the CS-4.4 read column and fails for a column that is none of
// the three, so a new column breaks the build until it is classified. The keys that are not hidden are
// `id`, `orgId`, `sessionId`, `sessionQuestionId` and, on the two section tables, `testId` and `sectionId`:
// the ids of the candidate's own org, session and test, which the scope fixes anyway. Columns CS-4.4 opens
// only under a grant (`sessions.invitationId`, `hmacKeyEnc`, `deviceInfo`, `session_questions.
// testQuestionId`, `media_chunks.objectKey`, the two `settings`, `invitations.accommodations`) and the
// RUN-row columns of submissions (`results`, `passed`, `total`) are hidden until PR 2 builds the grants
// and the RUN filter. BE-07 may rely on CANDIDATE column safety after PR 2 merges (FU-DB-190).
//
// Names are Prisma's field names (`hmacKeyEnc`), not column names. A test checks each entry against the
// generated client. Messages name the model, the column and the place, never a value.
import { deepFreeze } from './deep-freeze';
import { OrgScopeViolationError } from './errors';
import type { ModelName } from './org-scope-map';

type PlainObject = Record<string, unknown>;

interface InterimDeny {
  /** Refused in select, where, having, orderBy, distinct, groupBy and the aggregates. */
  readonly read: readonly string[];
}

const deny = (...read: string[]): InterimDeny => ({ read });

/**
 * INTERIM. PR 2 of ADR 0013 CS-4 (the CS-4.4 read allowlists, `omit` and grants) replaces this; it
 * exists only so that PR 1 does not ship a CANDIDATE scope with no read control. Each entry is the
 * complement of the CS-4.4 read column of that model (see the header).
 */
export const CANDIDATE_INTERIM_DENY: Readonly<Partial<Record<ModelName, InterimDeny>>> = deepFreeze(
  {
    // Readable: id, status, startedAt, deadlineAt, pauseReasons, pausedMs, proctorPausedAt, submittedAt,
    // authEpoch (CS-4.4; the last six feed `effectiveDeadline`).
    Session: deny(
      'invitationId',
      'hmacKeyEnc',
      'deviceInfo',
      'clientKind',
      'totalScore',
      'riskScore',
      'riskBand',
      'lastHeartbeat',
      'retentionAnchorAt',
      'reportKey',
      'reportGeneratedAt',
      'createdAt',
    ),
    // Readable: id, sessionId, position, points, finalCode, finalLanguage, answer.
    SessionQuestion: deny(
      'testQuestionId',
      'questionVersionId',
      'variantId',
      'score',
      'scoring',
      'scoredById',
      'scoredAt',
      'scoringNote',
    ),
    // Readable: every column.
    SessionSection: deny(),
    // Readable: id, sessionQuestionId, kind, language, createdAt. `results`, `passed` and `total` are
    // CS-4.4's RUN-row columns (the RUN filter is PR 2); `sourceCode` is written, never read back.
    Submission: deny('sourceCode', 'results', 'passed', 'total', 'score'),
    // Readable: id, attempt, status, createdAt.
    IdentityCheck: deny(
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
    ),
    // Readable: id, stream, segment, seq, sizeBytes, uploadedAt. `objectKey` is explicit-only.
    MediaChunk: deny('objectKey', 'startedAt', 'durationMs', 'deletedAt'),
    // Readable: seq, signature, eventCount.
    ProctorEventBatch: deny('receivedAt'),
    // Readable: seq, signature, startedAt. `id` is a global identity counter: reading it tells a candidate
    // how many keystroke batches every candidate of the platform has inserted (an insert-volume leak), and
    // CS-4.4 does not list it.
    KeystrokeBatch: deny('id', 'events'),
    // Readable: id, type, occurredAt, durationMs, batchSeq, createdAt. The SERVER rows are filtered out.
    ProctorEvent: deny('source', 'severity', 'confidence', 'payload', 'evidenceKey'),
    // Readable: id, consentTextId, signedAt, declinedAt.
    Consent: deny('signedName', 'ip', 'userAgent', 'pdfKey', 'pdfGeneratedAt', 'copyEmailedAt'),
    // Readable: id, name, retentionDays, currentConsentTextId. `settings` is explicit-only.
    Organization: deny('settings', 'createdAt'),
    // Readable: id, fullName, email.
    Candidate: deny('externalRef', 'erasureRequestedAt', 'erasedAt', 'createdAt'),
    // Readable: id, testId, candidateId, windowStart, windowEnd, usedAt. `accommodations` is explicit-only.
    Invitation: deny('tokenHash', 'accommodations', 'sentAt', 'createdById', 'createdAt'),
    // Readable: id, name, description, durationMinutes, profile. `settings` is explicit-only.
    Test: deny('passScore', 'settings', 'createdById', 'createdAt'),
    // Readable: id, title, position, timeLimitMin.
    TestSection: deny(),
    // Readable: id, type.
    Question: deny('slug', 'tags', 'currentVersionId', 'isArchived', 'createdById', 'createdAt'),
  },
);

/**
 * The compound unique selectors of the models on the CANDIDATE allowlist (`@@unique` and `@@id` of
 * schema.prisma, named `a_b` by Prisma). A `where` that names one is read through to its columns, so
 * `orgId_slug: { orgId, slug }` is not a way round the deny list. candidate-interim.spec.ts checks the
 * table against schema.prisma.
 */
export const COMPOUND_UNIQUES: Readonly<Partial<Record<ModelName, readonly string[]>>> = deepFreeze(
  {
    Candidate: ['orgId_email', 'id_orgId'],
    Invitation: ['id_orgId'],
    Test: ['id_orgId'],
    Question: ['orgId_slug'],
    SessionSection: ['sessionId_sectionId', 'sessionId_position'],
    IdentityCheck: ['sessionId_attempt'],
    MediaChunk: ['sessionId_stream_seq'],
    ProctorEventBatch: ['sessionId_seq'],
    KeystrokeBatch: ['sessionId_seq'],
  },
);

/** The operations whose result carries rows: they must name their `select`. */
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

function refuse(model: string, operation: string, field: string, where: string) {
  return new OrgScopeViolationError(
    `${model}.${operation}: the column ${field} is not available to a candidate in ${where} ` +
      '(interim deny list CANDIDATE_INTERIM_DENY; ADR 0013 CS-4.4 read allowlists are PR 2).',
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
        'none (interim read control; ADR 0013 CS-4.4).',
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

function assertNotDenied(
  model: ModelName,
  operation: string,
  denied: readonly string[],
  fields: Iterable<string>,
  where: string,
): void {
  for (const field of fields) {
    if (denied.includes(field)) throw refuse(model, operation, field, where);
  }
}

/**
 * The interim read control for a CANDIDATE scope. Pure: it reads the caller's arguments (after
 * CS-4.5 has refused relations, so `select` holds scalar fields only) and sends no query. The write
 * columns are checked separately, against the CS-4.4 write allowlist (session-scope-args.ts).
 */
export function assertInterimColumns(model: ModelName, operation: string, args: PlainObject): void {
  const denyRead = CANDIDATE_INTERIM_DENY[model]?.read ?? [];

  // 1. Rows only through an explicit select.
  if (ROW_RETURNING_OPERATIONS.includes(operation)) {
    if (!isPlainObject(args.select) || Object.keys(args.select).length === 0) {
      throw new OrgScopeViolationError(
        `${model}.${operation}: a candidate query that returns rows needs an explicit select ` +
          '(no default all-columns result; interim CS-4.4 control, ADR 0013 PR 2 replaces it).',
      );
    }
  }

  // 2. The read list in every place a column can be read, filtered or ordered on.
  if (isPlainObject(args.select)) {
    assertNotDenied(model, operation, denyRead, Object.keys(args.select), 'select');
  }
  assertNoFieldRefs(model, operation, args.where, 'where', 0);
  assertNoFieldRefs(model, operation, args.having, 'having', 0);
  const where = new Set<string>();
  whereFields(model, operation, args.where, where, 0);
  assertNotDenied(model, operation, denyRead, where, 'where');
  const having = new Set<string>();
  whereFields(model, operation, args.having, having, 0);
  assertNotDenied(model, operation, denyRead, having, 'having');
  const ordered = new Set<string>();
  orderByFields(model, operation, args.orderBy, ordered, 0);
  assertNotDenied(model, operation, denyRead, ordered, 'orderBy');
  for (const key of ['distinct', 'by'] as const) {
    const listed = new Set<string>();
    listFields(model, operation, args[key], listed, 0);
    assertNotDenied(model, operation, denyRead, listed, key === 'by' ? 'groupBy' : key);
  }
  for (const key of ['_count', '_sum', '_avg', '_min', '_max'] as const) {
    if (isPlainObject(args[key])) {
      assertNotDenied(model, operation, denyRead, Object.keys(args[key]), key);
    }
  }
}
