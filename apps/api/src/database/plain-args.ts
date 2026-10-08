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
//      `{ set }` or `{ increment }` object, a JSON value) with the same fault. Json column contents are not
//      walked, so an ingest path pays O(columns) and not O(payload).
// Dates, byte arrays, Decimals, the Json null sentinels and field references are values, not structure, and
// are skipped (the real ones only: see "Hidden keys" below).
//
// The operand of a Json filter is a VALUE, not structure (review of #185, S1): `where: { accommodations: {
// equals: stored } }` is a compare-and-set (retention, the org settings, the device-info fence), and `stored`
// is a document that the database returned, which may hold an own `__proto__` key at any depth or be nested
// deeper than the structure limit (writes check two levels only). Prisma serialises that operand as JSON and
// never reads it as structure, so the walk does not enter it: for a column of JSON_COLUMNS (the schema's Json
// columns, checked against the generated client by a spec), the operand of `equals`, `not`, `in`, `notIn`,
// `array_*` and `string_*` is skipped. Everything else keeps walking, including the filter object itself and
// a `path`. The `where` and `having` of a call are walked model by model (AND, OR, NOT and a relation filter
// follow the relation to its model); a `where` nested in a `select` or `include` has no model here and is
// walked whole, so a polluted Json operand there is refused (fail closed).
//
// The checks that read `select`, `omit`, `where`, `data` and the rest also read through ownValue(), so a key
// that is not the caller's own is never seen (defence in depth against a polluted Object.prototype).
//
// Hidden keys (FU-DB-281; the #261 delta review, S1; CLAUDE.md rule 3). The checks walk with `Object.entries`
// and `Object.values`, which see own ENUMERABLE string keys only, and they read a getter once. Prisma reads a
// relation's args with `function Wt({ select, include, ...rest })`, a [[Get]] that also finds a NON-ENUMERABLE
// own `select` or `include` and calls a getter again. Its argument clone (a for-in copy, made before the hook
// runs) normally drops non-enumerable and symbol keys and snapshots getters and Proxies, but it passes an
// object BY REFERENCE when `value[Symbol.for('prisma.objectEnumValue')] === true` (the brand of its null
// sentinels; the symbol is a registered one, so any code can set it), and a FieldRef or Skip instance too.
// (A Skip instance is refused: it is walked, and its prototype is not plain. `Prisma.skip` is not exported by
// this client, which does not enable the `strictUndefinedChecks` preview; a spec fails when it appears, so
// enabling the preview adds it to isValueObject by identity, like the Json null sentinels.)
// Confirmed against Postgres on Prisma 7.10: in system scope, a branded `_count` with a non-enumerable
// `select: { sessions: true }` counted the relation, and in STAFF scope a branded relation args object with a
// getter `include` gave the omit check `{}` and Prisma `{ invitation: { omit: { _count: false } } }`.
// So every object and array of the tree that the walk visits (the args, structure, where and having, the
// filter object of a Json column, the data rows and one level below each column) is refused when it:
//   - is a Proxy (its traps can answer the checks and Prisma differently);
//   - has a prototype other than Object.prototype or null (an array: other than Array.prototype), the
//     data rows included: Prisma hands the hook its own clone, so a DTO arrives here as a plain object;
//   - has an own symbol key (the brand among them), an own non-enumerable key, an own accessor (a getter
//     or a setter), or (an array) an own key that is not an index;
//   - has an own `__prismaRawParameters__` key or an own function value. Prisma's value serializer acts on
//     both before it reads the rest of the object: it sends `values` to the engine raw for the first, and
//     serialises `toJSON()` in the object's place for the second. Either would drop the org filter the scope
//     spreads in as sibling keys, or carry a field reference past the CANDIDATE refusal (FU-DB-281 review B1).
//     Both are JSON-constructible (unlike a symbol, a getter or a Proxy), so a request body could carry
//     `__prismaRawParameters__` IF a route ever forwarded a raw where/data object; no route on main does today
//     (every where/data node is built with fixed literal keys, and the global ValidationPipe is whitelist +
//     forbidNonWhitelisted), so, like the rest of FU-DB-281, only in-repo code reaches it now. No column is
//     named `__prismaRawParameters__`, and a function is never a valid query argument.
// A Date, a byte array, a Decimal, a field reference and the Json null sentinels are values and are skipped
// only when they are the real thing (the right prototype, no foreign own key, not a Proxy; a byte array's own
// string indices are not listed, an O(length) cost, so the walk, not this skip, is what stops a hostile own
// `slice`); anything else that looks like one is walked as structure, so it is refused. A value goes only where
// a value goes (a filter operand, a cursor value, a column value): one where a query object is expected is
// refused, so its own keys never become structure. That is the value of any argument key, a where (under AND,
// OR, NOT or a relation filter), a data row, a key that holds a query object (QUERY_OBJECT_KEYS), and every
// entry in the body of a select, include or omit (a relation field is true/false or nested args). The arrays
// one level below a column (a scalar list, a Json array) get the prototype, Proxy and symbol checks; their
// elements are values.
import { types } from 'node:util';
import { Prisma } from '../generated/prisma/client.js';
import { deepFreeze } from './deep-freeze';
import { OrgScopeViolationError } from './errors';
import type { ModelName } from './org-scope-map';
import { relationOf } from './org-scope-relations';

