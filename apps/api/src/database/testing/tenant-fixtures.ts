// One tenant's rows for the TC-008 tests: exactly one row in each of the 31 models, linked the way
// the schema links them (an org, its staff user, a question with a version, test cases and a
// variant, a test with a section, a candidate, an invitation, a session with its sections,
// questions, submission, consent, identity check, media chunk, event batch, event, keystroke
// batch, review, flag decision and appeal, a webhook endpoint and delivery). Synthetic data only.
//
// `rows` has an entry for every model. The type `Record<ModelName, ...>` means a model added to
// schema.prisma fails to compile here until its fixture row exists, so the isolation tests cannot
// silently skip a new model.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { ModelName } from '../org-scope-map';

type Where = Record<string, unknown>;

export interface RowSelector {
  /** Selects this tenant's row in findUnique, update, delete and upsert. */
  readonly unique: Where;
  /** Selects the same row in findMany, findFirst, count, updateMany and deleteMany. */
  readonly filter: Where;
}

export interface TenantFixture {
  readonly label: string;
  readonly orgId: string;
  readonly userId: string;
  readonly rows: Record<ModelName, RowSelector>;
}

const byId = (id: string | bigint): RowSelector => ({ unique: { id }, filter: { id } });
const NOW = new Date('2026-10-05T12:00:00.000Z');

