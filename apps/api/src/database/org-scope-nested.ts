// The nested guards: deny-by-default for nested relation writes, and no nested cursors.
//
// Nested relation writes (ADR 0006 section 8). In ANY scope the extension applies to, an org scope
// or system scope, every nested relation write inside `data` is refused: `connect`,
// `connectOrCreate`, `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`,
// `deleteMany`, `set` and `disconnect`, through every relation class (ORG_ID, SCOPE_HOP, COMPOSITE,
// RULE_I) and on both sides of the relation, including `org: { connect }`. Services write with
// scalar foreign keys only (`invitationId`, `userId`, `testId`, `orgId`) and with separate
// top-level calls; Postgres checks the composite foreign keys, and ADR 0006 section 2 rule (i)
// covers the rest. What stays: scalar fields (scalar foreign keys included), a scalar list's
// `{ set }`, Json columns, and a flat top-level `createMany`.
//
// Why a blanket rule and not a rule per class. A nested write acts on rows the scope filter never
// selected, and each class had a hole:
//   - parent-side connect/set: `organization.update({ where: { id: A }, data: { users: { connect:
//     { id: userOfB } } } })` moves B's user into A;
//   - RULE_I relations: the row on the other side can belong to another org, so
//     `reviewer: { update: { passwordHash } }` takes over that user;
//   - COMPOSITE relations: `connect` writes every column of the key, the shared org_id included, so
//     `session.update({ data: { invitation: { connect: { id: invitationOfB } } } })` moved the
//     session, with its proctoring data, into org B (the composite foreign key is satisfied by the
//     new values). The scalar form `invitationId: <B's>` keeps org_id = A and Postgres rejects it;
//   - `connect` next to a write in one to-one input: Prisma applies the `update` to the row that was
//     just connected, so `refreshToken.update({ data: { user: { connect: { id: userOfB }, update: {
//     passwordHash } } } })` writes B's user, through a SCOPE_HOP relation.
// A rule that lists the safe shapes would have to be re-proven on every Prisma release and every
// schema change. Refusing all of them cannot be wrong in this way.
//
// Exceptions go in NESTED_WRITE_ALLOWLIST, which starts empty. An entry names the model, the
// relation field and the operations, and must come with its own cross-org test in
// tc-008-org-isolation.spec.ts that shows the shape cannot reach another org's row. A unit test
// fails while the list is not empty, so adding an entry is a reviewed change.
//
// Nested cursors (org scope). A `cursor` anywhere inside `include` or `select` is refused at any
// depth: Prisma finds a cursor row by its own fields, so a nested one could rank the caller's rows
// against another org's row. It covers the fluent API: `session.findUnique(...).proctorEvents({
// cursor })` reaches the extension as `findUnique` with `select: { proctorEvents: { cursor } }`.
// Page nested relations with `where`, `take` and `orderBy` instead.
//
// Schema knowledge (which fields are relations) comes from org-scope-relations.ts, a table checked
// against schema.prisma, not from Prisma's runtime data model. Nothing here sends a query: it only
// reads the arguments, and the cost is one lookup per key of `data`. Messages name models and
// fields, never values.
import { OrgScopeViolationError } from './errors';
import type { ModelName } from './org-scope-map';
import { relationOf } from './org-scope-relations';
import { ownValue } from './plain-args';

type PlainObject = Record<string, unknown>;

interface Walk {
  readonly root: string;
  readonly operation: string;
}

// Real selections are a few levels deep. Anything beyond this is refused, not walked.
const MAX_DEPTH = 16;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(walk: Walk, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(`${walk.root}.${walk.operation}: ${what}.`);
}

// ---- nested relation writes ------------------------------------------------------------------

/** One allowed nested-write pattern. Each entry needs its own cross-org test. */
export interface NestedWriteAllowance {
  readonly model: ModelName;
  /** The relation field on `model`. */
  readonly field: string;
  /** The nested operations allowed through it, for example ['connect']. */
  readonly operations: readonly string[];
  /** Why this one is safe, and the name of the cross-org test that proves it. */
  readonly reason: string;
}

/**
 * Nested relation writes that are allowed anyway. EMPTY, on purpose: BE-02 and BE-03 write with
 * scalar foreign keys and top-level calls only. To add an entry, name the model, the relation and
 * the operations, explain why the shape cannot reach another org's row, and add a cross-org test
 * for it to tc-008-org-isolation.spec.ts. org-scope-nested.spec.ts fails until it is reviewed.
 */
export const NESTED_WRITE_ALLOWLIST: readonly NestedWriteAllowance[] = [];

