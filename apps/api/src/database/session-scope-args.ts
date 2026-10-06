// The pure part of the session scope (ADR 0013 section 5.10, CS-4.1 to CS-4.3 and CS-4.5): given a
// model, an operation, its arguments and the scope's actor and session, return the arguments the
// query must run with, and the session_questions ids a create must prove. No database and no
// context here, so every model and operation can be unit tested. The Prisma extension
// (org-scope.extension.ts) wraps this with the context lookup and the one existence check.
//
// Order of the checks, which matters:
//   1. CANDIDATE only: the model is on the allowlist (deny by default), a read-only model gets no
//      write, a model readable only under a grant is refused (grants are PR 2), a candidate deletes
//      nothing, and no cursor is accepted.
//   2. CANDIDATE only: the caller's arguments use no relation (vectors 1 to 5, candidate-relations.ts).
//      This runs on the caller's arguments, BEFORE any filter is added, so the relation filters the
//      extension injects itself (the org path, `sessionQuestion: { sessionId }`, `sessionSections:
//      { some }`) never trip it.
//   3. Both actors: a create takes the session from the context (stamped when missing, refused when
//      it names another), and an update may not write a session key.
//   4. The org scope (applyOrgScope: org filter, orgId stamp and check, nested writes refused).
//   5. The session filter (CS-4.2) and, for a CANDIDATE, the row filter of the model (CS-4.3) are
//      ANDed into `where`. Creates have no `where`.
//
// What this file does NOT do (ADR 0013 CS-4 PR 2 and 3): column allowlists, `omit`, grants, the
// submissions RUN filter, the proctor_events source filter, the fluent API (vector 6).
import { OrgScopeViolationError } from './errors';
import type { CandidateFacts, SessionBinding } from './org-context';
import { andWhere, applyOrgScope } from './org-scope-args';
import { ORG_SCOPE, orgFilter } from './org-scope-map';
import type { ModelName, OrgScopeRule } from './org-scope-map';
import { assertNoRelationVectors } from './candidate-relations';
import {
  candidateReadFilter,
  candidateRuleFor,
  isReadOperation,
  sessionRuleFor,
} from './session-scope-map';
import type { SessionModelRule } from './session-scope-map';

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

/** CS-4.3: deny by default. Returns the model's row filter (or none) for a CANDIDATE. */
function candidateGate(input: SessionScopeInput, args: PlainObject): PlainObject | undefined {
  const { model, operation, session, facts } = input;
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
  if (args.cursor !== undefined) {
    throw violation(
      model,
      operation,
      'a cursor is refused in a CANDIDATE scope: it ranks rows against a row named by its own ' +
        'fields, which could be another candidate or another session.',
    );
  }
  if (rule.kind === 'read' && !isReadOperation(operation)) {
    throw violation(
      model,
      operation,
      'this model is read-only in a CANDIDATE scope (ADR 0013 CS-4.3); every write operation is refused.',
    );
  }
  if (rule.kind === 'session' && (operation === 'delete' || operation === 'deleteMany')) {
    // CS-4.4 lists no delete for any model; PR 2 defines the writes per column.
    throw violation(
      model,
      operation,
      'a candidate deletes nothing: no CS-4.4 row grants a delete (ADR 0013 CS-4.3, stricter ' +
        'reading, FU-DB-184).',
    );
  }
  // CS-4.5: the caller's arguments, before the extension adds its own relation filters.
  assertNoRelationVectors(model, operation, args);
  return rule.kind === 'read'
    ? candidateReadFilter(model, rule.filter, session.sessionId, facts)
    : undefined;
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
  if (named !== sessionId) {
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
  return id;
}

/** An update may not write a session key, in any form (`{ set }` too), whatever the value. */
function assertSessionKeysKept(
  model: string,
  operation: string,
  rule: SessionModelRule,
  data: unknown,
): void {
  if (!isPlainObject(data)) return;
  for (const key of rule.immutable) {
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

/** Stamps the creates, collects the session_questions ids to prove, and checks the update keys. */
function stageArgs(
  model: ModelName,
  operation: string,
  rule: SessionModelRule,
  args: PlainObject,
  sessionId: string,
): { args: PlainObject; sessionQuestionIds: string[] } {
  const ids: string[] = [];
  const stamp = (data: unknown): unknown => {
    const id = questionRefOf(model, operation, rule, data);
    if (id !== undefined) ids.push(id);
    return stampSession(model, operation, rule, data, sessionId);
  };

  if (UPDATE_OPERATIONS.includes(operation)) {
    assertSessionKeysKept(model, operation, rule, operation === 'upsert' ? args.update : args.data);
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
  const readFilter = session.actor === 'CANDIDATE' ? candidateGate(input, args) : undefined;

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
      : stageArgs(model, operation, sessionRule, args, session.sessionId);

  const scoped = applyOrgScope({ model, rule, operation, args: staged.args, orgId });

  const filters: PlainObject[] = [];
  if (sessionRule !== undefined) filters.push(sessionRule.filter(session.sessionId));
  if (readFilter !== undefined) filters.push(readFilter);
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
