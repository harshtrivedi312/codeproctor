// The pure part of org scoping: given a model's scope rule, an operation and its arguments, return
// the arguments the query must run with. No database and no context here, so every operation can be
// unit tested. The Prisma extension (org-scope.extension.ts) wraps this with the context lookup.
import type { Prisma } from '../generated/prisma/client.js';
import { OrgScopeViolationError } from './errors';
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

/** `{ connect: { id } }` naming exactly the caller's org, the only relation form a create may use. */
function connectsOrg(relation: unknown, orgId: string): boolean {
  if (!isPlainObject(relation) || Object.keys(relation).length !== 1) return false;
  const connect = relation.connect;
  return isPlainObject(connect) && Object.keys(connect).length === 1 && connect.id === orgId;
}

function violation(model: string, operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(`${model}.${operation}: ${what}`);
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
  if (data.org !== undefined) {
    if (!connectsOrg(data.org, orgId) || data.orgId !== undefined) {
      throw violation(model, operation, "the org relation may only connect the caller's own org.");
    }
    return data;
  }
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
  if (data.org !== undefined) {
    throw violation(model, operation, 'the org relation cannot be changed by an update.');
  }
  if (data.orgId === undefined) return;
  const value = isPlainObject(data.orgId) ? data.orgId.set : data.orgId;
  if (value !== orgId) {
    throw violation(model, operation, 'orgId cannot be changed to another org.');
  }
}

/**
 * Arguments for a query on a scoped model, for the org `orgId`.
 *
 * - Reads, updates, deletes, counts, aggregates and group-bys get the org filter ANDed into
 *   `where`, so a row of another org is simply not found.
 * - Creates on a model with its own org_id get that org added, or are refused when they name
 *   another org. Creates on a path-scoped model are passed through: there is no org_id column to
 *   stamp, and the parent id in the payload must have been loaded through the scoped client first
 *   (ADR 0006 section 2, rule (i)).
 * - An unknown operation is refused.
 *
 * Nested writes (`create`, `connect` inside `data`) are not inspected; see the README.
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
