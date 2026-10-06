// Runtime immutability for the scope tables (ADR 0013 CS-4, #126 round 3, nit 3). `as const` and
// `readonly` are compile-time only: any code that holds a reference to `CANDIDATE_MODELS` or the deny
// list could `push` a column into it and widen what a candidate may write or read, for the whole
// process. The tables are frozen, deeply, when the module loads, so a write to one throws a TypeError
// (every module is strict) and the tests can assert it.
//
// Functions and regular expressions are left as they are: a function has no state to widen (the
// session filters), and freezing a RegExp is pointless (a non-global pattern has no mutable state).

/** Freezes `value` and everything reachable through its own properties. Returns `value`. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof RegExp || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}
