// The pure part of the session scope (ADR 0013 section 5.10, CS-4.1 to CS-4.5): given a model, an
// operation, its arguments and the scope's actor, session and active grant, return the arguments the query
// must run with, the session_questions ids and the consent text ids a create must prove. No database and no
// context here, so every model and operation can be unit tested. The Prisma extension
// (org-scope.extension.ts) wraps this with the context lookup and the two existence checks.
//
// Order of the checks, which matters:
//   1. CANDIDATE only (candidateGate): the model is on the allowlist (deny by default; a model that is
//      readable only under a grant needs an active grant of that model), the candidate facts are set,
//      no cursor, a candidate deletes nothing, a read-only model and a model with no candidate writes get
//      no write, a model a candidate may not create gets no create and one it may not update gets no
//      update (a grant adds columns to an operation the model already has, and the one create of
//      consents; it never adds an operation); then the caller's arguments use no relation (vectors 1 to 5,
//      candidate-relations.ts), then the read allowlist of CS-4.4 (candidate-interim.ts: select, where,
//      having, orderBy, distinct, by, aggregates; the default `omit`; the RUN filter).
//      The relation check runs on the caller's arguments, BEFORE any filter is added, so the relation
//      filters the extension injects itself (the org path, `sessionQuestion: { sessionId }`,
//      `sessionSections: { some }`) never trip it.
//   2. Both actors: a create takes the session from the context (stamped when missing, refused when it
//      names another), and an update may not write a session key. CANDIDATE also: the keys that feed other
//      models' filters are immutable, a create and an update carry only the columns of the CS-4.4 write
//      allowlist of the model (plus the columns an active grant unlocks; `id`, `orgId` and the timestamps
//      never), a create carries the fixed values of CS-4.4 (`source = 'CLIENT'`), a consents create
//      verifies its two keys, and the RUN-row columns of a submission are written on a RUN row only.
//   3. The org scope (applyOrgScope: org filter, orgId stamp and check, nested writes refused).
//   4. The session filter (CS-4.2) and, for a CANDIDATE, the CS-4.4 row filter, the CS-4.3 row filter of
//      the model, the grant's `id IN ids` and the RUN filter are ANDed into `where`. Creates have no `where`.
//   5. For a CANDIDATE call that returns rows with no `select`: `omit` of every column that is not in the
//      default select.
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionBinding } from './org-context';
import { andWhere, applyOrgScope } from './org-scope-args';
import { ORG_SCOPE, orgFilter } from './org-scope-map';
import type { ModelName, OrgScopeRule } from './org-scope-map';
import { assertCandidateColumns, COMPOUND_UNIQUES, whereFieldNames } from './candidate-interim';
import type { ColumnVerdict } from './candidate-interim';
import { assertNoRelationVectors } from './candidate-relations';
import { ownArgs } from './plain-args';
import {
  CANDIDATE_OBJECT_KEYS,
  candidateReadFilter,
  candidateRuleFor,
  isReadOperation,
  NEVER_WRITTEN_BY_CANDIDATE,
  sessionRuleFor,
} from './session-scope-map';
import type {
  CandidateModelRule,
  GrantView,
  ObjectKeyRule,
  SessionModelRule,
} from './session-scope-map';

/** The `session` kind of a CANDIDATE model rule: what a candidate may do on a session-path model. */
type CandidateSessionRule = Extract<CandidateModelRule, { kind: 'session' }>;

type PlainObject = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionScopeInput {
  readonly model: ModelName;
  readonly rule: OrgScopeRule;
  readonly operation: string;
  readonly args: unknown;
  readonly orgId: string;
  readonly session: SessionBinding;
  /** The candidate facts of a CANDIDATE scope, when the guard has set them. */
  readonly facts: CandidateFacts | undefined;
  /**
   * The ACTIVE grant of the scope, if any (CANDIDATE only; the extension refuses a query under an inactive
   * one before it gets here). It unlocks columns of ITS model only, filters that model by `id IN ids` (a
   * create grant: constrains the create's session key), and never widens the allowlist or the row filters.
   */
  readonly grant?: GrantView;
}

