// Fixtures for the candidate session tests: one tenant with a staff user, a consent text, a test
// with two sections and a pool of questions, and invitations (with their sessions) in any status.
// BE-06 has not landed, so rows are created straight through the owner Prisma client, coded against
// the schema. Synthetic data only.
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256Hex } from '../../auth/crypto.util';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { SessionStatus } from '../../generated/prisma/enums.js';

export interface TestFixture {
  readonly id: string;
  readonly sectionIds: readonly [string, string];
  readonly testQuestionIds: readonly [string, string, string];
  readonly fixedVersionIds: readonly [string, string];
  readonly randomPoolVersionIds: readonly string[];
  readonly variantIds: readonly string[];
}

export interface Tenant {
  readonly label: string;
  readonly orgId: string;
  readonly staffUserId: string;
  readonly staffEmail: string;
  readonly consentTextId: string;
  readonly test: TestFixture;
}

export interface InvitationFixture {
  readonly token: string;
  readonly invitationId: string;
  readonly sessionId: string;
  readonly candidateId: string;
  readonly candidateEmail: string;
}

export interface InvitationOptions {
  readonly status?: SessionStatus;
  readonly email?: string;
  readonly windowStart?: Date;
  readonly windowEnd?: Date;
  readonly accommodations?: Prisma.InputJsonObject;
  readonly session?: {
    readonly startedAt?: Date;
    readonly deadlineAt?: Date;
    readonly lastHeartbeat?: Date;
    readonly authEpoch?: number;
    readonly pauseReasons?: Array<'FULLSCREEN_EXIT' | 'SCREEN_SHARE_STOPPED' | 'SIDE_CAMERA_LOST' | 'PROCTOR'>;
    readonly hmacKeyEnc?: string;
    readonly deviceInfo?: Prisma.InputJsonObject;
  };
  readonly testId?: string;
  readonly createdById?: string | null;
}

export async function createTenant(
  db: PrismaClient,
  label: string,
  options: { legalApproved?: boolean; settings?: Prisma.InputJsonObject } = {},
): Promise<Tenant> {
  const org = await db.organization.create({
    data: { name: `Org ${label}`, settings: options.settings ?? {} },
  });
  const user = await db.user.create({
    data: {
      orgId: org.id,
      email: `recruiter-${label}@example.test`,
      fullName: `Recruiter ${label}`,
      passwordHash: 'not-a-real-hash',
      role: 'RECRUITER',
    },
  });
  const consentText = await db.consentText.create({
    data: {
      orgId: org.id,
      version: `v1-${label}`,
      bodyMd: '# Consent\n\nWe record your screen, webcam and microphone.\n\n- Retention 90 days',
      legalApprovedAt: options.legalApproved === false ? null : new Date('2026-10-01T00:00:00Z'),
      legalApprovedBy: options.legalApproved === false ? null : 'TEST-LEGAL-1',
    },
  });
  await db.organization.update({
    where: { id: org.id },
    data: { currentConsentTextId: consentText.id },
  });

  async function question(
    slug: string,
    tags: string[],
    variants = 0,
  ): Promise<{ versionId: string; variantIds: string[] }> {
    const q = await db.question.create({ data: { orgId: org.id, slug: `${slug}-${label}`, tags } });
    const version = await db.questionVersion.create({
      data: {
        questionId: q.id,
        version: 1,
        title: `Question ${slug}`,
        statementMd: 'Hidden statement template',
        difficulty: 'EASY',
        allowedLanguages: ['python'],
        isPublished: true,
        referenceSolution: { python: 'print(42)  # REFERENCE-SOLUTION-MARKER' },
      },
    });
    await db.question.update({ where: { id: q.id }, data: { currentVersionId: version.id } });
    const variantIds: string[] = [];
    for (let i = 0; i < variants; i++) {
      const v = await db.questionVariant.create({
        data: {
          questionVersionId: version.id,
          params: { n: i + 3, secret: 'VARIANT-PARAMS-MARKER' },
          renderedStatement: `Variant ${String(i)}`,
          isActive: i !== variants - 1 || variants === 1,
        },
      });
      variantIds.push(v.id);
    }
    return { versionId: version.id, variantIds };
  }

  const fixedA = await question('fixed-a', ['core'], 2);
  const fixedB = await question('fixed-b', ['core']);
  const pool = [
    await question('pool-1', ['arrays']),
    await question('pool-2', ['arrays']),
    await question('pool-3', ['arrays']),
  ];

  const test = await db.test.create({
    data: { orgId: org.id, name: `Test ${label}`, durationMinutes: 60, createdById: user.id },
  });
  const s1 = await db.testSection.create({
    data: { testId: test.id, title: 'Section one', position: 1, timeLimitMin: 20 },
  });
  const s2 = await db.testSection.create({
    data: { testId: test.id, title: 'Section two', position: 2, timeLimitMin: null },
  });
  const tq1 = await db.testQuestion.create({
    data: { sectionId: s1.id, questionVersionId: fixedA.versionId, points: 100, position: 1 },
  });
  const tq2 = await db.testQuestion.create({
    data: {
      sectionId: s1.id,
      randomRule: { tags: ['arrays'], difficulty: 'EASY' },
      points: 50,
      position: 2,
    },
  });
  const tq3 = await db.testQuestion.create({
    data: { sectionId: s2.id, questionVersionId: fixedB.versionId, points: 25, position: 1 },
  });

  return {
    label,
    orgId: org.id,
    staffUserId: user.id,
    staffEmail: user.email,
    consentTextId: consentText.id,
    test: {
      id: test.id,
      sectionIds: [s1.id, s2.id],
      testQuestionIds: [tq1.id, tq2.id, tq3.id],
      fixedVersionIds: [fixedA.versionId, fixedB.versionId],
      randomPoolVersionIds: pool.map((p) => p.versionId),
      variantIds: fixedA.variantIds,
    },
  };
}

