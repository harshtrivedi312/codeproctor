// Every foreign key in the schema, classified (FU-DB-64), and from it the side of every relation
// field that holds the key (FU-DB-63). Production code reads this table, not Prisma's internal
// runtime data model. org-scope-relations.spec.ts derives the foreign keys from prisma/schema.prisma
// and fails when one is missing, unclassified, classified twice, or on the wrong side, so a new
// foreign key breaks the build until it is classified here.
//
// Why it matters. The org scope filters the top-level model. A foreign key that points into
// another org is invisible to it, so every id that is written into such a column must be loaded
// through the scoped client first, and a miss answered 404 (ADR 0006 section 2, rule (i)). The 26
// foreign keys of class RULE_I below are exactly the ones rule (i) applies to
// (RULE_I_REFERENCES). Module tests and code review use that list.
//
// All 62 foreign keys of the schema, one class each:
//   ORG_ID     10   the org_id column of a model with its own org (to organizations)
//   SCOPE_HOP  21   the first hop of a path model's scope path (its own parent)
//   COMPOSITE   4   (id, org_id) keys on invitations, sessions and scheduled_windows (ADR 0006 section 2 ii)
//   RULE_I     27   rule (i) references: 14 staff (to users) and 13 cross-chain
// (SCOPE_HOP + COMPOSITE + RULE_I is 52; the 10 ORG_ID keys make 62.)
// ADR 0017 section 4.7 (C-53) added three: scheduled_windows.org_id (ORG_ID), the composite
// (invitation_id, org_id) to invitations (COMPOSITE) and scheduled_windows.requested_by (RULE_I, staff).
// 59 before it.
import type { ModelName } from './org-scope-map';

export type FkClass =
  /** The `org_id` column itself. */
  | 'ORG_ID'
  /** The first hop of the model's scope path in ORG_SCOPE: the child's own parent. */
  | 'SCOPE_HOP'
  /** A composite (id, org_id) foreign key: the database refuses a mismatch (ADR 0006 section 2 ii). */
  | 'COMPOSITE'
  /** Rule (i): a reference the scope cannot check; the service loads the id through the scoped client. */
  | 'RULE_I';

/** The two kinds of RULE_I reference: to a user, or into another chain or to a second parent. */
export type RuleIKind = 'staff' | 'cross-chain';

export interface ForeignKey {
  /** The model that holds the key column. */
  readonly model: ModelName;
  /** The relation field on `model` (not the scalar column). */
  readonly field: string;
  /** The model the key points to. */
  readonly target: ModelName;
  /** The relation field on `target` that points back. */
  readonly back: string;
  readonly fkClass: FkClass;
  /** Set for RULE_I only. */
  readonly ruleI?: RuleIKind;
}

const fk = (
  model: ModelName,
  field: string,
  target: ModelName,
  back: string,
  fkClass: FkClass,
  ruleI?: RuleIKind,
): ForeignKey => ({
  model,
  field,
  target,
  back,
  fkClass,
  ...(ruleI === undefined ? {} : { ruleI }),
});

