// The nested-write guard (FU-DB-63). In an org scope, a nested write in `data` can reach rows the
// scope filter never selected: `organization.update({ where: { id: A }, data: { users: { connect:
// { id: userOfB } } } })` filters Organization by A and then moves B's user into A. This walks
// `data` and refuses what can do that. It sends no query: it only reads the arguments.
//
// Refused, at any depth:
//   - `connect`, `connectOrCreate` and `set` on a PARENT-SIDE relation, where the foreign key is
//     held by the related model (`organization.users`, `session.consent`). They change rows of the
//     related model that the scope did not select.
//   - a nested `create`, `update`, `upsert` or `createMany` of a model with its own org_id that
//     names another org, through `orgId` or `org: { connect }`; a nested create of an organization;
//     and a nested operation this guard does not know (fail closed).
// Allowed:
//   - a CHILD-SIDE `connect` (the key is on this model, `session.invitation`): the same as setting
//     the scalar foreign key, so it stays under ADR 0006 section 2 rule (i).
//   - nested `create`, `update`, `delete`, `upsert` under an in-scope parent: they act inside that
//     parent's subtree.
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
  for (const [op, value] of Object.entries(input)) {
    switch (op) {
      case 'connect':
      case 'set':
        if (!side.holdsFk) throw parentSide(walk, model, field, side, op);
        break; // child side: same as setting the scalar foreign key (rule (i))
      case 'connectOrCreate':
        if (!side.holdsFk) throw parentSide(walk, model, field, side, op);
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
        for (const item of asList(value))
          visitPayload(walk, side.target, item, 'create', depth + 1);
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
      case 'delete':
      case 'deleteMany':
      case 'disconnect':
        break; // they act inside the parent's subtree and carry no data
      default:
        throw refuse(walk, `an operation on ${model}.${field} that the guard does not know`);
    }
  }
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
