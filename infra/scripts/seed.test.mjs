// Tests for the development seed (DB-04): the refusals that come before any connection (Q-28,
// ADR 0009 section 4.4) and the content of the seed plan, checked without a database. The plan is
// plain data built by prisma/seed/plan.ts, so these tests also stand in for the schema's CHECK
// constraints and foreign keys. A run against a real database is DB-08's job; DB-04 verified it by
// running `pnpm db:seed` twice. The reference solutions are run by seed-solutions.test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { REPO_ROOT, createSandbox } from './test-support.mjs';

const load = (path) => tsImport(path, import.meta.url);
const { buildSeedPlan } = await load('../../prisma/seed/plan.ts');
const guard = await load('../../prisma/seed/guard.ts');
const { STAFF, TEST_KEYS } = await load('../../prisma/seed/content.ts');
const risk = await load('../../prisma/seed/risk.ts');
const { seedId } = await load('../../prisma/seed/ids.ts');
const { codingQuestions } = await load('../../prisma/seed/questions/index.ts');
const { mcqQuestion, shortAnswerQuestion, CONSENT_PLACEHOLDER_PREFIX } = await load(
  '../../prisma/seed/non-coding.ts',
);
const { renderTemplate, SAFE_PARAM_VALUE } = await load('../../prisma/seed/mustache.ts');
const shared = await load('../../packages/shared/src/events.ts');

const NOW = new Date('2026-10-05T12:00:00.000Z');
const plan = buildSeedPlan(NOW);
const { content, delivery } = plan;
const DEMO_PASSWORD = guard.DEMO_PASSWORD;

// ---------- Refusals before any connection (Q-28) ----------