/** An invitation (raw token returned, only its SHA-256 stored) with its session in `status`. */
export async function createInvitation(
  db: PrismaClient,
  tenant: Tenant,
  options: InvitationOptions = {},
): Promise<InvitationFixture> {
  const now = Date.now();
  const token = randomBytes(32).toString('base64url');
  const email = options.email ?? `candidate-${randomUUID().slice(0, 8)}@example.test`;
  const candidate = await db.candidate.create({
    data: { orgId: tenant.orgId, email, fullName: 'Ada Candidate' },
  });
  const invitation = await db.invitation.create({
    data: {
      orgId: tenant.orgId,
      testId: options.testId ?? tenant.test.id,
      candidateId: candidate.id,
      tokenHash: sha256Hex(token),
      windowStart: options.windowStart ?? new Date(now - 86_400_000),
      windowEnd: options.windowEnd ?? new Date(now + 6 * 86_400_000),
      accommodations: options.accommodations ?? {},
      createdById: options.createdById === undefined ? tenant.staffUserId : options.createdById,
      sentAt: new Date(now - 3_600_000),
    },
  });
  const s = options.session ?? {};
  const session = await db.session.create({
    data: {
      orgId: tenant.orgId,
      invitationId: invitation.id,
      status: options.status ?? 'INVITED',
      authEpoch: s.authEpoch ?? 0,
      startedAt: s.startedAt ?? null,
      deadlineAt: s.deadlineAt ?? null,
      lastHeartbeat: s.lastHeartbeat ?? null,
      pauseReasons: s.pauseReasons ?? [],
      hmacKeyEnc: s.hmacKeyEnc ?? null,
      deviceInfo: s.deviceInfo ?? {},
    },
  });
  return {
    token,
    invitationId: invitation.id,
    sessionId: session.id,
    candidateId: candidate.id,
    candidateEmail: email,
  };
}

/** A passed system check, as the system-check route (BE-10) will store it. */
export function passedSystemCheck(at: Date = new Date()): Prisma.InputJsonObject {
  return { systemCheck: { passed: true, blocking: [], checkedAt: at.toISOString() } };
}
