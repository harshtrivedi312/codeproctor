// The nested guards (FU-DB-63 and the nested cursor). In an org scope, a nested write in `data` can
// reach rows the scope filter never selected: `organization.update({ where: { id: A }, data: {
// users: { connect: { id: userOfB } } } })` filters Organization by A and then moves B's user into
// A. And a `cursor` nested in `include` or `select` is resolved by its own fields, like a top-level
// one, so it can rank the caller's rows against another org's row. This walks `data`, `include` and
// `select` and refuses what can do that. It sends no query: it only reads the arguments.
//
// Nested writes, refused at any depth:
//   - `connect`, `connectOrCreate` and `set` on a PARENT-SIDE relation, where the foreign key is
//     held by the related model (`organization.users`, `session.consent`). They change rows of the
//     related model that the scope did not select.
//   - `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany` and
//     `connectOrCreate` through a RULE_I relation, on either side (`sessionReview.reviewer`,
//     `user.sessionReviews`): the row on the other side can belong to another org after one rule
//     (i) slip, so `reviewer: { update: { passwordHash } }` would take over another org's user.
//     A parent-side `disconnect` through a RULE_I relation is refused for the same reason.
//   - a nested `create`, `update`, `upsert` or `createMany` of a model with its own org_id that
//     names another org, through `orgId` or `org: { connect }`; a nested create of an organization;
//     and a nested operation this guard does not know (fail closed).
// Nested writes, allowed:
//   - a CHILD-SIDE `connect` or `disconnect` (the key is on this model, `session.invitation`): the
//     same as setting or clearing the scalar foreign key, so it stays under ADR 0006 section 2
//     rule (i), through any relation.
//   - nested `create`, `update`, `upsert` and `delete` through a SCOPE_HOP, COMPOSITE or ORG_ID
//     relation (`test.sections`, `candidate.invitations`, `organization.questions`): the related
//     row is in the parent's own subtree, in the parent's org by construction. They are NOT allowed
//     through a RULE_I relation, where that is not true.
//
// Nested cursors, refused: a `cursor` anywhere inside `include` or `select`, at any depth. It
// covers the fluent API too: `session.findUnique(...).proctorEvents({ cursor })` reaches the
// extension as `findUnique` with `select: { proctorEvents: { cursor } }`. Page nested relations
// with `where` plus `take` and `orderBy` instead: they name no row to rank against.
//
// Schema knowledge comes from org-scope-relations.ts (a table checked against schema.prisma), not
// from Prisma's runtime data model. Only relation fields are visited, so a Json column is never
// entered and a scalar list's `{ set: [...] }` is left alone. A `createMany` of a path model is
// flat and is not walked at all, so ingest paths pay nothing. Messages name models and fields,
// never values.
import { OrgScopeViolationError } from './errors';
import { ORG_SCOPE } from './org-scope-map';
import type { ModelName } from './org-scope-map';
import { relationOf } from './org-scope-relations';
import type { RelationSide } from './org-scope-relations';

type PlainObject = Record<string, unknown>;
type NestedMode = 'create' | 'update';

interface Walk {
  readonly root: string;
  readonly operation: string;
  readonly orgId: string;
}

// Real payloads are a few levels deep. Anything beyond this is refused, not walked.
const MAX_DEPTH = 16;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function refuse(walk: Walk, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(
    `${walk.root}.${walk.operation}: nested write refused: ${what}.`,
  );
}

/**
 * Walks the `data` of a write on `model` for the org `orgId` and throws on a nested write that
 * could change rows outside the org scope. The top-level payload's own orgId is checked by the
 * caller (applyOrgScope); only what is reached through its relations is checked here.
 */
export function assertNestedWritesScoped(
  model: ModelName,
  operation: string,
  data: unknown,
  orgId: string,
): void {
  walkRelations({ root: model, operation, orgId }, model, data, 0);
}

