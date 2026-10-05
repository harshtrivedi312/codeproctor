// Every foreign key in the schema, classified (FU-DB-64), and from it the side of every relation
// field that holds the key (FU-DB-63). Production code reads this table, not Prisma's internal
// runtime data model. org-scope-relations.spec.ts derives the foreign keys from prisma/schema.prisma
// and fails when one is missing, unclassified, classified twice, or on the wrong side, so a new
// foreign key breaks the build until it is classified here.
//
// Why it matters. The org scope filters the top-level model. A foreign key that points into
// another org is invisible to it, so every id that is written into such a column must be loaded
// through the scoped client first, and a miss answered 404 (ADR 0006 section 2, rule (i)). The 25
// foreign keys of the two `rule-i-*` kinds below are exactly the ones rule (i) applies to
// (RULE_I_REFERENCES). Module tests and code review use that list.
//
// Counts (58 foreign keys): 9 org-column, 21 scope-hop, 3 composite, 12 staff-ref, 13 cross-chain.
// The 49 that are not org-column are 21 hops + 3 composite + 25 rule (i) references.
import type { ModelName } from './org-scope-map';

export type FkKind =
  /** The `org_id` column itself. */
  | 'org-column'
  /** The first hop of the model's scope path in ORG_SCOPE: the child's own parent. */
  | 'scope-hop'
  /** A composite (id, org_id) foreign key: the database refuses a mismatch (ADR 0006 section 2 ii). */
  | 'composite'
  /** Rule (i): a reference to a user (created_by, reviewer_id, assigned_to, ...). */
  | 'staff-ref'
  /** Rule (i): a reference into another chain, or to a second parent. */
  | 'cross-chain';

export interface ForeignKey {
  /** The model that holds the key column. */
  readonly model: ModelName;
  /** The relation field on `model` (not the scalar column). */
  readonly field: string;
  /** The model the key points to. */
  readonly target: ModelName;
  /** The relation field on `target` that points back. */
  readonly back: string;
  readonly kind: FkKind;
}

const fk = (
  model: ModelName,
  field: string,
  target: ModelName,
  back: string,
  kind: FkKind,
): ForeignKey => ({ model, field, target, back, kind });