type PlainObject = Record<string, unknown>;

/** The deepest structure object (where, orderBy, ...) the walk follows; beyond it the call is refused. */
export const MAX_STRUCTURE_DEPTH = 64;

/**
 * The Json columns of the schema, by Prisma model and field name (`type Json` in prisma/schema.prisma). The
 * operand of a filter on one of them is a value, not structure (see the header). A spec compares this table
 * with the generated client's own metadata, so a Json column that a migration adds fails the build until it
 * is listed here; until then its operand is walked, which refuses and never lets anything through.
 */
export const JSON_COLUMNS: Readonly<Partial<Record<ModelName, readonly string[]>>> = deepFreeze({
  Organization: ['settings'],
  AuditLog: ['metadata'],
  QuestionVersion: ['limits', 'starterCode', 'referenceSolution', 'answerSpec', 'validationReport'],
  QuestionVariant: ['params'],
  Test: ['settings'],
  TestQuestion: ['randomRule'],
  Invitation: ['accommodations'],
  Session: ['deviceInfo'],
  SessionQuestion: ['answer'],
  Submission: ['results'],
  ProctorEvent: ['payload'],
  KeystrokeBatch: ['events'],
});

/**
 * The operators of a Json filter whose operand is a value: the equality and list operators, and the array and
 * string operators that Prisma documents for Json (`path` and `mode` are structure and are still walked).
 */
export const JSON_VALUE_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not',
  'in',
  'notIn',
  'array_contains',
  'array_starts_with',
  'array_ends_with',
  'string_contains',
  'string_starts_with',
  'string_ends_with',
]);

const LOGICAL_KEYS: ReadonlySet<string> = new Set(['AND', 'OR', 'NOT']);
/** The keys of a relation filter; they wrap a where of the same (related) model. */
const RELATION_FILTER_KEYS: ReadonlySet<string> = new Set(['some', 'every', 'none', 'is', 'isNot']);

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
 * It reads those keys with [[Get]], so a getter of the caller's runs: candidate-interim.ts uses it to REFUSE a field
 * reference; to SKIP one as a value, plain-args uses isRealFieldRef, which proves them data properties first.
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

/** The own keys of a Prisma field reference (`client.model.fields.column`), as its class declares them. */
const FIELD_REF_KEYS: ReadonlySet<string> = new Set([
  'modelName',
  'name',
  'typeName',
  'isList',
  'isEnum',
]);
/** The own keys of a decimal.js Decimal (the instance owns its constructor). */
const DECIMAL_KEYS: ReadonlySet<string> = new Set(['constructor', 's', 'e', 'd']);

/** True when every own key of `object` is a string in `allowed`, held as an enumerable data property. */
function hasOnlyDataKeys(object: object, allowed: ReadonlySet<string>): boolean {
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !('value' in descriptor)) return false;
    if (key !== 'constructor' && descriptor.enumerable !== true) return false;
  }
  return true;
}

// The isReal* helpers run inside isValueObject, after its Proxy check: on a non-Proxy, Reflect.ownKeys,
// Object.getPrototypeOf and getOwnPropertyDescriptor run no code of the caller's.

/** A Date that carries nothing: no own key, and a realm's Date.prototype (not a subclass's) as its prototype. */
function isRealDate(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return (
    types.isDate(value) &&
    Reflect.ownKeys(value).length === 0 &&
    typeof proto === 'object' &&
    proto !== null &&
    Object.hasOwn(proto, 'getTime') &&
    isPlainPrototype(Object.getPrototypeOf(proto))
  );
}