function walkRelations(walk: Walk, model: ModelName, data: unknown, depth: number): void {
  if (!isPlainObject(data)) return;
  for (const key of Object.keys(data)) {
    const side = relationOf(model, key);
    if (side === undefined) continue; // a scalar, a Json column or a scalar list: never entered
    // The org relation of a model with its own org_id is checked with its payload (checkOwnOrg).
    if (side.target === 'Organization' && side.holdsFk) continue;
    walkRelationInput(walk, model, key, side, data[key], depth);
  }
}

function walkRelationInput(
  walk: Walk,
  model: ModelName,
  field: string,
  side: RelationSide,
  input: unknown,
  depth: number,
): void {
  if (depth >= MAX_DEPTH) throw refuse(walk, `${model}.${field} is nested too deeply`);
  if (!isPlainObject(input)) return;
  const ruleI = side.fkClass === 'RULE_I';
  for (const [op, value] of Object.entries(input)) {
    switch (op) {
      case 'connect':
      case 'set':
        if (!side.holdsFk) throw parentSide(walk, model, field, side, op);
        break; // child side: same as setting the scalar foreign key (rule (i))
      case 'disconnect':
        // Child side: clears the scalar foreign key (rule (i)). Parent side: clears the key on
        // related rows, which through a RULE_I relation can belong to another org.
        if (ruleI && !side.holdsFk) throw throughRuleI(walk, model, field, side, op);
        break;
      case 'connectOrCreate':
        if (!side.holdsFk) throw parentSide(walk, model, field, side, op);
        if (ruleI) throw throughRuleI(walk, model, field, side, op);
        for (const item of asList(value)) {
          visitPayload(
            walk,
            side.target,
            isPlainObject(item) ? item.create : undefined,
            'create',
            depth + 1,
          );
        }
        break;
      case 'create':
      case 'createMany':
      case 'update':
      case 'updateMany':
      case 'upsert':
      case 'delete':
      case 'deleteMany':
        if (ruleI) throw throughRuleI(walk, model, field, side, op);
        walkNestedWrite(walk, side, op, value, depth);
        break;
      default:
        throw refuse(walk, `an operation on ${model}.${field} that the guard does not know`);
    }
  }
}

/** The nested write `op` through a relation that is not RULE_I: check the rows it writes. */
function walkNestedWrite(
  walk: Walk,
  side: RelationSide,
  op: string,
  value: unknown,
  depth: number,
): void {
  switch (op) {
    case 'create':
      for (const item of asList(value)) visitPayload(walk, side.target, item, 'create', depth + 1);
      break;
    case 'createMany':
      for (const row of asList(isPlainObject(value) ? value.data : undefined)) {
        visitFlatRow(walk, side.target, row, 'create');
      }
      break;
    case 'update':
      for (const item of asList(value)) {
        const payload = isPlainObject(item) && isPlainObject(item.data) ? item.data : item;
        visitPayload(walk, side.target, payload, 'update', depth + 1);
      }
      break;
    case 'updateMany':
      for (const item of asList(value)) {
        visitFlatRow(walk, side.target, isPlainObject(item) ? item.data : undefined, 'update');
      }
      break;
    case 'upsert':
      for (const item of asList(value)) {
        if (!isPlainObject(item)) continue;
        visitPayload(walk, side.target, item.create, 'create', depth + 1);
        visitPayload(walk, side.target, item.update, 'update', depth + 1);
      }
      break;
    default:
      break; // delete and deleteMany carry no data; they act inside the parent's subtree
  }
}

function throughRuleI(
  walk: Walk,
  model: ModelName,
  field: string,
  side: RelationSide,
  op: string,
): OrgScopeViolationError {
  return refuse(
    walk,
    `${op} through ${model}.${field} reaches ${side.target} rows that can belong to another org ` +
      '(a rule (i) reference). Write them with their own scoped call; only connect and, on the ' +
      'child side, disconnect are allowed through this relation (ADR 0006 section 2, rule (i))',
  );
}

