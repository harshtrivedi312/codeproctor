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
import type { UserRole } from '../../generated/prisma/enums.js';
import type { ModelName } from '../org-scope-map';

type Where = Record<string, unknown>;

export interface RowSelector {
  /** Selects this tenant's row in findUnique, update, delete and upsert. */
  readonly unique: Where;
  /** Selects the same row in findMany, findFirst, count, updateMany and deleteMany. */
  readonly filter: Where;
}

/**
 * The staff user's password hash. JwtAuthGuard (BE-02) binds an access token to it through the
 * `pwv` claim and re-reads it on every request, so tokens must be minted from the same value
 * (testing/staff-token.ts).
 */
export const FIXTURE_PASSWORD_HASH = 'not-a-real-hash';

/** The models a CS-4 session scope can reach: the ten session-path models and the six read-only ones. */
export type ChainModel =
  | 'Organization'
  | 'Candidate'
  | 'Invitation'
  | 'Test'
  | 'TestSection'
  | 'Question'
  | 'Session'
  | 'SessionQuestion'
  | 'SessionSection'
  | 'IdentityCheck'
  | 'MediaChunk'
  | 'ProctorEventBatch'
  | 'ProctorEvent'
  | 'KeystrokeBatch'
  | 'Consent'
  | 'Submission';

/**
 * One candidate's whole chain inside an org (ADR 0013 CS-4 tests): the candidate, an invitation to
 * the candidate's own test (with its own section, test question, question and version), the session
 * with its section, question, submission, consent, identity check, media chunk, event batch, event
 * and keystroke batch. Two chains in one org share nothing but the org, the staff user and the
 * consent text, so a filter that lets one candidate see the other's row shows up in every model.
 */
export interface SessionChain {
  readonly label: string;
  readonly orgId: string;
  readonly candidateId: string;
  readonly invitationId: string;
  readonly testId: string;
  readonly sectionId: string;
  readonly testQuestionId: string;
  readonly questionId: string;
  readonly questionVersionId: string;
  readonly sessionId: string;
  readonly sessionQuestionId: string;
  /** The selector of this chain's row in each model a CS-4 scope can reach. */
  readonly rows: Record<ChainModel, RowSelector>;
}

