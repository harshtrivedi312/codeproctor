// The pure part of the session scope (ADR 0013 section 5.10, CS-4.1 to CS-4.3 and CS-4.5): given a
// model, an operation, its arguments and the scope's actor and session, return the arguments the
// query must run with, and the session_questions ids a create must prove. No database and no
// context here, so every model and operation can be unit tested. The Prisma extension
// (org-scope.extension.ts) wraps this with the context lookup and the one existence check.
//
// Order of the checks, which matters:
//   1. CANDIDATE only (candidateGate): the model is on the allowlist (deny by default), a model that
//      is readable only under a grant is refused (grants are PR 2), no cursor, a read-only model and
//      a model with no candidate writes get no write, a model a candidate may not create gets no
//      create, a candidate deletes nothing; then the caller's arguments use no relation (vectors 1 to
//      5, candidate-relations.ts), then the interim column control (candidate-interim.ts).
//      The relation check runs on the caller's arguments, BEFORE any filter is added, so the relation
//      filters the extension injects itself (the org path, `sessionQuestion: { sessionId }`,
//      `sessionSections: { some }`) never trip it.
//   2. Both actors: a create takes the session from the context (stamped when missing, refused when
//      it names another), and an update may not write a session key. CANDIDATE also: the keys that
//      feed other models' filters are immutable, a create carries the fixed values of CS-4.4
//      (`source = 'CLIENT'`), and an update writes only the columns CS-4.4 allows.
//   3. The org scope (applyOrgScope: org filter, orgId stamp and check, nested writes refused).
//   4. The session filter (CS-4.2) and, for a CANDIDATE, the CS-4.4 row filter and the CS-4.3 row
//      filter of the model are ANDed into `where`. Creates have no `where`.
//
// What this file does NOT do (ADR 0013 CS-4 PR 2 and 3): the CS-4.4 column allowlists, `omit`, grants,
// the submissions RUN filter. Until PR 2, candidate-interim.ts keeps the columns closed on a fixed list.
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionBinding } from './org-context';
import { andWhere, applyOrgScope } from './org-scope-args';
import { ORG_SCOPE, orgFilter } from './org-scope-map';
import type { ModelName, OrgScopeRule } from './org-scope-map';
import { assertInterimColumns } from './candidate-interim';
import { assertNoRelationVectors } from './candidate-relations';
import {
  candidateReadFilter,
  candidateRuleFor,
  isReadOperation,
  sessionRuleFor,
} from './session-scope-map';
import type { CandidateModelRule, SessionModelRule } from './session-scope-map';

/** The `session` kind of a CANDIDATE model rule: what a candidate may do on a session-path model. */
type CandidateSessionRule = Extract<CandidateModelRule, { kind: 'session' }>;

type PlainObject = Record<string, unknown>;