/** A listener that only counts connections: a refusal must never reach it. */
async function startCountingListener() {
  const state = { connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    url: `postgresql://app_user:listener-secret-pw@127.0.0.1:${port}/codeproctor`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Runs prisma/seed.ts directly with an explicit environment and stdin closed. */
function runSeed(env) {
  const sandbox = createSandbox();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], {
      cwd: REPO_ROOT,
      env: sandbox.env(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      sandbox.remove();
      resolve({ status, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

function assertNoSecrets(result) {
  assert.doesNotMatch(
    result.output,
    new RegExp(
      `${DEMO_PASSWORD.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&')}|listener-secret-pw|postgresql://`,
    ),
  );
}

test('Q-28: APP_ENV unset refuses before the seed connects, and prints no secret', async () => {
  const listener = await startCountingListener();
  try {
    const result = await runSeed({
      DATABASE_URL: listener.url,
      MIGRATION_DATABASE_URL: listener.url,
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /APP_ENV is unset/);
    assert.match(result.stderr, /Q-28/);
    assert.equal(listener.state.connections, 0, 'the seed connected although APP_ENV was unset');
    assertNoSecrets(result);
  } finally {
    await listener.close();
  }
});

test('Q-28: APP_ENV empty, production, staging, pilot or a different spelling refuses before connecting', async () => {
  const listener = await startCountingListener();
  try {
    for (const value of ['', 'production', 'staging', 'pilot', 'Development', ' development']) {
      const result = await runSeed({
        APP_ENV: value,
        DATABASE_URL: listener.url,
        MIGRATION_DATABASE_URL: listener.url,
      });
      assert.equal(result.status, 1, `APP_ENV=${JSON.stringify(value)}: ${result.output}`);
      assert.match(result.stderr, /refusing to seed: APP_ENV is /);
      assertNoSecrets(result);
    }
    assert.equal(listener.state.connections, 0, 'the seed connected although APP_ENV was refused');
  } finally {
    await listener.close();
  }
});

test('Q-28: requireDevelopment accepts only the exact value "development"', () => {
  assert.doesNotThrow(() => guard.requireDevelopment({ APP_ENV: 'development' }));
  for (const env of [{}, { APP_ENV: '' }, { APP_ENV: 'production' }, { APP_ENV: 'Development' }]) {
    assert.throws(() => guard.requireDevelopment(env), guard.SeedRefusal);
  }
});

test('ADR-0009 4.4: with APP_ENV=development, a non-local database is refused by the localhost guard before connecting', async () => {
  const listener = await startCountingListener();
  try {
    for (const name of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
      const remote = 'postgresql://owner:remote-secret-pw@db.example.invalid:5432/codeproctor';
      const result = await runSeed({
        APP_ENV: 'development',
        DATABASE_URL: listener.url,
        MIGRATION_DATABASE_URL: listener.url,
        [name]: remote,
      });
      assert.equal(result.status, 1, `${name}: ${result.output}`);
      assert.match(result.stderr, /the localhost guard failed/);
      assert.match(result.stderr, /db\.example\.invalid/);
      assert.doesNotMatch(result.output, /remote-secret-pw/);
      assertNoSecrets(result);
    }
    assert.equal(listener.state.connections, 0);
  } finally {
    await listener.close();
  }
});

test('ADR-0009 4.4: a libpq redirect variable and a host override in the URL are refused before connecting', async () => {
  const listener = await startCountingListener();
  try {
    const base = { APP_ENV: 'development', MIGRATION_DATABASE_URL: listener.url };
    const redirect = await runSeed({ ...base, DATABASE_URL: listener.url, PGSERVICE: 'staging' });
    assert.equal(redirect.status, 1, redirect.output);
    assert.match(redirect.stderr, /PGSERVICE is set/);
    const override = await runSeed({
      ...base,
      DATABASE_URL: `${listener.url}?host=remote.example.invalid`,
    });
    assert.equal(override.status, 1, override.output);
    assert.match(override.stderr, /host, hostaddr or service query parameter/);
    assert.equal(listener.state.connections, 0);
  } finally {
    await listener.close();
  }
});

test('FU-DB-23: a database URL with leading or trailing whitespace is refused before connecting', async () => {
  const listener = await startCountingListener();
  try {
    for (const url of [
      ` ${listener.url}`,
      `\u00a0${listener.url}`,
      `\ufeff${listener.url}`,
      `${listener.url} `,
    ]) {
      const result = await runSeed({
        APP_ENV: 'development',
        DATABASE_URL: url,
        MIGRATION_DATABASE_URL: listener.url,
      });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /DATABASE_URL has leading or trailing whitespace/);
      assertNoSecrets(result);
    }
    assert.equal(listener.state.connections, 0);
  } finally {
    await listener.close();
  }
});

test('ADR-0009 4.3: the seed reads only DATABASE_URL, or MIGRATION_DATABASE_URL when that is empty', () => {
  const runtime = 'postgresql://app_user:x@127.0.0.1:5432/codeproctor';
  const owner = 'postgresql://owner:x@127.0.0.1:5432/codeproctor';
  assert.deepEqual(
    guard.chooseDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: owner }),
    {
      name: 'DATABASE_URL',
      url: runtime,
    },
  );
  assert.deepEqual(guard.chooseDatabaseUrl({ DATABASE_URL: '', MIGRATION_DATABASE_URL: owner }), {
    name: 'MIGRATION_DATABASE_URL',
    url: owner,
  });
  assert.throws(() => guard.chooseDatabaseUrl({}), guard.SeedRefusal);
});

test('ADR-0009 4.4: the seed never names the AI-consent variable, and prisma.config.ts runs the seed through tsx', () => {
  const name = `PRISMA_USER_CONSENT_FOR_${'DANGEROUS_AI_ACTION'}`;
  const dirs = ['prisma/seed', 'prisma/seed/questions'];
  const files = [
    'prisma/seed.ts',
    ...dirs.flatMap((dir) =>
      readdirSync(join(REPO_ROOT, dir))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `${dir}/${f}`),
    ),
  ];
  for (const file of files) {
    assert.ok(!readFileSync(join(REPO_ROOT, file), 'utf8').includes(name), file);
  }
  assert.match(
    readFileSync(join(REPO_ROOT, 'prisma.config.ts'), 'utf8'),
    /seed: 'tsx prisma\/seed\.ts'/,
  );
});

test('Q-28: the plan holds no password and no hash; the applier hashes the password only for missing staff', () => {
  const text = JSON.stringify(plan, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value,
  );
  assert.ok(!text.includes(DEMO_PASSWORD));
  assert.ok(!text.includes('$argon2'));
  const applySource = readFileSync(join(REPO_ROOT, 'prisma/seed/apply.ts'), 'utf8');
  assert.match(applySource, /hashPassword\(DEMO_PASSWORD\)/);
  const hasherSource = readFileSync(join(REPO_ROOT, 'prisma/seed/passwords.ts'), 'utf8');
  assert.match(hasherSource, /ARGON2ID = 2/);
  assert.match(hasherSource, /startsWith\('\$argon2id\$'\)/);
});

// ---------- The plan ----------

const byId = (rows) => new Map(rows.map((row) => [row.id, row]));

test('DB-04: staff are one user per role with distinct emails (Q-28)', () => {
  assert.deepEqual(content.staff.map((u) => u.role).sort(), [
    'AUTHOR',
    'RECRUITER',
    'REVIEWER',
    'SUPER_ADMIN',
  ]);
  assert.equal(new Set(content.staff.map((u) => u.email)).size, 4);
  assert.deepEqual(content.staff, STAFF);
});

test('FR-201..FR-203: 6 coding questions (2 EASY, 3 MEDIUM, 1 HARD), each with 3 samples, 8 hidden tests and 3 variants', () => {
  const coding = content.questions.filter((q) => q.type === 'CODING');
  assert.equal(coding.length, 6);
  const versions = byId(content.questionVersions);
  const difficulty = { EASY: 0, MEDIUM: 0, HARD: 0 };
  for (const question of coding) {
    const version = [...versions.values()].find((v) => v.questionId === question.id);
    difficulty[version.difficulty] += 1;
    assert.deepEqual(version.allowedLanguages, ['python', 'javascript', 'java']);
    assert.deepEqual(Object.keys(version.starterCode).sort(), ['java', 'javascript', 'python']);
    assert.deepEqual(Object.keys(version.referenceSolution).sort(), [
      'java',
      'javascript',
      'python',
    ]);
    assert.equal(version.isPublished, true);
    assert.equal(version.validatedAt, undefined, 'unvalidated until BE-05 runs the validation');
    const cases = content.testCases.filter((c) => c.questionVersionId === version.id);
    assert.equal(cases.filter((c) => !c.isHidden).length, 3, `${question.slug} samples`);
    assert.equal(cases.filter((c) => c.isHidden).length, 8, `${question.slug} hidden`);
    assert.deepEqual(
      cases.map((c) => c.position).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
    assert.equal(
      content.questionVariants.filter((v) => v.questionVersionId === version.id).length,
      3,
    );
  }
  assert.deepEqual(difficulty, { EASY: 2, MEDIUM: 3, HARD: 1 });
  assert.deepEqual(
    content.questions.map((q) => q.currentVersionId).filter((id) => id !== undefined),
    [],
    'current_version_id is set by the applier after the versions exist',
  );
});

test('ADR-0007 V-2: rendered statements have no placeholder left, and params are safe for Mustache escaping', () => {
  for (const spec of codingQuestions) {
    for (const [index, variant] of spec.variants.entries()) {
      for (const [name, value] of Object.entries(variant.params)) {
        assert.match(
          String(value),
          SAFE_PARAM_VALUE,
          `${spec.slug} variant ${index} param ${name}`,
        );
      }
      const row = content.questionVariants.find(
        (v) => v.id === seedId(`variant:${spec.slug}:${index}`),
      );
      assert.equal(row.renderedStatement, renderTemplate(spec.statementTemplate, variant.params));
      assert.doesNotMatch(row.renderedStatement, /\{\{/);
      assert.deepEqual(row.params, variant.params);
    }
  }
});

test('ADR-0007 V-1 and V-6: variant_test_cases rows override only where the data differs, within one question version', () => {
  const cases = byId(content.testCases);
  const variants = byId(content.questionVariants);
  const keys = new Set();
  assert.ok(content.variantTestCases.length > 0);
  for (const row of content.variantTestCases) {
    const key = `${row.variantId}|${row.testCaseId}`;
    assert.ok(!keys.has(key), `duplicate primary key ${key}`);
    keys.add(key);
    const slot = cases.get(row.testCaseId);
    const variant = variants.get(row.variantId);
    assert.equal(slot.questionVersionId, variant.questionVersionId, 'V-6');
    assert.ok(
      row.input !== slot.input || row.expectedOutput !== slot.expectedOutput,
      'no-op override',
    );
  }
  // Variant 0 is the base: its data is the default, so it has no overrides.
  for (const spec of codingQuestions) {
    assert.equal(
      content.variantTestCases.filter((r) => r.variantId === seedId(`variant:${spec.slug}:0`))
        .length,
      0,
    );
    for (const index of [1, 2]) {
      const overrides = content.variantTestCases.filter(
        (r) => r.variantId === seedId(`variant:${spec.slug}:${index}`),
      );
      assert.ok(overrides.length > 0, `${spec.slug} variant ${index} changes outputs`);
    }
  }
  // At least one variant changes an input as well as outputs ("array sizes", FR-203).
  assert.ok(
    content.variantTestCases.some((row) => row.input !== cases.get(row.testCaseId).input),
    'some variant changes an input',
  );
});

test('FR-205 and ADR-0007 sections 5 and 10: one MCQ and one short-answer question with answer_spec', () => {
  const nonCoding = content.questions.filter((q) => q.type !== 'CODING');
  assert.deepEqual(nonCoding.map((q) => q.type).sort(), ['MCQ', 'SHORT_ANSWER']);
  const mcq = content.questionVersions.find(
    (v) => v.questionId === seedId(`question:${mcqQuestion.slug}`),
  );
  assert.deepEqual(mcq.allowedLanguages, []);
  assert.ok(mcq.answerSpec.options.length >= 2);
  assert.ok(
    mcq.answerSpec.correctOptionIds.every((id) => mcq.answerSpec.options.some((o) => o.id === id)),
  );
  const short = content.questionVersions.find(
    (v) => v.questionId === seedId(`question:${shortAnswerQuestion.slug}`),
  );
  assert.equal(typeof short.answerSpec.canonical, 'string');
  assert.ok(short.answerSpec.acceptedVariants.length >= 1);
});

test('ADR-0005 section 4 and D-20: 6 synthetic AI reference rows per coding question, 2 assistants x 3 languages, base statement', () => {
  assert.equal(content.aiReferenceSolutions.length, 36);
  for (const spec of codingQuestions) {
    const versionId = seedId(`question-version:${spec.slug}:1`);
    const rows = content.aiReferenceSolutions.filter((r) => r.questionVersionId === versionId);
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows.map((r) => r.assistant)).size, 2, 'AI-5: two distinct assistants');
    for (const assistant of new Set(rows.map((r) => r.assistant))) {
      assert.deepEqual(
        rows
          .filter((r) => r.assistant === assistant)
          .map((r) => r.language)
          .sort(),
        ['java', 'javascript', 'python'],
      );
    }
    for (const row of rows) {
      assert.equal(row.variantId, null);
      assert.equal(row.collectedById, seedId('user:author'));
      assert.match(row.assistant, /^Synthetic Assistant [AB] \(seed data\)$/);
      assert.match(row.modelLabel, /^synthetic-seed-model-[ab]$/);
      assert.match(row.promptText, /^SYNTHETIC SEED DATA/);
      assert.match(row.solutionCode, /SYNTHETIC SEED DATA - not produced by an AI assistant\./);
      assert.equal(row.supersededAt, undefined);
    }
  }
});

test('FR-301 and ADR-0002 S-1, S-6: two tests, sequential sections, one with a 20-minute limit, random pick rules, no LOCKDOWN', () => {
  const [backend, senior] = [TEST_KEYS.backend, TEST_KEYS.senior].map((key) =>
    content.tests.find((t) => t.id === seedId(`test:${key}`)),
  );
  assert.equal(backend.name, 'Backend Engineer Screen');
  assert.equal(backend.profile, 'STANDARD');
  assert.equal(backend.durationMinutes, 60);
  assert.equal(senior.name, 'Senior Engineer Screen');
  assert.equal(senior.profile, 'STRICT');
  assert.equal(senior.durationMinutes, 90);
  for (const test of content.tests) {
    assert.notEqual(test.profile, 'LOCKDOWN');
    const sections = content.testSections
      .filter((s) => s.testId === test.id)
      .sort((a, b) => a.position - b.position);
    assert.deepEqual(
      sections.map((s) => s.position),
      sections.map((_, i) => i + 1),
    );
    const limits = sections.map((s) => s.timeLimitMin).filter((m) => m !== null);
    assert.ok(limits.reduce((a, b) => a + b, 0) <= test.durationMinutes, 'S-6');
    // Points of one session add up to 100 (a random rule's points apply to each pick).
    let points = 0;
    for (const section of sections) {
      for (const row of content.testQuestions.filter((q) => q.sectionId === section.id)) {
        points += Number(row.points) * (row.randomRule?.count ?? 1);
        assert.ok(
          row.questionVersionId !== undefined || row.randomRule !== undefined,
          'CHECK test_questions',
        );
      }
    }
    assert.equal(points, 100);
  }
  const backendSections = content.testSections.filter((s) => s.testId === backend.id);
  assert.equal(backendSections.length, 2);
  assert.ok(backendSections.some((s) => s.timeLimitMin === 20));
  const rules = content.testQuestions.filter((q) => q.randomRule !== undefined);
  assert.equal(rules.length, 3);
  assert.ok(rules.every((q) => q.questionVersionId === undefined));
  assert.ok(
    content.testQuestions.filter((q) => q.sectionId.length > 0 && q.randomRule === undefined)
      .length === 6,
  );
});

test('D-17: the placeholder consent text starts with the exact marker, is not Legal-approved, and pdf_key is NULL everywhere', () => {
  assert.equal(CONSENT_PLACEHOLDER_PREFIX, 'PLACEHOLDER - NOT APPROVED BY LEGAL');
  assert.ok(content.consentText.bodyMd.startsWith('PLACEHOLDER - NOT APPROVED BY LEGAL'));
  assert.equal(content.consentText.legalApprovedAt, null);
  assert.equal(content.consentText.legalApprovedBy, null);
  assert.equal(content.organization.name, 'Demo Corp');
  assert.equal(content.organization.retentionDays, 90);
  for (const consent of delivery.consents) {
    assert.equal(consent.consentTextId, content.consentText.id);
    assert.equal(consent.pdfKey ?? null, null);
    assert.equal(consent.pdfGeneratedAt ?? null, null);
  }
  assert.equal(
    delivery.sessions.find((s) => s.reportKey !== undefined),
    undefined,
  );
});

test('ADR-0003 Q-05: every refresh token carries a family_id, and a rotated token points at its replacement', () => {
  assert.ok(content.refreshTokens.length >= 2);
  const tokens = byId(content.refreshTokens);
  for (const token of content.refreshTokens) {
    assert.match(token.familyId, /^[0-9a-f-]{36}$/);
    assert.ok(content.staff.some((u) => u.id === token.userId));
    if (token.replacedById !== undefined) {
      assert.equal(tokens.get(token.replacedById).familyId, token.familyId, 'same family');
      assert.notEqual(token.revokedAt, undefined);
    }
    // Not a SHA-256 digest, so no raw token can ever match it.
    assert.doesNotMatch(token.tokenHash, /^[0-9a-f]{64}$/);
  }
});

test('ADR-0006: every session and invitation carries org_id, equal to its test and candidate (composite FKs)', () => {
  const invitations = byId(delivery.invitations);
  for (const invitation of delivery.invitations) {
    assert.equal(invitation.orgId, content.organization.id);
    assert.ok(invitation.windowEnd > invitation.windowStart, 'CHECK invitations');
    assert.ok(
      content.tests.some((t) => t.id === invitation.testId && t.orgId === invitation.orgId),
    );
    assert.ok(
      delivery.candidates.some(
        (c) => c.id === invitation.candidateId && c.orgId === invitation.orgId,
      ),
    );
    assert.doesNotMatch(invitation.tokenHash, /^[0-9a-f]{64}$/);
  }
  for (const session of delivery.sessions) {
    assert.equal(session.orgId, content.organization.id);
    assert.equal(invitations.get(session.invitationId).orgId, session.orgId);
  }
  assert.equal(
    new Set(delivery.sessions.map((s) => s.invitationId)).size,
    delivery.sessions.length,
    'invitation_id is unique',
  );
});

test('ADR-0002 section 2 and D-17: 5 candidates; INVITED, CONSENTED, EXPIRED, DECLINED and COMPLETED sessions exist', () => {
  assert.equal(delivery.candidates.length, 5);
  assert.equal(new Set(delivery.candidates.map((c) => c.email.toLowerCase())).size, 5);
  const statuses = delivery.sessions.map((s) => s.status);
  for (const status of ['INVITED', 'CONSENTED', 'EXPIRED', 'DECLINED', 'COMPLETED']) {
    assert.ok(statuses.includes(status), status);
  }
  assert.equal(delivery.sessions.length, 7);
  const consentOf = (session) => delivery.consents.find((c) => c.sessionId === session.id);
  for (const session of delivery.sessions) {
    const consent = consentOf(session);
    // CHECK consents: exactly one of signed_at and declined_at; a signed row names the signer.
    if (consent !== undefined) {
      assert.notEqual(consent.signedAt === undefined, consent.declinedAt === undefined);
      if (consent.signedAt !== undefined) assert.ok(consent.signedName);
    }
    if (session.status === 'DECLINED') {
      assert.ok(consent.declinedAt);
      assert.equal(consent.signedAt, undefined);
      assert.equal(session.startedAt, undefined, 'no recording after a decline');
      assert.ok(session.retentionAnchorAt, 'ADR 0004 R-1: anchored at the decline');
    }
    if (['INVITED', 'EXPIRED'].includes(session.status)) assert.equal(consent, undefined);
    if (session.status === 'CONSENTED') assert.ok(consent.signedAt);
    if (['INVITED', 'CONSENTED'].includes(session.status))
      assert.equal(session.retentionAnchorAt, undefined);
    if (session.status === 'EXPIRED') assert.ok(session.retentionAnchorAt);
  }
});

const finished = delivery.sessions.filter((s) => s.submittedAt !== undefined);

test('FR-801, FR-804, FR-902: three finished sessions, a risk score in each band, one completed review', () => {
  assert.equal(finished.length, 3);
  assert.deepEqual(finished.map((s) => s.riskBand).sort(), ['HIGH', 'LOW', 'MEDIUM']);
  assert.equal(delivery.sessionReviews.length, 1);
  const review = delivery.sessionReviews[0];
  assert.ok(review.verdict && review.completedAt && review.notes);
  const reviewed = delivery.sessions.find((s) => s.id === review.sessionId);
  assert.equal(reviewed.status, 'COMPLETED');
  // ADR 0002 section 2: a MEDIUM or HIGH session reaches COMPLETED only through a verdict, so the
  // other MEDIUM or HIGH session waits in UNDER_REVIEW with the retention anchor on hold.
  for (const session of finished) {
    if (session.riskBand === 'LOW') assert.equal(session.status, 'COMPLETED');
    if (session.id !== review.sessionId && session.riskBand !== 'LOW') {
      assert.equal(session.status, 'UNDER_REVIEW');
      assert.equal(session.retentionAnchorAt, null);
    }
  }
  assert.equal(delivery.flagDecisions.length, 4);
  for (const flag of delivery.flagDecisions) {
    assert.ok(delivery.proctorEvents.some((e) => e.key === flag.eventKey));
    assert.equal(flag.row.reviewerId, seedId('user:reviewer'));
  }
});

test('FR-401, FR-403, ADR-0002 S-2: each finished session has a signed consent, an identity check and sequential sections', () => {
  for (const session of finished) {
    const consent = delivery.consents.find((c) => c.sessionId === session.id);
    assert.ok(consent.signedAt < session.startedAt, 'signed before the test started');
    const checks = delivery.identityChecks.filter((c) => c.sessionId === session.id);
    assert.equal(checks.length, 1);
    assert.equal(
      checks[0].status,
      'PASSED',
      'CHECK identity_checks: PASSED has no manual decision',
    );
    assert.equal(checks[0].manualDecision, undefined);
    assert.equal(checks[0].idImageKey, undefined);
    assert.equal(checks[0].selfieKey, undefined);
    const invitation = delivery.invitations.find((i) => i.id === session.invitationId);
    const test = content.tests.find((t) => t.id === invitation.testId);
    assert.deepEqual(invitation.usedAt, session.startedAt);
    assert.equal(
      session.deadlineAt.getTime(),
      session.startedAt.getTime() + test.durationMinutes * 60_000,
    );
    const sections = delivery.sessionSections
      .filter((s) => s.sessionId === session.id)
      .sort((a, b) => a.position - b.position);
    const testSections = content.testSections
      .filter((s) => s.testId === test.id)
      .sort((a, b) => a.position - b.position);
    assert.deepEqual(
      sections.map((s) => s.sectionId),
      testSections.map((s) => s.id),
    );
    sections.forEach((section, index) => {
      assert.equal(section.position, index + 1);
      assert.ok(section.deadlineAt <= session.deadlineAt, 'never later than the session deadline');
      assert.ok(section.endedAt <= section.deadlineAt, 'ended inside its limit');
      if (index > 0)
        assert.deepEqual(section.startedAt, sections[index - 1].endedAt, 'S-1: in order, no gap');
      const limitMin = testSections[index].timeLimitMin;
      assert.equal(section.timeLimitMs, limitMin === null ? null : BigInt(limitMin) * 60_000n);
    });
    assert.ok(session.submittedAt <= session.deadlineAt);
    assert.deepEqual(sections.at(-1).endedAt, session.submittedAt);
  }
});

test('FR-506 and ADR-0007 sections 3 and 10: served questions, scores and manual scoring add up', () => {
  for (const session of finished) {
    const rows = delivery.sessionQuestions.filter((q) => q.sessionId === session.id);
    assert.ok(rows.length >= 4);
    assert.equal(new Set(rows.map((r) => r.position)).size, rows.length);
    assert.equal(
      rows.reduce((sum, r) => sum + Number(r.points), 0),
      100,
    );
    assert.equal(rows.reduce((sum, r) => sum + Number(r.score), 0).toFixed(2), session.totalScore);
    for (const row of rows) {
      // CHECK session_questions: MANUAL if and only if scored_by and scored_at are both set.
      assert.equal(
        row.scoring === 'MANUAL',
        row.scoredById !== undefined && row.scoredAt !== undefined,
      );
      assert.ok(row.scoring !== 'MANUAL_PENDING', 'nothing waits for scoring in the seed');
      assert.equal(row.score === undefined, false);
      const testQuestion = content.testQuestions.find((t) => t.id === row.testQuestionId);
      assert.equal(row.points, testQuestion.points);
      const version = content.questionVersions.find((v) => v.id === row.questionVersionId);
      if (testQuestion.questionVersionId !== undefined)
        assert.equal(testQuestion.questionVersionId, row.questionVersionId);
      else {
        // A random pick: the version matches the rule's difficulty and tags.
        assert.equal(version.difficulty, testQuestion.randomRule.difficulty);
        const question = content.questions.find((q) => q.id === version.questionId);
        for (const tag of testQuestion.randomRule.tags ?? [])
          assert.ok(question.tags.includes(tag));
      }
      const variants = content.questionVariants.filter(
        (v) => v.questionVersionId === row.questionVersionId,
      );
      if (variants.length > 0)
        assert.ok(
          variants.some((v) => v.id === row.variantId),
          'a coding question serves a variant',
        );
      else assert.equal(row.variantId, null);
      const submissions = delivery.submissions.filter((s) => s.sessionQuestionId === row.id);
      if (row.finalCode === undefined) assert.equal(submissions.length, 0);
      else {
        assert.deepEqual(
          submissions.map((s) => s.kind),
          ['RUN', 'SUBMIT'],
        );
        assert.equal(submissions[1].passed, submissions[1].total);
        assert.equal(submissions[1].score, row.score);
        assert.ok(submissions[0].createdAt < submissions[1].createdAt);
      }
    }
  }
  const manual = delivery.sessionQuestions.filter((q) => q.scoring === 'MANUAL');
  assert.equal(manual.length, 1, 'TC-099: one short answer scored by the reviewer');
  assert.equal(manual[0].scoredById, seedId('user:reviewer'));
  assert.ok(manual[0].scoringNote);
  assert.ok(
    delivery.auditLogs.some((a) => a.action === 'scoring.manual' && a.entityId === manual[0].id),
    'the manual score is audited',
  );
  // MCQ and short answers store the answer, never code.
  const answered = delivery.sessionQuestions.filter((q) => q.answer !== undefined);
  assert.ok(answered.length >= 3);
  assert.ok(answered.every((q) => q.finalCode === undefined));
});

test('ADR-0005 section 2 and FR-804: risk scores equal the formula over the stored events, with the shared severities and payloads', () => {
  const {
    DEFAULT_EVENT_SEVERITY,
    DEFAULT_EVENT_WEIGHT,
    DEFAULT_SEVERITY_POINTS,
    DEFAULT_EVENT_CAP_PER_TYPE,
    riskBandForScore,
    EVENT_PAYLOAD_SCHEMAS,
  } = shared;
  for (const session of finished) {
    const events = delivery.proctorEvents
      .filter((e) => e.row.sessionId === session.id)
      .map((e) => e.row);
    assert.ok(events.length >= 4);
    const severities = new Set(events.map((e) => e.severity));
    assert.ok(severities.size >= 2, 'mixed severity');
    // The contract in packages/shared, applied to the stored events.
    const counts = new Map();
    for (const event of events) {
      assert.equal(event.severity, DEFAULT_EVENT_SEVERITY[event.type], event.type);
      EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload);
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    }
    let expected = 0;
    for (const [type, count] of counts) {
      expected +=
        Math.min(count, DEFAULT_EVENT_CAP_PER_TYPE) *
        DEFAULT_SEVERITY_POINTS[DEFAULT_EVENT_SEVERITY[type]] *
        DEFAULT_EVENT_WEIGHT[type];
    }
    expected = Math.min(100, expected);
    assert.equal(session.riskScore, expected);
    assert.equal(session.riskBand, riskBandForScore(expected));
    // The seed's own copy of the rules agrees with the contract.
    assert.equal(risk.riskScore(events.map((e) => e.type)), expected);
    assert.equal(risk.riskBand(expected), session.riskBand);
    assert.ok(session.riskScore >= 0 && session.riskScore <= 100, 'CHECK sessions');
  }
  const bandOf = (band) => finished.find((s) => s.riskBand === band).riskScore;
  assert.ok(
    bandOf('LOW') <= 29 && bandOf('MEDIUM') >= 30 && bandOf('MEDIUM') <= 59 && bandOf('HIGH') >= 60,
  );
});

test('TC-063, TC-065, ADR-0005 section 3: events carry their batch; batch counts match; SERVER events have no batch; times run forward', () => {
  for (const session of finished) {
    const events = delivery.proctorEvents
      .filter((e) => e.row.sessionId === session.id)
      .map((e) => e.row);
    const batches = delivery.proctorEventBatches.filter((b) => b.sessionId === session.id);
    assert.ok(batches.length >= 2);
    assert.equal(new Set(batches.map((b) => b.seq)).size, batches.length, 'one row per seq');
    for (const batch of batches) {
      assert.equal(batch.signature.length, 32, 'HMAC-SHA256 is 32 bytes');
      assert.equal(events.filter((e) => e.batchSeq === batch.seq).length, batch.eventCount);
      assert.ok(batch.eventCount >= 1 && batch.eventCount <= 100);
    }
    assert.equal(
      new Set(batches.map((b) => Buffer.from(b.signature).toString('hex'))).size,
      batches.length,
    );
    for (const event of events) {
      assert.equal(event.source === 'SERVER', event.batchSeq === null);
      if (event.batchSeq !== null) assert.ok(batches.some((b) => b.seq === event.batchSeq));
      assert.ok(event.occurredAt >= session.startedAt && event.occurredAt <= session.submittedAt);
    }
    const times = events.map((e) => e.occurredAt.getTime());
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
      'chronological',
    );
    assert.equal(new Set(times).size, times.length, 'distinct times');
  }
});

test('ADR-0004 R-1: the retention anchor is the latest of submission and verdict time, and NULL while a review is pending', () => {
  const review = delivery.sessionReviews[0];
  const reviewed = delivery.sessions.find((s) => s.id === review.sessionId);
  assert.deepEqual(
    reviewed.retentionAnchorAt,
    new Date(Math.max(reviewed.submittedAt.getTime(), review.completedAt.getTime())),
  );
  const low = finished.find((s) => s.riskBand === 'LOW');
  assert.deepEqual(low.retentionAnchorAt, low.submittedAt);
  assert.ok(review.startedAt >= reviewed.submittedAt);
  assert.ok(review.completedAt > review.startedAt);
});

test('DB-04 idempotency: ids and natural keys do not depend on the run time, and are unique in every table', () => {
  const later = buildSeedPlan(new Date('2027-03-01T08:30:00.000Z'));
  const idsOf = (p) => ({
    content: Object.fromEntries(
      Object.entries(p.content)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [k, v.map((r) => r.id ?? `${r.variantId}|${r.testCaseId}`)]),
    ),
    delivery: Object.fromEntries(
      Object.entries(p.delivery)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [
          k,
          v.map(
            (r) =>
              r.id ??
              r.row?.id ??
              r.key ??
              (r.action === undefined
                ? `${r.sessionId}|${r.sectionId ?? r.seq}`
                : `${r.actorId}|${r.action}|${r.entityType}|${r.entityId}`),
          ),
        ]),
    ),
  });
  assert.deepEqual(idsOf(later), idsOf(plan));
  for (const [group, tables] of Object.entries(idsOf(plan))) {
    for (const [table, ids] of Object.entries(tables)) {
      assert.equal(new Set(ids).size, ids.length, `${group}.${table} has duplicate ids`);
    }
  }
  // The five identity columns are GENERATED ALWAYS: no seeded row sets one.
  for (const event of delivery.proctorEvents) assert.equal('id' in event.row, false);
  for (const entry of delivery.auditLogs) assert.equal('id' in entry, false);
  // Audit rows are found again by actor, action and entity, so a second run adds none.
  const auditKeys = delivery.auditLogs.map(
    (a) => `${a.actorId}|${a.action}|${a.entityType}|${a.entityId}`,
  );
  assert.equal(new Set(auditKeys).size, auditKeys.length);
  for (const entry of delivery.auditLogs) {
    assert.deepEqual(
      Object.keys(entry.metadata).filter((k) => !/Id$/.test(k)),
      [],
      'ADR 0001 C-3: IDs only in metadata',
    );
  }
});

