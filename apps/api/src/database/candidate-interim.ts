// INTERIM column safety for a CANDIDATE scope (ADR 0013 CS-4.4 is PR 2; rule 3 of CLAUDE.md).
//
// PR 1 has no CS-4.4 column allowlists, so without this file a candidate could `select` the sealed
// session key, `include`-free but all-columns, or write `sessions.status`. Until PR 2's allowlists
// replace it, a CANDIDATE scope fails closed on a fixed list:
//
//   1. Every call that returns rows names an explicit `select` (no default all-columns result):
//      findUnique, findUniqueOrThrow, findFirst, findFirstOrThrow, findMany, create,
//      createManyAndReturn, update, updateManyAndReturn, upsert and delete. A new column therefore
//      stays hidden until a route lists it. `include` is refused by CS-4.5 (candidate-relations.ts).
//   2. CANDIDATE_INTERIM_DENY.read is refused in `select`, `where`, `having`, `orderBy`, `distinct`,
//      `by` (groupBy), the aggregates (`_count`, `_sum`, `_avg`, `_min`, `_max`) and the `select` of
//      `count`, so a hidden column cannot act as a boolean or ordering oracle either.
//   3. CANDIDATE_INTERIM_DENY.write (the read list plus the state columns) is refused in the data of
//      every write.
//
// It is a deny list, so it is only as complete as its entries. It is NOT the CS-4.4 allowlist: a column
// that is not named here (for example `sessions.retentionAnchorAt`, `session_questions.points`,
// `proctor_events.severity`, `media_chunks.objectKey`) is still readable or writable. BE-07 may rely on
// CANDIDATE column safety only after PR 2 merges (FU-DB-190).
//
// Names are Prisma's field names (`hmacKeyEnc`), not column names. A test checks each entry against the
// generated client. Messages name the model, the column and the place, never a value.
import { OrgScopeViolationError } from './errors';
import type { ModelName } from './org-scope-map';

type PlainObject = Record<string, unknown>;

interface InterimDeny {
  /** Refused in select, where, orderBy, distinct, groupBy and the aggregates. */
  readonly read: readonly string[];
  /** Refused in the data of a write: `read` plus the state and review columns. */
  readonly write: readonly string[];
}

const READ_DENIED: Readonly<Partial<Record<ModelName, readonly string[]>>> = {
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
  Submission: ['score'],
  SessionQuestion: ['score', 'scoringNote'],
};

/** Columns a candidate may read but not write: the session state and the identity review. */
const WRITE_ONLY_DENIED: Readonly<Partial<Record<ModelName, readonly string[]>>> = {
  Session: [
    'status',
    'pauseReasons',
    'submittedAt',
    'authEpoch',
    'startedAt',
    'deadlineAt',
    'pausedMs',
  ],
  IdentityCheck: ['status'],
};

/**
 * INTERIM. PR 2 of ADR 0013 CS-4 (the CS-4.4 column allowlists, `omit` and grants) replaces this list;
 * it exists only so that PR 1 does not ship a CANDIDATE scope with no column control at all.
 */
export const CANDIDATE_INTERIM_DENY: Readonly<Partial<Record<ModelName, InterimDeny>>> =
  Object.fromEntries(
    [...new Set([...Object.keys(READ_DENIED), ...Object.keys(WRITE_ONLY_DENIED)])].map((model) => {
      const read = READ_DENIED[model as ModelName] ?? [];
      return [
        model,
        { read, write: [...read, ...(WRITE_ONLY_DENIED[model as ModelName] ?? [])] },
      ] as const;
    }),
  );

/** The operations whose result carries rows: they must name their `select`. */
export const ROW_RETURNING_OPERATIONS: readonly string[] = [
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
];

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(model: string, operation: string, field: string, where: string) {
  return new OrgScopeViolationError(
    `${model}.${operation}: the column ${field} is not available to a candidate in ${where} ` +
      '(interim deny list CANDIDATE_INTERIM_DENY; ADR 0013 CS-4.4 column allowlists are PR 2).',
  );
}

// A where nests AND, OR and NOT. Anything beyond this is refused, as in candidate-relations.ts.
const MAX_DEPTH = 32;

/** The field names a where or having mentions: its own keys, through AND, OR, NOT and `_avg`-style keys. */
function whereFields(value: unknown, into: Set<string>, depth: number): void {
  if (Array.isArray(value)) {
    for (const item of value) whereFields(item, into, depth);
    return;
  }
  if (!isPlainObject(value)) return;
  if (depth > MAX_DEPTH) {
    throw new OrgScopeViolationError(
      `a where nested more than ${MAX_DEPTH} levels deep is refused in a CANDIDATE scope.`,
    );
  }
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if (key === 'AND' || key === 'OR' || key === 'NOT') whereFields(inner, into, depth + 1);
    else if (key.startsWith('_') && isPlainObject(inner)) {
      for (const field of Object.keys(inner)) into.add(field); // having: { _avg: { riskScore: ... } }
    } else into.add(key);
  }
}

/** The field names an orderBy mentions, including `{ _min: { field: 'asc' } }` (groupBy). */
function orderByFields(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) orderByFields(item, into);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if (key.startsWith('_') && isPlainObject(inner))
      for (const field of Object.keys(inner)) into.add(field);
    else into.add(key);
  }
}

function listFields(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) listFields(item, into);
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

function rowsOf(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [data];
}

/**
 * The interim column control for a CANDIDATE scope. Pure: it reads the caller's arguments (after
 * CS-4.5 has refused relations, so `select` holds scalar fields only) and sends no query.
 */
export function assertInterimColumns(model: ModelName, operation: string, args: PlainObject): void {
  const deny = CANDIDATE_INTERIM_DENY[model];
  const denyRead = deny?.read ?? [];
  const denyWrite = deny?.write ?? [];

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
  const where = new Set<string>();
  whereFields(args.where, where, 0);
  assertNotDenied(model, operation, denyRead, where, 'where');
  const having = new Set<string>();
  whereFields(args.having, having, 0);
  assertNotDenied(model, operation, denyRead, having, 'having');
  const ordered = new Set<string>();
  orderByFields(args.orderBy, ordered);
  assertNotDenied(model, operation, denyRead, ordered, 'orderBy');
  for (const key of ['distinct', 'by'] as const) {
    const listed = new Set<string>();
    listFields(args[key], listed);
    assertNotDenied(model, operation, denyRead, listed, key === 'by' ? 'groupBy' : key);
  }
  for (const key of ['_count', '_sum', '_avg', '_min', '_max'] as const) {
    if (isPlainObject(args[key])) {
      assertNotDenied(model, operation, denyRead, Object.keys(args[key]), key);
    }
  }

  // 3. The write list in the data of every write.
  const payloads: unknown[] = [];
  switch (operation) {
    case 'create':
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
    case 'createMany':
    case 'createManyAndReturn':
      payloads.push(...rowsOf(args.data));
      break;
    case 'upsert':
      payloads.push(args.create, args.update);
      break;
    default:
      break;
  }
  for (const payload of payloads) {
    if (!isPlainObject(payload)) continue;
    const written = Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    assertNotDenied(model, operation, denyWrite, written, 'a write');
  }
}
