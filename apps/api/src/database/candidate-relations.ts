// CS-4.5 (ADR 0013): in a CANDIDATE scope the relation vectors are refused. A Prisma query extension
// sees only the top-level model, so a relation reached through `include`, `select`, `where`,
// `orderBy` or `_count` follows foreign keys without the org or session filter: from the candidate's
// own session an `include` would reach every other candidate of the org, the question versions and
// their hidden test cases. Instead of walking every depth, the vectors are refused:
//
//   1  a relation field in `include`
//   2  a relation field in `select`
//   3  a relation filter in `where` (`some`, `every`, `none`, `is`, `isNot`, or a plain relation
//      object), at any depth of AND, OR and NOT
//   4  a relation field in `orderBy`
//   5  a relation `_count`, in `select` or `include`
//   6  the fluent API (`findUnique(...).questionVersion()`): NOT here. ADR 0013 CS-4 PR 3.
//
// Only the filters the extension injects itself (CS-4.2 and CS-4.3: `sessionQuestion: { sessionId }`,
// `sessionSections: { some: ... }`, the org path) may use relations. The caller's arguments are
// checked here BEFORE those are added, so they never trip this check. Nested relation WRITES are
// refused for every scope by org-scope-nested.ts (ADR 0006 section 8.2), not here.
//
// A relation is any field in the relation table of org-scope-relations.ts (both sides of all 58
// foreign keys, checked against schema.prisma), whatever its value: `false`, `null` and `{}` are
// refused too. Messages name the model, the field and the vector, never a value.
import { OrgScopeViolationError } from './errors';
import type { ModelName } from './org-scope-map';
import { relationOf } from './org-scope-relations';

type PlainObject = Record<string, unknown>;

// A where nests AND, OR and NOT. Real ones are a few levels deep; anything beyond this is refused.
const MAX_DEPTH = 32;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(model: string, operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(
    `${model}.${operation}: ${what} is refused in a CANDIDATE scope (ADR 0013 CS-4.5). ` +
      'Load each model with its own scoped call.',
  );
}

/** Vectors 1, 2 and 5: `include` and `select`. Any relation field, and any `_count`. */
function assertSelection(
  model: ModelName,
  operation: string,
  where: 'include' | 'select',
  selection: unknown,
): void {
  if (!isPlainObject(selection)) return;
  const vector = where === 'include' ? 1 : 2;
  for (const [field, value] of Object.entries(selection)) {
    if (value === undefined) continue;
    if (field === '_count') {
      throw refuse(model, operation, `a relation _count in ${where} (vector 5)`);
    }
    if (relationOf(model, field) !== undefined) {
      throw refuse(
        model,
        operation,
        `the relation ${model}.${field} in ${where} (vector ${vector})`,
      );
    }
  }
}

/** Vector 3: a relation filter anywhere in a `where` (or `having`), through AND, OR and NOT. */
function assertWhere(model: ModelName, operation: string, where: unknown, depth: number): void {
  if (Array.isArray(where)) {
    for (const item of where) assertWhere(model, operation, item, depth);
    return;
  }
  if (!isPlainObject(where)) return;
  if (depth > MAX_DEPTH) {
    throw refuse(model, operation, `a where nested more than ${MAX_DEPTH} levels deep`);
  }
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      assertWhere(model, operation, value, depth + 1);
      continue;
    }
    if (relationOf(model, key) !== undefined) {
      throw refuse(model, operation, `the relation filter ${model}.${key} in where (vector 3)`);
    }
  }
}

/** Vector 4: a relation field in `orderBy` (one object, or a list of them). */
function assertOrderBy(model: ModelName, operation: string, orderBy: unknown): void {
  if (Array.isArray(orderBy)) {
    for (const item of orderBy) assertOrderBy(model, operation, item);
    return;
  }
  if (!isPlainObject(orderBy)) return;
  for (const [field, value] of Object.entries(orderBy)) {
    if (value === undefined) continue;
    if (relationOf(model, field) !== undefined) {
      throw refuse(model, operation, `the relation ${model}.${field} in orderBy (vector 4)`);
    }
  }
}

/**
 * Throws when the caller's arguments use a relation (vectors 1 to 5). Pure: it reads the arguments
 * and sends no query. Call it on the caller's arguments, before the extension adds its own filters.
 * The arguments walked: `include`, `select`, `where`, `having`, `orderBy`. A relation inside `include`
 * or `select` is refused at the first level, so nothing deeper can be reached through them.
 */
export function assertNoRelationVectors(model: ModelName, operation: string, args: unknown): void {
  if (!isPlainObject(args)) return;
  assertSelection(model, operation, 'include', args.include);
  assertSelection(model, operation, 'select', args.select);
  assertWhere(model, operation, args.where, 0);
  assertWhere(model, operation, args.having, 0);
  assertOrderBy(model, operation, args.orderBy);
}