test('ADR-0006 and database.md: every foreign key in the plan points at a row in the plan', () => {
  const ids = (rows) => new Set(rows.map((row) => row.id));
  const orgs = new Set([content.organization.id]);
  const users = ids(content.staff);
  const versions = ids(content.questionVersions);
  const variants = ids(content.questionVariants);
  const cases = ids(content.testCases);
  const sections = ids(content.testSections);
  const testQuestions = ids(content.testQuestions);
  const sessions = ids(delivery.sessions);
  const sessionQuestions = ids(delivery.sessionQuestions);
  const checks = [
    [content.refreshTokens, 'userId', users],
    [content.refreshTokens, 'replacedById', ids(content.refreshTokens)],
    [content.questions, 'orgId', orgs],
    [content.questions, 'createdById', users],
    [content.questionVersions, 'questionId', ids(content.questions)],
    [content.testCases, 'questionVersionId', versions],
    [content.questionVariants, 'questionVersionId', versions],
    [content.variantTestCases, 'variantId', variants],
    [content.variantTestCases, 'testCaseId', cases],
    [content.aiReferenceSolutions, 'questionVersionId', versions],
    [content.aiReferenceSolutions, 'collectedById', users],
    [content.tests, 'orgId', orgs],
    [content.tests, 'createdById', users],
    [content.testSections, 'testId', ids(content.tests)],
    [content.testQuestions, 'sectionId', sections],
    [content.testQuestions, 'questionVersionId', versions],
    [content.consentText ? [content.consentText] : [], 'orgId', orgs],
    [delivery.candidates, 'orgId', orgs],
    [delivery.invitations, 'candidateId', ids(delivery.candidates)],
    [delivery.invitations, 'testId', ids(content.tests)],
    [delivery.invitations, 'createdById', users],
    [delivery.sessions, 'invitationId', ids(delivery.invitations)],
    [delivery.sessionSections, 'sessionId', sessions],
    [delivery.sessionSections, 'sectionId', sections],
    [delivery.sessionQuestions, 'sessionId', sessions],
    [delivery.sessionQuestions, 'testQuestionId', testQuestions],
    [delivery.sessionQuestions, 'questionVersionId', versions],
    [delivery.sessionQuestions, 'variantId', variants],
    [delivery.sessionQuestions, 'scoredById', users],
    [delivery.submissions, 'sessionQuestionId', sessionQuestions],
    [delivery.consents, 'sessionId', sessions],
    [delivery.identityChecks, 'sessionId', sessions],
    [delivery.proctorEventBatches, 'sessionId', sessions],
    [delivery.proctorEvents.map((e) => e.row), 'sessionId', sessions],
    [delivery.sessionReviews, 'sessionId', sessions],
    [delivery.sessionReviews, 'reviewerId', users],
    [delivery.flagDecisions.map((f) => f.row), 'reviewerId', users],
    [delivery.auditLogs, 'orgId', orgs],
    [delivery.auditLogs, 'actorId', users],
  ];
  for (const [rows, column, targets] of checks) {
    for (const row of rows) {
      const value = row[column];
      if (value === undefined || value === null) continue;
      assert.ok(targets.has(value), `${column} -> ${value} is not in the plan`);
    }
  }
  // Payload references inside events.
  for (const { row } of delivery.proctorEvents) {
    const payload = row.payload;
    if (payload.sessionQuestionId !== undefined)
      assert.ok(sessionQuestions.has(payload.sessionQuestionId));
    if (payload.aiReferenceSolutionId !== undefined) {
      assert.ok(content.aiReferenceSolutions.some((r) => r.id === payload.aiReferenceSolutionId));
    }
  }
});

test('DB-04: the organization settings use only keys that ADR 0007 section 6 names, with the erasure hold on', () => {
  const settings = content.organization.settings;
  assert.deepEqual(Object.keys(settings).sort(), [
    'aiReferences',
    'consentDeclineContact',
    'erasure',
    'maxProctorPauseMinutes',
  ]);
  assert.equal(settings.erasure.holdWhileReviewOrAppealOpen, true);
  assert.equal(settings.aiReferences.minAssistants, 2);
});