export interface TenantFixture {
  readonly label: string;
  readonly orgId: string;
  readonly userId: string;
  readonly userRole: UserRole;
  readonly passwordHash: string;
  readonly consentTextId: string;
  readonly rows: Record<ModelName, RowSelector>;
  /** The chain of the tenant's own candidate (the one `rows` is made of). */
  readonly chain: SessionChain;
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
      passwordHash: FIXTURE_PASSWORD_HASH,
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
    userRole: 'RECRUITER',
    passwordHash: FIXTURE_PASSWORD_HASH,
    consentTextId: consentText.id,
    chain: {
      label,
      orgId,
      candidateId: candidate.id,
      invitationId: invitation.id,
      testId: test.id,
      sectionId: section.id,
      testQuestionId: testQuestion.id,
      questionId: question.id,
      questionVersionId: questionVersion.id,
      sessionId: session.id,
      sessionQuestionId: sessionQuestion.id,
      rows: {
        Organization: byId(orgId),
        Candidate: byId(candidate.id),
        Invitation: byId(invitation.id),
        Test: byId(test.id),
        TestSection: byId(section.id),
        Question: byId(question.id),
        Session: byId(session.id),
        SessionQuestion: byId(sessionQuestion.id),
        SessionSection: {
          unique: { sessionId_sectionId: { sessionId: session.id, sectionId: section.id } },
          filter: { sessionId: session.id, sectionId: section.id },
        },
        IdentityCheck: byId(identityCheck.id),
        MediaChunk: byId(mediaChunk.id),
        ProctorEventBatch: {
          unique: { sessionId_seq: { sessionId: session.id, seq: 0 } },
          filter: { sessionId: session.id, seq: 0 },
        },
        ProctorEvent: byId(proctorEvent.id),
        KeystrokeBatch: byId(keystrokeBatch.id),
        Consent: byId(consent.id),
        Submission: byId(submission.id),
      },
    },
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

/** Options of createCandidateChain. */
export interface CandidateChainOptions {
  /**
   * Take the test, its section, its test question and the question (with its version) of this chain
   * instead of creating them: two candidates who sit the SAME test (nit 6). Each still gets an
   * invitation, a session, session sections and session questions of their own, so a filter that
   * follows the test cannot tell them apart, and one that follows the session can.
   */
  readonly shareTestWith?: SessionChain;
}

/**
 * A second candidate in an existing tenant, with a whole chain of its own (see SessionChain): its own
 * test, section, question and invitation, so that two candidates of one org can be told apart in
 * every model; or, with `shareTestWith`, the same test as another chain. Created through `client`,
 * which must be allowed to write every table (the owner).
 */
export async function createCandidateChain(
  client: PrismaClient,
  tenant: TenantFixture,
  label: string,
  options: CandidateChainOptions = {},
): Promise<SessionChain> {
  const { orgId } = tenant;
  const shared = options.shareTestWith;

  const question =
    shared === undefined
      ? await client.question.create({ data: { orgId, slug: `q-${label}` } })
      : { id: shared.questionId };
  const questionVersion =
    shared === undefined
      ? await client.questionVersion.create({
          data: {
            questionId: question.id,
            version: 1,
            title: `Question ${label}`,
            statementMd: 'Subtract two numbers.',
            difficulty: 'EASY',
            allowedLanguages: ['python'],
          },
        })
      : { id: shared.questionVersionId };
  const test =
    shared === undefined
      ? await client.test.create({ data: { orgId, name: `Test ${label}`, durationMinutes: 45 } })
      : { id: shared.testId };
  const section =
    shared === undefined
      ? await client.testSection.create({
          data: { testId: test.id, title: `Section ${label}`, position: 0 },
        })
      : { id: shared.sectionId };
  const testQuestion =
    shared === undefined
      ? await client.testQuestion.create({
          data: { sectionId: section.id, questionVersionId: questionVersion.id, position: 0 },
        })
      : { id: shared.testQuestionId };
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
  const session = await client.session.create({ data: { orgId, invitationId: invitation.id } });
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
      sourceCode: 'print(1)',
    },
  });
  const consent = await client.consent.create({
    data: {
      sessionId: session.id,
      consentTextId: tenant.consentTextId,
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
      sessionQuestionId: sessionQuestion.id,
      seq: 0,
      signature: Buffer.from('sig'),
      startedAt: NOW,
      events: [],
    },
  });

  return {
    label,
    orgId,
    candidateId: candidate.id,
    invitationId: invitation.id,
    testId: test.id,
    sectionId: section.id,
    testQuestionId: testQuestion.id,
    questionId: question.id,
    questionVersionId: questionVersion.id,
    sessionId: session.id,
    sessionQuestionId: sessionQuestion.id,
    rows: {
      Organization: byId(orgId),
      Candidate: byId(candidate.id),
      Invitation: byId(invitation.id),
      Test: byId(test.id),
      TestSection: byId(section.id),
      Question: byId(question.id),
      Session: byId(session.id),
      SessionQuestion: byId(sessionQuestion.id),
      SessionSection: {
        unique: { sessionId_sectionId: { sessionId: session.id, sectionId: section.id } },
        filter: { sessionId: session.id, sectionId: section.id },
      },
      IdentityCheck: byId(identityCheck.id),
      MediaChunk: byId(mediaChunk.id),
      ProctorEventBatch: {
        unique: { sessionId_seq: { sessionId: session.id, seq: 0 } },
        filter: { sessionId: session.id, seq: 0 },
      },
      ProctorEvent: byId(proctorEvent.id),
      KeystrokeBatch: byId(keystrokeBatch.id),
      Consent: byId(consent.id),
      Submission: byId(submission.id),
    },
  };
}