/**
 * A byte array: a typed array whose prototype is a realm's Uint8Array.prototype (or another element type's) or
 * Node's Buffer.prototype, with no symbol key (Prisma's brand among them). Prisma reads a byte array as bytes
 * (`buffer`, `byteOffset` and `byteLength`, then base64), never as structure, so its own string keys are not listed:
 * that would cost O(length) (about 100 ms for 1 MiB). The guarantee is the walk, not the clone: the clone calls the
 * value's own `slice(0)` (for a Buffer, a view on the same memory, not a copy), so the hook sees whatever that
 * returns. A branded or foreign object is refused here, and a real byte array is refused wherever a query object is
 * expected (see the header), so its own keys are never read as structure.
 */
function isRealByteArray(value: object): boolean {
  if (!types.isTypedArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (typeof proto !== 'object' || proto === null) return false;
  const builtin =
    proto === Buffer.prototype ||
    (Object.hasOwn(proto, 'BYTES_PER_ELEMENT') &&
      isPlainPrototype(Object.getPrototypeOf(Object.getPrototypeOf(proto))));
  return builtin && Object.getOwnPropertySymbols(value).length === 0;
}

/** A Prisma Decimal (the class the client and its clone build): its own `s`, `e` and `d`, and nothing else. */
function isRealDecimal(value: object): boolean {
  // The prototype and the own keys first: no getter of the caller's runs before the object is known to be one.
  return (
    Object.getPrototypeOf(value) === Prisma.Decimal.prototype &&
    Object.hasOwn(value, 's') &&
    Object.hasOwn(value, 'e') &&
    Object.hasOwn(value, 'd') &&
    hasOnlyDataKeys(value, DECIMAL_KEYS) &&
    Prisma.Decimal.isDecimal(value)
  );
}

/**
 * A field reference as the runtime builds it: the five own keys of its class and nothing else, and a prototype that
 * owns only `constructor` and `_toGraphQLInputType`, on Object.prototype. A look-alike, a reference with a key
 * added, or an object built on a reference (`Object.create(ref)`) is not one, and is walked (and refused).
 */
function isRealFieldRef(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  if (
    typeof proto !== 'object' ||
    proto === null ||
    !isPlainPrototype(Object.getPrototypeOf(proto))
  ) {
    return false;
  }
  const own = Reflect.ownKeys(proto);
  return (
    own.length === 2 &&
    Object.hasOwn(proto, 'constructor') &&
    typeof Object.getOwnPropertyDescriptor(proto, '_toGraphQLInputType')?.value === 'function' &&
    hasOnlyDataKeys(value, FIELD_REF_KEYS) &&
    Object.keys(value).length === FIELD_REF_KEYS.size &&
    isFieldRef(value)
  );
}

/**
 * A value Prisma takes as it is, not a structure to walk: the real thing only (see the header). A Proxy is never
 * one, whatever it wraps.
 */
function isValueObject(value: object): boolean {
  if (types.isProxy(value)) return false;
  return (
    value === Prisma.DbNull ||
    value === Prisma.JsonNull ||
    value === Prisma.AnyNull ||
    isRealDate(value) ||
    isRealByteArray(value) ||
    isRealDecimal(value) ||
    isRealFieldRef(value)
  );
}

/** True when `object` has an enumerable key that it does not own (a for...in finds it, so Prisma does). */
function hasInheritedKey(object: object): boolean {
  for (const key in object) {
    if (!Object.hasOwn(object, key)) return true;
  }
  return false;
}

/**
 * The keys of a relation's args (nested under select or include) whose value is a query object, never a value.
 * No column of the schema has one of these names.
 */
const QUERY_OBJECT_KEYS: ReadonlySet<string> = new Set([
  'select',
  'include',
  'omit',
  'where',
  'orderBy',
  'cursor',
  'having',
  '_count',
  '_avg',
  '_sum',
  '_min',
  '_max',
]);

const VALUE_WHERE_OBJECT =
  'a value (a Date, bytes, a Decimal, a field reference or a Json null) where a query object is expected';

/** Prisma's serializer sends `values` to the engine raw when an own property of this name is `true` (`$c`/`us`). */
const RAW_PARAMETERS_KEY = '__prismaRawParameters__';

/**
 * The keys whose value is the BODY of a selection: `{ relationField: true | <args> }`. Inside one, no entry's value is
 * ever a value object (a relation field is `true`, `false` or a nested args object), so one there is refused. A
 * relation's own args (its `where`, `cursor`, ...) are walked with this off again, so their value operands pass.
 */
const SELECTION_BODY_KEYS: ReadonlySet<string> = new Set(['select', 'include', 'omit']);

/** A canonical array index ('0', '1', ... but not '01' or '-1'), below 2^32 - 1. */
function isArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  return Number(key) < 4294967295;
}

