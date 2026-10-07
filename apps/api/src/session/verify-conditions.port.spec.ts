// ColumnVerifyConditions on a real Postgres 16 (app_user, SERVICE scope of one session): what must
// be true before CONSENTED may become VERIFIED (ADR 0002 section 2, ADR 0013 section 3, FR-402,
// FR-403, FR-404, FR-605). Plus the module binding of the two ports.
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { createInvitation, createTenant, passedSystemCheck } from '../candidate/testing/fixtures';
import type { InvitationOptions, Tenant } from '../candidate/testing/fixtures';
import { createPrismaClient } from '../database/create-prisma-client';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { IdentityCheckStatus, MediaStream } from '../generated/prisma/enums.js';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { SessionLockPort, UnwiredSessionLockPort } from './session-lock.port';
import { SessionModule } from './session.module';
import {
  ColumnVerifyConditions,
  VerifyConditionsPort,
  type VerifyCondition,
} from './verify-conditions.port';

describe('ColumnVerifyConditions (FR-402, FR-403, FR-404, FR-605, ADR 0013 section 3)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let prisma: PrismaService;
  let orgContext: OrgContextService;
  let tenant: Tenant;
  const conditions = new ColumnVerifyConditions();

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    orgContext = new OrgContextService();
    prisma = new PrismaService(
      { get: () => db.appUserUrl } as unknown as ConfigService<never, true>,
      orgContext,
    );
    tenant = await createTenant(owner, 'conds');
  }, 240_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await prisma?.onApplicationShutdown();
    await db?.stop();
  });

  const evaluate = async (
    sessionId: string,
    t: Tenant = tenant,
  ): Promise<readonly VerifyCondition[]> =>
    orgContext.runAsSessionJob(t.orgId, sessionId, () =>
      prisma.client.$transaction(async (tx) => (await conditions.evaluate(tx, sessionId)).unmet),
    );

  const session = (over: Partial<InvitationOptions> = {}): Promise<{ sessionId: string }> =>
    createInvitation(owner, tenant, {
      status: 'CONSENTED',
      session: { deviceInfo: passedSystemCheck() },
      ...over,
    });

  const identity = (
    sessionId: string,
    status: IdentityCheckStatus,
    attempt = 1,
  ): Promise<unknown> =>
    owner.identityCheck.create({
      data: {
        sessionId,
        attempt,
        status,
        // The table's CHECK: REVIEWED rows carry the reviewer's decision, and only they do.
        ...(status === 'REVIEWED'
          ? { manualDecision: 'MATCH', reviewedById: tenant.staffUserId, reviewedAt: new Date() }
          : {}),
      },
    });

  let seq = 0;
  const chunk = (
    sessionId: string,
    stream: MediaStream,
    over: { uploaded?: boolean; deleted?: boolean } = {},
  ): Promise<unknown> =>
    owner.mediaChunk.create({
      data: {
        sessionId,
        stream,
        seq: ++seq,
        startedAt: new Date(),
        durationMs: 10_000,
        uploadedAt: over.uploaded === false ? null : new Date(),
        deletedAt: over.deleted === true ? new Date() : null,
      },
    });

  it('FR-402, FR-403, FR-404: with a passed check, a finished identity and an uploaded room scan on a STANDARD test, nothing is unmet', async () => {
    const { sessionId } = await session();
    await identity(sessionId, 'PASSED');
    await chunk(sessionId, 'ROOM_SCAN');
    expect(await evaluate(sessionId)).toEqual([]);
  });

  it('FR-402: a system check that is missing, failed, blocking or malformed is unmet; an old one is not (the start re-checks freshness)', async () => {
    const cases: Array<[string, InvitationOptions['session']]> = [
      ['missing', { deviceInfo: {} }],
      [
        'passed false',
        { deviceInfo: { systemCheck: { passed: false, checkedAt: new Date().toISOString() } } },
      ],
      [
        'blocking',
        {
          deviceInfo: {
            systemCheck: {
              passed: true,
              blocking: ['MULTI_MONITOR'],
              checkedAt: new Date().toISOString(),
            },
          },
        },
      ],
      ['no date', { deviceInfo: { systemCheck: { passed: true } } }],
      ['malformed', { deviceInfo: { systemCheck: 'ok' } }],
    ];
    for (const [label, sessionOpts] of cases) {
      const { sessionId } = await session({ session: sessionOpts });
      await identity(sessionId, 'PASSED');
      await chunk(sessionId, 'ROOM_SCAN');
      expect([label, await evaluate(sessionId)]).toEqual([label, ['SYSTEM_CHECK']]);
    }
    const old = await session({
      session: { deviceInfo: passedSystemCheck(new Date(Date.now() - 3 * 3_600_000)) },
    });
    await identity(old.sessionId, 'PASSED');
    await chunk(old.sessionId, 'ROOM_SCAN');
    expect(await evaluate(old.sessionId)).toEqual([]);
  });

  it('FR-403: only PENDING or LOW_CONFIDENCE attempts are unmet; PASSED, MANUAL_REVIEW and REVIEWED are met', async () => {
    for (const [statuses, expected] of [
      [[], ['IDENTITY']],
      [['PENDING'], ['IDENTITY']],
      [['PENDING', 'LOW_CONFIDENCE'], ['IDENTITY']],
      [['PASSED'], []],
      [['MANUAL_REVIEW'], []],
      [['REVIEWED'], []],
      [['LOW_CONFIDENCE', 'MANUAL_REVIEW'], []],
    ] as Array<[IdentityCheckStatus[], VerifyCondition[]]>) {
      const { sessionId } = await session();
      await chunk(sessionId, 'ROOM_SCAN');
      for (const [i, status] of statuses.entries()) await identity(sessionId, status, i + 1);
      expect([statuses, await evaluate(sessionId)]).toEqual([statuses, expected]);
    }
  });

  it('FR-403, ADR 0015 section 7: the accommodations key identityCheckWaived ALONE is not a waiver (it is the erasure leftover): IDENTITY stays unmet', async () => {
    for (const accommodations of [
      { identityCheckWaived: true },
      { identityCheckWaiver: { reasonCode: 'OTHER' }, identityCheckWaived: true },
    ]) {
      const { sessionId } = await session({ accommodations });
      await chunk(sessionId, 'ROOM_SCAN');
      expect(await evaluate(sessionId)).toEqual(['IDENTITY']);
    }
  });

  it('FR-404: a ROOM_SCAN chunk that is not uploaded, deleted, on another stream or in another session is unmet; an uploaded one is met', async () => {
    const other = await session();
    await chunk(other.sessionId, 'ROOM_SCAN');
    const cases: Array<[string, (id: string) => Promise<unknown>, VerifyCondition[]]> = [
      ['not uploaded', (id) => chunk(id, 'ROOM_SCAN', { uploaded: false }), ['ROOM_SCAN']],
      ['deleted', (id) => chunk(id, 'ROOM_SCAN', { deleted: true }), ['ROOM_SCAN']],
      ['other stream', (id) => chunk(id, 'SCREEN'), ['ROOM_SCAN']],
      ['other session only', () => Promise.resolve(), ['ROOM_SCAN']],
      ['uploaded', (id) => chunk(id, 'ROOM_SCAN'), []],
    ];
    for (const [label, setup, expected] of cases) {
      const { sessionId } = await session();
      await identity(sessionId, 'PASSED');
      await setup(sessionId);
      expect([label, await evaluate(sessionId)]).toEqual([label, expected]);
    }
  });

  it('FR-605, ADR 0013 section 3: a STRICT test always names SIDE_CAMERA (no stored evidence yet); a STANDARD test never does', async () => {
    const strict = await createTenant(owner, 'conds-strict');
    await owner.test.update({ where: { id: strict.test.id }, data: { profile: 'STRICT' } });
    const { sessionId } = await createInvitation(owner, strict, {
      status: 'CONSENTED',
      session: { deviceInfo: passedSystemCheck() },
    });
    await identity(sessionId, 'PASSED');
    await chunk(sessionId, 'ROOM_SCAN');
    await chunk(sessionId, 'SIDE_CAMERA');
    expect(await evaluate(sessionId, strict)).toEqual(['SIDE_CAMERA']);
    const standard = await session();
    await identity(standard.sessionId, 'PASSED');
    await chunk(standard.sessionId, 'ROOM_SCAN');
    expect(await evaluate(standard.sessionId)).not.toContain('SIDE_CAMERA');
  });

  it("TC-008: another org's session, or a missing one, meets nothing", async () => {
    const other = await createTenant(owner, 'conds-other');
    const theirs = await createInvitation(owner, other, {
      status: 'CONSENTED',
      session: { deviceInfo: passedSystemCheck() },
    });
    await identity(theirs.sessionId, 'PASSED');
    await chunk(theirs.sessionId, 'ROOM_SCAN');
    // Evaluated in this org's scope: not found, so every condition is unmet.
    expect((await evaluate(theirs.sessionId)).length).toBe(4);
    expect((await evaluate(randomUUID())).length).toBe(4);
  });
});

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: OrgContextService, useValue: new OrgContextService() },
    { provide: ConfigService, useValue: { get: () => 'redis://127.0.0.1:6379' } },
    { provide: REDIS_CLIENT, useValue: {} },
  ],
  exports: [PrismaService, OrgContextService, ConfigService, REDIS_CLIENT],
})
class InfraStubs {}

describe('SessionModule bindings (FU-BEB-111, FR-402)', () => {
  it('ADR 0013 5.7, FR-402: the module resolves SessionLockPort to UnwiredSessionLockPort and VerifyConditionsPort to ColumnVerifyConditions', async () => {
    // compile() without init(): no worker or queue is started.
    const moduleRef = await Test.createTestingModule({
      imports: [InfraStubs, SessionModule],
    }).compile();
    expect(moduleRef.get(SessionLockPort)).toBeInstanceOf(UnwiredSessionLockPort);
    expect(moduleRef.get(VerifyConditionsPort)).toBeInstanceOf(ColumnVerifyConditions);
    await moduleRef.close();
  });
});