export interface SessionScopeResult {
  /** The arguments the query runs with. */
  readonly args: PlainObject;
  /**
   * The session_questions ids a create names (`sessionQuestionId` of submissions and keystroke
   * batches). The extension runs ONE scoped primary-key existence check for them before the query,
   * and throws on a miss (CS-4.2). Empty for every other operation.
   */
  readonly sessionQuestionIds: readonly string[];
  /**
   * The consent text ids a consents create names (`consentTextId`, lower-cased). The extension reads
   * `organizations.current_consent_text_id` for the scope's org before the insert and throws unless every
   * one of them equals it (ADR 0013 CS-4.4, item 9). Empty for every other operation.
   */
  readonly consentTextIds: readonly string[];
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function violation(model: string, operation: string, what: string): OrgScopeViolationError {
  return new OrgScopeViolationError(`${model}.${operation}: ${what}`);
}

const CREATE_OPERATIONS: readonly string[] = [
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
];
const UPDATE_OPERATIONS: readonly string[] = [
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
];
/** Creates carry no `where`, so no row filter is added to them. */
const NO_WHERE: readonly string[] = ['create', 'createMany', 'createManyAndReturn'];

/** The columns a candidate create and update may carry in this call: the model's lists plus the grant's. */
interface WritePlan {
  readonly create: readonly string[] | undefined;
  readonly update: readonly string[] | undefined;
}

/**
 * CS-4.4's write column for one call. `update` is the model's list plus the columns of `grantedUpdate` that
 * an active grant of the model names; a model with no `update` stays without one (a grant does not make a
 * model updatable). `create` is the model's list, or, for the consents create, the columns of
 * `grantedCreate` that an active CREATE grant of the model names; without that grant the model has none.
 */
function writePlan(
  model: string,
  rule: CandidateSessionRule,
  grant: GrantView | undefined,
): WritePlan {
  const mine = grant !== undefined && grant.model === model ? grant : undefined;
  // A rows grant unlocks the update of its columns, a create grant the create of its columns: neither
  // unlocks the other's operation (no site mixes them today, so this holds the property for a new one).
  const unlocked = (columns: readonly string[] | undefined, mode: 'rows' | 'create'): string[] =>
    (columns ?? []).filter((column) => mine?.mode === mode && mine.columns.includes(column));
  const update =
    rule.update === undefined
      ? undefined
      : [...rule.update, ...unlocked(rule.grantedUpdate, 'rows')];
  const create =
    rule.create !== undefined
      ? [...rule.create]
      : rule.grantedCreate !== undefined && mine?.mode === 'create'
        ? unlocked(rule.grantedCreate, 'create')
        : undefined;
  return { create, update };
}

interface CandidateGateResult {
  /** The model's rule, when it is a session-path model. */
  readonly sessionRule: CandidateSessionRule | undefined;
  /** What the call may write (session-path models only). */
  readonly plan: WritePlan | undefined;
  /** The CS-4.3 row filter of a model a candidate reads (none for session-path models). */
  readonly readFilter: PlainObject | undefined;
  /** The read allowlist's verdict: the default `omit`, and whether the RUN filter applies. */
  readonly columns: ColumnVerdict;
}

/**
 * CS-4.3, the model-level half of the CANDIDATE gate: deny by default, and a model that is readable
 * only under a grant needs an active grant OF THAT MODEL (a grant of another model, or a create grant,
 * does not open it). It needs no arguments, so the extension runs it FIRST, before anything else,
 * including the `unscoped` early return (a model that is global on purpose is still not reachable by a
 * candidate unless the allowlist names it).
 */
export function assertCandidateModelAllowed(
  model: string,
  operation: string,
  grant?: GrantView,
): CandidateModelRule {
  const rule = candidateRuleFor(model);
  if (rule === undefined) {
    throw violation(
      model,
      operation,
      'this model is not on the CANDIDATE allowlist (ADR 0013 CS-4.3, deny by default).',
    );
  }
  if (rule.kind === 'grant-only' && (grant?.model !== model || grant.mode !== 'rows')) {
    throw violation(
      model,
      operation,
      `this model is readable only under a grant of its own (${rule.grantSite}; ADR 0013 CS-4.3).`,
    );
  }
  return rule;
}

/**
 * CS-4.4, "Candidate facts": until the guard has set them, every CANDIDATE query on any model throws, not
 * only the three models whose filters need a fact (PR 1 threw on those three alone).
 */
function assertFactsSet(model: string, operation: string, facts: CandidateFacts | undefined): void {
  if (facts === undefined) {
    throw violation(
      model,
      operation,
      'the candidate facts are not set, so no candidate query may run yet (CandidateSessionGuard ' +
        'sets them once, as the first action in the scope; ADR 0013 CS-4.4).',
    );
  }
}

/** CS-4.3: deny by default. See the header for the order of the checks. */
function candidateGate(input: SessionScopeInput, args: PlainObject): CandidateGateResult {
  const { model, operation, session, facts, grant } = input;
  const rule = assertCandidateModelAllowed(model, operation, grant);
  assertFactsSet(model, operation, facts);
  if (args.cursor !== undefined) {
    throw violation(
      model,
      operation,
      'a cursor is refused in a CANDIDATE scope: it ranks rows against a row named by its own ' +
        'fields, which could be another candidate or another session.',
    );
  }
  const isRead = isReadOperation(operation);
  if (rule.kind === 'session' && (operation === 'delete' || operation === 'deleteMany')) {
    // CS-4.4 lists no delete for any model; PR 2 confirms it (FU-DB-184).
    throw violation(
      model,
      operation,
      'a candidate deletes nothing: no CS-4.4 row grants a delete (ADR 0013 CS-4.3, stricter ' +
        'reading, FU-DB-184).',
    );
  }
  if (!isRead && rule.kind !== 'session') {
    throw violation(
      model,
      operation,
      'this model is read-only in a CANDIDATE scope (ADR 0013 CS-4.3); every write operation is refused.',
    );
  }
  const plan = rule.kind === 'session' ? writePlan(model, rule, grant) : undefined;
  if (!isRead && rule.kind === 'session' && plan !== undefined) {
    // The write allowlist of CS-4.4 (session-scope-map.ts): which operations, then which columns.
    if (plan.create === undefined && plan.update === undefined) {
      throw violation(
        model,
        operation,
        rule.grantedCreate !== undefined
          ? 'a candidate creates this row only under its create grant (ADR 0013 CS-4.4), and none ' +
              'is active: every write operation is refused.'
          : 'a candidate writes nothing here: CS-4.4 grants no write on this model (its writers are ' +
              'SERVICE jobs), so every write operation is refused.',
      );
    }
    if (
      plan.create !== undefined &&
      rule.createOperations !== undefined &&
      CREATE_OPERATIONS.includes(operation) &&
      !rule.createOperations.includes(operation)
    ) {
      throw violation(
        model,
        operation,
        `this model takes only ${rule.createOperations.join(', ')} (one row per session): ` +
          'no batch create and no upsert (ADR 0013 CS-4.4).',
      );
    }
    if (plan.create === undefined && CREATE_OPERATIONS.includes(operation)) {
      // A planted row would widen the filters of other models (a session_question reaches `questions`
      // through its question version) and is not a candidate action: CS-4.4 grants updates only.
      throw violation(
        model,
        operation,
        'a candidate cannot create this row: CS-4.4 grants updates only (ADR 0013 CS-4.4; rows are ' +
          'created by the session job or the staff route).',
      );
    }
    if (plan.update === undefined && UPDATE_OPERATIONS.includes(operation)) {
      throw violation(
        model,
        operation,
        'a candidate cannot update this row: CS-4.4 grants create only (ADR 0013 CS-4.4); a row ' +
          'that was written is not rewritten by the candidate.',
      );
    }
  }
  // CS-4.5: the caller's arguments, before the extension adds its own relation filters.
  assertNoRelationVectors(model, operation, args);
  // CS-4.4: the read allowlist, the default omit and the RUN filter.
  const columns = assertCandidateColumns(model, operation, args, rule.kind === 'grant-only', grant);
  return {
    sessionRule: rule.kind === 'session' ? rule : undefined,
    plan,
    readFilter:
      rule.kind === 'read'
        ? candidateReadFilter(model, rule.filter, session.sessionId, facts)
        : rule.kind === 'grant-only' && rule.filter !== undefined
          ? candidateReadFilter(model, rule.filter, session.sessionId, facts)
          : undefined,
    columns,
  };
}

/** A create row: the session comes from the context, and a row that names another is refused. */
function stampSession(
  model: string,
  operation: string,
  rule: SessionModelRule,
  data: unknown,
  sessionId: string,
): unknown {
  if (rule.createKey === undefined || !isPlainObject(data)) return data;
  const named = data[rule.createKey];
  if (named === undefined) return { ...data, [rule.createKey]: sessionId };
  if (typeof named !== 'string' || named.toLowerCase() !== sessionId) {
    throw violation(
      model,
      operation,
      `${rule.createKey} in the data is not the session of this scope (ADR 0013 CS-4.2).`,
    );
  }
  return data;
}

/** The session_questions id a create row names, if the model carries one. */
function questionRefOf(
  model: string,
  operation: string,
  rule: SessionModelRule,
  data: unknown,
): string | undefined {
  if (rule.questionRef === undefined || !isPlainObject(data)) return undefined;
  const id = data.sessionQuestionId;
  if (id === undefined || id === null) return undefined;
  if (typeof id !== 'string') {
    throw violation(
      model,
      operation,
      'sessionQuestionId must be a plain id; the scope checks it against the session.',
    );
  }
  return id.toLowerCase();
}

/** An update may not write a session key, in any form (`{ set }` too), whatever the value. */
function assertSessionKeysKept(
  model: string,
  operation: string,
  keys: readonly string[],
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  for (const key of keys) {
    if (data[key] !== undefined) {
      throw violation(
        model,
        operation,
        `${key} is a session key and cannot be written by an update (ADR 0013 CS-4.2): a row is ` +
          'never moved to another session.',
      );
    }
  }
}

/**
 * The write allowlist of CS-4.4 for a CANDIDATE: a create or an update carries only the listed columns
 * (and the ones an active grant unlocks). Anything else throws, including `id`, `orgId` and the
 * timestamps, which no candidate write names (NEVER_WRITTEN_BY_CANDIDATE: a create that names `id` is also
 * a P2002 existence oracle). A key whose value is `undefined` is not a write. The message names the model,
 * the column and the list, never a value.
 */
function assertWriteColumns(
  model: string,
  operation: string,
  kind: 'create' | 'update',
  allowed: readonly string[],
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (NEVER_WRITTEN_BY_CANDIDATE.includes(key)) {
      throw violation(
        model,
        operation,
        `${key} is never written by a candidate (the primary key, the org and the timestamps belong ` +
          'to the server; ADR 0013 CS-4.4).',
      );
    }
    if (!allowed.includes(key)) {
      throw violation(
        model,
        operation,
        `${key} cannot be written by a candidate ${kind} here: CS-4.4 lists ${allowed.join(', ')} ` +
          '(write allowlist, plus the columns an active grant unlocks; ADR 0013 CS-4.4).',
      );
    }
  }
}

