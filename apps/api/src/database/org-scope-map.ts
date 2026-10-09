// Org scope map (ADR 0006 section 1): how every Prisma model is tied to an organization. The
// Prisma extension in org-scope.extension.ts reads this map and adds the filter, so a query can
// only see or change rows of the caller's org (TC-008, FR-103, NFR-04).
//
// Every model must have an entry. `Record<ModelName, ...>` makes the compiler reject a missing or
// an unknown model, and org-scope-map.spec.ts checks the entries against the generated client's
// own metadata, so a model added to schema.prisma breaks the build and the test until it is
// declared here.
//
// The four kinds of entry:
//   direct    The model has an org_id column (Prisma field `orgId`). Filter: `{ orgId }`.
//             Create payloads must carry the caller's org (or get it added).
//   path      No org_id column. `path` lists relation names, starting at this model and ending at
//             the nearest ancestor that has `orgId`. Every hop is a required to-one relation, so
//             a row cannot sit outside the chain. Filter: `{ session: { orgId } }`, and for deeper
//             paths `{ questionVersion: { question: { orgId } } }`.
//   self      The organization row itself: the tenant root. Filter: `{ id: orgId }`. Creating or
//             replacing organizations is not possible inside an org scope.
//   unscoped  A model that is global on purpose. It needs a written reason. There are none today.
import type { Prisma } from '../generated/prisma/client.js';

export type ModelName = Prisma.ModelName;

export type OrgScopeRule =
  | { readonly kind: 'direct' }
  | { readonly kind: 'self' }
  | { readonly kind: 'path'; readonly path: readonly [string, ...string[]] }
  | { readonly kind: 'unscoped'; readonly reason: string };

const direct: OrgScopeRule = { kind: 'direct' };
const via = (...relations: [string, ...string[]]): OrgScopeRule => ({
  kind: 'path',
  path: relations,
});

export const ORG_SCOPE: Readonly<Record<ModelName, OrgScopeRule>> = {
  // Tenant root.
  Organization: { kind: 'self' },

  // Models with an org_id column (ADR 0006 section 5): users, questions, tests, candidates,
  // invitations, sessions, audit_logs, consent_texts and webhook_endpoints, and, from ADR 0017 section 4.7
  // (C-53), scheduled_windows. Its org scope is the usual one: reads and writes in an org scope see the
  // caller's org only. The one cross-organisation read of it is the system-scope reason SCHEDULE_CAPACITY
  // (org-context.ts, schedule-capacity.ts), an exception that ADR 0006 does not list yet (FU-DB-272).
  User: direct,
  Question: direct,
  Test: direct,
  Candidate: direct,
  Invitation: direct,
  Session: direct,
  AuditLog: direct,
  ConsentText: direct,
  WebhookEndpoint: direct,
  ScheduledWindow: direct,

  // Identity
  RefreshToken: via('user'),

  // Content: everything hangs off a question version, which belongs to a question.
  QuestionVersion: via('question'),
  TestCase: via('questionVersion', 'question'),
  QuestionVariant: via('questionVersion', 'question'),
  VariantTestCase: via('variant', 'questionVersion', 'question'),
  AiReferenceSolution: via('questionVersion', 'question'),

  // Delivery: tests own sections and questions; sessions own what happens during an attempt.
  TestSection: via('test'),
  TestQuestion: via('section', 'test'),
  SessionSection: via('session'),
  SessionQuestion: via('session'),
  Submission: via('sessionQuestion', 'session'),

  // Proctoring and review, all owned by a session.
  Consent: via('session'),
  IdentityCheck: via('session'),
  MediaChunk: via('session'),
  ProctorEventBatch: via('session'),
  ProctorEvent: via('session'),
  KeystrokeBatch: via('session'),
  SessionReview: via('session'),
  FlagDecision: via('event', 'session'),
  Appeal: via('sessionReview', 'session'),

  // Integrations
  WebhookDelivery: via('endpoint'),
};

/** Models that are global on purpose, with the reason for each. Empty: every model is scoped. */
export const UNSCOPED_MODELS: ReadonlyArray<{
  readonly model: ModelName;
  readonly reason: string;
}> = (Object.entries(ORG_SCOPE) as Array<[ModelName, OrgScopeRule]>).flatMap(([model, rule]) =>
  rule.kind === 'unscoped' ? [{ model, reason: rule.reason }] : [],
);

type PlainObject = Record<string, unknown>;

/**
 * The where-filter that limits a model to one org, or `undefined` for an unscoped model.
 * A path of ['questionVersion', 'question'] becomes { questionVersion: { question: { orgId } } }.
 */
export function orgFilter(rule: OrgScopeRule, orgId: string): PlainObject | undefined {
  switch (rule.kind) {
    case 'direct':
      return { orgId };
    case 'self':
      return { id: orgId };
    case 'path':
      return rule.path.reduceRight<PlainObject>((inner, relation) => ({ [relation]: inner }), {
        orgId,
      });
    case 'unscoped':
      return undefined;
  }
}
