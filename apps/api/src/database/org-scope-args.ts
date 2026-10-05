// The pure part of org scoping: given a model's scope rule, an operation and its arguments, return
// the arguments the query must run with. No database and no context here, so every operation can be
// unit tested. The Prisma extension (org-scope.extension.ts) wraps this with the context lookup.
import type { Prisma } from '../generated/prisma/client.js';
import { OrgScopeViolationError } from './errors';
import { assertNoNestedCursor, assertNoNestedWritesIn } from './org-scope-nested';
import { orgFilter } from './org-scope-map';
import type { ModelName, OrgScopeRule } from './org-scope-map';

type PlainObject = Record<string, unknown>;

/**
 * Every operation a Prisma model delegate offers on PostgreSQL. The extension rejects any other
 * operation, so one added by a future Prisma version cannot slip past the filter.
 */
export const SCOPED_OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
] as const;

export type ScopedOperation = (typeof SCOPED_OPERATIONS)[number];

type PrismaOperation = {
  [M in ModelName]: keyof Prisma.TypeMap['model'][M]['operations'];
}[ModelName];

/**
 * Compile-time check: it resolves to `true` only while SCOPED_OPERATIONS lists every operation of
 * the generated client. When Prisma adds one, `pnpm typecheck` fails here until it is handled.
 */
export type OperationCoverage = [Exclude<PrismaOperation, ScopedOperation>] extends [never]
  ? true
  : never;
export const OPERATION_COVERAGE: OperationCoverage = true;

export function isScopedOperation(operation: string): operation is ScopedOperation {
  return (SCOPED_OPERATIONS as readonly string[]).includes(operation);
}