/** A `..` or `.` segment, an empty segment (`//`), a backslash or a control character in an object key. */
function hasUnsafePathPiece(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return key.split('/').some((segment, index, all) => {
    const edge = index === all.length - 1 && segment === '';
    return (segment === '' && !edge) || segment === '.' || segment === '..';
  });
}

/** `{ set: value }` is the update form of a scalar (a create takes the bare value). */
function writtenValue(kind: 'create' | 'update', given: unknown): unknown {
  return kind === 'update' && isPlainObject(given) && Object.hasOwn(given, 'set')
    ? given.set
    : given;
}

/**
 * What the `where` of an update (or of an upsert's update branch) says about the row it names, for the
 * columns an object key is bound to (FU-DB-199). A column is PINNED when the where names it by plain
 * equality: `stream: 'SCREEN'`, `seq: { equals: 3 }`, or inside a compound unique selector
 * (`sessionId_stream_seq: { sessionId, stream, seq }`). A column the where mentions in any other form (a
 * range, `in`, `not`, or anywhere inside AND, OR and NOT) is LOOSE: the row is not determined by it.
 */
interface Pinned {
  readonly values: PlainObject;
  readonly loose: readonly string[];
}

function pinnedByWhere(
  model: ModelName,
  operation: string,
  binds: readonly string[],
  where: unknown,
): Pinned {
  const values: PlainObject = {};
  const loose = new Set<string>();
  if (!isPlainObject(where)) return { values, loose: [] };
  const note = (column: string, given: unknown): void => {
    if (given === undefined) return;
    if (typeof given === 'string' || typeof given === 'number') {
      values[column] = given;
    } else if (
      isPlainObject(given) &&
      Object.keys(given).length === 1 &&
      (typeof given.equals === 'string' || typeof given.equals === 'number')
    ) {
      values[column] = given.equals;
    } else {
      loose.add(column);
    }
  };
  for (const column of binds) note(column, where[column]);
  for (const key of COMPOUND_UNIQUES[model] ?? []) {
    const inner = where[key];
    if (isPlainObject(inner)) for (const column of binds) note(column, inner[column]);
  }
  // Anything under AND, OR and NOT is not a plain pin, whatever it says.
  const nested = whereFieldNames(model, operation, {
    AND: where.AND,
    OR: where.OR,
    NOT: where.NOT,
  });
  for (const column of binds) if (nested.has(column)) loose.add(column);
  for (const column of loose) delete values[column];
  return { values, loose: [...loose] };
}

