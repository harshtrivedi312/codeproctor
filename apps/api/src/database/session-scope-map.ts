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
// candidate update may carry, per model; updates only on sessions, session_questions and media_chunks,
// create only on submissions, identity_checks, the two batch tables and, under the ConsentService
// grant, consents; none on session_sections), the columns a GRANT unlocks for a write (`grantedUpdate`,
// `grantedCreate`), the eleven grant sites (GRANT_SITES), and the `proctor_events` rules (source =
// 'CLIENT' row filter, creates carry it).
//
// The READ column allowlists, the explicit-only columns, `omit` and the `submissions` RUN filter are in
// candidate-interim.ts (the file keeps its PR 1 name: the consent-access scan of Database B pins the
// path). The fluent API (CS-4.5 vector 6) arrives as a relation select and is refused by vector 2.
import { MediaStream } from '../generated/prisma/enums.js';
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
  | 'questions'
  /**
   * `test_questions` (under its grant): `sessionQuestions: { some: { sessionId } }`, so the grant reaches
   * only a test question that one of THIS session's questions points to. CS-4.3 names `id IN grant.ids`
   * alone; the session filter is the stricter reading (FU-DB-212): without it a service that passed another
   * candidate's `test_question_id` would read its `section_id`.
   */
  | 'testQuestions';

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
 * What an object-key rule reads of the write it checks: the values of the same row that the parts of the
 * key must equal (`stream`, `segment` and `seq` of a media chunk, the `attempt` of an identity check).
 * Only the columns the rule names in `binds` are present, unwrapped from `{ set }`.
 */
export type ObjectKeyBinding = Readonly<Record<string, unknown>>;

/** One column's object-key rule (see CANDIDATE_OBJECT_KEYS). */
export interface ObjectKeyRule {
  /** The columns of the same write that the key's own parts must equal, when the write carries them. */
  readonly binds: readonly string[];
  /** What such a column is on a create that leaves it out: the schema default. */
  readonly defaults: Readonly<Record<string, number>>;
  /**
   * True when `path` (the key after `orgs/{orgId}/sessions/{sessionId}/`) is in this column's folder, has
   * its shape and agrees with `bound`. A function and not a RegExp on purpose: the patterns stay private
   * to this module, because freezing a RegExp does not stop `RegExp.prototype.compile` from rewriting it.
   */
  readonly accepts: (path: string, bound: ObjectKeyBinding) => boolean;
}

// The patterns of ADR 0013 section 5.7. Module-private: nothing outside can reach one to `compile` it.
// A ULID is 26 characters of Crockford base32 (no I, L, O or U).
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
// The stream is the MediaStream enum of the schema, not a free word.
const MEDIA_KEY = new RegExp(
  `^media/(${Object.values(MediaStream).join('|')})/(\\d{6})/(\\d{8})\\.webm$`,
);
// Only the sealed copies: id_image_key and selfie_key never point to the upload, which can be re-PUT
// within its 60 s URL and is deleted once sealed (section 5.7). The attempt has no leading zero.
const ID_IMAGE_KEY = new RegExp(`^identity/([1-9]\\d{0,2})/sealed/id-${ULID}\\.jpg$`);
const SELFIE_KEY = new RegExp(`^identity/([1-9]\\d{0,2})/sealed/selfie-${ULID}\\.jpg$`);
// An EVENT frame. The sealed re-check frame (evidence/sealed/) belongs to the server-written
// FACE_MISMATCH row, never to a CLIENT event.
const EVIDENCE_KEY = new RegExp(`^evidence/${ULID}\\.jpg$`);

/** A part of the key equals the row's value, when the write carries one. */
const sameText = (given: unknown, part: string | undefined): boolean =>
  given === undefined || given === part;
const sameInt = (given: unknown, part: string | undefined): boolean =>
  given === undefined ||
  (typeof given === 'number' && part !== undefined && given === Number(part));

/**
 * The object keys a candidate write may carry (ADR 0013 section 5.7, ADR 0004 section 9.2): the key must
 * be `orgs/{orgId}/sessions/{sessionId}/` (the scope's own, lower-cased) followed by a path in the folder
 * and shape section 5.7 fixes for that column, and the parts of the key (the stream, segment and seq of a
 * media chunk, the attempt of an identity check) must equal the row's own values when the same write
 * carries them (a create that leaves out `segment` or `attempt` gets the schema default). A key of
 * another session, another org, a traversal (`..`, `//`, a leading `/`) or a shape that is not the layout
 * is refused, and the refusal never echoes the key. `null` is accepted on a create only (it points
 * nowhere). Every column a candidate may write whose name ends in `Key` must be here: a spec checks.
 */