/** Creates the tenant through `client`, which must be allowed to write every table (the owner). */
export async function createTenant(client: PrismaClient, label: string): Promise<TenantFixture> {
  const org = await client.organization.create({ data: { name: `Org ${label}` } });
  const orgId = org.id;

  const user = await client.user.create({
    data: {
      orgId,
      email: `staff-${label}@example.test`,
      fullName: `Staff ${label}`,
      passwordHash: 'not-a-real-hash',
      role: 'RECRUITER',
    },
  });
  const refreshToken = await client.refreshToken.create({
    data: {
      userId: user.id,
      familyId: randomUUID(),
      tokenHash: `rt-${label}-${randomUUID()}`,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    },
  });
  const auditLog = await client.auditLog.create({
    data: { orgId, actorId: user.id, action: 'fixture.created', entityType: 'organization' },
  });
  const consentText = await client.consentText.create({
    data: { orgId, version: '1', bodyMd: 'PLACEHOLDER - NOT APPROVED BY LEGAL' },
  });

  // Content
  const question = await client.question.create({ data: { orgId, slug: `q-${label}` } });
  const questionVersion = await client.questionVersion.create({
    data: {
      questionId: question.id,
      version: 1,
      title: `Question ${label}`,
      statementMd: 'Add two numbers.',
      difficulty: 'EASY',
      allowedLanguages: ['python'],
    },
  });
  const testCase = await client.testCase.create({
    data: { questionVersionId: questionVersion.id, input: '1 2', expectedOutput: '3', position: 0 },
  });
  const variant = await client.questionVariant.create({
    data: { questionVersionId: questionVersion.id, params: {}, renderedStatement: 'Add.' },
  });
  await client.variantTestCase.create({
    data: { variantId: variant.id, testCaseId: testCase.id, input: '2 3', expectedOutput: '5' },
  });
  const aiSolution = await client.aiReferenceSolution.create({
    data: {
      questionVersionId: questionVersion.id,
      assistant: 'synthetic-assistant',
      modelLabel: 'synthetic-model',
      language: 'python',
      solutionCode: 'print(3)',
      collectedAt: NOW,
      collectedById: user.id,
    },
  });

  // Delivery
  const test = await client.test.create({
    data: { orgId, name: `Test ${label}`, durationMinutes: 60 },
  });
  const section = await client.testSection.create({
    data: { testId: test.id, title: 'Section 1', position: 0 },
  });
  const testQuestion = await client.testQuestion.create({
    data: { sectionId: section.id, questionVersionId: questionVersion.id, position: 0 },
  });
  const candidate = await client.candidate.create({
    data: { orgId, email: `candidate-${label}@example.test`, fullName: `Candidate ${label}` },
  });
  const invitation = await client.invitation.create({
    data: {
      orgId,
      testId: test.id,
      candidateId: candidate.id,
      tokenHash: `inv-${label}-${randomUUID()}`,
      windowStart: NOW,
      windowEnd: new Date(NOW.getTime() + 86_400_000),
    },
  });
  const session = await client.session.create({
    data: { orgId, invitationId: invitation.id },
  });
  await client.sessionSection.create({
    data: { sessionId: session.id, sectionId: section.id, position: 0 },
  });
  const sessionQuestion = await client.sessionQuestion.create({
    data: {
      sessionId: session.id,
      testQuestionId: testQuestion.id,
      questionVersionId: questionVersion.id,
      position: 0,
      points: 100,
    },
  });
  const submission = await client.submission.create({
    data: {
      sessionQuestionId: sessionQuestion.id,
      kind: 'RUN',
      language: 'python',
      sourceCode: 'print(3)',
    },
  });

  // Proctoring and review
  const consent = await client.consent.create({
    data: {
      sessionId: session.id,
      consentTextId: consentText.id,
      signedName: `Candidate ${label}`,
      signedAt: NOW,
    },
  });
  const identityCheck = await client.identityCheck.create({ data: { sessionId: session.id } });
  const mediaChunk = await client.mediaChunk.create({
    data: { sessionId: session.id, stream: 'SCREEN', seq: 0, startedAt: NOW, durationMs: 10_000 },
  });
  await client.proctorEventBatch.create({
    data: { sessionId: session.id, seq: 0, signature: Buffer.from('sig'), eventCount: 1 },
  });
  const proctorEvent = await client.proctorEvent.create({
    data: {
      sessionId: session.id,
      batchSeq: 0,
      type: 'TAB_SWITCH',
      severity: 'LOW',
      occurredAt: NOW,
    },
  });
  const keystrokeBatch = await client.keystrokeBatch.create({
    data: {
      sessionId: session.id,
      seq: 0,
      signature: Buffer.from('sig'),
      startedAt: NOW,
      events: [],
    },
  });
  const review = await client.sessionReview.create({
    data: { sessionId: session.id, reviewerId: user.id },
  });
  const flagDecision = await client.flagDecision.create({
    data: { eventId: proctorEvent.id, reviewerId: user.id, decision: 'CONFIRMED' },
  });
  const appeal = await client.appeal.create({
    data: { sessionReviewId: review.id, reason: 'Synthetic appeal reason.' },
  });

  // Integrations
  const endpoint = await client.webhookEndpoint.create({
    data: {
      orgId,
      url: 'https://hooks.example.test/x',
      events: [],
      secretEnc: 'not-a-real-secret',
    },
  });
  const delivery = await client.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      event: 'session.completed',
      sessionId: session.id,
      attempt: 1,
    },
  });

  return {
    label,
    orgId,
    userId: user.id,
    rows: {
      Organization: byId(orgId),
      User: byId(user.id),
      RefreshToken: byId(refreshToken.id),
      AuditLog: byId(auditLog.id),
      Question: byId(question.id),
      QuestionVersion: byId(questionVersion.id),
      TestCase: byId(testCase.id),
      QuestionVariant: byId(variant.id),
      VariantTestCase: {
        unique: { variantId_testCaseId: { variantId: variant.id, testCaseId: testCase.id } },
        filter: { variantId: variant.id, testCaseId: testCase.id },
      },
      AiReferenceSolution: byId(aiSolution.id),
      Test: byId(test.id),
      TestSection: byId(section.id),
      TestQuestion: byId(testQuestion.id),
      Candidate: byId(candidate.id),
      Invitation: byId(invitation.id),
      Session: byId(session.id),
      SessionSection: {
        unique: { sessionId_sectionId: { sessionId: session.id, sectionId: section.id } },
        filter: { sessionId: session.id, sectionId: section.id },
      },
      SessionQuestion: byId(sessionQuestion.id),
      Submission: byId(submission.id),
      ConsentText: byId(consentText.id),
      Consent: byId(consent.id),
      IdentityCheck: byId(identityCheck.id),
      MediaChunk: byId(mediaChunk.id),
      ProctorEventBatch: {
        unique: { sessionId_seq: { sessionId: session.id, seq: 0 } },
        filter: { sessionId: session.id, seq: 0 },
      },
      ProctorEvent: byId(proctorEvent.id),
      KeystrokeBatch: byId(keystrokeBatch.id),
      SessionReview: byId(review.id),
      FlagDecision: byId(flagDecision.id),
      Appeal: byId(appeal.id),
      WebhookEndpoint: byId(endpoint.id),
      WebhookDelivery: byId(delivery.id),
    },
  };
}