export interface SessionScopeInput {
  readonly model: ModelName;
  readonly rule: OrgScopeRule;
  readonly operation: string;
  readonly args: unknown;
  readonly orgId: string;
  readonly session: SessionBinding;
  /** The candidate facts of a CANDIDATE scope, when the guard has set them. */
  readonly facts: CandidateFacts | undefined;
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

interface CandidateGateResult {
  /** The model's rule, when it is a session-path model. */
  readonly sessionRule: CandidateSessionRule | undefined;
  /** The CS-4.3 row filter of a model a candidate reads (none for session-path models). */
  readonly readFilter: PlainObject | undefined;
}

/**
 * CS-4.3, the model-level half of the CANDIDATE gate: deny by default, and a model that is readable
 * only under a grant is refused until grants exist. It needs no arguments, so the extension runs it
 * FIRST, before anything else, including the `unscoped` early return (a model that is global on
 * purpose is still not reachable by a candidate unless the allowlist names it).
 */
export function assertCandidateModelAllowed(
  model: string,
  operation: string,
): Exclude<CandidateModelRule, { kind: 'grant-only' }> {
  const rule = candidateRuleFor(model);
  if (rule === undefined) {
    throw violation(
      model,
      operation,
      'this model is not on the CANDIDATE allowlist (ADR 0013 CS-4.3, deny by default).',
    );
  }
  if (rule.kind === 'grant-only') {
    // TODO(ADR 0013 CS-4 PR 2): readable under the grant of `rule.grantSite` (`id IN grant.ids`).
    // Grants do not exist in this PR, so the model is refused.
    throw violation(
      model,
      operation,
      `this model is readable only under a grant (${rule.grantSite}), and grants are not built yet ` +
        '(ADR 0013 CS-4.3, PR 2).',
    );
  }
  return rule;
}

/** CS-4.3: deny by default. See the header for the order of the checks. */
function candidateGate(input: SessionScopeInput, args: PlainObject): CandidateGateResult {
  const { model, operation, session, facts } = input;
  const rule = assertCandidateModelAllowed(model, operation);
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
    // CS-4.4 lists no delete for any model; PR 2 defines the writes per column.
    throw violation(
      model,
      operation,
      'a candidate deletes nothing: no CS-4.4 row grants a delete (ADR 0013 CS-4.3, stricter ' +
        'reading, FU-DB-184).',
    );
  }
  if (!isRead && (rule.kind === 'read' || rule.writes === 'none')) {
    throw violation(
      model,
      operation,
      rule.kind === 'read'
        ? 'this model is read-only in a CANDIDATE scope (ADR 0013 CS-4.3); every write operation is refused.'
        : 'a candidate writes nothing here: CS-4.4 grants no write on this model (its writers are ' +
            'SERVICE jobs), so every write operation is refused.',
    );
  }
  if (
    rule.kind === 'session' &&
    rule.writes === 'no-create' &&
    CREATE_OPERATIONS.includes(operation)
  ) {
    // A planted row would widen the filters of other models (a session_question reaches `questions`
    // through its question version) and is not a candidate action: CS-4.4 grants updates only.
    throw violation(
      model,
      operation,
      'a candidate cannot create this row: CS-4.4 grants updates only (ADR 0013 CS-4.4; rows are ' +
        'created by the session job or the staff route).',
    );
  }
  // CS-4.5: the caller's arguments, before the extension adds its own relation filters.
  assertNoRelationVectors(model, operation, args);
  // Interim column safety, until the CS-4.4 allowlists of PR 2 replace it.
  assertInterimColumns(model, operation, args);
  return {
    sessionRule: rule.kind === 'session' ? rule : undefined,
    readFilter:
      rule.kind === 'read'
        ? candidateReadFilter(model, rule.filter, session.sessionId, facts)
        : undefined,
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

/** A CANDIDATE update writes only the columns CS-4.4 lists for the model (proctor_events: duration_ms). */
function assertUpdateColumns(
  model: string,
  operation: string,
  allowed: readonly string[],
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && !allowed.includes(key)) {
      throw violation(
        model,
        operation,
        `${key} cannot be written by a candidate update here: CS-4.4 allows ` +
          `${allowed.join(', ')} only.`,
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

/**
 * Stamps the creates, collects the session_questions ids to prove, and checks the update keys.
 * `candidate` is set for a CANDIDATE actor on a session-path model.
 */
function stageArgs(
  model: ModelName,
  operation: string,
  rule: SessionModelRule,
  candidate: CandidateSessionRule | undefined,
  args: PlainObject,
  sessionId: string,
): { args: PlainObject; sessionQuestionIds: string[] } {
  const ids: string[] = [];
  const stamp = (data: unknown): unknown => {
    const id = questionRefOf(model, operation, rule, data);
    if (id !== undefined) ids.push(id);
    const stamped = stampSession(model, operation, rule, data, sessionId);
    return candidate?.createFixed === undefined
      ? stamped
      : fixCreate(model, operation, candidate.createFixed, stamped);
  };

  if (UPDATE_OPERATIONS.includes(operation)) {
    const data = operation === 'upsert' ? args.update : args.data;
    const keys = [...rule.immutable, ...(candidate?.immutable ?? [])];
    assertSessionKeysKept(model, operation, keys, data);
    if (candidate?.updateOnly !== undefined) {
      assertUpdateColumns(model, operation, candidate.updateOnly, data);
    }
  }
  if (!CREATE_OPERATIONS.includes(operation)) {
    return { args, sessionQuestionIds: ids };
  }
  switch (operation) {
    case 'create':
      return { args: { ...args, data: stamp(args.data) }, sessionQuestionIds: ids };
    case 'createMany':
    case 'createManyAndReturn': {
      const { data } = args;
      const stamped = Array.isArray(data) ? data.map((row: unknown) => stamp(row)) : stamp(data);
      return { args: { ...args, data: stamped }, sessionQuestionIds: ids };
    }
    default: // upsert: only the create branch takes the session; the where is filtered below
      return { args: { ...args, create: stamp(args.create) }, sessionQuestionIds: ids };
  }
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
  const args: PlainObject = isPlainObject(input.args) ? input.args : {};

  const sessionRule = sessionRuleFor(model);
  const gate = session.actor === 'CANDIDATE' ? candidateGate(input, args) : undefined;

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

  const staged =
    sessionRule === undefined
      ? { args, sessionQuestionIds: [] as string[] }
      : stageArgs(model, operation, sessionRule, gate?.sessionRule, args, session.sessionId);

  const scoped = applyOrgScope({ model, rule, operation, args: staged.args, orgId });

  const filters: PlainObject[] = [];
  if (sessionRule !== undefined) filters.push(sessionRule.filter(session.sessionId));
  if (gate?.sessionRule?.rowFilter !== undefined) filters.push(gate.sessionRule.rowFilter);
  if (gate?.readFilter !== undefined) filters.push(gate.readFilter);
  if (filters.length === 0 || NO_WHERE.includes(operation)) {
    return { args: scoped, sessionQuestionIds: staged.sessionQuestionIds };
  }
  let where: unknown = scoped.where;
  for (const filter of filters) where = andWhere(model, operation, where, filter);
  return { args: { ...scoped, where }, sessionQuestionIds: staged.sessionQuestionIds };
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
