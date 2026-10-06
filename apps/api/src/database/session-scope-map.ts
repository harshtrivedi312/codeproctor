// The session scope map (ADR 0013 section 5.10, rule CS-4): what a scope bound to ONE session adds
// on top of the org scope (ADR 0006). Two actors work in such a scope, and the entry function sets
// the actor (org-context.ts): CANDIDATE (runAsCandidate) and SERVICE (runAsSessionJob).
//
//   SESSION_SCOPE     CS-4.2, both actors. The ten session-path models and the row filter each one
//                     gets (`id = sid`, `session_id = sid`, or, for submissions, `sessionQuestion:
//                     { sessionId }`), the key a create takes from the context, the keys an update
//                     may not change, and the `session_question_id` a create must prove.
//   CANDIDATE_MODELS  CS-4.3, CANDIDATE only. The allowlist, deny by default: a model that is not
//                     listed throws. Read-only models refuse every write, and the row filters of the
//                     models a candidate may read.
//
// Model names are Prisma's (`SessionQuestion`), not table names (`session_questions`). The tests
// check this file against the generated client.
//
// In this file from CS-4.4: the `proctor_events` rules (source = 'CLIENT' row filter, creates carry
// it, updates write `duration_ms` only), and which writes a candidate has on each model (updates only
// on sessions and session_questions, none on session_sections).
//
// Out of this file, on purpose (ADR 0013 CS-4 PR 2): the column allowlists, `omit`, grants and the
// `submissions` RUN filter (CS-4.4). Until PR 2, candidate-interim.ts closes the columns on a fixed
// list. The fluent API (CS-4.5 vector 6) arrives as a relation select and is refused by vector 2.
import type { CandidateFacts } from './org-context';
import { OrgScopeViolationError } from './errors';
import type { ModelName } from './org-scope-map';

type PlainObject = Record<string, unknown>;

export interface SessionModelRule {
  /** The row filter that limits the model to the scope's session (CS-4.2). */
  readonly filter: (sessionId: string) => PlainObject;
  /**
   * The scalar a create takes from the context and may not set to another value: `sessionId`, or
   * `id` on sessions. Absent on submissions, which have no session column.
   */
  readonly createKey?: 'id' | 'sessionId';
  /**
   * The scalars an update may not write, whatever the value (session keys are immutable, CS-4.2).
   * `id` of sessions and of session_questions is listed too (the stricter reading of "session_id or
   * any session_question_id": FU-DB-181).
   */
  readonly immutable: readonly string[];
  /**
   * `sessionQuestionId`: a session_questions id the context cannot check. A create runs one scoped
   * primary-key existence check on it and throws on a miss. `optional`: the column may be null.
   */
  readonly questionRef?: { readonly optional: boolean };
}

const bySessionId: SessionModelRule = {
  filter: (sessionId) => ({ sessionId }),
  createKey: 'sessionId',
  immutable: ['sessionId'],
};

/** CS-4.2: the models the session filter applies to, for both actors. Every other model is org-only. */
export const SESSION_SCOPE: Readonly<Partial<Record<ModelName, SessionModelRule>>> = {
  // `invitationId` decides which invitation, candidate and test the CS-4.3 filters of `invitations`,
  // `candidates` and `tests` reach, and the composite foreign key allows any invitation of the org.
  Session: {
    filter: (sessionId) => ({ id: sessionId }),
    createKey: 'id',
    immutable: ['id', 'invitationId'],
  },
  SessionQuestion: { ...bySessionId, immutable: ['sessionId', 'id'] },
  SessionSection: bySessionId,
  IdentityCheck: bySessionId,
  MediaChunk: bySessionId,
  ProctorEventBatch: bySessionId,
  ProctorEvent: bySessionId,
  KeystrokeBatch: {
    ...bySessionId,
    immutable: ['sessionId', 'sessionQuestionId'],
    questionRef: { optional: true },
  },
  Consent: bySessionId,
  // No session column: the session is reached through its session_question.
  Submission: {
    filter: (sessionId) => ({ sessionQuestion: { sessionId } }),
    immutable: ['sessionQuestionId'],
    questionRef: { optional: false },
  },
};

export function sessionRuleFor(model: string): SessionModelRule | undefined {
  return Object.hasOwn(SESSION_SCOPE, model) ? SESSION_SCOPE[model as ModelName] : undefined;
}

/** The operations that only read. Everything else in SCOPED_OPERATIONS writes. */
export const READ_OPERATIONS: readonly string[] = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
];

export function isReadOperation(operation: string): boolean {
  return READ_OPERATIONS.includes(operation);
}

/** CS-4.3: how a CANDIDATE-readable model is filtered on top of the org filter. */
export type CandidateReadFilter =
  /** `organizations`: `id = ctx.orgId`. The org filter of the tenant root already is that. */
  | 'org'
  /** `candidates`: `id = ctx.candidateId` AND an invitation of this session (S2: a wrong fact narrows). */
  | 'candidate'
  /** `invitations`: `id = ctx.invitationId` AND `sessions: { some: { id: sid } }`. */
  | 'invitation'
  /** `tests`: `id = ctx.testId` AND an invitation of this session. */
  | 'test'
  /** `test_sections`: `sessionSections: { some: { sessionId } }` (injected relation filter). */
  | 'sections'
  /** `questions`: `versions: { some: { sessionQuestions: { some: { sessionId } } } }`. */
  | 'questions';

/** Which writes CS-4.4 grants a candidate on a session-path model. */
export type CandidateWrites =
  /** Creates and updates (the default: the per-column limits are PR 2). */
  | 'any'
  /** Updates only: a candidate never creates the row (sessions, session_questions). */
  | 'no-create'
  /** No write at all (session_sections: its writers are SERVICE jobs and the staff proctor-resume). */
  | 'none';

