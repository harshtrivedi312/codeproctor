// Runtime immutability for the scope tables (ADR 0013 CS-4, #126 round 3, nit 3). `as const` and
// `readonly` are compile-time only: any code that holds a reference to `CANDIDATE_MODELS` or the deny
// list could `push` a column into it and widen what a candidate may write or read, for the whole
// process. The tables are frozen, deeply, when the module loads, so a write to one throws a TypeError
// (every module is strict) and the tests can assert it.
//
// Functions are left as they are: a function has no state to widen (the session filters, the object-key
// checks). A RegExp is refused: freezing one does not stop `RegExp.prototype.compile` from rewriting its
// pattern (the internal slots change before the `lastIndex` write throws), so a table must not hold one.
// Keep the pattern private to its module and put a predicate function in the table (#126 round 4).

/** Freezes `value` and everything reachable through its own properties. Returns `value`. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof RegExp) {
    throw new TypeError(
      'deepFreeze: a RegExp cannot be frozen (RegExp.prototype.compile rewrites it); ' +
        'keep the pattern private and put a predicate in the table.',
    );
  }
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}
