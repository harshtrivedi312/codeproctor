// The one cross-organisation read of scheduled_windows (ADR 0017 section 4.7, owner decisions C-53 and P-40/D-60;
// the hub's ruling of 2026-10-06 on Database A's question). The instances are shared by every organisation, so
// capacity (FR-306), the stale-ceiling rule (ADR 0017 section 4.3) and the monthly instance-hours read the windows
// of all organisations, which an org-scoped query cannot do. ADR 0017 calls it a "SERVICE-scope read"; SERVICE is
// the session-bound actor here (ADR 0013 CS-4.1), so it is a system scope with its own reason, SCHEDULE_CAPACITY,
// and the extension holds it to this shape, before any statement:
//   (a) under SCHEDULE_CAPACITY, ScheduledWindow is read with findMany (an explicit select), count, aggregate or
//       groupBy only, and every column the call names, in select, by, where, orderBy, distinct, having or an
//       aggregate, is one of SCHEDULE_CAPACITY_COLUMNS: never id, org_id, invitation_id, requested_by or the
//       timestamps, and no include, omit, cursor or relation filter;
//   (b) under any other system reason, ScheduledWindow is refused, reads included;
//   (c) every ScheduledWindow write in system scope is refused: writes stay org-scoped (runInOrg, runAsUser);
//   (d) SCHEDULE_CAPACITY reads no other model.
// The schedule view shows another organisation's rows only as anonymous busy capacity (FR-307), so the shape
// carries no organisation and no person. This is the ADR 0006 exception the ADR asks Database A's PR to declare;
// the ADR 0006 row itself is the hub's (owner batch). Who may enter the reason is pinned in call-sites.spec.ts.
import { OrgScopeViolationError } from './errors';
import { deepFreeze } from './deep-freeze';
import { FK_CLASSES } from './org-scope-relations';
import { isFieldRef, isPlainPrototype, ownValue } from './plain-args';

/** The only columns a SCHEDULE_CAPACITY read may name (ADR 0017 section 4.7). */
export const SCHEDULE_CAPACITY_COLUMNS: readonly string[] = deepFreeze([
  'startsAt',
  'endsAt',
  'ceilingAt',
  'status',
  'kind',
]);

