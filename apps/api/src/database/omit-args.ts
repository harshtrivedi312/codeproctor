// `omit` takes only `true`, in every scope (CLAUDE.md rule 3; ADR 0013 CS-4.5 and ADR 0006 section 8.4, the
// relation vectors).
//
// The Prisma 7 client turns an `omit` entry whose value is not `true` into a SELECTION of that key: its omit
// handling writes `selection[key] = !value` for every entry, and it does not check that the key is a scalar
// column. So `omit: { questionVersion: false }` on SessionQuestion selects the related QuestionVersion row, and
// `omit: { _count: false }` (or `null`, `0`, `''`) selects `_count` of every list relation, past the relation
// refusals, which read `include` and `select` (FU-DB-280).
//
// So the hook refuses, for EVERY scope (candidate, session job, staff, org job and system) and before any
// statement, any `omit` in the selection tree of a call whose entry is not exactly `true`, and any `_count`
// entry in an `omit`. The selection tree is the top-level `omit`, and the `omit` of every nested args object
// under `include` and `select`, at any depth (a relation's args, `_count`'s args). It runs for every operation:
// reads, and creates, updates, upserts and deletes, which return a selection too. A nested args object, and an
// `omit`, must be plain objects (B1 of the #314 review): an object built in code on another prototype (a field
// reference's, say) would carry `include`, `select` or `omit` that Prisma reads through the prototype chain and
// an own-key walk does not see. `omit: { column: true }` is unchanged.
import { OrgScopeViolationError } from './errors';
import { isPlainPrototype } from './plain-args';

type PlainObject = Record<string, unknown>;

const isObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasPlainPrototype = (value: object): boolean =>
  isPlainPrototype(Object.getPrototypeOf(value));

/** Nested include and select levels walked; deeper selection trees are refused, never passed. */
const MAX_SELECTION_DEPTH = 64;
/** A key longer than this is not echoed into the message (N2 of the #314 review: no unbounded log line). */
const MAX_ECHOED_KEY_LENGTH = 64;

function refuse(model: string, operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(`${model}.${operation}: ${what} (ADR 0013 CS-4.5).`);
}

const named = (key: string): string =>
  key.length <= MAX_ECHOED_KEY_LENGTH ? `omit.${key}` : 'an omit entry';

function checkSelection(model: string, operation: string, args: unknown, depth: number): void {
  if (!isObject(args)) return;
  if (depth > MAX_SELECTION_DEPTH) {
    throw refuse(model, operation, 'the selection is nested too deep to check its omit entries');
  }
  if (depth > 0 && !hasPlainPrototype(args)) {
    throw refuse(
      model,
      operation,
      'the args of a relation in include or select must be a plain object',
    );
  }
  const omit = Object.hasOwn(args, 'omit') ? args.omit : undefined;
  if (omit !== undefined && omit !== null) {
    if (!isObject(omit) || !hasPlainPrototype(omit)) {
      throw refuse(model, operation, 'omit must be a plain object');
    }
    for (const [key, value] of Object.entries(omit)) {
      if (key === '_count') {
        throw refuse(
          model,
          operation,
          'omit may not name _count (it selects every relation count)',
        );
      }
      if (value !== true) {
        throw refuse(
          model,
          operation,
          `${named(key)} must be true: any other value selects it, a relation or _count included`,
        );
      }
    }
  }
  for (const key of ['include', 'select']) {
    const selection = Object.hasOwn(args, key) ? args[key] : undefined;
    if (!isObject(selection)) continue;
    for (const nested of Object.values(selection)) {
      if (typeof nested === 'object' && nested !== null) {
        checkSelection(model, operation, nested, depth + 1);
      }
    }
  }
}

/**
 * Called by the extension for every model query, in every scope, right after the plain-args check and before any
 * other: refuses an `omit` entry that is not exactly `true`, or names `_count`, anywhere in the selection tree, and a
 * nested args object or `omit` that is not a plain object.
 */
export function assertOmitValues(model: string, operation: string, args: unknown): void {
  checkSelection(model, operation, args, 0);
}