export const CANDIDATE_OBJECT_KEYS: Readonly<
  Partial<Record<ModelName, Readonly<Record<string, ObjectKeyRule>>>>
> = deepFreeze({
  // media/{stream}/{segment:06d}/{seq:08d}.webm
  MediaChunk: {
    objectKey: {
      binds: ['stream', 'segment', 'seq'],
      defaults: { segment: 0 },
      accepts: (path, bound) => {
        const m = MEDIA_KEY.exec(path);
        return (
          m !== null &&
          sameText(bound.stream, m[1]) &&
          sameInt(bound.segment, m[2]) &&
          sameInt(bound.seq, m[3])
        );
      },
    },
  },
  // identity/{attempt}/sealed/{id|selfie}-{ULID}.jpg
  IdentityCheck: {
    idImageKey: {
      binds: ['attempt'],
      defaults: { attempt: 1 },
      accepts: (path, bound) => {
        const m = ID_IMAGE_KEY.exec(path);
        return m !== null && sameInt(bound.attempt, m[1]);
      },
    },
    selfieKey: {
      binds: ['attempt'],
      defaults: { attempt: 1 },
      accepts: (path, bound) => {
        const m = SELFIE_KEY.exec(path);
        return m !== null && sameInt(bound.attempt, m[1]);
      },
    },
  },
  // evidence/{ULID}.jpg
  ProctorEvent: {
    evidenceKey: { binds: [], defaults: {}, accepts: (path) => EVIDENCE_KEY.test(path) },
  },
});

/**
 * Event types a candidate create may not carry (CS-4.4: SERVER events come only from SERVICE scope, and
 * a CLIENT row must be one the browser can send): exactly the EVENT_TYPES of packages/shared that are not
 * in CLIENT_EVENT_TYPES (the server-written ones, ADR 0010), 12 of them. `FACE_MISMATCH` is not here: it
 * is still in CLIENT_EVENT_TYPES, and ADR 0013 section 5.6 says the server accepts it from older clients
 * until ADR 0010 is amended. Such a row is stamped `source = 'CLIENT'`, so the candidate read filter and
 * the review treat it as client-reported (FU-DB-197). A spec compares the list with packages/shared, so a
 * new event type fails until it is classified. #126 nit 4.
 */
