// Inserts what is missing (DB-04). Idempotent: every row has a stable id or natural key, tables with
// one go through `createMany({ skipDuplicates: true })` (INSERT ... ON CONFLICT DO NOTHING), and the
// rows that cannot conflict are checked first:
//  - proctor_events has a GENERATED ALWAYS id, so its rows are inserted once per session, and only
//    when the session has none;
//  - audit_logs is append-only for app_user (no UPDATE, no DELETE), so a row is inserted only when
//    no row with the same actor, action and entity exists.
// Existing rows are never changed, except that the two circular links are filled in when empty:
// organizations.current_consent_text_id and questions.current_version_id.
// The five identity ids are never set.
import type { PrismaClient } from '../../apps/api/src/generated/prisma/client';
import { DEMO_APPROVED_CONSENT_VERSION, buildApprovedDemoConsentText } from './demo-consent';
import { eventKey } from './delivery';
import { DEMO_PASSWORD, requireDevelopment } from './guard';
import type { SeedEnv } from './guard';
import { ID } from './ids';
import type { PasswordHasher } from './passwords';
import type { SeedPlan } from './plan';

export type TableCounts = Readonly<Record<string, number>>;

/** Row counts of all 31 tables, in the order of docs/database.md. */
export async function countRows(client: PrismaClient): Promise<TableCounts> {
  const counters: readonly (readonly [string, () => Promise<number>])[] = [
    ['organizations', () => client.organization.count()],
    ['users', () => client.user.count()],
    ['refresh_tokens', () => client.refreshToken.count()],
    ['audit_logs', () => client.auditLog.count()],
    ['questions', () => client.question.count()],
    ['question_versions', () => client.questionVersion.count()],
    ['test_cases', () => client.testCase.count()],
    ['question_variants', () => client.questionVariant.count()],
    ['variant_test_cases', () => client.variantTestCase.count()],
    ['ai_reference_solutions', () => client.aiReferenceSolution.count()],
    ['tests', () => client.test.count()],
    ['test_sections', () => client.testSection.count()],
    ['test_questions', () => client.testQuestion.count()],
    ['candidates', () => client.candidate.count()],
    ['invitations', () => client.invitation.count()],
    ['sessions', () => client.session.count()],
    ['session_sections', () => client.sessionSection.count()],
    ['session_questions', () => client.sessionQuestion.count()],
    ['submissions', () => client.submission.count()],
    ['consent_texts', () => client.consentText.count()],
    ['consents', () => client.consent.count()],
    ['identity_checks', () => client.identityCheck.count()],
    ['media_chunks', () => client.mediaChunk.count()],
    ['proctor_event_batches', () => client.proctorEventBatch.count()],
    ['proctor_events', () => client.proctorEvent.count()],
    ['keystroke_batches', () => client.keystrokeBatch.count()],
    ['session_reviews', () => client.sessionReview.count()],
    ['flag_decisions', () => client.flagDecision.count()],
    ['appeals', () => client.appeal.count()],
    ['webhook_endpoints', () => client.webhookEndpoint.count()],
    ['webhook_deliveries', () => client.webhookDelivery.count()],
  ];
  const counts: Record<string, number> = {};
  for (const [table, count] of counters) counts[table] = await count();
  return counts;
}