/**
 * The values of the same write that the key's parts must equal (the rule's `binds`): what the write
 * carries, and on a create the schema default of a column it leaves out. On an update, a column the write
 * does not carry is bound to the value the `where` pins (FU-DB-199: the row is the one the where names),
 * and is unbound when neither names it. A value that is not a plain number or string (a `{ increment }`)
 * is passed on as it is, and the rule refuses it.
 */
function boundValues(
  rule: ObjectKeyRule,
  kind: 'create' | 'update',
  data: PlainObject,
  pinned: Pinned,
): PlainObject {
  const bound: PlainObject = {};
  for (const column of rule.binds) {
    const given = writtenValue(kind, data[column]);
    const value =
      given !== undefined
        ? given
        : kind === 'create'
          ? rule.defaults[column]
          : pinned.values[column];
    if (value !== undefined) bound[column] = value;
  }
  return bound;
}

/**
 * The object keys a candidate may write stay inside the session's own prefix (ADR 0013 section 5.7, ADR
 * 0004 section 9.2): `orgs/{orgId}/sessions/{sessionId}/` with the scope's own, lower-cased ids, then the
 * folder and shape fixed for the column (CANDIDATE_OBJECT_KEYS), with the parts of the key equal to the
 * row's own `stream`, `segment`, `seq` and `attempt`: the values the same write carries, and, on an update,
 * the values its `where` pins (FU-DB-199; an upsert's update branch and an update by
 * `sessionId_stream_seq` included). A `where` that mentions one of those columns in a form that does not
 * pin it (a range, `in`, anything under AND, OR or NOT) next to a key write is refused: the row the key
 * belongs to is not determined. Another session's prefix, another org's, a traversal (`..`, `//`, a
 * leading `/`, a backslash, a control character) and any other shape are refused. `null` points nowhere
 * and is accepted on a create only. The message names the model and the column, never the key.
 */