function refusal(model: string, operation: string, place: string, what: string) {
  return new OrgScopeViolationError(
    `${model}.${operation}: ${what} in ${place} is refused: query arguments must be plain objects ` +
      '(Prisma reads keys that the scope checks do not see; ADR 0013 CS-4.4, #185 B1, FU-DB-281).',
  );
}

/**
 * The own keys of one object or array: no symbol key, no own `__proto__`, no accessor and no non-enumerable key
 * (an array's `length` aside), and for an array (`array` set) no key but its indices.
 */
function checkOwnKeys(
  model: string,
  operation: string,
  object: object,
  place: string,
  array: boolean,
): void {
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === 'symbol') throw refusal(model, operation, place, 'a symbol key');
    if (key === '__proto__') throw refusal(model, operation, place, 'an own "__proto__" key');
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw refusal(model, operation, place, 'an accessor (a getter or a setter)');
    }
    if (descriptor.enumerable !== true) {
      throw refusal(model, operation, place, 'a non-enumerable key');
    }
    if (array) {
      if (!isArrayIndex(key)) {
        throw refusal(model, operation, place, 'an array with a key that is not an index');
      }
      continue;
    }
    // Prisma's value serializer acts on two own keys before it reads the rest of the object: `__prismaRawParameters__`
    // (`$c`), for which it sends `values` to the engine raw, and any `toJSON` (`Lc`), whose return it serializes in the
    // object's place. Either would drop the org filter the scope spreads in as sibling keys (org-scope-args.ts), or
    // carry a field reference past the CANDIDATE refusal. A function value is never a legitimate query argument (Prisma
    // rejects one anyway), and no column is named `__prismaRawParameters__`.
    if (key === RAW_PARAMETERS_KEY) {
      throw refusal(
        model,
        operation,
        place,
        `an own "${RAW_PARAMETERS_KEY}" key (a Prisma raw-parameter marker)`,
      );
    }
    if (typeof descriptor.value === 'function') {
      throw refusal(model, operation, place, 'a function value');
    }
  }
}

/**
 * One object of the arguments, wherever it is (args, structure, where, a data row, a column value): not a Proxy,
 * a prototype of Object.prototype or null, clean own keys (checkOwnKeys) and no inherited enumerable key.
 */
function checkObject(model: string, operation: string, object: object, place: string): void {
  if (types.isProxy(object)) throw refusal(model, operation, place, 'a Proxy');
  if (!isPlainPrototype(Object.getPrototypeOf(object))) {
    throw refusal(
      model,
      operation,
      place,
      'an object with a prototype other than Object.prototype',
    );
  }
  checkOwnKeys(model, operation, object, place, false);
  if (hasInheritedKey(object)) throw refusal(model, operation, place, 'an inherited key');
}

/**
 * One array of the arguments: not a Proxy, a realm's Array.prototype as its prototype, no symbol key, and (when
 * `keys` is set, for structure and the rows of a createMany) no own key but its indices, each a plain value. The
 * arrays one level below a data column are values (a scalar list, a Json array): `keys` is off for them, so a
 * long one costs O(1) here.
 */
function checkArray(
  model: string,
  operation: string,
  array: readonly unknown[],
  place: string,
  keys: boolean,
): void {
  if (types.isProxy(array)) throw refusal(model, operation, place, 'a Proxy');
  const proto: unknown = Object.getPrototypeOf(array);
  if (!Array.isArray(proto) || !isPlainPrototype(Object.getPrototypeOf(proto))) {
    throw refusal(model, operation, place, 'an array with a prototype other than Array.prototype');
  }
  if (keys) checkOwnKeys(model, operation, array, place, true);
  else if (Object.getOwnPropertySymbols(array).length > 0) {
    throw refusal(model, operation, place, 'a symbol key');
  }
}