/** Inserts every missing row of the plan. Returns the number of rows inserted per table. */
export async function applySeed(
  client: PrismaClient,
  plan: SeedPlan,
  hashPassword: PasswordHasher,
): Promise<TableCounts> {
  const { content, delivery } = plan;
  const inserted: Record<string, number> = {};
  const record = (table: string, count: number): void => {
    inserted[table] = (inserted[table] ?? 0) + count;
  };

  record(
    'organizations',
    (await client.organization.createMany({ data: [content.organization], skipDuplicates: true }))
      .count,
  );

  // Staff. Hash only the accounts that are missing: a second run does not rehash or reset anything.
  const existingUsers = await client.user.findMany({
    where: {
      OR: [
        { id: { in: content.staff.map((u) => u.id) } },
        { email: { in: content.staff.map((u) => u.email) } },
      ],
    },
    select: { id: true, email: true },
  });
  for (const user of content.staff) {
    const clash = existingUsers.find(
      (row) => row.email.toLowerCase() === user.email && row.id !== user.id,
    );
    if (clash !== undefined) {
      throw new Error(
        `A user with the seeded email ${user.email} already exists with a different id. Use a clean database.`,
      );
    }
  }
  const missing = content.staff.filter((user) => !existingUsers.some((row) => row.id === user.id));
  const staffRows = [];
  for (const user of missing) {
    staffRows.push({
      id: user.id,
      orgId: ID.org,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      passwordHash: await hashPassword(DEMO_PASSWORD),
    });
  }
  record('users', (await client.user.createMany({ data: staffRows, skipDuplicates: true })).count);

  record(
    'consent_texts',
    (await client.consentText.createMany({ data: [content.consentText], skipDuplicates: true }))
      .count,
  );
  await client.organization.updateMany({
    where: { id: ID.org, currentConsentTextId: null },
    data: { currentConsentTextId: ID.consentText },
  });
  record(
    'refresh_tokens',
    (await client.refreshToken.createMany({ data: content.refreshTokens, skipDuplicates: true }))
      .count,
  );

  record(
    'questions',
    (await client.question.createMany({ data: content.questions, skipDuplicates: true })).count,
  );
  record(
    'question_versions',
    (
      await client.questionVersion.createMany({
        data: content.questionVersions,
        skipDuplicates: true,
      })
    ).count,
  );
  for (const version of content.questionVersions) {
    await client.question.updateMany({
      where: { id: version.questionId, currentVersionId: null },
      data: { currentVersionId: version.id as string },
    });
  }
  record(
    'test_cases',
    (await client.testCase.createMany({ data: content.testCases, skipDuplicates: true })).count,
  );
  record(
    'question_variants',
    (
      await client.questionVariant.createMany({
        data: content.questionVariants,
        skipDuplicates: true,
      })
    ).count,
  );
  record(
    'variant_test_cases',
    (
      await client.variantTestCase.createMany({
        data: content.variantTestCases,
        skipDuplicates: true,
      })
    ).count,
  );
  record(
    'ai_reference_solutions',
    (
      await client.aiReferenceSolution.createMany({
        data: content.aiReferenceSolutions,
        skipDuplicates: true,
      })
    ).count,
  );

  record(
    'tests',
    (await client.test.createMany({ data: content.tests, skipDuplicates: true })).count,
  );
  record(
    'test_sections',
    (await client.testSection.createMany({ data: content.testSections, skipDuplicates: true }))
      .count,
  );
  record(
    'test_questions',
    (await client.testQuestion.createMany({ data: content.testQuestions, skipDuplicates: true }))
      .count,
  );

  record(
    'candidates',
    (await client.candidate.createMany({ data: delivery.candidates, skipDuplicates: true })).count,
  );
  record(
    'invitations',
    (await client.invitation.createMany({ data: delivery.invitations, skipDuplicates: true }))
      .count,
  );
  record(
    'sessions',
    (await client.session.createMany({ data: delivery.sessions, skipDuplicates: true })).count,
  );
  record(
    'consents',
    (await client.consent.createMany({ data: delivery.consents, skipDuplicates: true })).count,
  );
  record(
    'identity_checks',
    (await client.identityCheck.createMany({ data: delivery.identityChecks, skipDuplicates: true }))
      .count,
  );
  record(
    'session_sections',
    (
      await client.sessionSection.createMany({
        data: delivery.sessionSections,
        skipDuplicates: true,
      })
    ).count,
  );
  record(
    'session_questions',
    (
      await client.sessionQuestion.createMany({
        data: delivery.sessionQuestions,
        skipDuplicates: true,
      })
    ).count,
  );
  record(
    'submissions',
    (await client.submission.createMany({ data: delivery.submissions, skipDuplicates: true }))
      .count,
  );
  record(
    'proctor_event_batches',
    (
      await client.proctorEventBatch.createMany({
        data: delivery.proctorEventBatches,
        skipDuplicates: true,
      })
    ).count,
  );

  // proctor_events: the id is GENERATED ALWAYS, so there is nothing to conflict on. One statement
  // per session, and only for a session that has no events yet.
  const sessionIds = [...new Set(delivery.proctorEvents.map((event) => event.row.sessionId))];
  for (const sessionId of sessionIds) {
    if ((await client.proctorEvent.count({ where: { sessionId } })) > 0) continue;
    const rows = delivery.proctorEvents
      .filter((event) => event.row.sessionId === sessionId)
      .map((event) => event.row);
    record('proctor_events', (await client.proctorEvent.createMany({ data: rows })).count);
  }

  record(
    'session_reviews',
    (await client.sessionReview.createMany({ data: delivery.sessionReviews, skipDuplicates: true }))
      .count,
  );

  // flag_decisions need the generated event ids. Match stored events to planned ones by session,
  // type and rank by time (see PlannedEvent.key), which does not depend on the run time.
  const eventIds = new Map<string, bigint>();
  const events = await client.proctorEvent.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true, sessionId: true, type: true },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const seenOfType = new Map<string, number>();
  for (const event of events) {
    const group = `${event.sessionId}|${event.type}`;
    const rank = seenOfType.get(group) ?? 0;
    seenOfType.set(group, rank + 1);
    eventIds.set(eventKey(event.sessionId, event.type, rank), event.id);
  }
  const flagRows = delivery.flagDecisions.map((flag) => {
    const eventId = eventIds.get(flag.eventKey);
    if (eventId === undefined)
      throw new Error('A flag decision refers to an event that was not seeded.');
    return { ...flag.row, eventId };
  });
  record(
    'flag_decisions',
    (await client.flagDecision.createMany({ data: flagRows, skipDuplicates: true })).count,
  );

  // audit_logs: append-only for app_user, so check before inserting.
  for (const entry of delivery.auditLogs) {
    const existing = await client.auditLog.findFirst({
      where: {
        orgId: entry.orgId,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
      },
      select: { id: true },
    });
    if (existing === null) {
      await client.auditLog.create({ data: entry });
      record('audit_logs', 1);
    }
  }

  return inserted;
}

