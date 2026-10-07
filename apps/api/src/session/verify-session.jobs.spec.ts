// The verify-session job (ADR 0002 CONSENTED to VERIFIED, ADR 0013 CS-4.7; FR-402, FR-403, FR-404,
// FR-505): real Postgres 16 (app_user) and real Redis through Testcontainers.
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { Queue, UnrecoverableError, type Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { createInvitation, createTenant } from '../candidate/testing/fixtures';
import type { Tenant } from '../candidate/testing/fixtures';
import { createPrismaClient } from '../database/create-prisma-client';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SessionStatus } from '../generated/prisma/enums.js';
import { StubSessionLockPort } from './session-lock.port';
import { InMemoryVerifyConditions } from './testing/in-memory-verify-conditions';
import { SessionStateService } from './session-state.service';
import { SessionStatus as AllStatuses } from '../generated/prisma/enums.js';
import {
  VERIFY_SESSION_QUEUE,
  VerifyEnqueueScopeError,
  VerifySessionJobs,
} from './verify-session.jobs';

describe('verify-session job (FR-402, FR-403, FR-404, ADR 0013 CS-4.7, ADR 0015)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let prisma: PrismaService;
  let orgContext: OrgContextService;
  let redis: Redis;
  let jobs: VerifySessionJobs;
  let queue: Queue;
  let tenant: Tenant;
  let other: Tenant;
  const conditions = new InMemoryVerifyConditions();
  const warns: string[] = [];
  const savedEnv = { node: process.env.NODE_ENV, app: process.env.APP_ENV };

  beforeAll(async () => {
    // The stub lock answers LIVE only when both are "test".
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    [db, redisBox] = await Promise.all([
      startMigratedDatabase(),
      new RedisContainer('redis:8.8').start(),
    ]);
    owner = createPrismaClient(db.ownerUrl);
    orgContext = new OrgContextService();
    prisma = new PrismaService(
      { get: () => db.appUserUrl } as unknown as ConfigService<never, true>,
      orgContext,
    );
    redis = new Redis(redisBox.getConnectionUrl());
    const config = { get: () => redisBox.getConnectionUrl() } as unknown as ConfigService<
      never,
      true
    >;
    jobs = new VerifySessionJobs(
      config,
      prisma,
      orgContext,
      new StubSessionLockPort(),
      new SessionStateService(prisma, orgContext, new StubSessionLockPort(), config, redis),
      conditions,
      redis,
    );
    jobs.onModuleInit();
    queue = new Queue(VERIFY_SESSION_QUEUE, {
      connection: { host: redisBox.getHost(), port: redisBox.getPort() },
    });
    tenant = await createTenant(owner, 'verify');
    other = await createTenant(owner, 'verify-other');
  }, 240_000);

  afterAll(async () => {
    process.env.NODE_ENV = savedEnv.node;
    process.env.APP_ENV = savedEnv.app;
    await queue?.close();
    await jobs?.onApplicationShutdown();
    redis?.disconnect();
    await owner?.$disconnect();
    await prisma?.onApplicationShutdown();
    await redisBox?.stop();
    await db?.stop();
  });

  beforeEach(() => {
    warns.length = 0;
    conditions.unmet = [];
    conditions.gate = undefined;
    conditions.calls = 0;
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m: unknown) => void warns.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  const worker = (): Worker => (jobs as unknown as { worker: Worker }).worker;
  const statusOf = async (id: string): Promise<SessionStatus> =>
    (await owner.session.findUniqueOrThrow({ where: { id } })).status;
  const sessionIn = async (status: SessionStatus, t: Tenant = tenant): Promise<string> =>
    (await createInvitation(owner, t, { status })).sessionId;
  const inCandidateScope = <T>(
    orgId: string,
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> => orgContext.runAsCandidate(orgId, sessionId, fn);
  const eventually = async (check: () => Promise<boolean>, ms = 20_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return check();
  };

  it('FR-402: CONSENTED with every condition met becomes VERIFIED through SessionStateService', async () => {
    const id = await sessionIn('CONSENTED');
    expect(await jobs.process({ orgId: tenant.orgId, sessionId: id })).toBe('VERIFIED');
    expect(await statusOf(id)).toBe('VERIFIED');
  });

  it('FR-402, FR-403, FR-404: when a condition is not met the session is left untouched and the log names the conditions only', async () => {
    const id = await sessionIn('CONSENTED');
    conditions.unmet = ['SYSTEM_CHECK', 'ROOM_SCAN'];
    expect(await jobs.process({ orgId: tenant.orgId, sessionId: id })).toBe('DROPPED');
    expect(await statusOf(id)).toBe('CONSENTED');
    expect(warns).toEqual([
      `verify-session dropped: session ${id} conditions not met: SYSTEM_CHECK,ROOM_SCAN`,
    ]);
    // The enqueue that completes the last condition then verifies it.
    conditions.unmet = [];
    expect(await jobs.process({ orgId: tenant.orgId, sessionId: id })).toBe('VERIFIED');
    expect(await statusOf(id)).toBe('VERIFIED');
  });

  it('FR-402: an already VERIFIED session is a no-op success, and a second run changes nothing', async () => {
    const id = await sessionIn('CONSENTED');
    await jobs.process({ orgId: tenant.orgId, sessionId: id });
    expect(await jobs.process({ orgId: tenant.orgId, sessionId: id })).toBe('ALREADY_VERIFIED');
    expect(await statusOf(id)).toBe('VERIFIED');
    expect(warns).toEqual([]);
  });

  it('FR-505: every other status is dropped untouched, with an ids-only log (no illegal transition)', async () => {
    for (const status of Object.values(AllStatuses)) {
      if (status === 'CONSENTED' || status === 'VERIFIED') continue;
      const id = await sessionIn(status);
      warns.length = 0;
      expect(await jobs.process({ orgId: tenant.orgId, sessionId: id })).toBe('DROPPED');
      expect(await statusOf(id)).toBe(status);
      expect(warns).toEqual([`verify-session dropped: session ${id} is not CONSENTED`]);
    }
    expect(conditions.calls).toBe(0);
  });

  it('TC-008: a session of another org and a missing session are dropped; a bad payload fails for good (UnrecoverableError)', async () => {
    const foreign = await sessionIn('CONSENTED', other);
    expect(await jobs.process({ orgId: tenant.orgId, sessionId: foreign })).toBe('DROPPED');
    expect(await statusOf(foreign)).toBe('CONSENTED');
    expect(await jobs.process({ orgId: tenant.orgId, sessionId: randomUUID() })).toBe('DROPPED');
    for (const bad of [
      null,
      {},
      { orgId: tenant.orgId },
      { orgId: 'x', sessionId: 'y' },
      { orgId: tenant.orgId, sessionId: foreign, extra: 'secret-value' },
    ]) {
      await expect(jobs.process(bad)).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(warns.join('\n')).not.toContain('secret-value');
    expect(await statusOf(foreign)).toBe('CONSENTED');
  });

  it('FR-505: upper-case ids are normalised once and work the same', async () => {
    const id = await sessionIn('CONSENTED');
    expect(
      await jobs.process({ orgId: tenant.orgId.toUpperCase(), sessionId: id.toUpperCase() }),
    ).toBe('VERIFIED');
  });

  it('FR-505: concurrent runs for one session produce one transition and all succeed', async () => {
    const id = await sessionIn('CONSENTED');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => jobs.process({ orgId: tenant.orgId, sessionId: id })),
    );
    expect(results.filter((r) => r === 'VERIFIED')).toHaveLength(1);
    expect(results.filter((r) => r === 'ALREADY_VERIFIED')).toHaveLength(11);
    expect(await statusOf(id)).toBe('VERIFIED');
  });

  it('NFR-04: the logs name only the session and org ids and fixed condition names, never a payload value', async () => {
    const id = await sessionIn('OPENED');
    await jobs.process({ orgId: tenant.orgId, sessionId: id });
    const missing = randomUUID();
    await jobs.process({ orgId: tenant.orgId, sessionId: missing });
    const uuids = new Set(
      warns.flatMap(
        (m) => m.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [],
      ),
    );
    expect(warns.length).toBeGreaterThan(0);
    for (const u of uuids) expect([id, missing, tenant.orgId]).toContain(u);
    expect(warns.join('\n')).not.toMatch(/token|otp|key|email|@/i);
  });

  it('TC-008, ADR 0013 CS-4.7: enqueue is refused outside the candidate scope of that same org and session, and nothing is queued', async () => {
    const mine = await sessionIn('CONSENTED');
    const theirs = await sessionIn('CONSENTED', other);
    const sameOrgOther = await sessionIn('CONSENTED');
    const ids = { orgId: tenant.orgId, sessionId: mine };
    await worker().pause();
    // No scope, a plain org scope (staff or service code), another session, another org.
    await expect(jobs.enqueueVerifySession(ids.orgId, ids.sessionId)).rejects.toBeInstanceOf(
      VerifyEnqueueScopeError,
    );
    await expect(
      orgContext.runInOrg(tenant.orgId, () => jobs.enqueueVerifySession(ids.orgId, ids.sessionId)),
    ).rejects.toBeInstanceOf(VerifyEnqueueScopeError);
    await expect(
      inCandidateScope(tenant.orgId, sameOrgOther, () =>
        jobs.enqueueVerifySession(ids.orgId, ids.sessionId),
      ),
    ).rejects.toBeInstanceOf(VerifyEnqueueScopeError);
    await expect(
      inCandidateScope(other.orgId, theirs, () => jobs.enqueueVerifySession(tenant.orgId, theirs)),
    ).rejects.toBeInstanceOf(VerifyEnqueueScopeError);
    await expect(
      inCandidateScope(other.orgId, theirs, () => jobs.enqueueVerifySession(other.orgId, mine)),
    ).rejects.toBeInstanceOf(VerifyEnqueueScopeError);
    await expect(jobs.enqueueVerifySession('nope', 'nope')).rejects.toThrow();
    expect(await redis.exists(`vs:${mine}`)).toBe(0);
    expect(await queue.getJobCounts('delayed', 'waiting')).toMatchObject({
      delayed: 0,
      waiting: 0,
    });
    // The same org and session is accepted, in a candidate scope and in a session-job scope.
    await inCandidateScope(ids.orgId, ids.sessionId, () =>
      jobs.enqueueVerifySession(ids.orgId, ids.sessionId),
    );
    expect(await redis.get(`vs:${mine}`)).toBe('1');
    await orgContext.runAsSessionJob(ids.orgId, ids.sessionId, () =>
      jobs.enqueueVerifySession(ids.orgId, ids.sessionId),
    );
    await queue.drain(true);
    await worker().resume();
  });

  it('ADR 0013 CS-4.7: the job id is verify-session_{sid}_{n} from the vs counter (no colon), and a burst of 20 enqueues is one debounced job', async () => {
    const id = await sessionIn('CONSENTED');
    await worker().pause();
    await queue.drain(true);
    await redis.del(`vs:${id}`);
    await inCandidateScope(tenant.orgId, id, () =>
      Promise.all(Array.from({ length: 20 }, () => jobs.enqueueVerifySession(tenant.orgId, id))),
    );
    expect(await redis.get(`vs:${id}`)).toBe('20');
    expect((await redis.ttl(`vs:${id}`)) > 80_000).toBe(true);
    const pending = [...(await queue.getDelayed()), ...(await queue.getWaiting())];
    expect(pending).toHaveLength(1);
    const job = pending[0];
    expect(job?.id).toMatch(new RegExp(`^verify-session_${id}_\\d+$`));
    expect(job?.id).not.toContain(':');
    expect(job?.data).toEqual({ orgId: tenant.orgId, sessionId: id });
    expect(job?.opts).toMatchObject({ removeOnComplete: true, attempts: 5 });
    expect(job?.opts.removeOnFail).toMatchObject({
      age: expect.any(Number) as number,
      count: expect.any(Number) as number,
    });
    await queue.drain(true);
    await worker().resume();
  });

  it('ADR 0013 CS-4.7: the debounced job runs once and verifies the session', async () => {
    const id = await sessionIn('CONSENTED');
    await inCandidateScope(tenant.orgId, id, () => jobs.enqueueVerifySession(tenant.orgId, id));
    expect(await eventually(async () => (await statusOf(id)) === 'VERIFIED')).toBe(true);
  });

  it('ADR 0013 CS-4.7: an enqueue that arrives while the job is active is not lost: it schedules a fresh run', async () => {
    const id = await sessionIn('CONSENTED');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    conditions.gate = async () => {
      if (first) {
        first = false;
        await held;
      }
    };
    const process = jest.spyOn(jobs, 'process');
    await inCandidateScope(tenant.orgId, id, () => jobs.enqueueVerifySession(tenant.orgId, id));
    // Wait until the first run is active (inside the held evaluation).
    expect(await eventually(() => Promise.resolve(conditions.calls >= 1))).toBe(true);
    await inCandidateScope(tenant.orgId, id, () => jobs.enqueueVerifySession(tenant.orgId, id));
    release();
    expect(await eventually(() => Promise.resolve(process.mock.calls.length >= 2))).toBe(true);
    expect(await statusOf(id)).toBe('VERIFIED');
  });
});