/** A structure object (a where, a select, an orderBy, ...) and everything under it. */
function walkStructure(
  model: string,
  operation: string,
  value: unknown,
  place: string,
  depth: number,
  selectionBody: boolean,
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
    checkArray(model, operation, value, place, true);
    for (const item of value) walkStructure(model, operation, item, place, depth + 1, false);
    return;
  }
  checkObject(model, operation, value, place);
  for (const [key, inner] of Object.entries(value) as Array<[string, unknown]>) {
    if (typeof inner === 'object' && inner !== null && isValueObject(inner)) {
      // A value object goes only where a value goes. At a key that holds a query object, and anywhere in the body of a
      // select or include (a relation field is true/false or nested args), it is refused rather than skipped.
      if (selectionBody || QUERY_OBJECT_KEYS.has(key)) {
        throw refusal(model, operation, place, VALUE_WHERE_OBJECT);
      }
    }
    walkStructure(model, operation, inner, place, depth + 1, SELECTION_BODY_KEYS.has(key));
  }
}

/** The operators of a Json filter: the operand of a value operator is skipped, the rest is walked. */
function walkJsonFilter(
  model: string,
  operation: string,
  filter: unknown,
  place: string,
  depth: number,
): void {
  if (typeof filter !== 'object' || filter === null || isValueObject(filter)) return;
  if (Array.isArray(filter)) {
    walkStructure(model, operation, filter, place, depth, false);
    return;
  }
  checkObject(model, operation, filter, place);
  for (const [operator, operand] of Object.entries(filter)) {
    if (JSON_VALUE_OPERATORS.has(operator)) continue; // a JSON document (or a field reference): a value
    walkStructure(model, operation, operand, place, depth + 1, false);
  }
}

/**
 * A `where` or a `having`, model by model: AND, OR and NOT, a relation filter (to the related model) and a Json
 * column filter are told apart; any other key (a scalar filter, an unknown key) is walked as structure.
 * `owner` is the model the where filters, or `undefined` when it is not known (then nothing is exempt).
 */
function walkWhere(
  model: string,
  operation: string,
  where: unknown,
  place: string,
  depth: number,
  owner: ModelName | undefined,
): void {
  if (typeof where !== 'object' || where === null) return;
  if (isValueObject(where)) throw refusal(model, operation, place, VALUE_WHERE_OBJECT);
  if (depth > MAX_STRUCTURE_DEPTH) {
    throw refusal(
      model,
      operation,
      place,
      `a structure nested more than ${MAX_STRUCTURE_DEPTH} levels`,
    );
  }
  if (Array.isArray(where)) {
    checkArray(model, operation, where, place, true);
    for (const item of where) walkWhere(model, operation, item, place, depth + 1, owner);
    return;
  }
  checkObject(model, operation, where, place);
  for (const [key, inner] of Object.entries(where)) {
    if (LOGICAL_KEYS.has(key) || RELATION_FILTER_KEYS.has(key)) {
      walkWhere(model, operation, inner, place, depth + 1, owner);
    } else if (owner !== undefined && JSON_COLUMNS[owner]?.includes(key) === true) {
      walkJsonFilter(model, operation, inner, place, depth + 1);
    } else if (owner !== undefined && relationOf(owner, key) !== undefined) {
      walkWhere(model, operation, inner, place, depth + 1, relationOf(owner, key)?.target);
    } else {
      walkStructure(model, operation, inner, place, depth + 1, false);
    }
  }
}

/** The row(s) of a write and one level below each column. JSON contents are not walked. */
function walkData(model: string, operation: string, value: unknown, place: string): void {
  if (Array.isArray(value)) {
    checkArray(model, operation, value, place, true);
    for (const row of value) walkData(model, operation, row, place);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (isValueObject(value)) throw refusal(model, operation, place, VALUE_WHERE_OBJECT);
  checkObject(model, operation, value, place);
  for (const inner of Object.values(value) as unknown[]) {
    if (typeof inner !== 'object' || inner === null) continue;
    if (Array.isArray(inner))
      checkArray(model, operation, inner, `${place} (a column value)`, false);
    else if (!isValueObject(inner))
      checkObject(model, operation, inner, `${place} (a column value)`);
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
  checkObject(model, operation, args, 'the arguments');
  const owner = Object.hasOwn(Prisma.ModelName, model) ? (model as ModelName) : undefined;
  for (const [key, value] of Object.entries(args) as Array<[string, unknown]>) {
    if (typeof value === 'object' && value !== null && isValueObject(value)) {
      throw refusal(model, operation, key, VALUE_WHERE_OBJECT);
    }
    if ((WRITE_KEYS as readonly string[]).includes(key)) walkData(model, operation, value, key);
    else if (key === 'where' || key === 'having') walkWhere(model, operation, value, key, 0, owner);
    else walkStructure(model, operation, value, key, 0, SELECTION_BODY_KEYS.has(key));
  }
}