function assertObjectKeys(
  model: ModelName,
  operation: string,
  kind: 'create' | 'update',
  data: unknown,
  orgId: string,
  sessionId: string,
  where?: unknown,
): void {
  const columns = CANDIDATE_OBJECT_KEYS[model];
  if (columns === undefined || !isPlainObject(data)) return;
  const prefix = `orgs/${orgId}/sessions/${sessionId}/`;
  for (const [column, rule] of Object.entries(columns)) {
    const given = data[column];
    if (given === undefined) continue;
    // A create takes the bare value, so an object there is refused.
    const value = writtenValue(kind, given);
    if (value === null && kind === 'create') continue;
    const pinned =
      kind === 'update'
        ? pinnedByWhere(model, operation, rule.binds, where)
        : { values: {}, loose: [] };
    const inside =
      typeof value === 'string' &&
      pinned.loose.length === 0 &&
      value.startsWith(prefix) &&
      !hasUnsafePathPiece(value) &&
      rule.accepts(value.slice(prefix.length), boundValues(rule, kind, data, pinned));
    if (!inside) {
      throw violation(
        model,
        operation,
        `${column} must be an object key under this session's own prefix and in the folder of ` +
          'ADR 0013 section 5.7 (no other session, no other org, no traversal), and agree with the row it ' +
          'is written to (the stream, segment, seq or attempt of the write or of its where).',
      );
    }
  }
}

