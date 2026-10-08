// `omit` takes only `true`, in every scope (CLAUDE.md rule 3; ADR 0013 CS-4.4, the relation vectors).
//
// The Prisma 7 client turns an `omit` entry whose value is not `true` into a SELECTION of that key: its omit
// handling writes `selection[key] = !value` for every entry, and it does not check that the key is a scalar
// column. So `omit: { questionVersion: false }` on SessionQuestion selects the related QuestionVersion row
// (`referenceSolution` and `answerSpec` included), and `omit: { _count: false }` (or `null`, `0`, `''`) selects
// `_count` of every list relation. Shown against Postgres through the real client, in a CANDIDATE scope, where it
// bypasses the CS-4.4 relation refusal (which reads `include` and `select` only). Hidden scalar columns stayed
// hidden there, because the candidate's default omit wins on the merge, but a relation or `_count` is not in it.
//
// So the hook refuses, for EVERY scope (candidate, session job, staff, org job and system) and before any
// statement, any `omit` in the selection tree of a call whose entry is not exactly `true`, and any `_count`
// entry in an `omit`. The selection tree is the top-level `omit`, and the `omit` of every nested args object
// under `include` and `select`, at any depth (a relation's args, `_count`'s args). It runs for every operation:
// reads, and creates, updates, upserts and deletes, which return a selection too. Nothing in the application
// writes an `omit` value other than `true`; `omit: { column: true }` is unchanged.
import { OrgScopeViolationError } from './errors';

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Nested include and select levels walked; deeper selection trees are refused, never passed. */
const MAX_SELECTION_DEPTH = 64;

function refuse(model: string, operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(`${model}.${operation}: ${what} (ADR 0013 CS-4.4).`);
}

function checkSelection(model: string, operation: string, args: unknown, depth: number): void {
  if (!isPlainObject(args)) return;
  if (depth > MAX_SELECTION_DEPTH) {
    throw refuse(model, operation, 'the selection is nested too deep to check its omit entries');
  }
  const omit = Object.hasOwn(args, 'omit') ? args.omit : undefined;
  if (omit !== undefined && omit !== null) {
    if (!isPlainObject(omit)) throw refuse(model, operation, 'omit must be an object');
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
          `omit.${key} must be true: any other value selects it, a relation or _count included`,
        );
      }
    }
  }
  for (const key of ['include', 'select']) {
    const selection = Object.hasOwn(args, key) ? args[key] : undefined;
    if (!isPlainObject(selection)) continue;
    for (const nested of Object.values(selection)) {
      if (isPlainObject(nested)) checkSelection(model, operation, nested, depth + 1);
    }
  }
}

/**
 * Called by the extension for every model query, in every scope, right after the plain-args check and before any
 * other: refuses an `omit` entry that is not exactly `true`, or names `_count`, anywhere in the selection tree.
 */
export function assertOmitValues(model: string, operation: string, args: unknown): void {
  checkSelection(model, operation, args, 0);
}