export type CandidateModelRule =
  /** A session-path model (CS-4.2). Its columns are limited by CS-4.4 (PR 2) and the interim deny list. */
  | {
      readonly kind: 'session';
      readonly writes: CandidateWrites;
      /**
       * Scalars a CANDIDATE may not write on update, on top of SessionModelRule.immutable: keys that
       * decide what the injected filters of OTHER models reach. `session_questions.questionVersionId`
       * feeds the `questions` filter, `testQuestionId` and `variantId` the question content (CS-4.6).
       */
      readonly immutable?: readonly string[];
      /** A CS-4.4 row filter ANDed on top of the session filter (proctor_events: source = 'CLIENT'). */
      readonly rowFilter?: PlainObject;
      /** Values a create must carry: stamped when missing, refused when different (CS-4.4). */
      readonly createFixed?: PlainObject;
      /** An update may write only these columns (CS-4.4: proctor_events `duration_ms` only). */
      readonly updateOnly?: readonly string[];
    }
  /** Read-only: every write operation throws. */
  | { readonly kind: 'read'; readonly filter: CandidateReadFilter }
  /**
   * Readable only under a grant (`consent_texts`, `test_questions`). TODO(ADR 0013 CS-4 PR 2): grants
   * do not exist yet, so in this PR these two models throw in a CANDIDATE scope. PR 2 adds
   * `withGrant`, the `id IN grant.ids` filter and the (`id`, `section_id`) column limit.
   */
  | { readonly kind: 'grant-only'; readonly grantSite: string };

/** CS-4.3: the CANDIDATE allowlist. A model that is not here throws (deny by default). */
export const CANDIDATE_MODELS: Readonly<Partial<Record<ModelName, CandidateModelRule>>> = {
  // Session-path models (CS-4.2).
  Session: { kind: 'session', writes: 'no-create' },
  SessionQuestion: {
    kind: 'session',
    writes: 'no-create',
    immutable: ['questionVersionId', 'testQuestionId', 'variantId'],
  },
  SessionSection: { kind: 'session', writes: 'none' },
  IdentityCheck: { kind: 'session', writes: 'any' },
  MediaChunk: { kind: 'session', writes: 'any' },
  ProctorEventBatch: { kind: 'session', writes: 'any' },
  // CS-4.4: reads and writes only `source = 'CLIENT'` rows (SERVER events stay hidden), creates carry
  // `source = 'CLIENT'`, and an update writes `duration_ms` only.
  ProctorEvent: {
    kind: 'session',
    writes: 'any',
    rowFilter: { source: 'CLIENT' },
    createFixed: { source: 'CLIENT' },
    updateOnly: ['durationMs'],
  },
  KeystrokeBatch: { kind: 'session', writes: 'any' },
  Consent: { kind: 'session', writes: 'any' },
  Submission: { kind: 'session', writes: 'any' },
  // Read-only.
  Organization: { kind: 'read', filter: 'org' },
  Candidate: { kind: 'read', filter: 'candidate' },
  Invitation: { kind: 'read', filter: 'invitation' },
  Test: { kind: 'read', filter: 'test' },
  TestSection: { kind: 'read', filter: 'sections' },
  Question: { kind: 'read', filter: 'questions' },
  // Readable only under a grant (PR 2); refused until then.
  ConsentText: { kind: 'grant-only', grantSite: 'ConsentService' },
  TestQuestion: { kind: 'grant-only', grantSite: 'SectionGateService (step 2)' },
};

export function candidateRuleFor(model: string): CandidateModelRule | undefined {
  return Object.hasOwn(CANDIDATE_MODELS, model) ? CANDIDATE_MODELS[model as ModelName] : undefined;
}

/** A candidate fact the filter needs, or a throw when the guard has not set the facts yet. */
function needFact(
  model: string,
  facts: CandidateFacts | undefined,
  key: keyof CandidateFacts,
): string {
  const value = facts?.[key];
  if (value === undefined) {
    throw new OrgScopeViolationError(
      `${model}: the candidate facts are not set, so the row filter cannot be built ` +
        '(CandidateSessionGuard sets them once, right after loading the session; ADR 0013 CS-4.4).',
    );
  }
  return value;
}

/**
 * The row filter CS-4.3 adds for a model a candidate may read, to be ANDed after the org filter and
 * after the caller's arguments were checked (so the relation filters it uses never trip CS-4.5).
 * `undefined` when the org filter already is the whole rule (`organizations`).
 *
 * A fact is ANDed with a filter derived from the scope's OWN session (`sid`, from the token), so a
 * wrong fact can only narrow: if the guard set another candidate's facts of the same org, the
 * session filter excludes that candidate's invitation, candidate and test, and the read finds
 * nothing (FU-DB-185, DL-31).
 */
export function candidateReadFilter(
  model: string,
  filter: CandidateReadFilter,
  sessionId: string,
  facts: CandidateFacts | undefined,
): PlainObject | undefined {
  const ofThisSession = { invitations: { some: { sessions: { some: { id: sessionId } } } } };
  switch (filter) {
    case 'org':
      return undefined;
    case 'candidate':
      return { id: needFact(model, facts, 'candidateId'), ...ofThisSession };
    case 'invitation':
      return {
        id: needFact(model, facts, 'invitationId'),
        sessions: { some: { id: sessionId } },
      };
    case 'test':
      return { id: needFact(model, facts, 'testId'), ...ofThisSession };
    case 'sections':
      return { sessionSections: { some: { sessionId } } };
    case 'questions':
      return { versions: { some: { sessionQuestions: { some: { sessionId } } } } };
  }
}