/** A candidate create may not carry the values the server alone writes (proctor_events `type`). */
function assertNoRefusedValues(
  model: string,
  operation: string,
  refused: Readonly<Record<string, readonly string[]>>,
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  for (const [column, values] of Object.entries(refused)) {
    const given = data[column];
    if (typeof given === 'string' && values.includes(given)) {
      throw violation(
        model,
        operation,
        `${column} names a value that only the server writes: a candidate create cannot carry it ` +
          '(ADR 0013 CS-4.4: SERVER events come from SERVICE scope).',
      );
    }
  }
}

/** A CANDIDATE create carries the fixed values of CS-4.4: stamped when missing, refused when different. */
function fixCreate(model: string, operation: string, fixed: PlainObject, data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const out: PlainObject = { ...data };
  for (const [key, value] of Object.entries(fixed)) {
    if (out[key] === undefined) out[key] = value;
    else if (out[key] !== value) {
      throw violation(
        model,
        operation,
        `${key} must be ${String(value)} in a candidate create (ADR 0013 CS-4.4).`,
      );
    }
  }
  return out;
}

/** The columns a create must carry, as plain ids: the extension verifies them, it does not stamp them. */
function assertRequiredIds(
  model: string,
  operation: string,
  required: readonly string[],
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  for (const column of required) {
    const given = data[column];
    if (typeof given !== 'string' || !UUID.test(given)) {
      throw violation(
        model,
        operation,
        `${column} is required in this create, as an id: the service sets it from the context and the ` +
          'extension verifies it (ADR 0013 CS-4.4).',
      );
    }
  }
}

/** `results`, `passed` and `total` of a submission are written on a RUN row only (CS-4.4). */
function assertCreateWhen(
  model: string,
  operation: string,
  when: NonNullable<CandidateSessionRule['createWhen']>,
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  const named = when.columns.filter((column) => data[column] !== undefined);
  if (named.length > 0 && data[when.column] !== when.equals) {
    throw violation(
      model,
      operation,
      `${named.join(', ')} can be written only on a row whose ${when.column} is ${when.equals} ` +
        '(ADR 0013 CS-4.4).',
    );
  }
}

/**
 * The shape of a create row that the database would otherwise answer with a constraint violation (the
 * consents CHECKs, named in the rule): exactly one of the two `createXor` columns is set, and a column of
 * `createNeeds` that is set brings its partner as a non-empty string. Then the two rules that have no database
 * CHECK (C-30, D-55, FU-DB-260; a CHECK would block the consent-PDF job's update of a pre-C-30 row): a column
 * of `createNeedsDate` that is set brings its partner as a valid Date, and a column of `createForbids` that is
 * set brings none of the listed columns. Thrown first, with no value in it.
 */
function assertCreateShape(
  model: string,
  operation: string,
  rule: CandidateSessionRule,
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  const isSet = (column: string): boolean => data[column] !== undefined && data[column] !== null;
  if (rule.createXor !== undefined) {
    const [first, second] = rule.createXor;
    if (isSet(first) === isSet(second)) {
      throw violation(
        model,
        operation,
        `exactly one of ${first} and ${second} must be set in this create (ADR 0013 CS-4.4).`,
      );
    }
  }
  for (const [column, partner] of Object.entries(rule.createNeeds ?? {})) {
    const value = data[partner];
    if (isSet(column) && !(typeof value === 'string' && value.trim() !== '')) {
      throw violation(
        model,
        operation,
        `${partner} is required with ${column} in this create (ADR 0013 CS-4.4).`,
      );
    }
  }
  for (const [column, partner] of Object.entries(rule.createNeedsDate ?? {})) {
    const value = data[partner];
    if (isSet(column) && !(value instanceof Date && !Number.isNaN(value.getTime()))) {
      throw violation(
        model,
        operation,
        `${partner} is required with ${column} in this create, as a valid Date set by the service ` +
          '(ADR 0013 CS-4.4).',
      );
    }
  }
  for (const [column, forbidden] of Object.entries(rule.createForbids ?? {})) {
    const carried = forbidden.filter((name) => isSet(name));
    if (isSet(column) && carried.length > 0) {
      throw violation(
        model,
        operation,
        `${carried.join(', ')} cannot be set with ${column} in this create (ADR 0013 CS-4.4).`,
      );
    }
  }
}

/** What a CANDIDATE call may write: its rule, the plan with the grant's columns, and the grant. */
interface CandidateWrite {
  readonly rule: CandidateSessionRule;
  readonly plan: WritePlan;
  readonly grant: GrantView | undefined;
}