export const FK_CLASSES: readonly ForeignKey[] = [
  // ORG_ID (10): every model with `org_id` has a foreign key to organizations. The scope filters on
  // it; a create is stamped with it.
  fk('User', 'org', 'Organization', 'users', 'ORG_ID'),
  fk('AuditLog', 'org', 'Organization', 'auditLogs', 'ORG_ID'),
  fk('Question', 'org', 'Organization', 'questions', 'ORG_ID'),
  fk('Test', 'org', 'Organization', 'tests', 'ORG_ID'),
  fk('Candidate', 'org', 'Organization', 'candidates', 'ORG_ID'),
  fk('Invitation', 'org', 'Organization', 'invitations', 'ORG_ID'),
  fk('Session', 'org', 'Organization', 'sessions', 'ORG_ID'),
  fk('ConsentText', 'org', 'Organization', 'consentTexts', 'ORG_ID'),
  fk('WebhookEndpoint', 'org', 'Organization', 'webhookEndpoints', 'ORG_ID'),
  // ADR 0017 section 4.7 (C-53).
  fk('ScheduledWindow', 'org', 'Organization', 'scheduledWindows', 'ORG_ID'),

  // SCOPE_HOP (21): the first hop of a scope path (ORG_SCOPE), the child's own parent. The scope reaches the org
  // through it, so a row cannot be read or changed outside its parent's org. Creating a row under a
  // parent of another org, or re-parenting one, is rule (i).
  fk('RefreshToken', 'user', 'User', 'refreshTokens', 'SCOPE_HOP'),
  fk('QuestionVersion', 'question', 'Question', 'versions', 'SCOPE_HOP'),
  fk('TestCase', 'questionVersion', 'QuestionVersion', 'testCases', 'SCOPE_HOP'),
  fk('QuestionVariant', 'questionVersion', 'QuestionVersion', 'variants', 'SCOPE_HOP'),
  fk('VariantTestCase', 'variant', 'QuestionVariant', 'testCaseOverrides', 'SCOPE_HOP'),
  fk(
    'AiReferenceSolution',
    'questionVersion',
    'QuestionVersion',
    'aiReferenceSolutions',
    'SCOPE_HOP',
  ),
  fk('TestSection', 'test', 'Test', 'sections', 'SCOPE_HOP'),
  fk('TestQuestion', 'section', 'TestSection', 'questions', 'SCOPE_HOP'),
  fk('SessionSection', 'session', 'Session', 'sections', 'SCOPE_HOP'),
  fk('SessionQuestion', 'session', 'Session', 'questions', 'SCOPE_HOP'),
  fk('Submission', 'sessionQuestion', 'SessionQuestion', 'submissions', 'SCOPE_HOP'),
  fk('Consent', 'session', 'Session', 'consent', 'SCOPE_HOP'),
  fk('IdentityCheck', 'session', 'Session', 'identityChecks', 'SCOPE_HOP'),
  fk('MediaChunk', 'session', 'Session', 'mediaChunks', 'SCOPE_HOP'),
  fk('ProctorEventBatch', 'session', 'Session', 'proctorEventBatches', 'SCOPE_HOP'),
  fk('ProctorEvent', 'session', 'Session', 'proctorEvents', 'SCOPE_HOP'),
  fk('KeystrokeBatch', 'session', 'Session', 'keystrokeBatches', 'SCOPE_HOP'),
  fk('SessionReview', 'session', 'Session', 'review', 'SCOPE_HOP'),
  fk('FlagDecision', 'event', 'ProctorEvent', 'flagDecision', 'SCOPE_HOP'),
  fk('Appeal', 'sessionReview', 'SessionReview', 'appeal', 'SCOPE_HOP'),
  fk('WebhookDelivery', 'endpoint', 'WebhookEndpoint', 'deliveries', 'SCOPE_HOP'),

  // COMPOSITE (4): composite foreign keys (ADR 0006 section 2 ii). (id, org_id) makes the database
  // refuse a delivery-chain row whose parent is in another org.
  fk('Invitation', 'test', 'Test', 'invitations', 'COMPOSITE'),
  fk('Invitation', 'candidate', 'Candidate', 'invitations', 'COMPOSITE'),
  fk('Session', 'invitation', 'Invitation', 'sessions', 'COMPOSITE'),
  // ADR 0017 section 4.7 (C-53): the SLOT row of an invitation. The key is (invitation_id, org_id), so the
  // database refuses an invitation of another org. The column is nullable (a REVIEW row has none) and the key
  // is MATCH SIMPLE, so a REVIEW row is not checked.
  fk('ScheduledWindow', 'invitation', 'Invitation', 'scheduledWindows', 'COMPOSITE'),

  // RULE_I, staff (14): a reference to a user. A user of any org can be named. Load the user
  // through the scoped client first.
  fk('AuditLog', 'actor', 'User', 'auditLogs', 'RULE_I', 'staff'),
  fk('Question', 'createdBy', 'User', 'createdQuestions', 'RULE_I', 'staff'),
  fk(
    'AiReferenceSolution',
    'collectedBy',
    'User',
    'collectedAiReferenceSolutions',
    'RULE_I',
    'staff',
  ),
  fk('Test', 'createdBy', 'User', 'createdTests', 'RULE_I', 'staff'),
  fk('Invitation', 'createdBy', 'User', 'createdInvitations', 'RULE_I', 'staff'),
  fk('SessionQuestion', 'scoredBy', 'User', 'scoredSessionQuestions', 'RULE_I', 'staff'),
  fk('ConsentText', 'createdBy', 'User', 'createdConsentTexts', 'RULE_I', 'staff'),
  fk('IdentityCheck', 'reviewedBy', 'User', 'reviewedIdentityChecks', 'RULE_I', 'staff'),
  // ADR 0015 section 4: the recruiter who recorded the video ID check on a WAIVED row. Not
  // org-composite, so the service loads the user through the scoped client first, as for reviewedBy.
  fk('IdentityCheck', 'videoCheckBy', 'User', 'videoCheckedIdentityChecks', 'RULE_I', 'staff'),
  fk('SessionReview', 'reviewer', 'User', 'sessionReviews', 'RULE_I', 'staff'),
  fk('FlagDecision', 'reviewer', 'User', 'flagDecisions', 'RULE_I', 'staff'),
  fk('Appeal', 'assignedTo', 'User', 'assignedAppeals', 'RULE_I', 'staff'),
  fk('WebhookEndpoint', 'createdBy', 'User', 'createdWebhookEndpoints', 'RULE_I', 'staff'),
  // ADR 0017 section 4.7 (C-53): the reviewer who requested a REVIEW window. Not org-composite, so the
  // service loads the user through the scoped client first (as for reviewer_id).
  fk('ScheduledWindow', 'requestedBy', 'User', 'requestedScheduledWindows', 'RULE_I', 'staff'),

  // RULE_I, cross-chain (13): references into another chain, or to a second parent. The scope
  // cannot see a mismatch. Load the target through the scoped client first.
  fk(
    'Organization',
    'currentConsentText',
    'ConsentText',
    'currentForOrganizations',
    'RULE_I',
    'cross-chain',
  ),
  fk('RefreshToken', 'replacedBy', 'RefreshToken', 'replaces', 'RULE_I', 'cross-chain'),
  fk(
    'Question',
    'currentVersion',
    'QuestionVersion',
    'currentForQuestions',
    'RULE_I',
    'cross-chain',
  ),
  fk('VariantTestCase', 'testCase', 'TestCase', 'variantOverrides', 'RULE_I', 'cross-chain'),
  fk(
    'AiReferenceSolution',
    'variant',
    'QuestionVariant',
    'aiReferenceSolutions',
    'RULE_I',
    'cross-chain',
  ),
  fk(
    'TestQuestion',
    'questionVersion',
    'QuestionVersion',
    'testQuestions',
    'RULE_I',
    'cross-chain',
  ),
  fk('SessionSection', 'section', 'TestSection', 'sessionSections', 'RULE_I', 'cross-chain'),
  fk(
    'SessionQuestion',
    'testQuestion',
    'TestQuestion',
    'sessionQuestions',
    'RULE_I',
    'cross-chain',
  ),
  fk(
    'SessionQuestion',
    'questionVersion',
    'QuestionVersion',
    'sessionQuestions',
    'RULE_I',
    'cross-chain',
  ),
  fk('SessionQuestion', 'variant', 'QuestionVariant', 'sessionQuestions', 'RULE_I', 'cross-chain'),
  fk('Consent', 'consentText', 'ConsentText', 'consents', 'RULE_I', 'cross-chain'),
  fk(
    'KeystrokeBatch',
    'sessionQuestion',
    'SessionQuestion',
    'keystrokeBatches',
    'RULE_I',
    'cross-chain',
  ),
  fk('WebhookDelivery', 'session', 'Session', 'webhookDeliveries', 'RULE_I', 'cross-chain'),
];