export interface OrgScopeInput {
  readonly model: ModelName;
  readonly rule: OrgScopeRule;
  readonly operation: string;
  readonly args: unknown;
  readonly orgId: string;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArgs(model: string, operation: string, args: unknown): PlainObject {
  if (args === undefined || args === null) return {};
  if (!isPlainObject(args)) {
    throw new OrgScopeViolationError(
      `${model}.${operation} was called with arguments that are not an object.`,
    );
  }
  return args;
}

/** where AND filter. An existing AND (single or list) is kept, so the caller's filter still applies. */
function andWhere(
  model: string,
  operation: string,
  where: unknown,
  filter: PlainObject,
): PlainObject {
  if (where === undefined || where === null) return filter;
  if (!isPlainObject(where)) {
    throw new OrgScopeViolationError(
      `${model}.${operation} was called with a where that is not an object.`,
    );
  }
  const existing = where.AND;
  const kept: unknown[] =
    existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return { ...where, AND: [...kept, filter] };
}

function violation(model: string, operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(`${model}.${operation}: ${what}`);
}

/** The org relation (`org: { connect }`) is a nested relation write: refused with the others. */
function orgRelation(model: string, operation: string): OrgScopeViolationError {
  return violation(
    model,
    operation,
    'the org relation cannot be written; set the scalar orgId, or let the scope stamp it.',
  );
}

/** Create payload of a model with its own org_id: the org is added when missing and must match. */
function stampCreateData(
  model: string,
  operation: string,
  rule: OrgScopeRule,
  data: unknown,
  orgId: string,
): unknown {
  if (rule.kind === 'self') {
    throw violation(
      model,
      operation,
      'organizations are created or replaced only in system scope (OrgContextService.runSystem).',
    );
  }
  if (rule.kind !== 'direct') return data; // path: no org_id column to stamp (ADR 0006 section 2)
  if (!isPlainObject(data)) return data; // Prisma reports the malformed payload itself
  if (data.org !== undefined) throw orgRelation(model, operation); // refused earlier; fail closed
  if (data.orgId === undefined) return { ...data, orgId };
  if (data.orgId !== orgId) {
    throw violation(model, operation, "orgId in the data is not the caller's org.");
  }
  return data;
}

/** Update payload: a row cannot be moved to another org, and an organization keeps its id. */
function assertTenancyKept(
  model: string,
  operation: string,
  rule: OrgScopeRule,
  data: unknown,
  orgId: string,
): void {
  if (!isPlainObject(data)) return;
  if (rule.kind === 'self' && data.id !== undefined) {
    throw violation(model, operation, "an organization's id cannot be changed.");
  }
  if (rule.kind !== 'direct') return;
  if (data.org !== undefined) throw orgRelation(model, operation); // refused earlier; fail closed
  if (data.orgId === undefined) return;
  const value = isPlainObject(data.orgId) ? data.orgId.set : data.orgId;
  if (value !== orgId) {
    throw violation(model, operation, 'orgId cannot be changed to another org.');
  }
}

/**
 * System scope: no org filter, but writes still may not move a row to another org. After nested
 * relation writes are denied, a scalar `orgId` in an update is the only way left to do that, and
 * Postgres catches it only on the composite-key tables. So on a model with its own org_id, any
 * `orgId` key in the payload of `update`, `updateMany`, `updateManyAndReturn` or the update branch
 * of `upsert` is refused, whatever its value and in any form (`{ set }` too), and an Organization
 * keeps its id. A `create` may set `orgId` here: creates in system scope are review-only (ADR 0006).
 * Sends no query; the message carries no value.
 */
function assertNoOrgMove(
  model: string,
  operation: string,
  rule: OrgScopeRule,
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  if (rule.kind === 'self' && data.id !== undefined) {
    throw violation(model, operation, "an organization's id cannot be changed.");
  }
  if (rule.kind === 'direct' && data.orgId !== undefined) {
    throw violation(
      model,
      operation,
      'orgId cannot be written by an update, in system scope or any other (a row is never moved to another org).',
    );
  }
}

/**
 * The checks that apply in system scope, where nothing is filtered: no nested relation write
 * (ADR 0006 section 8), and no `orgId` in an update. Org scope has the same two checks inside
 * applyOrgScope, with the filter and stamping on top.
 */
export function assertSystemScopeWrite(
  model: ModelName,
  rule: OrgScopeRule,
  operation: string,
  args: unknown,
): void {
  assertNoNestedWritesIn(model, operation, args);
  if (!isPlainObject(args)) return;
  switch (operation) {
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      assertNoOrgMove(model, operation, rule, args.data);
      break;
    case 'upsert':
      assertNoOrgMove(model, operation, rule, args.update);
      break;
    default:
      break; // creates may set orgId in system scope; reads and deletes carry no data
  }
}

/**
 * A cursor, scoped. Prisma finds the cursor row with the cursor's own fields only: the query's
 * `where` is not applied to that lookup, so in org A's scope `cursor: { id: <B's id> }` would rank
 * A's rows against B's row (leaking its values and whether the id exists). So:
 *
 * - `direct`: the caller's org is added to the cursor (`{ id, orgId }` is a valid cursor and the
 *   lookup then includes `org_id`), and a cursor that names another org is refused.
 * - `self` (Organization): the cursor must be the caller's own organization.
 * - `path`: refused. A cursor takes no relation filter and no AND, so there is no way to scope
 *   it. Page with `where` plus `orderBy` (for example `where: { id: { gt: lastId } }`), which the
 *   scope does filter.
 */
function scopeCursor(
  model: string,
  operation: string,
  rule: OrgScopeRule,
  cursor: unknown,
  orgId: string,
): unknown {
  if (cursor === undefined || cursor === null) return cursor;
  if (!isPlainObject(cursor)) {
    throw violation(model, operation, 'cursor is not an object.');
  }
  switch (rule.kind) {
    case 'direct':
      if (namesOtherOrg(cursor, orgId)) {
        throw violation(model, operation, "the cursor names another org's row.");
      }
      return { ...cursor, orgId };
    case 'self':
      if (cursor.id !== orgId) {
        throw violation(model, operation, "the cursor is not the caller's own organization.");
      }
      return cursor;
    case 'path':
      throw violation(
        model,
        operation,
        'a cursor cannot be scoped on a model without org_id (Prisma finds the cursor row by its ' +
          "own fields, so a cursor on another org's row would rank this org's rows against it). " +
          'Page with where plus orderBy instead, for example where: { id: { gt: lastId } }.',
      );
    case 'unscoped':
      return cursor;
  }
}

/** True when the cursor, or a compound key inside it, has an orgId that is not `orgId`. */
function namesOtherOrg(cursor: PlainObject, orgId: string): boolean {
  return Object.entries(cursor).some(([key, value]) =>
    key === 'orgId' ? value !== orgId : isPlainObject(value) && namesOtherOrg(value, orgId),
  );
}

/**
 * Arguments for a query on a scoped model, for the org `orgId`.
 *
 * - Reads, updates, deletes, counts, aggregates and group-bys get the org filter ANDed into
 *   `where`, so a row of another org is simply not found.
 * - A `cursor` (findMany, findFirst, findFirstOrThrow, count, aggregate) is scoped too, or refused
 *   on a model without org_id; see scopeCursor.
 * - Creates on a model with its own org_id get that org added, or are refused when they name
 *   another org. Creates on a path-scoped model are passed through: there is no org_id column to
 *   stamp, so the parent id in the payload must follow ADR 0006 section 2 rule (i).
 * - An unknown operation is refused.
 *
 * Nested relation writes are refused (org-scope-nested.ts, ADR 0006 section 8): every nested
 * `connect`, `connectOrCreate`, `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`,
 * `deleteMany`, `set` and `disconnect` in `data`, through every relation class and on both sides,
 * `org: { connect }` included. A `connect` through a COMPOSITE relation rewrites org_id and one next
 * to an `update` writes the connected row, so no shape is safe by class; services use scalar
 * foreign keys (Prisma's unchecked inputs) and separate top-level calls. The exception list is empty.
 * A `cursor` nested in include or select is refused too (the fluent API arrives as a select).
 *
 * What it does NOT cover (README "Limits"). Only the top-level model, its `where`, its `cursor`,
 * its create/update `orgId`, nested relation writes and nested cursors are looked at. Everything
 * else reached through a relation is not:
 *
 * (a) Ids written as scalar foreign keys. Which id is written is not checked: Postgres checks the
 *     composite keys, and every other id follows rule (i), load it through the scoped client first.
 * (b) Re-parenting. An update that changes a path model's first-hop foreign key
 *     (`testSection.update({ data: { testId } })`) is the same as a path create: rule (i).
 * (c) Nested reads. `include`, `select`, the fluent API, relation filters, `orderBy` on a relation
 *     and `_count` follow foreign keys blindly and are not filtered. Any foreign key that crosses
 *     orgs leaks: `sessionReview.findUnique({ include: { reviewer: true } })` returns the reviewer
 *     user row of another org, password hash included, if reviewer_id points there.
 * (d) The foreign keys that rule (i) has to cover are many more than the staff references
 *     (`created_by`, `reviewer_id`, `assigned_to`, `collected_by`) and
 *     `test_questions.question_version_id`: RULE_I_REFERENCES (org-scope-relations.ts) lists the
 *     25 (12 staff, 13 cross-chain), among them the cross-chain ones
 *     (session_questions to test_questions, question_versions and variants; session_sections to
 *     test_sections; consents to consent_texts; keystroke_batches to session_questions).
 * (e) The raw SQL hatch (OrgContextService.runRawSql) stays open inside a scope started within
 *     it; see its JSDoc.
 */
export function applyOrgScope(input: OrgScopeInput): PlainObject {
  const { model, rule, operation, orgId } = input;
  const filter = orgFilter(rule, orgId);
  if (filter === undefined) {
    throw violation(
      model,
      operation,
      'unscoped models are not filtered; the caller must skip them.',
    );
  }
  if (!isScopedOperation(operation)) {
    throw violation(
      model,
      operation,
      'unknown operation. Add it to SCOPED_OPERATIONS and handle it.',
    );
  }
  const args = asArgs(model, operation, input.args);
  // Deny by default: no nested relation write, in any shape (ADR 0006 section 8).
  assertNoNestedWritesIn(model, operation, args);
  const rewritten = rewriteArgs(model, rule, operation, args, filter, orgId);
  // A cursor nested in include or select is resolved by its own fields too (any operation).
  assertNoNestedCursor(model, operation, args);
  // A cursor never goes through unscoped, whichever operation carries it.
  return args.cursor === undefined
    ? rewritten
    : { ...rewritten, cursor: scopeCursor(model, operation, rule, args.cursor, orgId) };
}

function rewriteArgs(
  model: ModelName,
  rule: OrgScopeRule,
  operation: ScopedOperation,
  args: PlainObject,
  filter: PlainObject,
  orgId: string,
): PlainObject {
  switch (operation) {
    case 'findUnique':
    case 'findUniqueOrThrow':
    case 'findFirst':
    case 'findFirstOrThrow':
    case 'findMany':
    case 'count':
    case 'aggregate':
    case 'groupBy':
    case 'delete':
    case 'deleteMany':
      return { ...args, where: andWhere(model, operation, args.where, filter) };

    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      assertTenancyKept(model, operation, rule, args.data, orgId);
      return { ...args, where: andWhere(model, operation, args.where, filter) };

    case 'create':
      return { ...args, data: stampCreateData(model, operation, rule, args.data, orgId) };

    case 'createMany':
    case 'createManyAndReturn': {
      const { data } = args;
      const stamped = Array.isArray(data)
        ? data.map((row: unknown) => stampCreateData(model, operation, rule, row, orgId))
        : stampCreateData(model, operation, rule, data, orgId);
      return { ...args, data: stamped };
    }

    case 'upsert':
      assertTenancyKept(model, operation, rule, args.update, orgId);
      return {
        ...args,
        where: andWhere(model, operation, args.where, filter),
        create: stampCreateData(model, operation, rule, args.create, orgId),
      };
  }
}