/** The operations a SCHEDULE_CAPACITY read may use. */
export const SCHEDULE_CAPACITY_OPERATIONS: readonly string[] = deepFreeze([
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const SCHEDULE_MODEL = 'ScheduledWindow';
const REASON = 'SCHEDULE_CAPACITY';

/** The top-level keys each operation may carry; `select` (findMany) and `by` (groupBy) are required. */
const TOP_LEVEL: Readonly<Record<string, readonly string[]>> = deepFreeze({
  findMany: ['select', 'where', 'orderBy', 'distinct', 'take', 'skip'],
  count: ['select', 'where', 'orderBy', 'distinct', 'take', 'skip'],
  aggregate: ['where', 'orderBy', 'take', 'skip', '_count', '_min', '_max'],
  groupBy: ['by', 'where', 'orderBy', 'having', 'take', 'skip', '_count', '_min', '_max'],
});

/**
 * The keys allowed anywhere inside the structure: the five columns, the logical operators, the scalar filter
 * operators and the aggregate and sort keys. Anything else, a column outside the five or a relation name above
 * all, is refused wherever it stands.
 */
const NESTED_KEYS: ReadonlySet<string> = new Set([
  ...SCHEDULE_CAPACITY_COLUMNS,
  'AND',
  'OR',
  'NOT',
  'equals',
  'in',
  'notIn',
  'lt',
  'lte',
  'gt',
  'gte',
  'not',
  '_count',
  '_min',
  '_max',
  '_all',
  'sort',
  'nulls',
]);

function refuse(operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(
    `${SCHEDULE_MODEL}.${operation}: ${what} (ADR 0017 section 4.7).`,
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Walks a structure value: only allowed keys, plain objects and arrays, scalars and Dates; no field reference. */
function walk(operation: string, value: unknown, depth: number): void {
  if (depth > 32)
    throw refuse(operation, 'the arguments are nested too deep for a SCHEDULE_CAPACITY read');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (value instanceof Date) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(operation, item, depth + 1);
    return;
  }
  if (isFieldRef(value)) {
    throw refuse(operation, 'a field reference is refused in a SCHEDULE_CAPACITY read');
  }
  if (!isObject(value) || !isPlainPrototype(Object.getPrototypeOf(value))) {
    throw refuse(operation, 'a SCHEDULE_CAPACITY read takes plain arguments only');
  }
  for (const [key, inner] of Object.entries(value)) {
    if (!NESTED_KEYS.has(key)) {
      throw refuse(
        operation,
        `${key} is not one of ${SCHEDULE_CAPACITY_COLUMNS.join(', ')}: a SCHEDULE_CAPACITY read names those columns only`,
      );
    }
    walk(operation, inner, depth + 1);
  }
}

/** A list of column names (`by`, `distinct`), one name or an array. */
function assertColumnList(operation: string, key: string, value: unknown): void {
  const names = Array.isArray(value) ? value : [value];
  for (const name of names) {
    if (typeof name !== 'string' || !SCHEDULE_CAPACITY_COLUMNS.includes(name)) {
      throw refuse(
        operation,
        `${key} names a column that is not one of ${SCHEDULE_CAPACITY_COLUMNS.join(', ')}`,
      );
    }
  }
}

/** The select of a findMany or a count: explicit, each value `true`, each key one of the five (or `_all`). */
function assertSelect(operation: string, select: unknown): void {
  if (!isObject(select) || !isPlainPrototype(Object.getPrototypeOf(select))) {
    throw refuse(operation, 'a SCHEDULE_CAPACITY read names its columns in an explicit select');
  }
  const keys = Object.keys(select);
  if (keys.length === 0)
    throw refuse(operation, 'the select of a SCHEDULE_CAPACITY read names no column');
  for (const key of keys) {
    const allowed =
      SCHEDULE_CAPACITY_COLUMNS.includes(key) || (operation === 'count' && key === '_all');
    if (!allowed || select[key] !== true) {
      throw refuse(
        operation,
        `the select may name only ${SCHEDULE_CAPACITY_COLUMNS.join(', ')}, each as true`,
      );
    }
  }
}

/**
 * S1 of the #261 review: raw SQL cannot be held to the five columns, so it is refused under the schedule read even
 * inside runRawSql. Called by the extension for every raw query in a system scope (it keeps the reason's name here,
 * in the one file the call-site guard lists for it).
 */
export function assertNoRawUnderScheduleCapacity(reason: string, operation: string): void {
  if (reason === REASON) {
    throw new OrgScopeViolationError(
      `${operation}: raw SQL is refused under ${REASON} (ADR 0017 section 4.7): read scheduled_windows through the model API, five columns only.`,
    );
  }
}

/**
 * The relation fields that lead to scheduled_windows, derived from FK_CLASSES (checked against schema.prisma) so a
 * new one is refused without an edit here: the back-relations of the keys FROM scheduled_windows
 * (`Organization.scheduledWindows`, `Invitation.scheduledWindows`, `User.requestedScheduledWindows`) and the forward
 * relations of any key INTO it (none today; S-a of the #261 delta review).
 */
export const SCHEDULE_BACK_RELATIONS: readonly string[] = deepFreeze(
  [
    ...new Set([
      ...FK_CLASSES.filter((key) => key.model === SCHEDULE_MODEL).map((key) => key.back),
      ...FK_CLASSES.filter((key) => key.target === SCHEDULE_MODEL).map((key) => key.field),
    ]),
  ].sort(),
);

/** How deep the relation walk goes; deeper arguments are refused, never passed (B1b of the #261 delta review). */
const RELATION_WALK_DEPTH = 96;
/** The write payloads of a call: nested relation writes in them are refused elsewhere (assertSystemScopeWrite). */
const WRITE_PAYLOADS = new Set(['data', 'create', 'update']);
/** A `_count` that counts every list relation of its model (no explicit `select`): B1a of the #261 delta review. */
const COUNT_ALL =
  '_count without an explicit select (it counts every relation, scheduled_windows included)';

/**
 * A `_count` that names its relations (S1 of the #261 round-3 review): a plain object whose own `select` is a plain
 * object with at least one relation set to `true` or to plain-object args, and no `$`-prefixed key. `{ select: {} }`,
 * `{ select: { x: false } }` and `{ select: { $scalars: true } }` end in a Prisma error today, which is a Prisma detail
 * and not a promise (as #185 S2 found for `select`), so they are refused here as counting every relation.
 */
function isExplicitCount(value: unknown): boolean {
  if (!isObject(value)) return false;
  const select = ownValue(value, 'select');
  if (!isObject(select)) return false;
  const entries = Object.entries(select);
  if (entries.some(([key]) => key.startsWith('$'))) return false;
  return entries.some(
    ([, v]) => v === true || (isObject(v) && isPlainPrototype(Object.getPrototypeOf(v))),
  );
}

/**
 * The first relation to scheduled_windows that `value` reaches, anywhere in it (objects and arrays): a key named like
 * one, or a `_count` under a select or include that has no explicit `select` object (`_count: true`, `{}`,
 * `{ select: null }`), which counts every list relation of its model. Past RELATION_WALK_DEPTH it throws.
 */
function findRelationKey(
  operation: string,
  value: unknown,
  depth: number,
  parentKey: string | undefined,
): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (depth > RELATION_WALK_DEPTH) {
    throw new OrgScopeViolationError(
      `${operation}: the arguments are nested too deep to check for a relation to scheduled_windows (ADR 0017 section 4.7).`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRelationKey(operation, item, depth + 1, parentKey);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (depth === 0 && WRITE_PAYLOADS.has(key)) continue;
    if (SCHEDULE_BACK_RELATIONS.includes(key)) return key;
    if (key === '_count' && (parentKey === 'select' || parentKey === 'include')) {
      if (!isExplicitCount(inner)) return COUNT_ALL;
    }
    const found = findRelationKey(operation, inner, depth + 1, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Called by the extension for every query in a system scope, before the `unscoped` early return and the
 * system-scope write check: the four rules of the header, and (b) through a relation. It throws or returns;
 * it never rewrites the arguments.
 */
export function assertScheduleCapacityScope(
  model: string,
  operation: string,
  reason: string,
  args: unknown,
): void {
  if (model !== SCHEDULE_MODEL) {
    if (reason === REASON) {
      throw new OrgScopeViolationError(
        `${model}.${operation}: the ${REASON} reason reads scheduled_windows only (ADR 0017 section 4.7).`,
      );
    }
    // (b) through a relation (B1 of the #261 review): a system query on another model may not name a
    // relation that leads to scheduled_windows anywhere in its arguments (include, select, _count, where,
    // orderBy, cursor, having, at any depth), or `invitation.findMany({ include: { scheduledWindows: true } })`
    // would return every organisation's windows, all columns, under BACKGROUND_JOB or RETENTION_ERASURE.
    const relation = findRelationKey(operation, args, 0, undefined);
    if (relation !== undefined) {
      throw new OrgScopeViolationError(
        `${model}.${operation}: ${relation} leads to scheduled_windows, which a system scope reads only under ${REASON}, on ScheduledWindow itself (ADR 0017 section 4.7).`,
      );
    }
    return;
  }
  if (reason !== REASON) {
    throw refuse(
      operation,
      `scheduled_windows is read across organisations only under ${REASON}; everything else, writes included, runs in an org scope`,
    );
  }
  if (!SCHEDULE_CAPACITY_OPERATIONS.includes(operation)) {
    throw refuse(
      operation,
      `${REASON} allows ${SCHEDULE_CAPACITY_OPERATIONS.join(', ')} only: writes stay org-scoped`,
    );
  }
  const given: Record<string, unknown> =
    args === undefined || args === null ? {} : (args as Record<string, unknown>);
  if (!isObject(given) || !isPlainPrototype(Object.getPrototypeOf(given))) {
    throw refuse(operation, 'a SCHEDULE_CAPACITY read takes plain arguments only');
  }
  const allowedTop = TOP_LEVEL[operation] as readonly string[];
  for (const key of Object.keys(given)) {
    if (!allowedTop.includes(key)) {
      throw refuse(operation, `${key} is refused in a SCHEDULE_CAPACITY ${operation}`);
    }
  }
  if (operation === 'findMany' || given.select !== undefined) assertSelect(operation, given.select);
  if (operation === 'groupBy') {
    if (given.by === undefined)
      throw refuse(operation, 'a SCHEDULE_CAPACITY groupBy names its by columns');
    assertColumnList(operation, 'by', given.by);
  }
  if (given.distinct !== undefined) assertColumnList(operation, 'distinct', given.distinct);
  for (const key of ['where', 'orderBy', 'having', '_count', '_min', '_max']) {
    if (given[key] !== undefined) walk(operation, given[key], 0);
  }
  for (const key of ['take', 'skip']) {
    if (given[key] !== undefined && typeof given[key] !== 'number') {
      throw refuse(operation, `${key} must be a number`);
    }
  }
}