/**
 * Stamps the creates, collects the session_questions ids and the consent text ids to prove, and checks the
 * update keys. `candidate` is set for a CANDIDATE actor on a session-path model.
 */
function stageArgs(
  model: ModelName,
  operation: string,
  rule: SessionModelRule,
  candidate: CandidateWrite | undefined,
  args: PlainObject,
  orgId: string,
  sessionId: string,
): { args: PlainObject; sessionQuestionIds: string[]; consentTextIds: string[] } {
  const ids: string[] = [];
  const consentTextIds: string[] = [];
  const stamp = (data: unknown): unknown => {
    if (candidate !== undefined) {
      const { rule: own, plan } = candidate;
      assertWriteColumns(model, operation, 'create', plan.create ?? [], data);
      assertObjectKeys(model, operation, 'create', data, orgId, sessionId);
      if (own.createRefused !== undefined) {
        assertNoRefusedValues(model, operation, own.createRefused, data);
      }
      if (own.createRequired !== undefined) {
        assertRequiredIds(model, operation, own.createRequired, data);
      }
      if (own.createWhen !== undefined) assertCreateWhen(model, operation, own.createWhen, data);
      assertCreateShape(model, operation, own, data);
      if (own.checksConsentText === true) {
        if (isPlainObject(data) && typeof data.consentTextId === 'string') {
          consentTextIds.push(data.consentTextId.toLowerCase());
        }
      }
    }
    const id = questionRefOf(model, operation, rule, data);
    if (id !== undefined) ids.push(id);
    const stamped = stampSession(model, operation, rule, data, sessionId);
    // A create grant has no `where` to filter: its ids constrain the checked session key instead. The
    // context decides first (stampSession threw on any other session); the grant must then list it.
    const grant = candidate?.grant;
    if (grant?.mode === 'create' && grant.model === model && rule.createKey !== undefined) {
      const key = isPlainObject(stamped) ? stamped[rule.createKey] : undefined;
      if (typeof key !== 'string' || !grant.ids.includes(key.toLowerCase())) {
        throw violation(
          model,
          operation,
          `${rule.createKey} in the data is not in the ids of the active grant (ADR 0013 CS-4.4: a ` +
            'create grant constrains the checked session key).',
        );
      }
    }
    return candidate?.rule.createFixed === undefined
      ? stamped
      : fixCreate(model, operation, candidate.rule.createFixed, stamped);
  };

  if (UPDATE_OPERATIONS.includes(operation)) {
    const data = operation === 'upsert' ? args.update : args.data;
    const keys = [...rule.immutable, ...(candidate?.rule.immutable ?? [])];
    assertSessionKeysKept(model, operation, keys, data);
    if (candidate !== undefined) {
      assertWriteColumns(model, operation, 'update', candidate.plan.update ?? [], data);
      assertObjectKeys(model, operation, 'update', data, orgId, sessionId, args.where);
    }
  }
  if (!CREATE_OPERATIONS.includes(operation)) {
    return { args, sessionQuestionIds: ids, consentTextIds };
  }
  switch (operation) {
    case 'create':
      return { args: { ...args, data: stamp(args.data) }, sessionQuestionIds: ids, consentTextIds };
    case 'createMany':
    case 'createManyAndReturn': {
      const { data } = args;
      const stamped = Array.isArray(data) ? data.map((row: unknown) => stamp(row)) : stamp(data);
      return { args: { ...args, data: stamped }, sessionQuestionIds: ids, consentTextIds };
    }
    default: // upsert: only the create branch takes the session; the where is filtered below
      return {
        args: { ...args, create: stamp(args.create) },
        sessionQuestionIds: ids,
        consentTextIds,
      };
  }
}

/** The rows a create call writes, as the caller's data (a createMany takes a list or one row). */
function createdRows(operation: string, args: PlainObject): unknown[] {
  if (operation === 'create') return [args.data];
  if (operation === 'upsert') return [args.create];
  return Array.isArray(args.data) ? args.data : [args.data];
}

/**
 * Arguments for a query in a session scope (CANDIDATE or SERVICE). See the header for the order.
 * CS-4.1: SERVICE gets no allowlist and no column limit, only the org filter and the session filter.
 */