export const SERVER_ONLY_EVENT_TYPES: readonly string[] = deepFreeze([
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

/** How a grant filters (ADR 0013 CS-4.4, ADR 0006 section 8.5). */
export type GrantMode =
  /** `id IN ids` is ANDed into every query on the grant's model (reads, updates, and the rest). */
  | 'rows'
  /** A create grant: there is no `where`, so `ids` constrain the create's own session key instead. */
  | 'create';

/**
 * What a query sees of an active grant (org-context.ts builds the live object; the pure functions only
 * read these four fields). `columns` are Prisma field names, `ids` are normalised (lower-case uuids, or
 * bigint for media_chunks).
 */
export interface GrantView {
  readonly model: string;
  readonly columns: readonly string[];
  readonly ids: readonly (string | bigint)[];
  readonly mode: GrantMode;
}

/**
 * One grant site of ADR 0013 CS-4.4's table (the FU-DB-67 call-site entries): the model, the columns it
 * unlocks and how the ids filter. A grant must name a model and a non-empty subset of the columns of ONE
 * site of that model, so one grant cannot join two services' columns (`status` with `hmacKeyEnc`). The
 * site names are for messages and for the call-site test; the extension knows a grant only by its model
 * and columns. `idKind`: `uuid`, or `bigint` for media_chunks, whose primary key is an identity counter.
 */
export interface GrantSite {
  readonly name: string;
  readonly model: ModelName;
  readonly columns: readonly string[];
  readonly mode: GrantMode;
  readonly idKind: 'uuid' | 'bigint';
}

/**
 * The eleven grant sites (ADR 0013 CS-4.4 table; ADR 0006 section 8.5 as amended by the hub, item 9).
 * `CandidateSessionGuard` has no grant (DL-31). What each site unlocks:
 *   - read of an explicit-only column (hmacKeyEnc, deviceInfo, objectKey, the two settings,
 *     accommodations, testQuestionId): the column is also named in CANDIDATE_READ.explicit;
 *   - the write of a column that is writable only under a grant (`grantedUpdate`: status, pauseReasons,
 *     submittedAt, deviceInfo);
 *   - the read of a model that is readable only under a grant (`grant-only`: consent_texts,
 *     test_questions);
 *   - the one candidate create of `consents` (`grantedCreate`), whose `ids` constrain `sessionId`.
 */
export const GRANT_SITES: readonly GrantSite[] = deepFreeze([
  {
    name: 'SessionStateService',
    model: 'Session',
    columns: ['status', 'pauseReasons', 'submittedAt'],
    mode: 'rows',
    idKind: 'uuid',
  },
  { name: 'KeyService', model: 'Session', columns: ['hmacKeyEnc'], mode: 'rows', idKind: 'uuid' },
  {
    name: 'DeviceInfoService',
    model: 'Session',
    columns: ['deviceInfo'],
    mode: 'rows',
    idKind: 'uuid',
  },
  {
    name: 'StorageService',
    model: 'MediaChunk',
    columns: ['objectKey'],
    mode: 'rows',
    idKind: 'bigint',
  },
  {
    name: 'OrgSettingsService',
    model: 'Organization',
    columns: ['settings'],
    mode: 'rows',
    idKind: 'uuid',
  },
  {
    name: 'TestSettingsService',
    model: 'Test',
    columns: ['settings'],
    mode: 'rows',
    idKind: 'uuid',
  },
  {
    name: 'AccommodationsService',
    model: 'Invitation',
    columns: ['accommodations'],
    mode: 'rows',
    idKind: 'uuid',
  },
  {
    name: 'SectionGateService (step 1)',
    model: 'SessionQuestion',
    columns: ['testQuestionId'],
    mode: 'rows',
    idKind: 'uuid',
  },
  {
    name: 'SectionGateService (step 2)',
    model: 'TestQuestion',
    columns: ['id', 'sectionId'],
    mode: 'rows',
    idKind: 'uuid',
  },
  {
    name: 'ConsentService (consent text)',
    model: 'ConsentText',
    columns: ['id', 'version', 'bodyMd', 'legalApprovedAt'],
    mode: 'rows',
    idKind: 'uuid',
  },
  {
    name: 'ConsentService (create)',
    model: 'Consent',
    columns: [
      'sessionId',
      'consentTextId',
      'signedName',
      'signedAt',
      'declinedAt',
      'ip',
      'userAgent',
    ],
    mode: 'create',
    idKind: 'uuid',
  },
]);

export type CandidateModelRule =
  /**
   * A session-path model (CS-4.2). Its WRITE columns are the CS-4.4 "Write" column, as an allowlist:
   * `create` and `update` list the columns a candidate create and a candidate update may carry. A
   * missing list means the operation is refused (`update` missing: create only; `create` missing:
   * update only; both missing: the model is read-only). Anything not listed throws. Columns that CS-4.4
   * writable only under a grant are in `grantedUpdate` and `grantedCreate`: they are writable while a
   * grant of this model names them, and a grant never adds an operation the lists above refuse. Its READ
   * columns are limited by CANDIDATE_READ (candidate-interim.ts).
   */
  | {
      readonly kind: 'session';
      /** Columns a candidate create may carry (the session key `sessionId` included, which must match). */
      readonly create?: readonly string[];
      /** Columns a candidate update may write. The session keys are never among them. */
      readonly update?: readonly string[];
      /**
       * Columns an UPDATE may write only while a grant of this model names them (CS-4.4: `sessions.status`,
       * `pauseReasons`, `submittedAt` under the SessionStateService grant, `deviceInfo` under
       * DeviceInfoService). Needs `update` to be set: a grant does not make a model updatable. Only the
       * column is unlocked; the transition rules (CS-4.4a) are the service's.
       */
      readonly grantedUpdate?: readonly string[];
      /**
       * A model with NO ungranted create whose create is allowed while a create grant of this model is
       * active: the columns the grant may unlock (the consents create: the five written columns and the
       * two checked keys). `create` is then unset.
       */
      readonly grantedCreate?: readonly string[];
      /**
       * The only create operations allowed (default: all four). The consents create is `create` alone:
       * one row per session (`UNIQUE(session_id)`), so no batch and no upsert.
       */
      readonly createOperations?: readonly string[];
      /**
       * Columns a create must carry. The extension verifies them (the session key against the context
       * and the grant's ids; `consentTextId` against the org's current text) instead of stamping them.
       */
      readonly createRequired?: readonly string[];
      /**
       * Columns a create may carry only on a row whose `column` equals `equals` (submissions: `results`,
       * `passed` and `total` only on a RUN row, CS-4.4). A row that names one with another value, or none,
       * is refused.
       */
      readonly createWhen?: {
        readonly columns: readonly string[];
        readonly column: string;
        readonly equals: string;
      };
      /**
       * Exactly one of these two columns is set in a create (the database CHECK, thrown first with no
       * value in it): consents `signedAt` and `declinedAt`.
       */
      readonly createXor?: readonly [string, string];
      /**
       * A create that sets the key column must also carry the value column as a non-empty string
       * (consents: `signedAt` needs the typed name, `consents_check1`).
       */
      readonly createNeeds?: Readonly<Record<string, string>>;
      /**
       * The create names a consent text that the extension checks against the organisation's current one
       * (`organizations.current_consent_text_id`, one read on the factory client) before the insert. Only
       * the consents create sets it.
       */
      readonly checksConsentText?: boolean;
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
    }
  /** Read-only: every write operation throws. */
  | { readonly kind: 'read'; readonly filter: CandidateReadFilter }
  /**
   * Readable only under a grant (`consent_texts`, `test_questions`; CS-4.3): with no grant of this
   * model every operation throws. Under one, the model is read-only, `id IN grant.ids` is ANDed into
   * every query, and only the columns the grant names are readable (CS-4.4: `consent_texts`
   * `id`, `version`, `body_md`, `legal_approved_at`; `test_questions` `id` and `section_id`).
   */
  | {
      readonly kind: 'grant-only';
      readonly grantSite: string;
      /** A row filter ANDed on top of the grant's `id IN ids` (test_questions: the session's own). */
      readonly filter?: CandidateReadFilter;
    };

/**
 * CS-4.3: the CANDIDATE allowlist. A model that is not here throws (deny by default). The write
 * columns are CS-4.4's "Write" column, by Prisma field name (a name that differs from the ADR's
 * snake_case follows the schema; `sourceCode` is `source_code`).
 */
export const CANDIDATE_MODELS: Readonly<Partial<Record<ModelName, CandidateModelRule>>> =
  deepFreeze({
    // Session-path models (CS-4.2).
    // CS-4.4: `last_heartbeat`; `device_info` only under the DeviceInfoService grant; `status`,
    // `pause_reasons`, `submitted_at` only under the SessionStateService grant (the grant unlocks the
    // column, the CS-4.4a transition rules are the service's). No create, no delete.
    Session: {
      kind: 'session',
      update: ['lastHeartbeat'],
      grantedUpdate: ['status', 'pauseReasons', 'submittedAt', 'deviceInfo'],
    },
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
    // CS-4.4 (item 9, ADR 0013 PR #178): CREATE ONLY, and only under the ConsentService (create) grant
    // (`ids` = [ctx.sessionId]). No update, delete or upsert, and no createMany: sign and decline are one
    // `create` each, and write-once is `UNIQUE(session_id)` plus the CHECKs (a second create is P2002,
    // which BE-07 maps to 409). The create carries `sessionId` and `consentTextId`, which the service sets
    // (Prisma's unchecked create input requires them) and the extension VERIFIES: `sessionId` must be the
    // scope's own and in the grant's ids, `consentTextId` must be the org's current text. The five written
    // columns are `signedName`, `signedAt`, `declinedAt`, `ip`, `userAgent`; `pdfKey`, `pdfGeneratedAt` and
    // `copyEmailedAt` stay with the consent-PDF job. The row a create returns omits `signedName`, `ip` and
    // `userAgent` (read allowlist, candidate-interim.ts). This replaces PR 1's update-only, write-once
    // update path (FU-DB-195 (h)).
    Consent: {
      kind: 'session',
      grantedCreate: [
        'sessionId',
        'consentTextId',
        'signedName',
        'signedAt',
        'declinedAt',
        'ip',
        'userAgent',
      ],
      createOperations: ['create'],
      createRequired: ['sessionId', 'consentTextId'],
      createXor: ['signedAt', 'declinedAt'],
      createNeeds: { signedAt: 'signedName' },
      checksConsentText: true,
    },
    // CS-4.4: create only: `session_question_id`, `kind` (RUN or SUBMIT), `language`, `source_code`, and
    // `results`, `passed`, `total` on a RUN row only (the read side has the RUN filter, candidate-interim.ts).
    Submission: {
      kind: 'session',
      create: ['sessionQuestionId', 'kind', 'language', 'sourceCode', 'results', 'passed', 'total'],
      createWhen: { columns: ['results', 'passed', 'total'], column: 'kind', equals: 'RUN' },
    },
    // Read-only.
    Organization: { kind: 'read', filter: 'org' },
    Candidate: { kind: 'read', filter: 'candidate' },
    Invitation: { kind: 'read', filter: 'invitation' },
    Test: { kind: 'read', filter: 'test' },
    TestSection: { kind: 'read', filter: 'sections' },
    Question: { kind: 'read', filter: 'questions' },
    // Readable only under a grant of that model (CS-4.3): `id IN grant.ids`, and the grant's columns.
    ConsentText: { kind: 'grant-only', grantSite: 'ConsentService' },
    TestQuestion: {
      kind: 'grant-only',
      grantSite: 'SectionGateService (step 2)',
      filter: 'testQuestions',
    },
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
    case 'testQuestions':
      return { sessionQuestions: { some: { sessionId } } };
  }
}