/** The foreign keys that rule (i) applies to: a service must load the id through the scoped client. */
export const RULE_I_REFERENCES: readonly ForeignKey[] = FK_CLASSES.filter(
  (key) => key.fkClass === 'RULE_I',
);

/**
 * One relation field of a model. The nested-write guard (deny by default) only asks whether a field
 * is a relation; `holdsFk`, `fkClass` and `target` are checked against schema.prisma by the
 * completeness test, so the table cannot drift, and are available to rule (i) reviews.
 */
export interface RelationSide {
  readonly target: ModelName;
  /**
   * True when the key column is on this model (a child-side relation: `session.invitation`). False
   * when it is on the related model (a parent-side relation: `organization.users`).
   */
  readonly holdsFk: boolean;
  /** The class of the foreign key behind this relation (both sides carry it). */
  readonly fkClass: FkClass;
}

const SIDES = new Map<string, RelationSide>();
for (const key of FK_CLASSES) {
  SIDES.set(`${key.model}.${key.field}`, {
    target: key.target,
    holdsFk: true,
    fkClass: key.fkClass,
  });
  SIDES.set(`${key.target}.${key.back}`, {
    target: key.model,
    holdsFk: false,
    fkClass: key.fkClass,
  });
}

const SCOPE_HOP_COLUMNS = new Map<ModelName, string>();
for (const key of FK_CLASSES) {
  // The column of a first-hop key is its relation field plus `Id` (`test` -> `testId`). The
  // completeness test checks that against the schema, so a key named differently breaks the build.
  if (key.fkClass === 'SCOPE_HOP') SCOPE_HOP_COLUMNS.set(key.model, `${key.field}Id`);
}

/**
 * The scalar column that holds the first hop of a path model's scope path (`testId` of TestSection,
 * `sessionId` of ProctorEvent, `userId` of RefreshToken), or `undefined` for a model without one.
 * System scope refuses to change it in an update (FU-DB-107).
 */
export function scopeHopColumn(model: ModelName): string | undefined {
  return SCOPE_HOP_COLUMNS.get(model);
}

/** The relation field `field` of `model`, or `undefined` when it is a scalar, Json or list column. */
export function relationOf(model: ModelName, field: string): RelationSide | undefined {
  return SIDES.get(`${model}.${field}`);
}

/** Every relation field known to the table, as `Model.field`. For the completeness test. */
export function relationKeys(): string[] {
  return [...SIDES.keys()];
}
