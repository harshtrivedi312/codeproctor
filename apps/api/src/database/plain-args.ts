// Arguments must be plain, in every scope (review of #185, B1; CLAUDE.md rule 3).
//
// The scope checks read the caller's arguments with own-key walks (`Object.keys`, `Object.entries`, a
// property read of `args.select`), and then forward a COPY (`{ ...args, where }`), which carries own keys
// only. Prisma reads more than own keys:
//
//   - Its top-level clone assigns each key with plain assignment, so a key named `__proto__` that
//     `JSON.parse` made an OWN property (`{"__proto__":{"select":{"id":true}}}`) becomes the PROTOTYPE of
//     the args the extension receives. A check that reads `args.select` then sees the `select` on the
//     prototype, decides the call names its select and adds no `omit`, the forwarded copy has lost the
//     `select` (a spread copies own keys only), and Prisma returns every column: the sealed key,
//     `accommodations`, the hidden-test results, `score` and the columns of a consent record.
//   - Prisma honours INHERITED enumerable keys in nested objects: `data: Object.create({ status: 'PAUSED' })`
//     writes `status`, and `where: Object.create({ id })` filters by `id`. An own-key check sees neither,
//     so a column outside the write allowlist, or a filter on a hidden column, passes unseen.
//
// So the hook refuses, for EVERY scope (staff, org, session, system) and before any other check:
//   1. top-level args whose prototype is not Object.prototype or null, or that carry an own `__proto__` key;
//   2. nested structure objects (`where`, `select`, `orderBy`, `having`, `cursor`, `omit`, `include` and the
//      aggregates, walked fully) that have the same fault, or an enumerable key inherited from anywhere;
//   3. the row of `data`, `create` and `update` (and each row of a `createMany`) and ONE level below it (a
//      `{ set }` or `{ increment }` object, a JSON value): an own `__proto__` key or an inherited enumerable
//      key. Json column contents are not walked, so an ingest path pays O(columns) and not O(payload).
// A class instance with no enumerable inherited key (a DTO) passes in `data`; it never passes as a top-level
// args object or as a structure object. Dates, byte arrays, Decimals, the Json null sentinels and field
// references are values, not structure, and are skipped.
//
// The checks that read `select`, `omit`, `where`, `data` and the rest also read through ownValue(), so a key
// that is not the caller's own is never seen (defence in depth against a polluted Object.prototype).
import { Prisma } from '../generated/prisma/client.js';
import { OrgScopeViolationError } from './errors';

type PlainObject = Record<string, unknown>;

/** The deepest structure object (where, orderBy, ...) the walk follows; beyond it the call is refused. */
export const MAX_STRUCTURE_DEPTH = 64;

/**
 * The value of `key` when `object` OWNS it, else undefined: an inherited key is never read. Use it wherever a
 * check reads a key of the caller's arguments.
 */
export function ownValue(object: unknown, key: string): unknown {
  return typeof object === 'object' && object !== null && Object.hasOwn(object, key)
    ? (object as PlainObject)[key]
    : undefined;
}

/**
 * The caller's own enumerable keys, copied into an object with no prototype: every later read of `args.select`,
 * `args.where`, `args.data` and the rest is a read of a key the caller owns, whatever is on any prototype.
 * The pure scope functions call it once at their entry; what they forward is built with a spread (a normal
 * object), never this copy.
 */
export function ownArgs(args: PlainObject): PlainObject {
  return Object.assign(Object.create(null) as PlainObject, args);
}

/**
 * Object.prototype or null, from this realm or another (a vm context, as in Jest): a prototype with no
 * parent that owns the `Object` constructor and `isPrototypeOf`. A prototype that `JSON.parse` could build
 * (a plain object, whose parent is Object.prototype) never passes.
 */
export function isPlainPrototype(proto: unknown): boolean {
  if (proto === null || proto === Object.prototype) return true;
  if (typeof proto !== 'object') return false;
  const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value as unknown;
  return (
    Object.getPrototypeOf(proto) === null &&
    typeof ctor === 'function' &&
    ctor.name === 'Object' &&
    Object.hasOwn(proto, 'isPrototypeOf')
  );
}