/** What applyApprovedDemoConsent did, for the seed's printed summary and the tests. */
export interface ApprovedDemoConsentResult {
  /** 1 when the row was inserted this run, 0 when it already existed (idempotent). */
  readonly inserted: number;
  /** True when this run repointed the organisation's current consent text to the demo row. */
  readonly madeCurrent: boolean;
}

/**
 * Writes the dev-only approved demo consent text (D-69) and makes it the organisation's current text, so
 * the candidate flow can be shown end to end. REFUSES unless APP_ENV is exactly "development": the whole
 * seed already requires that (prisma/seed.ts, guard.ts), and this is a second, independent check right at
 * the approved-row write, so it still holds if the outer guard is ever loosened. Idempotent: the row is an
 * upsert on (orgId, version) and the repoint only moves the org off the placeholder (or an unset) text, so
 * a re-run of `pnpm db:seed` with no reset adds it once and then changes nothing. Separate from applySeed
 * so the core seed, and its "a second run inserts nothing" test, never depend on APP_ENV.
 */
export async function applyApprovedDemoConsent(
  client: PrismaClient,
  env: SeedEnv,
): Promise<ApprovedDemoConsentResult> {
  requireDevelopment(env);
  const row = buildApprovedDemoConsentText();
  const before = await client.consentText.count({
    where: { orgId: row.orgId, version: DEMO_APPROVED_CONSENT_VERSION },
  });
  await client.consentText.upsert({
    where: { orgId_version: { orgId: row.orgId, version: DEMO_APPROVED_CONSENT_VERSION } },
    create: row,
    update: {},
  });
  // Point the org at the demo text, but only when it still points at the placeholder (or nothing): never
  // move it off a text someone set deliberately. A no-op once it already points at the demo row.
  const { count } = await client.organization.updateMany({
    where: {
      id: ID.org,
      OR: [{ currentConsentTextId: ID.consentText }, { currentConsentTextId: null }],
    },
    data: { currentConsentTextId: ID.approvedConsentText },
  });
  return { inserted: before === 0 ? 1 : 0, madeCurrent: count > 0 };
}