export const FK_CLASSES: readonly ForeignKey[] = [
  // The org_id column itself: every model with `org_id` has a foreign key to organizations.
  // The scope filters on it; a create is stamped with it.
  fk('User', 'org', 'Organization', 'users', 'org-column'),
  fk('AuditLog', 'org', 'Organization', 'auditLogs', 'org-column'),
  fk('Question', 'org', 'Organization', 'questions', 'org-column'),
  fk('Test', 'org', 'Organization', 'tests', 'org-column'),
  fk('Candidate', 'org', 'Organization', 'candidates', 'org-column'),
  fk('Invitation', 'org', 'Organization', 'invitations', 'org-column'),
  fk('Session', 'org', 'Organization', 'sessions', 'org-column'),
  fk('ConsentText', 'org', 'Organization', 'consentTexts', 'org-column'),
  fk('WebhookEndpoint', 'org', 'Organization', 'webhookEndpoints', 'org-column'),

  // First hop of a scope path (ORG_SCOPE): the child's own parent. The scope reaches the org
  // through it, so a row cannot be read or changed outside its parent's org. Creating a row under a
  // parent of another org, or re-parenting one, is rule (i).
  fk('RefreshToken', 'user', 'User', 'refreshTokens', 'scope-hop'),
  fk('QuestionVersion', 'question', 'Question', 'versions', 'scope-hop'),
  fk('TestCase', 'questionVersion', 'QuestionVersion', 'testCases', 'scope-hop'),
  fk('QuestionVariant', 'questionVersion', 'QuestionVersion', 'variants', 'scope-hop'),
  fk('VariantTestCase', 'variant', 'QuestionVariant', 'testCaseOverrides', 'scope-hop'),
  fk(
    'AiReferenceSolution',
    'questionVersion',
    'QuestionVersion',
    'aiReferenceSolutions',
    'scope-hop',
  ),
  fk('TestSection', 'test', 'Test', 'sections', 'scope-hop'),
  fk('TestQuestion', 'section', 'TestSection', 'questions', 'scope-hop'),
  fk('SessionSection', 'session', 'Session', 'sections', 'scope-hop'),
  fk('SessionQuestion', 'session', 'Session', 'questions', 'scope-hop'),
  fk('Submission', 'sessionQuestion', 'SessionQuestion', 'submissions', 'scope-hop'),
  fk('Consent', 'session', 'Session', 'consent', 'scope-hop'),
  fk('IdentityCheck', 'session', 'Session', 'identityChecks', 'scope-hop'),
  fk('MediaChunk', 'session', 'Session', 'mediaChunks', 'scope-hop'),
  fk('ProctorEventBatch', 'session', 'Session', 'proctorEventBatches', 'scope-hop'),
  fk('ProctorEvent', 'session', 'Session', 'proctorEvents', 'scope-hop'),
  fk('KeystrokeBatch', 'session', 'Session', 'keystrokeBatches', 'scope-hop'),
  fk('SessionReview', 'session', 'Session', 'review', 'scope-hop'),
  fk('FlagDecision', 'event', 'ProctorEvent', 'flagDecision', 'scope-hop'),
  fk('Appeal', 'sessionReview', 'SessionReview', 'appeal', 'scope-hop'),
  fk('WebhookDelivery', 'endpoint', 'WebhookEndpoint', 'deliveries', 'scope-hop'),

  // Composite foreign keys (ADR 0006 section 2 ii): (id, org_id) makes the database refuse a
  // delivery-chain row whose parent is in another org.
  fk('Invitation', 'test', 'Test', 'invitations', 'composite'),
  fk('Invitation', 'candidate', 'Candidate', 'invitations', 'composite'),
  fk('Session', 'invitation', 'Invitation', 'sessions', 'composite'),

  // Rule (i), staff references: a user of any org can be named. Load the user through the scoped
  // client first.
  fk('AuditLog', 'actor', 'User', 'auditLogs', 'staff-ref'),
  fk('Question', 'createdBy', 'User', 'createdQuestions', 'staff-ref'),
  fk('AiReferenceSolution', 'collectedBy', 'User', 'collectedAiReferenceSolutions', 'staff-ref'),
  fk('Test', 'createdBy', 'User', 'createdTests', 'staff-ref'),
  fk('Invitation', 'createdBy', 'User', 'createdInvitations', 'staff-ref'),
  fk('SessionQuestion', 'scoredBy', 'User', 'scoredSessionQuestions', 'staff-ref'),
  fk('ConsentText', 'createdBy', 'User', 'createdConsentTexts', 'staff-ref'),
  fk('IdentityCheck', 'reviewedBy', 'User', 'reviewedIdentityChecks', 'staff-ref'),
  fk('SessionReview', 'reviewer', 'User', 'sessionReviews', 'staff-ref'),
  fk('FlagDecision', 'reviewer', 'User', 'flagDecisions', 'staff-ref'),
  fk('Appeal', 'assignedTo', 'User', 'assignedAppeals', 'staff-ref'),
  fk('WebhookEndpoint', 'createdBy', 'User', 'createdWebhookEndpoints', 'staff-ref'),

  // Rule (i), cross-chain and second-parent references: the target is in another chain (or
  // another parent of the same chain), so the scope cannot see a mismatch. Load the target through
  // the scoped client first.
  fk('Organization', 'currentConsentText', 'ConsentText', 'currentForOrganizations', 'cross-chain'),
  fk('RefreshToken', 'replacedBy', 'RefreshToken', 'replaces', 'cross-chain'),
  fk('Question', 'currentVersion', 'QuestionVersion', 'currentForQuestions', 'cross-chain'),
  fk('VariantTestCase', 'testCase', 'TestCase', 'variantOverrides', 'cross-chain'),
  fk('AiReferenceSolution', 'variant', 'QuestionVariant', 'aiReferenceSolutions', 'cross-chain'),
  fk('TestQuestion', 'questionVersion', 'QuestionVersion', 'testQuestions', 'cross-chain'),
  fk('SessionSection', 'section', 'TestSection', 'sessionSections', 'cross-chain'),
  fk('SessionQuestion', 'testQuestion', 'TestQuestion', 'sessionQuestions', 'cross-chain'),
  fk('SessionQuestion', 'questionVersion', 'QuestionVersion', 'sessionQuestions', 'cross-chain'),
  fk('SessionQuestion', 'variant', 'QuestionVariant', 'sessionQuestions', 'cross-chain'),
  fk('Consent', 'consentText', 'ConsentText', 'consents', 'cross-chain'),
  fk('KeystrokeBatch', 'sessionQuestion', 'SessionQuestion', 'keystrokeBatches', 'cross-chain'),
  fk('WebhookDelivery', 'session', 'Session', 'webhookDeliveries', 'cross-chain'),
];

/** The foreign keys that rule (i) applies to: a service must load the id through the scoped client. */
export const RULE_I_REFERENCES: readonly ForeignKey[] = FK_CLASSES.filter(
  (key) => key.kind === 'staff-ref' || key.kind === 'cross-chain',
);

/** One relation field of a model: what it points to, and whether this model holds the key. */
export interface RelationSide {
  readonly target: ModelName;
  /**
   * True when the key column is on this model (a child-side relation: `session.invitation`). False
   * when it is on the related model (a parent-side relation: `organization.users`), so connecting
   * or setting through it changes rows of the related model.
   */
  readonly holdsFk: boolean;
}

const SIDES = new Map<string, RelationSide>();
for (const key of FK_CLASSES) {
  SIDES.set(`${key.model}.${key.field}`, { target: key.target, holdsFk: true });
  SIDES.set(`${key.target}.${key.back}`, { target: key.model, holdsFk: false });
}

/** The relation field `field` of `model`, or `undefined` when it is a scalar, Json or list column. */
export function relationOf(model: ModelName, field: string): RelationSide | undefined {
  return SIDES.get(`${model}.${field}`);
}

/** Every relation field known to the table, as `Model.field`. For the completeness test. */
export function relationKeys(): string[] {
  return [...SIDES.keys()];
}
