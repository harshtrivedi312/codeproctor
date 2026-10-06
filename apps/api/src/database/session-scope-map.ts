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
// In this file from CS-4.4: the WRITE column as an allowlist (which columns a candidate create and a
// candidate update may carry, per model; updates only on sessions, session_questions and consents,
// create only on submissions, identity_checks and the two batch tables, none on session_sections),
// and the `proctor_events` rules (source = 'CLIENT' row filter, creates carry it).
//
// Out of this file, on purpose (ADR 0013 CS-4 PR 2): the READ column allowlists and `omit`, grants,
// and the `submissions` RUN filter (CS-4.4). Until PR 2, candidate-interim.ts closes the read columns
// on a list that is the complement of CS-4.4's read column. The fluent API (CS-4.5 vector 6) arrives as
// a relation select and is refused by vector 2.
import { deepFreeze } from './deep-freeze';
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
export const SESSION_SCOPE: Readonly<Partial<Record<ModelName, SessionModelRule>>> = deepFreeze({
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
});

export function sessionRuleFor(model: string): SessionModelRule | undefined {
  return Object.hasOwn(SESSION_SCOPE, model) ? SESSION_SCOPE[model as ModelName] : undefined;
}

/** The operations that only read. Everything else in SCOPED_OPERATIONS writes. */
export const READ_OPERATIONS: readonly string[] = deepFreeze([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

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

/**
 * Columns that no candidate write names, ever (the review's rule): the primary key (a create that names
 * `id` is also an existence oracle, because the primary-key collision answers P2002), the org, and the
 * timestamps the server keeps.
 */
export const NEVER_WRITTEN_BY_CANDIDATE: readonly string[] = deepFreeze([
  'id',
  'orgId',
  'createdAt',
  'updatedAt',
]);

/**
 * The object keys a candidate write may carry (ADR 0013 section 5.7, ADR 0004 section 9.2): the key must
 * be `orgs/{orgId}/sessions/{sessionId}/` (the scope's own, lower-cased) followed by a path that matches
 * the pattern here, the folder section 5.7 fixes for that column. A key of another session, another org,
 * a traversal (`..`, `//`, a leading `/`) or a shape that is not the layout is refused, and the refusal
 * never echoes the key. `null` is accepted on a create only (it points nowhere). Every column a
 * candidate may write whose name ends in `Key` must be here: a spec checks.
 */
export const CANDIDATE_OBJECT_KEYS: Readonly<
  Partial<Record<ModelName, Readonly<Record<string, RegExp>>>>
> = deepFreeze({
  // media/{stream}/{segment:06d}/{seq:08d}.webm
  MediaChunk: { objectKey: /^media\/[A-Za-z_]+\/\d{6}\/\d{8}\.webm$/ },
  // identity/{attempt}/{id|selfie}-{ULID}.jpg, or the sealed copy identity/{attempt}/sealed/... the
  // identity_checks columns point to (section 5.7: the server derives them from the issued names)
  IdentityCheck: {
    idImageKey: /^identity\/\d{1,3}\/(?:sealed\/)?id-[A-Za-z0-9]+\.jpg$/,
    selfieKey: /^identity\/\d{1,3}\/(?:sealed\/)?selfie-[A-Za-z0-9]+\.jpg$/,
  },
  // evidence/{ULID}.jpg: an EVENT frame. The sealed re-check frame (evidence/sealed/) belongs to the
  // server-written FACE_MISMATCH row, never to a CLIENT event.
  ProctorEvent: { evidenceKey: /^evidence\/[A-Za-z0-9]+\.jpg$/ },
});

/**
 * Event types a candidate create may not carry (CS-4.4: SERVER events come only from SERVICE scope, and
 * a CLIENT row must be one the browser can send). The list is every type in EVENT_TYPES that is not in
 * CLIENT_EVENT_TYPES of packages/shared (the server-written ones, ADR 0010), plus FACE_MISMATCH, which
 * ADR 0013 section 5.6 makes a server re-check (it leaves CLIENT_EVENT_TYPES when the SDK ships). A spec
 * compares it with packages/shared, so a new event type fails until it is classified. #126 nit 4.
 */
export const SERVER_ONLY_EVENT_TYPES: readonly string[] = deepFreeze([
  'FACE_MISMATCH',
  'DISCONNECTED',
  'RECONNECTED',
  'PASTE_BURST',
  'TYPING_ANOMALY',
  'CODE_SIMILARITY',
  'AI_LIKENESS',
  'PROCTOR_PAUSE',
  'PROCTOR_MESSAGE',
  'PROCTOR_RESUME',
  'IDLE_THEN_COMPLETE',
  'IDENTITY_MANUAL_REVIEW',
  'RESUME_OTP_FAILED',
]);

export type CandidateModelRule =
  /**
   * A session-path model (CS-4.2). Its WRITE columns are the CS-4.4 "Write" column, as an allowlist:
   * `create` and `update` list the columns a candidate create and a candidate update may carry. A
   * missing list means the operation is refused (`update` missing: create only; `create` missing:
   * update only; both missing: the model is read-only). Anything not listed throws. Its READ columns
   * are limited by CANDIDATE_INTERIM_DENY (candidate-interim.ts) until PR 2.
   *
   * What is interim here is the grants: columns CS-4.4 opens only under a grant (`sessions.status`,
   * `pauseReasons`, `submittedAt` and `deviceInfo`; `session_questions.testQuestionId`) are refused
   * until PR 2 adds `withGrant`.
   */
  | {
      readonly kind: 'session';
      /** Columns a candidate create may carry (the session key `sessionId` included, which must match). */
      readonly create?: readonly string[];
      /** Columns a candidate update may write. The session keys are never among them. */
      readonly update?: readonly string[];
      /**
       * Scalars a CANDIDATE may not write on update, on top of SessionModelRule.immutable: keys that
       * decide what the injected filters of OTHER models reach. `session_questions.questionVersionId`
       * feeds the `questions` filter, `testQuestionId` and `variantId` the question content (CS-4.6).
       * The update allowlist already refuses them; this keeps the sharper message (S1).
       */
      readonly immutable?: readonly string[];
      /** A CS-4.4 row filter ANDed on top of the session filter (proctor_events: source = 'CLIENT'). */
      readonly rowFilter?: PlainObject;
      /** Values a create must carry: stamped when missing, refused when different (CS-4.4). */
      readonly createFixed?: PlainObject;
      /**
       * Values a create may not carry, per column (proctor_events `type`: the server-written event types).
       * A row that names one is refused; the message never echoes it.
       */
      readonly createRefused?: Readonly<Record<string, readonly string[]>>;
      /**
       * A filter ANDed into the `where` of every candidate UPDATE (and of an upsert's where), and of no
       * read: the rows a candidate may still change. consents: only a row that is neither signed nor
       * declined, so the record of a signature is written once (FR-401, C-17).
       */
      readonly updateFilter?: PlainObject;
    }
  /** Read-only: every write operation throws. */
  | { readonly kind: 'read'; readonly filter: CandidateReadFilter }
  /**
   * Readable only under a grant (`consent_texts`, `test_questions`). TODO(ADR 0013 CS-4 PR 2): grants
   * do not exist yet, so in this PR these two models throw in a CANDIDATE scope. PR 2 adds
   * `withGrant`, the `id IN grant.ids` filter and the (`id`, `section_id`) column limit.
   */
  | { readonly kind: 'grant-only'; readonly grantSite: string };

/**
 * CS-4.3: the CANDIDATE allowlist. A model that is not here throws (deny by default). The write
 * columns are CS-4.4's "Write" column, by Prisma field name (a name that differs from the ADR's
 * snake_case follows the schema; `sourceCode` is `source_code`).
 */
export const CANDIDATE_MODELS: Readonly<Partial<Record<ModelName, CandidateModelRule>>> =
  deepFreeze({
    // Session-path models (CS-4.2).
    // CS-4.4: `last_heartbeat`; `device_info` (DeviceInfoService grant) and `status`, `pause_reasons`,
    // `submitted_at` (SessionStateService grant) come with PR 2. No create, no delete.
    Session: { kind: 'session', update: ['lastHeartbeat'] },
    // CS-4.4: `final_code`, `final_language`, `answer`. No create.
    SessionQuestion: {
      kind: 'session',
      update: ['finalCode', 'finalLanguage', 'answer'],
      immutable: ['questionVersionId', 'testQuestionId', 'variantId'],
    },
    // CS-4.4: "none". Its writers are SERVICE jobs and the staff proctor-resume.
    SessionSection: { kind: 'session' },
    // CS-4.4: create only.
    IdentityCheck: {
      kind: 'session',
      create: ['sessionId', 'attempt', 'idImageKey', 'selfieKey', 'livenessPassed'],
    },
    MediaChunk: {
      kind: 'session',
      create: [
        'sessionId',
        'stream',
        'segment',
        'seq',
        'startedAt',
        'durationMs',
        'sizeBytes',
        'uploadedAt',
        'objectKey',
      ],
      update: [
        'stream',
        'segment',
        'seq',
        'startedAt',
        'durationMs',
        'sizeBytes',
        'uploadedAt',
        'objectKey',
      ],
    },
    // CS-4.4: create only.
    ProctorEventBatch: { kind: 'session', create: ['sessionId', 'seq', 'signature', 'eventCount'] },
    // CS-4.4: reads and writes only `source = 'CLIENT'` rows (SERVER events stay hidden), creates carry
    // `source = 'CLIENT'`, and an update writes `duration_ms` only. `severity` is assigned server-side by
    // the batch route, which writes it.
    ProctorEvent: {
      kind: 'session',
      create: [
        'sessionId',
        'type',
        'occurredAt',
        'durationMs',
        'confidence',
        'payload',
        'evidenceKey',
        'batchSeq',
        'severity',
        'source',
      ],
      update: ['durationMs'],
      rowFilter: { source: 'CLIENT' },
      createFixed: { source: 'CLIENT' },
      createRefused: { type: SERVER_ONLY_EVENT_TYPES },
    },
    // CS-4.4: create only.
    KeystrokeBatch: {
      kind: 'session',
      create: ['sessionId', 'sessionQuestionId', 'seq', 'signature', 'startedAt', 'events'],
    },
    // CS-4.4: `signed_name`, `signed_at`, `declined_at`, `ip`, `user_agent`. `consent_text_id` is set
    // server-side and `pdf_key` by the consent-PDF job, so neither is writable here, which also means a
    // candidate cannot create the row (its `consentTextId` is required): update only.
    // The record of a signature is written once: an update reaches only a row that is neither signed
    // nor declined (`updateFilter`), so once signed or declined, `signedName`, `ip` and `userAgent` cannot be
    // rewritten (0 rows). The database CHECK (exactly one of signed_at and declined_at is set) means a row
    // is never in that state, so a candidate update changes nothing today; the row is created, with its
    // server-set consentTextId, by a SERVICE job or an org-scope create, or by PR 2's ConsentService grant.
    Consent: {
      kind: 'session',
      update: ['signedName', 'signedAt', 'declinedAt', 'ip', 'userAgent'],
      updateFilter: { signedAt: null, declinedAt: null },
    },
    // CS-4.4: create only: `session_question_id`, `kind` (RUN or SUBMIT), `language`, `source_code`.
    // `results`, `passed` and `total` are CS-4.4's RUN-row columns: refused until the RUN filter of PR 2.
    Submission: {
      kind: 'session',
      create: ['sessionQuestionId', 'kind', 'language', 'sourceCode'],
    },
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
  });

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