/**
 * A Prisma field reference (`client.model.fields.column`), as the runtime builds it: an object with the own
 * properties `modelName`, `name`, `typeName`, `isList` and `isEnum`, and a `_toGraphQLInputType` method.
 * Either mark is enough, so a look-alike that carries the four properties is refused too (fail closed).
 * A column name is never a field reference: it is a key, and its value is a filter or a scalar.
 */
export function isFieldRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v._toGraphQLInputType === 'function' ||
    (typeof v.modelName === 'string' &&
      typeof v.name === 'string' &&
      typeof v.typeName === 'string' &&
      typeof v.isList === 'boolean')
  );
}

/** A value Prisma takes as it is, not a structure to walk. */
function isValueObject(value: object): boolean {
  return (
    Object.prototype.toString.call(value) === '[object Date]' ||
    ArrayBuffer.isView(value) ||
    Prisma.Decimal.isDecimal(value) ||
    value === Prisma.DbNull ||
    value === Prisma.JsonNull ||
    value === Prisma.AnyNull ||
    isFieldRef(value)
  );
}

/** True when `object` has an enumerable key that it does not own (a for...in finds it, so Prisma does). */
function hasInheritedKey(object: object): boolean {
  for (const key in object) {
    if (!Object.hasOwn(object, key)) return true;
  }
  return false;
}

function refusal(model: string, operation: string, place: string, what: string) {
  return new OrgScopeViolationError(
    `${model}.${operation}: ${what} in ${place} is refused: query arguments must be plain objects ` +
      '(Prisma reads inherited keys that the scope checks do not see; ADR 0013 CS-4.4, #185 B1).',
  );
}

/**
 * One object of the arguments. `strict`: the prototype must be Object.prototype or null (the args, and the
 * structure objects). Otherwise only the keys count: no own `__proto__`, no inherited enumerable key.
 */
function checkObject(
  model: string,
  operation: string,
  object: object,
  place: string,
  strict: boolean,
): void {
  if (Object.hasOwn(object, '__proto__')) {
    throw refusal(model, operation, place, 'an own "__proto__" key');
  }
  if (strict && !isPlainPrototype(Object.getPrototypeOf(object))) {
    throw refusal(
      model,
      operation,
      place,
      'an object with a prototype other than Object.prototype',
    );
  }
  if (hasInheritedKey(object)) throw refusal(model, operation, place, 'an inherited key');
}

/** A structure object (a where, a select, an orderBy, ...) and everything under it. */
function walkStructure(
  model: string,
  operation: string,
  value: unknown,
  place: string,
  depth: number,
): void {
  if (typeof value !== 'object' || value === null || isValueObject(value)) return;
  if (depth > MAX_STRUCTURE_DEPTH) {
    throw refusal(
      model,
      operation,
      place,
      `a structure nested more than ${MAX_STRUCTURE_DEPTH} levels`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStructure(model, operation, item, place, depth + 1);
    return;
  }
  checkObject(model, operation, value, place, true);
  for (const inner of Object.values(value))
    walkStructure(model, operation, inner, place, depth + 1);
}

/** The row(s) of a write and one level below each column. JSON contents are not walked. */
function walkData(model: string, operation: string, value: unknown, place: string): void {
  if (Array.isArray(value)) {
    for (const row of value) walkData(model, operation, row, place);
    return;
  }
  if (typeof value !== 'object' || value === null || isValueObject(value)) return;
  checkObject(model, operation, value, place, false);
  for (const inner of Object.values(value) as unknown[]) {
    if (
      typeof inner === 'object' &&
      inner !== null &&
      !Array.isArray(inner) &&
      !isValueObject(inner)
    ) {
      checkObject(model, operation, inner, `${place} (a column value)`, false);
    }
  }
}

const WRITE_KEYS = ['data', 'create', 'update'] as const;

/**
 * Refuses arguments whose structure Prisma and the scope checks would read differently (see the header).
 * Pure: it reads the arguments and sends no query. Called first in the extension hook, for every scope and
 * every model operation; `undefined` and `null` arguments are left to the checks that follow.
 */
export function assertPlainArgs(model: string, operation: string, args: unknown): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return;
  checkObject(model, operation, args, 'the arguments', true);
  for (const [key, value] of Object.entries(args)) {
    if ((WRITE_KEYS as readonly string[]).includes(key)) walkData(model, operation, value, key);
    else walkStructure(model, operation, value, key, 0);
  }
}