function parentSide(
  walk: Walk,
  model: ModelName,
  field: string,
  side: RelationSide,
  op: string,
): OrgScopeViolationError {
  return refuse(
    walk,
    `${op} on ${model}.${field} would change ${side.target} rows the org scope did not select ` +
      `(the foreign key is on ${side.target}). Load the id through the scoped client and set the ` +
      'foreign key on the child instead (ADR 0006 section 2, rule (i))',
  );
}

/** A nested row (create or update payload) of `model`: its own org, then its relations. */
function visitPayload(
  walk: Walk,
  model: ModelName,
  payload: unknown,
  mode: NestedMode,
  depth: number,
): void {
  if (!isPlainObject(payload)) return;
  checkOwnOrg(walk, model, payload, mode);
  walkRelations(walk, model, payload, depth);
}

/** A nested row of createMany or updateMany: flat, so only its own org is checked. */
function visitFlatRow(walk: Walk, model: ModelName, row: unknown, mode: NestedMode): void {
  if (!isPlainObject(row)) return;
  checkOwnOrg(walk, model, row, mode);
}

/** A nested row of a model with its own org_id must not name another org. */
function checkOwnOrg(walk: Walk, model: ModelName, row: PlainObject, mode: NestedMode): void {
  const rule = ORG_SCOPE[model];
  if (rule.kind === 'self') {
    if (mode === 'create') throw refuse(walk, `${model} would be created (only in system scope)`);
    if (row.id !== undefined) throw refuse(walk, `${model} id would be changed`);
    return;
  }
  if (rule.kind !== 'direct') return;
  const org = row.org;
  if (org !== undefined) {
    if (mode === 'update' || !connectsOwnOrg(org, walk.orgId) || row.orgId !== undefined) {
      throw refuse(walk, `${model} names another org through the org relation`);
    }
  }
  if (row.orgId !== undefined) {
    const value = isPlainObject(row.orgId) ? row.orgId.set : row.orgId;
    if (value !== walk.orgId) throw refuse(walk, `${model} names another org through orgId`);
  }
}

/** `{ connect: { id } }` naming exactly the caller's org. */
function connectsOwnOrg(relation: unknown, orgId: string): boolean {
  if (!isPlainObject(relation) || Object.keys(relation).length !== 1) return false;
  const connect = relation.connect;
  return isPlainObject(connect) && Object.keys(connect).length === 1 && connect.id === orgId;
}

// ---- nested cursors in include and select ----------------------------------------------------

/**
 * Refuses a `cursor` anywhere inside the `include` or `select` of `args`, at any depth. Prisma
 * resolves a nested cursor by its own fields, like a top-level one, so it could rank the caller's
 * rows against another org's row. Covers the fluent API, which arrives as a `select` on the
 * relation. Page nested relations with `where`, `take` and `orderBy` instead.
 */
export function assertNoNestedCursor(model: ModelName, operation: string, args: PlainObject): void {
  walkSelection({ root: model, operation, orgId: '' }, model, args, 0);
}

function walkSelection(walk: Walk, model: ModelName, args: PlainObject, depth: number): void {
  for (const key of ['select', 'include'] as const) {
    const selection = args[key];
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
      if (depth >= MAX_DEPTH) throw refuse(walk, `${model}.${field} is nested too deeply`);
      if (value.cursor !== undefined) throw nestedCursor(walk, model, field);
      walkSelection(walk, side.target, value, depth + 1);
    }
  }
}

function nestedCursor(walk: Walk, model: ModelName, field: string): OrgScopeViolationError {
  return new OrgScopeViolationError(
    `${walk.root}.${walk.operation}: nested cursor refused on ${model}.${field}: Prisma finds a ` +
      "cursor row by its own fields, so it could rank this org's rows against another org's row. " +
      'Page nested relations with where, take and orderBy instead.',
  );
}