function isAllowed(
  allowlist: readonly NestedWriteAllowance[],
  model: ModelName,
  field: string,
  operation: string,
): boolean {
  return allowlist.some(
    (entry) =>
      entry.model === model && entry.field === field && entry.operations.includes(operation),
  );
}

/**
 * Refuses every nested relation write in `data`: any relation field with a value, whatever the
 * nested operation, class or side. `data` is the payload of a create, an update, or one branch of an
 * upsert.
 */
export function assertNoNestedWrites(
  model: ModelName,
  operation: string,
  data: unknown,
  allowlist: readonly NestedWriteAllowance[] = NESTED_WRITE_ALLOWLIST,
): void {
  if (!isPlainObject(data)) return;
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined || relationOf(model, field) === undefined) continue;
    const nested = isPlainObject(value) ? Object.keys(value) : ['(not an object)'];
    for (const nestedOperation of nested.length === 0 ? ['(empty)'] : nested) {
      if (isAllowed(allowlist, model, field, nestedOperation)) continue;
      throw refuse(
        { root: model, operation },
        `nested relation write refused (${model}.${field}.${nestedOperation}): write related rows ` +
          'with their own scoped call and scalar foreign keys (ADR 0006 §8, deny-by-default)',
      );
    }
  }
}

/** The payloads of a write that can carry nested writes: `data`, or an upsert's two branches. */
export function assertNoNestedWritesIn(
  model: ModelName,
  operation: string,
  args: unknown,
  allowlist: readonly NestedWriteAllowance[] = NESTED_WRITE_ALLOWLIST,
): void {
  if (!isPlainObject(args)) return;
  switch (operation) {
    case 'create':
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      assertNoNestedWrites(model, operation, ownValue(args, 'data'), allowlist);
      break;
    case 'upsert':
      assertNoNestedWrites(model, operation, ownValue(args, 'create'), allowlist);
      assertNoNestedWrites(model, operation, ownValue(args, 'update'), allowlist);
      break;
    default:
      break; // reads and deletes carry no data; createMany rows are flat and never walked
  }
}

// ---- nested cursors in include and select ----------------------------------------------------

/**
 * Refuses a `cursor` anywhere inside the `include` or `select` of `args`, at any depth. Prisma
 * resolves a nested cursor by its own fields, like a top-level one, so it could rank the caller's
 * rows against another org's row. Covers the fluent API, which arrives as a `select` on the
 * relation. Page nested relations with `where`, `take` and `orderBy` instead.
 */
export function assertNoNestedCursor(model: ModelName, operation: string, args: PlainObject): void {
  walkSelection({ root: model, operation }, model, args, 0);
}

function walkSelection(walk: Walk, model: ModelName, args: PlainObject, depth: number): void {
  for (const key of ['select', 'include'] as const) {
    const selection = ownValue(args, key);
    if (!isPlainObject(selection)) continue;
    for (const [field, value] of Object.entries(selection)) {
      if (!isPlainObject(value)) continue; // `true`: a scalar or a whole relation, no arguments
      if (field === '_count') {
        // _count: { select: { relation: true | { where } } }
        const counted = isPlainObject(value.select) ? value.select : {};
        for (const [name, countArgs] of Object.entries(counted)) {
          if (isPlainObject(countArgs) && countArgs.cursor !== undefined) {
            throw nestedCursor(walk, model, `_count.${name}`);
          }
        }
        continue;
      }
      const side = relationOf(model, field);
      if (side === undefined) continue; // not a relation: nothing to page
      if (depth >= MAX_DEPTH) throw selectionTooDeep(walk, model, field);
      if (value.cursor !== undefined) throw nestedCursor(walk, model, field);
      walkSelection(walk, side.target, value, depth + 1);
    }
  }
}

/** The selection itself is refused (it is a read, not a write): it cannot be walked to the end. */
function selectionTooDeep(walk: Walk, model: ModelName, field: string): OrgScopeViolationError {
  return new OrgScopeViolationError(
    `${walk.root}.${walk.operation}: selection refused at ${model}.${field}: include and select ` +
      `are nested more than ${MAX_DEPTH} relations deep, which the scope cannot check for ` +
      'nested cursors. Select fewer levels, or load the deeper rows with their own call.',
  );
}

function nestedCursor(walk: Walk, model: ModelName, field: string): OrgScopeViolationError {
  return new OrgScopeViolationError(
    `${walk.root}.${walk.operation}: nested cursor refused on ${model}.${field}: Prisma finds a ` +
      "cursor row by its own fields, so it could rank this org's rows against another org's row. " +
      'Page nested relations with where, take and orderBy instead.',
  );
}