export function applySessionScope(input: SessionScopeInput): SessionScopeResult {
  const { model, rule, operation, orgId, session } = input;
  if (input.args !== undefined && input.args !== null && !isPlainObject(input.args)) {
    throw violation(model, operation, 'was called with arguments that are not an object.');
  }
  // Own keys only: a key of a prototype is never read (plain-args.ts; the hook refuses such arguments first).
  const args: PlainObject = isPlainObject(input.args) ? ownArgs(input.args) : {};

  const sessionRule = sessionRuleFor(model);
  const isCandidate = session.actor === 'CANDIDATE';
  const gate = isCandidate ? candidateGate(input, args) : undefined;

  // A cursor ranks rows against the row its own fields name, and `where` is not applied to that
  // lookup, so another session's row (same org) could be named. Path models refuse a cursor in the
  // org scope already; sessions is a direct model, so it is refused here.
  if (sessionRule !== undefined && args.cursor !== undefined) {
    throw violation(
      model,
      operation,
      'a cursor is refused in a session scope: the filter selects the one session, and a cursor ' +
        "could rank it against another session's row.",
    );
  }

  const candidate: CandidateWrite | undefined =
    gate?.sessionRule !== undefined && gate.plan !== undefined
      ? { rule: gate.sessionRule, plan: gate.plan, grant: input.grant }
      : undefined;
  const staged =
    sessionRule === undefined
      ? { args, sessionQuestionIds: [] as string[], consentTextIds: [] as string[] }
      : stageArgs(model, operation, sessionRule, candidate, args, orgId, session.sessionId);

  // CS-4.4: a create that reads `results`, `passed` or `total` back must be RUN rows only (there is no
  // `where` to AND the RUN filter into).
  if (gate?.columns.runFilter === true && NO_WHERE.includes(operation)) {
    const rows = createdRows(operation, staged.args);
    if (!rows.every((row) => isPlainObject(row) && row.kind === 'RUN')) {
      throw violation(
        model,
        operation,
        'results, passed and total can be read only on RUN rows (ADR 0013 CS-4.4: the RUN filter).',
      );
    }
  }

  const scoped = applyOrgScope({ model, rule, operation, args: staged.args, orgId });
  const withOmit = (out: PlainObject): PlainObject =>
    gate?.columns.omit === undefined ? out : { ...out, omit: gate.columns.omit };
  const done = (out: PlainObject): SessionScopeResult => ({
    args: withOmit(out),
    sessionQuestionIds: staged.sessionQuestionIds,
    consentTextIds: staged.consentTextIds,
  });

  const filters: PlainObject[] = [];
  if (sessionRule !== undefined) filters.push(sessionRule.filter(session.sessionId));
  if (gate?.sessionRule?.rowFilter !== undefined) filters.push(gate.sessionRule.rowFilter);
  if (gate?.readFilter !== undefined) filters.push(gate.readFilter);
  // CS-4.4: the grant's `id IN ids`, on every query on the grant's own model (never on another model, and
  // never from a create grant, which has no where to filter).
  const grant = input.grant;
  if (isCandidate && grant?.mode === 'rows' && grant.model === model) {
    filters.push({ id: { in: [...grant.ids] } });
  }
  // CS-4.4: results, passed or total named anywhere means RUN rows only.
  if (gate?.columns.runFilter === true) filters.push({ kind: 'RUN' });
  if (filters.length === 0 || NO_WHERE.includes(operation)) return done(scoped);
  let where: unknown = scoped.where;
  for (const filter of filters) where = andWhere(model, operation, where, filter);
  return done({ ...scoped, where });
}

/**
 * The `where` of the one existence check a create needs (CS-4.2): the session_questions with these
 * ids, under the org filter and the session filter. The extension counts them and throws unless
 * every distinct id is found.
 */
export function sessionQuestionsWhere(
  orgId: string,
  sessionId: string,
  ids: readonly string[],
): PlainObject {
  const sessionQuestions = sessionRuleFor('SessionQuestion');
  const org = orgFilter(ORG_SCOPE.SessionQuestion, orgId);
  if (sessionQuestions === undefined || org === undefined) {
    throw new OrgScopeViolationError('SessionQuestion has no session or org rule.');
  }
  return { AND: [org, sessionQuestions.filter(sessionId), { id: { in: [...new Set(ids)] } }] };
}
