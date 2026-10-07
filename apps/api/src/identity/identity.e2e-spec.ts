// BE-08b end to end: the candidate identity check over HTTP against real Postgres 16 (app_user,
// real grants and migrations), real Redis and real BullMQ (Testcontainers; the dev stack is never
// touched). Storage and the worker are fakes. Covers FR-403, TC-033, TC-034 (server half), C-34,
// C-18, DL-30 and ADR 0013 5.6, ADR 0014 6.2 to 6.5, ADR 0015 sections 3 and 6.
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createInvitation, createTenant } from '../candidate/testing/fixtures';
import type { InvitationOptions, Tenant } from '../candidate/testing/fixtures';
import type { CandidateTokenService } from '../candidate/candidate-token.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import { FakeStorage } from '../media/testing/fake-storage';
import type { PrefixDeleteResult } from '../media/storage.service';
import { identitySealedKey } from '../media/storage-keys';
import { WorkerClient } from './worker-client';
import type { FaceMatchRequest, FaceMatchResponse } from './worker-client';
import { VerifySessionPort } from './identity-ports';
import type { IdentityService } from './identity.service';

const API = '/api/v1/candidate/session/identity';
const MIB = 1024 * 1024;

/** The in-memory store plus the two calls the identity check adds: CopyObject and prefix delete. */
class IdentityStorage extends FakeStorage {
  override copy(source: string, destination: string): Promise<void> {
    const o = this.objects.get(source);
    if (o === undefined) return Promise.reject(new Error('missing source'));
    this.objects.set(destination, { ...o });
    return Promise.resolve();
  }
  override deletePrefix(prefix: string): Promise<PrefixDeleteResult> {
    if (this.leaveBehind) return Promise.resolve({ deleted: 0, errors: 1, remaining: 1 });
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted += 1;
      }
    }
    return Promise.resolve({ deleted, errors: 0, remaining: 0 });
  }
  /** Simulates a delete that leaves objects behind (a storage error). */
  leaveBehind = false;
  keysUnder(fragment: string): string[] {
    return [...this.objects.keys()].filter((k) => k.includes(fragment));
  }
}

/** A programmable worker. `next` decides each answer; `gate` holds a call until released. */
class FakeWorker extends WorkerClient {
  readonly calls: FaceMatchRequest[] = [];
  next: (request: FaceMatchRequest) => FaceMatchResponse = () => match(0.93);
  gate: Promise<void> | null = null;
  faceMatch(request: FaceMatchRequest): Promise<FaceMatchResponse> {
    this.calls.push(request);
    const answer = (): Promise<FaceMatchResponse> => {
      try {
        return Promise.resolve(this.next(request));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error('worker'));
      }
    };
    return this.gate === null ? answer() : this.gate.then(answer);
  }
}

class RecordingVerify extends VerifySessionPort {
  readonly calls: Array<{ orgId: string; sessionId: string }> = [];
  enqueue(orgId: string, sessionId: string): Promise<void> {
    this.calls.push({ orgId, sessionId });
    return Promise.resolve();
  }
}

const base = {
  workerVersion: '0.0.0',
  lockDigest: 'abcdef012345',
  modelId: 'auraface-v1:a7933ea5',
  threshold: 0.75,
};
const match = (score: number): FaceMatchResponse => ({
  ...base,
  decision: 'MATCH',
  reason: null,
  detail: null,
  score,
});
const review = (
  reason: NonNullable<FaceMatchResponse['reason']>,
  score: number | null = 0.31,
): FaceMatchResponse => ({ ...base, decision: 'MANUAL_REVIEW', reason, detail: reason, score });

async function eventually<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Identity check (FR-403, TC-033, TC-034, C-34, DL-30, ADR 0013 5.6, ADR 0015)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let redis: Redis;
  let app: INestApplication<App>;
  let tokens: CandidateTokenService;
  let identity: IdentityService;
  // The app is built after jest.resetModules(), so its error classes are not the ones imported at
  // the top of this file: take them from the same registry (an instanceof across two copies fails).
  let errors: typeof import('./worker-client');
  let tenant: Tenant;
  let other: Tenant;
  const storage = new IdentityStorage();
  const worker = new FakeWorker();
  const verify = new RecordingVerify();
  const logged: string[] = [];
  let stdout: jest.SpyInstance;

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    [db, redisBox] = await Promise.all([
      startMigratedDatabase(),
      new RedisContainer('redis:8.8').start(),
    ]);
    owner = createPrismaClient(db.ownerUrl);
    redis = new Redis(redisBox.getConnectionUrl());
    tenant = await createTenant(owner, 'identity');
    other = await createTenant(owner, 'identity-other');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      LOG_LEVEL: 'info',
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: db.appUserUrl,
      REDIS_URL: redisBox.getConnectionUrl(),
      HEALTH_TIMEOUT_MS: '1500',
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64'),
      COOKIE_SECRET: randomBytes(32).toString('base64'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      JWT_CANDIDATE_SECRET: randomBytes(32).toString('base64'),
      OTP_PEPPER: randomBytes(32).toString('base64'),
      SESSION_KEY_ENC_ACTIVE_KID: 'k1',
      SESSION_KEY_ENC_KEY_k1: randomBytes(32).toString('base64'),
      THROTTLE_DEFAULT_LIMIT: '100000',
      THROTTLE_AUTH_LIMIT: '100000',
      THROTTLE_CANDIDATE_LIMIT: '100000',
    });
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const mailPort = jest.requireActual<typeof import('../candidate/candidate-mail.port')>(
      '../candidate/candidate-mail.port',
    );
    const storageSvc = jest.requireActual<typeof import('../media/storage.service')>(
      '../media/storage.service',
    );
    const workerMod = jest.requireActual<typeof import('./worker-client')>('./worker-client');
    errors = workerMod;
    const portsMod = jest.requireActual<typeof import('./identity-ports')>('./identity-ports');
    const noMail = {
      sendOtp: () => Promise.resolve(),
      sendOtpLockout: () => Promise.resolve(),
      sendConsentCopy: () => Promise.resolve(),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(mailPort.CandidateMailPort)
      .useValue(noMail)
      .overrideProvider(storageSvc.StorageService)
      .useValue(storage)
      .overrideProvider(workerMod.WorkerClient)
      .useValue(worker)
      .overrideProvider(portsMod.VerifySessionPort)
      .useValue(verify)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    tokens = app.get(
      jest.requireActual<typeof import('../candidate/candidate-token.service')>(
        '../candidate/candidate-token.service',
      ).CandidateTokenService,
    );
    identity = app.get(
      jest.requireActual<typeof import('./identity.service')>('./identity.service').IdentityService,
    );
  }, 240_000);

  afterAll(async () => {
    stdout.mockRestore();
    await app?.close();
    redis?.disconnect();
    await owner?.$disconnect();
    await redisBox?.stop();
    await db?.stop();
  });

  beforeEach(() => {
    worker.calls.length = 0;
    worker.next = () => match(0.93);
    worker.gate = null;
    verify.calls.length = 0;
  });

  // ---------- helpers ----------

  /**
   * Waits until one face-match job has finished (BullMQ sets `finishedOn` on its hash when it
   * completes or fails): a positive "the job ran", not a guess. Throws at the deadline.
   */
  async function jobFinished(sessionId: string, attempt = 1, ms = 15_000): Promise<void> {
    const key = `bull:identity-jobs:face-match_${sessionId}_${String(attempt)}`;
    const deadline = Date.now() + ms;
    for (;;) {
      if ((await redis.hget(key, 'finishedOn')) !== null) return;
      if (Date.now() > deadline) throw new Error('the face-match job did not finish');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  interface Candidate {
    readonly sessionId: string;
    readonly orgId: string;
    readonly token: string;
  }

  async function session(options: InvitationOptions = {}, t: Tenant = tenant): Promise<Candidate> {
    const inv = await createInvitation(owner, t, { status: 'CONSENTED', ...options });
    const token = tokens.sign({ sid: inv.sessionId, oid: t.orgId, epoch: 0 }).token;
    return { sessionId: inv.sessionId, orgId: t.orgId, token };
  }

  /** The status and the JSON body, typed (supertest's own body type is `any`). */
  interface Json {
    code: string;
    status: string;
    name: string;
    attempt: number;
    [key: string]: unknown;
  }
  interface Reply {
    status: number;
    body: Json;
  }
  const reply = async (t: request.Test): Promise<Reply> => {
    const r = await t;
    return { status: r.status, body: r.body as Json };
  };
  const post = (path: string, c: Candidate, payload: object): Promise<Reply> =>
    reply(
      request(app.getHttpServer())
        .post(`${API}${path}`)
        .set('Authorization', `Bearer ${c.token}`)
        .send(payload),
    );
  const get = (c: Candidate): Promise<Reply> =>
    reply(request(app.getHttpServer()).get(API).set('Authorization', `Bearer ${c.token}`));

  /** Presigns both names, and "uploads" them as the browser would. */
  async function upload(
    c: Candidate,
    over: { idType?: string; bytes?: number } = {},
  ): Promise<{ idImageName: string; selfieName: string; attempt: number }> {
    const names: Record<string, string> = {};
    let attempt = 0;
    for (const purpose of ['ID_IMAGE', 'SELFIE'] as const) {
      const res = await post('/presign', c, {
        purpose,
        contentType: 'image/jpeg',
        bytes: over.bytes ?? 2 * MIB,
      });
      expect(res.status).toBe(200);
      names[purpose] = res.body.name;
      attempt = res.body.attempt;
      const key = `orgs/${c.orgId}/sessions/${c.sessionId}/${res.body.name}`;
      storage.upload(
        key,
        over.bytes ?? 2 * MIB,
        (purpose === 'ID_IMAGE' && over.idType) || 'image/jpeg',
      );
    }
    return { idImageName: names.ID_IMAGE as string, selfieName: names.SELFIE as string, attempt };
  }

  const submit = (c: Candidate, n: { idImageName: string; selfieName: string }, live = true) =>
    post('', c, { idImageName: n.idImageName, selfieName: n.selfieName, livenessConfirmed: live });

  const rows = (sessionId: string) =>
    owner.identityCheck.findMany({ where: { sessionId }, orderBy: { attempt: 'asc' } });
  const events = (sessionId: string) =>
    owner.proctorEvent.findMany({ where: { sessionId, type: 'IDENTITY_MANUAL_REVIEW' } });
  const settled = (sessionId: string, attempt = 1) =>
    eventually(
      async () => (await rows(sessionId)).find((r) => r.attempt === attempt),
      (r) => r !== undefined && r.status !== 'PENDING',
    );
  const nameState = async (c: Candidate, name: string): Promise<string | null> => {
    const raw = await redis.hget(`evidence:${c.sessionId}`, name);
    return raw === null ? null : (JSON.parse(raw) as { state: string }).state;
  };

  // ---------- TC-033: presign, upload, submit, match ----------

  it('FR-403/TC-033: presign, upload, submit and a MATCH give PASSED, seal the images, and queue verify-session', async () => {
    const c = await session();
    const n = await upload(c);
    const res = await submit(c, n);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ attempt: 1, status: 'PENDING', canRetry: false });

    const row = await settled(c.sessionId);
    expect(row?.status).toBe('PASSED');
    expect(Number(row?.faceMatchScore)).toBeCloseTo(0.93);
    expect(row?.modelId).toBe('auraface-v1:a7933ea5');
    // The originals are gone, the sealed pair is kept and is what the row points at.
    expect(
      storage.keysUnder(`${c.sessionId}/identity/1/id-`).filter((k) => !k.includes('/sealed/')),
    ).toEqual([]);
    expect(row?.idImageKey).toContain('/identity/1/sealed/id-');
    expect(storage.objects.has(row?.idImageKey as string)).toBe(true);
    await eventually(
      () => Promise.resolve(verify.calls.length),
      (n2) => n2 > 0,
    );
    expect(verify.calls).toEqual([{ orgId: c.orgId, sessionId: c.sessionId }]);
    // The worker got two 60 s sealed URLs and the reported liveness; never a key.
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0]?.livenessConfirmed).toBe(true);
    expect(worker.calls[0]?.idImageUrl).toContain('storage.invalid');
    expect(storage.gets.map((g) => g.ttlSeconds)).toEqual(expect.arrayContaining([60, 60]));
    // The candidate sees the status only (NFR-05).
    const status = await get(c);
    expect(status.body).toEqual({ attempt: 1, status: 'PASSED', canRetry: false });
    expect(JSON.stringify(status.body)).not.toMatch(/score|threshold|model|reason/i);
    expect(await events(c.sessionId)).toHaveLength(0); // a pass writes no review event
  });

  it('TC-033: below threshold twice is LOW_CONFIDENCE, a retry, then MANUAL_REVIEW with the review event and verify-session; never a rejection', async () => {
    const c = await session();
    worker.next = () => review('BELOW_THRESHOLD');
    const first = await upload(c);
    expect((await submit(c, first)).status).toBe(202);
    expect((await settled(c.sessionId, 1))?.status).toBe('LOW_CONFIDENCE');
    expect((await get(c)).body).toEqual({ attempt: 1, status: 'LOW_CONFIDENCE', canRetry: true });
    expect(verify.calls).toHaveLength(0); // the candidate retries: no gate yet

    const second = await upload(c);
    expect(second.attempt).toBe(2);
    expect((await submit(c, second)).status).toBe(202);
    const row2 = await settled(c.sessionId, 2);
    expect(row2?.status).toBe('MANUAL_REVIEW');
    expect(row2?.reviewReason).toBe('BELOW_THRESHOLD');
    expect(await events(c.sessionId)).toHaveLength(1);
    await eventually(
      () => Promise.resolve(verify.calls.length),
      (n2) => n2 > 0,
    );
    expect(verify.calls).toHaveLength(1);
    // The candidate continues; no third attempt.
    expect((await get(c)).body).toEqual({ attempt: 2, status: 'MANUAL_REVIEW', canRetry: false });
    const third = await post('/presign', c, {
      purpose: 'SELFIE',
      contentType: 'image/jpeg',
      bytes: MIB,
    });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('IDENTITY_ATTEMPTS_EXHAUSTED');
    const all = await rows(c.sessionId);
    expect(all.map((r) => r.status)).toEqual(['LOW_CONFIDENCE', 'MANUAL_REVIEW']);
  });

  it('TC-034: liveness not confirmed is passed to the worker and only ever leads to review', async () => {
    const c = await session();
    worker.next = (req) =>
      req.livenessConfirmed ? match(0.9) : review('LIVENESS_NOT_CONFIRMED', null);
    const n = await upload(c);
    await submit(c, n, false);
    const row = await settled(c.sessionId);
    expect(worker.calls[0]?.livenessConfirmed).toBe(false);
    expect(row?.status).toBe('LOW_CONFIDENCE');
    expect(row?.reviewReason).toBe('LIVENESS_NOT_CONFIRMED');
  });

  // ---------- idempotency keyed on the names ----------

  it('FR-403/TC-033: a repeat POST of the same names returns the same row; two concurrent identical POSTs make one row and one job', async () => {
    const c = await session();
    let release: () => void = () => undefined;
    worker.gate = new Promise((r) => (release = r));
    const n = await upload(c);
    const [a, b] = await Promise.all([submit(c, n), submit(c, n)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    const again = await submit(c, n);
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('PENDING');
    expect(await rows(c.sessionId)).toHaveLength(1);
    release();
    await settled(c.sessionId);
    expect(worker.calls).toHaveLength(1); // one job, one worker call
    const repeat = await submit(c, n); // after the match: the row with its real status
    expect(repeat.body.status).toBe('PASSED');
  });

  it('FR-403/TC-033: new names while attempt 1 is PENDING are refused with 409 and their uploads are deleted', async () => {
    const c = await session();
    let release: () => void = () => undefined;
    worker.gate = new Promise((r) => (release = r));
    const first = await upload(c);
    const second = await upload(c); // both sets are issued for attempt 1 before the first submit
    await submit(c, first);
    const res = await submit(c, second);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDENTITY_CHECK_PENDING');
    expect(await nameState(c, second.idImageName)).toBe('EXPIRED');
    expect(storage.keysUnder(second.idImageName.slice('identity/1/'.length))).toEqual([]);
    expect(await rows(c.sessionId)).toHaveLength(1);
    release();
    await settled(c.sessionId);
  });

  it('FR-403: a lost enqueue leaves a PENDING row that a repeat POST of the same names recovers', async () => {
    const c = await session();
    const jobs = app.get(
      jest.requireActual<typeof import('./identity-jobs.service')>('./identity-jobs.service')
        .IdentityJobsService,
    );
    const spy = jest.spyOn(jobs, 'enqueue').mockRejectedValueOnce(new Error('redis down'));
    const n = await upload(c);
    const first = await submit(c, n);
    expect(first.status).toBe(202); // the request does not fail: the row is the record
    spy.mockRestore();
    expect((await rows(c.sessionId))[0]?.status).toBe('PENDING');
    expect((await submit(c, n)).status).toBe(202); // a repeat queues the job again
    expect((await settled(c.sessionId))?.status).toBe('PASSED');
  });

  // ---------- the waiver (C-02, C-19, C-25, ADR 0015, N3, DL-30) ----------

  const waive = (c: Candidate): Promise<unknown> =>
    owner.invitation.updateMany({
      where: { sessions: { some: { id: c.sessionId } } },
      data: { accommodations: { identityCheckWaiver: { reasonCode: 'OTHER', reasonNote: 'x' } } },
    });

  it('C-02: a waived session refuses presign and submit with 409, whatever the state, deleting the uploads and expiring the names', async () => {
    const c = await session();
    const n = await upload(c); // uploaded before the recruiter waived
    await waive(c);
    expect(
      (await post('/presign', c, { purpose: 'ID_IMAGE', contentType: 'image/jpeg', bytes: MIB }))
        .body.code,
    ).toBe('IDENTITY_CHECK_WAIVED');
    const res = await submit(c, n);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDENTITY_CHECK_WAIVED');
    expect(storage.keysUnder(`${c.sessionId}/identity/`)).toEqual([]); // N3: deleted by the 409 handler
    expect(await nameState(c, n.idImageName)).toBe('EXPIRED');
    expect(await rows(c.sessionId)).toHaveLength(0);
    expect(worker.calls).toHaveLength(0); // no worker call, no image read
    expect((await get(c)).body).toEqual({ attempt: 0, status: 'WAIVED', canRetry: false });
  });

  it('C-02/FR-403: a waived session answers 409 on a repeat POST of an accepted attempt too, never 202; and for a VERIFIED session', async () => {
    const c = await session();
    const n = await upload(c);
    await submit(c, n);
    await settled(c.sessionId);
    await waive(c);
    const repeat = await submit(c, n);
    expect(repeat.status).toBe(409);
    expect(repeat.body.code).toBe('IDENTITY_CHECK_WAIVED');
    const v = await session({ status: 'VERIFIED' });
    await waive(v);
    const ghost = {
      idImageName: `identity/1/id-${'0'.repeat(26)}.jpg`,
      selfieName: `identity/1/selfie-${'0'.repeat(26)}.jpg`,
    };
    expect((await submit(v, ghost)).body.code).toBe('IDENTITY_CHECK_WAIVED');
  });

  it('DL-30: a waiver after a match deletes every sealed image of every attempt; the rows keep only ids, status and times', async () => {
    const c = await session();
    worker.next = () => review('NO_FACE', null);
    await submit(c, await upload(c));
    await settled(c.sessionId, 1);
    worker.next = () => match(0.9);
    await submit(c, await upload(c));
    await settled(c.sessionId, 2);
    expect(storage.keysUnder(`${c.sessionId}/identity/`).length).toBeGreaterThan(0);
    await waive(c);
    const out = await identity.purgeAfterWaiver(c.orgId, c.sessionId);
    expect(out.deleted).toBe(true);
    expect(storage.keysUnder(`${c.sessionId}/identity/`)).toEqual([]);
    for (const r of await rows(c.sessionId)) {
      expect([
        r.idImageKey,
        r.selfieKey,
        r.faceMatchScore,
        r.modelId,
        r.threshold,
        r.reviewReason,
      ]).toEqual([null, null, null, null, null, null]);
    }
    expect((await rows(c.sessionId)).map((r) => r.status)).toEqual(['LOW_CONFIDENCE', 'PASSED']);
  });

  it('DL-30/C-02: a waiver that lands while the job waits: the job deletes the images and writes no result', async () => {
    const c = await session();
    let release: () => void = () => undefined;
    worker.gate = new Promise((r) => (release = r));
    await submit(c, await upload(c));
    await eventually(
      () => Promise.resolve(worker.calls.length),
      (n) => n > 0,
    ); // the call is in flight
    await waive(c);
    release();
    await eventually(
      () => Promise.resolve(storage.keysUnder(`${c.sessionId}/identity/`)),
      (k) => k.length === 0,
    );
    expect(storage.keysUnder(`${c.sessionId}/identity/`)).toEqual([]);
    const [row] = await rows(c.sessionId);
    expect(row?.status).toBe('PENDING'); // nothing was written
    expect(row?.faceMatchScore).toBeNull();
    expect(verify.calls).toHaveLength(0);
  });

  it('ADR 0004 9.5: an erasure request stops the job before any image is presigned or read, and writes nothing', async () => {
    const c = await session();
    const inv = await owner.session.findUniqueOrThrow({
      where: { id: c.sessionId },
      select: { invitation: { select: { candidateId: true } } },
    });
    await owner.identityCheck.create({
      data: {
        sessionId: c.sessionId,
        attempt: 1,
        status: 'PENDING',
        idImageKey: identitySealedKey(
          { orgId: c.orgId, sessionId: c.sessionId },
          1,
          'id',
          '1'.repeat(26),
        ),
        selfieKey: identitySealedKey(
          { orgId: c.orgId, sessionId: c.sessionId },
          1,
          'selfie',
          '1'.repeat(26),
        ),
        livenessPassed: true,
      },
    });
    await owner.candidate.update({
      where: { id: inv.invitation.candidateId },
      data: { erasureRequestedAt: new Date() },
    });
    const jobs = app.get(
      jest.requireActual<typeof import('./identity-jobs.service')>('./identity-jobs.service')
        .IdentityJobsService,
    );
    const gets = storage.gets.length;
    await jobs.process({
      name: 'face-match',
      data: { orgId: c.orgId, sessionId: c.sessionId, attempt: 1 },
    });
    expect(worker.calls).toHaveLength(0);
    expect(storage.gets.length).toBe(gets); // nothing was presigned
    const [row] = await rows(c.sessionId);
    expect(row?.status).toBe('PENDING');
    expect(verify.calls).toHaveLength(0);
    // The reconciler leaves an erased or erasing session alone, too.
    await owner.identityCheck.updateMany({
      where: { sessionId: c.sessionId },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    await jobs.reconcilePending();
    expect(worker.calls).toHaveLength(0);
  });

  it('DL-30/B1: a purge that lands after the job pre-check cannot be overwritten by the late result', async () => {
    const c = await session();
    let release: () => void = () => undefined;
    worker.gate = new Promise((r) => (release = r));
    await submit(c, await upload(c));
    await eventually(
      () => Promise.resolve(worker.calls.length),
      (n) => n > 0,
    );
    // The waiver flow purges while the worker call is in flight, but the waiver is not yet visible
    // to the job's own re-read (it only sees the nulled keys): the compare-and-set must still lose.
    await owner.identityCheck.updateMany({
      where: { sessionId: c.sessionId },
      data: { idImageKey: null, selfieKey: null },
    });
    release();
    await jobFinished(c.sessionId); // the job really finished before we look
    const [row] = await rows(c.sessionId);
    expect(row?.status).toBe('PENDING');
    expect([row?.faceMatchScore, row?.modelId, row?.reviewReason]).toEqual([null, null, null]);
    expect(verify.calls).toHaveLength(0);
  });

  it('ADR 0004 9.5/B1: an erasure request that lands during the worker call writes no result', async () => {
    const c = await session();
    const candidateId = (
      await owner.session.findUniqueOrThrow({
        where: { id: c.sessionId },
        select: { invitation: { select: { candidateId: true } } },
      })
    ).invitation.candidateId;
    let release: () => void = () => undefined;
    worker.gate = new Promise((r) => (release = r));
    await submit(c, await upload(c));
    await eventually(
      () => Promise.resolve(worker.calls.length),
      (n) => n > 0,
    );
    await owner.candidate.update({
      where: { id: candidateId },
      data: { erasureRequestedAt: new Date() },
    });
    release();
    await jobFinished(c.sessionId); // the job really finished before we look
    const [row] = await rows(c.sessionId);
    expect(row?.status).toBe('PENDING');
    expect(row?.faceMatchScore).toBeNull();
    expect(verify.calls).toHaveLength(0);
  });

  it('DL-30/B2: the reconciler deletes what a waived session left when its job was lost', async () => {
    const c = await session();
    const sealedId = identitySealedKey(
      { orgId: c.orgId, sessionId: c.sessionId },
      1,
      'id',
      '2'.repeat(26),
    );
    const sealedSelfie = identitySealedKey(
      { orgId: c.orgId, sessionId: c.sessionId },
      1,
      'selfie',
      '2'.repeat(26),
    );
    storage.upload(sealedId, MIB, 'image/jpeg');
    storage.upload(sealedSelfie, MIB, 'image/jpeg');
    await owner.identityCheck.create({
      data: {
        sessionId: c.sessionId,
        attempt: 1,
        status: 'PENDING',
        idImageKey: sealedId,
        selfieKey: sealedSelfie,
        livenessPassed: true,
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await waive(c);
    const jobs = app.get(
      jest.requireActual<typeof import('./identity-jobs.service')>('./identity-jobs.service')
        .IdentityJobsService,
    );
    await jobs.reconcilePending();
    expect(storage.keysUnder(`${c.sessionId}/identity/`)).toEqual([]);
    const [row] = await rows(c.sessionId);
    expect([row?.idImageKey, row?.selfieKey]).toEqual([null, null]);
    expect(worker.calls).toHaveLength(0);
  });

  it('DL-30/B3: a purge that leaves objects behind keeps the keys and fails, so it is retried', async () => {
    const c = await session();
    const sealedId = identitySealedKey(
      { orgId: c.orgId, sessionId: c.sessionId },
      1,
      'id',
      '3'.repeat(26),
    );
    storage.upload(sealedId, MIB, 'image/jpeg');
    await owner.identityCheck.create({
      data: {
        sessionId: c.sessionId,
        attempt: 1,
        status: 'PASSED',
        idImageKey: sealedId,
        selfieKey: sealedId,
      },
    });
    storage.leaveBehind = true;
    await expect(identity.purgeAfterWaiver(c.orgId, c.sessionId)).rejects.toThrow(
      'IDENTITY_PURGE_INCOMPLETE',
    );
    storage.leaveBehind = false;
    const [kept] = await rows(c.sessionId);
    expect(kept?.idImageKey).toBe(sealedId); // the record of the object that still exists
    await identity.purgeAfterWaiver(c.orgId, c.sessionId); // the retry finishes
    const [done] = await rows(c.sessionId);
    expect(done?.idImageKey).toBeNull();
    expect(storage.keysUnder(`${c.sessionId}/identity/`)).toEqual([]);
  });

  // ---------- a failing worker never blocks the candidate (D-05) ----------

  it('TC-033: a worker that is down ends in MANUAL_REVIEW with MATCH_ERROR after the retries, with the event and verify-session', async () => {
    const c = await session();
    worker.next = () => {
      throw new errors.WorkerRetryableError('WORKER_UNAVAILABLE');
    };
    await submit(c, await upload(c));
    const row = await settled(c.sessionId);
    expect(row?.status).toBe('MANUAL_REVIEW');
    expect(row?.reviewReason).toBe('MATCH_ERROR');
    expect(worker.calls).toHaveLength(2); // two attempts
    expect(await events(c.sessionId)).toHaveLength(1);
    await eventually(
      () => Promise.resolve(verify.calls.length),
      (n) => n > 0,
    );
    expect(verify.calls).toHaveLength(1);
  });

  it('TC-033/D-05: an unrecoverable worker failure (a key mistake) resolves at once, with no retry', async () => {
    const c = await session();
    worker.next = () => {
      throw new errors.WorkerUnrecoverableError('WORKER_AUTH_FAILED');
    };
    await submit(c, await upload(c));
    const row = await settled(c.sessionId);
    expect(row?.status).toBe('MANUAL_REVIEW');
    expect(worker.calls).toHaveLength(1);
  });

  it('TC-033/ADR 0014 6.4: a verified WORKER_BUSY re-delays without using an attempt, then the match goes through', async () => {
    const c = await session();
    let n = 0;
    worker.next = () => {
      n += 1;
      if (n === 1) throw new errors.WorkerBusyError(1);
      return match(0.9);
    };
    await submit(c, await upload(c));
    const row = await settled(c.sessionId);
    expect(row?.status).toBe('PASSED');
    expect(worker.calls).toHaveLength(2);
  });

  it('TC-033/CS-4.7: a busy session lock at the result write re-delays the job and keeps the computed result, never a match error', async () => {
    const { IdentitySessionJobs } =
      jest.requireActual<typeof import('./identity-session-jobs')>('./identity-session-jobs');
    const { SessionLockRetryError } =
      jest.requireActual<typeof import('../database/errors')>('../database/errors');
    const writer = app.get(IdentitySessionJobs);
    const real = writer.commit.bind(writer);
    let busy = 1;
    const spy = jest.spyOn(writer, 'commit').mockImplementation((data, keys) => {
      if (busy-- > 0) return Promise.reject(new SessionLockRetryError());
      return real(data, keys);
    });
    try {
      const c = await session();
      await submit(c, await upload(c));
      const row = await settled(c.sessionId);
      expect(row?.status).toBe('PASSED'); // the match was kept, not replaced by MANUAL_REVIEW
    } finally {
      spy.mockRestore();
    }
  });

  // ---------- uploads and names ----------

  it('FR-403: submitting before the upload gives 409 UPLOAD_NOT_FOUND and leaves the names usable', async () => {
    const c = await session();
    const names: Record<string, string> = {};
    for (const purpose of ['ID_IMAGE', 'SELFIE'] as const) {
      const res = await post('/presign', c, { purpose, contentType: 'image/jpeg', bytes: MIB });
      names[purpose] = res.body.name;
    }
    const n = { idImageName: names.ID_IMAGE as string, selfieName: names.SELFIE as string };
    const res = await submit(c, n);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UPLOAD_NOT_FOUND');
    expect(await nameState(c, n.idImageName)).toBe('ISSUED');
    expect(await rows(c.sessionId)).toHaveLength(0);
  });

  it('FR-403/ADR 0013 5.6: a wrong object (not a JPEG) is refused with 400, deleted, and its name is spent', async () => {
    const c = await session();
    const n = await upload(c, { idType: 'text/html' });
    const res = await submit(c, n);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDENTITY_IMAGE_REJECTED');
    expect(await nameState(c, n.idImageName)).toBe('EXPIRED');
    expect(storage.keysUnder(`${c.sessionId}/identity/1/id-`)).toEqual([]);
    expect(await rows(c.sessionId)).toHaveLength(0);
  });

  it('FR-403/CS-3: names are validated: foreign, unknown, swapped, reused and bad-format names are 400 and nothing is copied', async () => {
    const c = await session();
    const n = await upload(c);
    const swapped = await submit(c, { idImageName: n.selfieName, selfieName: n.idImageName });
    expect(swapped.status).toBe(400);
    const bad = await post('', c, {
      idImageName: 'identity/../x.jpg',
      selfieName: n.selfieName,
      livenessConfirmed: true,
    });
    expect(bad.status).toBe(400);
    const unknown = await submit(c, {
      idImageName: `identity/1/id-${'1'.repeat(26)}.jpg`,
      selfieName: n.selfieName,
    });
    expect(unknown.status).toBe(400);
    // Another session's names are not ours.
    const other2 = await session();
    const theirs = await upload(other2);
    const foreign = await submit(c, theirs);
    expect(foreign.status).toBe(400);
    expect(storage.keysUnder(`${c.sessionId}/identity/1/sealed`)).toEqual([]);
    expect(await rows(c.sessionId)).toHaveLength(0);
  });

  it('FR-403: presign refuses a bad size, the wrong type and a session that is not CONSENTED', async () => {
    const c = await session();
    for (const body of [
      { purpose: 'ID_IMAGE', contentType: 'image/jpeg', bytes: 5 * MIB + 1 },
      { purpose: 'ID_IMAGE', contentType: 'image/jpeg', bytes: 0 },
      { purpose: 'ID_IMAGE', contentType: 'image/png', bytes: MIB },
      { purpose: 'PASSPORT', contentType: 'image/jpeg', bytes: MIB },
      { purpose: 'ID_IMAGE', contentType: 'image/jpeg', bytes: MIB, sessionId: 'x' },
    ]) {
      expect((await post('/presign', c, body)).status).toBe(400);
    }
    const started = await session({ status: 'IN_PROGRESS' });
    expect(
      (
        await post('/presign', started, {
          purpose: 'SELFIE',
          contentType: 'image/jpeg',
          bytes: MIB,
        })
      ).status,
    ).toBe(409);
  });

  it('FR-403: a lost enqueue is recovered by the reconciler: a PENDING row with no job gets one again', async () => {
    const c = await session();
    const old = new Date(Date.now() - 10 * 60_000);
    await owner.identityCheck.create({
      data: {
        sessionId: c.sessionId,
        attempt: 1,
        status: 'PENDING',
        idImageKey: identitySealedKey(
          { orgId: c.orgId, sessionId: c.sessionId },
          1,
          'id',
          '0'.repeat(26),
        ),
        selfieKey: identitySealedKey(
          { orgId: c.orgId, sessionId: c.sessionId },
          1,
          'selfie',
          '0'.repeat(26),
        ),
        livenessPassed: true,
        createdAt: old,
      },
    });
    const jobs = app.get(
      jest.requireActual<typeof import('./identity-jobs.service')>('./identity-jobs.service')
        .IdentityJobsService,
    );
    expect(await jobs.reconcilePending()).toBeGreaterThanOrEqual(1);
    const row = await settled(c.sessionId);
    expect(row?.status).toBe('PASSED');
  });

  // ---------- scope, secrecy ----------

  it('FR-403/TC-008: org scope: another organisation sees no row and cannot use these names', async () => {
    const c = await session();
    await submit(c, await upload(c));
    await settled(c.sessionId);
    const o = await session({}, other);
    expect((await get(o)).body).toEqual({ attempt: 0, status: 'NOT_STARTED', canRetry: false });
    // The other organisation's token cannot claim this session's names or reach its images.
    const fresh = await session();
    const mine = await upload(fresh);
    const theirs = await submit(o, mine);
    expect(theirs.status).toBe(400);
    expect(await nameState(fresh, mine.idImageName)).toBe('ISSUED'); // untouched
    expect(await rows(o.sessionId)).toHaveLength(0);
  });

  it('FR-403/ADR 0013 5.10: same-organisation scope: candidate B sees nothing of candidate A and cannot use A names or attempt', async () => {
    const a = await session();
    const aNames = await upload(a);
    await submit(a, aNames);
    await settled(a.sessionId);
    const b = await session();
    // B reads its own (empty) state, not A's PASSED row.
    expect((await get(b)).body).toEqual({ attempt: 0, status: 'NOT_STARTED', canRetry: false });
    // A's unused names, sent with B's token, are refused and stay A's.
    const fresh = await session();
    const mine = await upload(fresh);
    expect((await submit(b, mine)).status).toBe(400);
    expect(await nameState(fresh, mine.idImageName)).toBe('ISSUED');
    // A's used names (and so A's attempt number) give B no row and no idempotent replay.
    const replay = await submit(b, aNames);
    expect(replay.status).toBe(400);
    expect(await rows(b.sessionId)).toHaveLength(0);
    expect(await rows(a.sessionId)).toHaveLength(1);
  });

  it('FR-403/CS-4.7: the real verify-session enqueue is accepted from the session-job scope, after the commit, and nowhere else', async () => {
    const actual = <T extends object>(path: string): T => jest.requireActual<T>(path);
    const { VerifySessionJobs, VerifyEnqueueScopeError } = actual<
      typeof import('../session/verify-session.jobs')
    >('../session/verify-session.jobs');
    const { IdentitySessionJobs } =
      actual<typeof import('./identity-session-jobs')>('./identity-session-jobs');
    const { PrismaService } = actual<typeof import('../database/prisma.service')>(
      '../database/prisma.service',
    );
    const { OrgContextService } =
      actual<typeof import('../database/org-context')>('../database/org-context');
    const { SessionStateService } = actual<typeof import('../session/session-state.service')>(
      '../session/session-state.service',
    );
    const real = app.get(VerifySessionJobs);
    const c = await session();
    // Outside any scope the real enqueue refuses (a coding error, never a request path).
    await expect(real.enqueueVerifySession(c.orgId, c.sessionId)).rejects.toBeInstanceOf(
      VerifyEnqueueScopeError,
    );
    const writer = new IdentitySessionJobs(
      app.get(PrismaService),
      app.get(OrgContextService),
      app.get(SessionStateService),
      { enqueue: (o: string, s: string) => real.enqueueVerifySession(o, s) },
    );
    await writer.enqueueVerify(c.orgId, c.sessionId);
    expect(await redis.exists(`vs:${c.sessionId}`)).toBe(1); // the job was queued with its counter
    // Another organisation's ids from this session's scope are refused too.
    const o = await session({}, other);
    const foreign = new IdentitySessionJobs(
      app.get(PrismaService),
      app.get(OrgContextService),
      app.get(SessionStateService),
      { enqueue: () => real.enqueueVerifySession(o.orgId, o.sessionId) },
    );
    await expect(foreign.enqueueVerify(c.orgId, c.sessionId)).rejects.toBeInstanceOf(
      VerifyEnqueueScopeError,
    );
  });

  it('FR-403: no token and a bad token are refused', async () => {
    const res = await reply(request(app.getHttpServer()).get(API));
    expect(res.status).toBe(401);
    const bad = await reply(
      request(app.getHttpServer()).get(API).set('Authorization', 'Bearer not-a-token'),
    );
    expect(bad.status).toBe(401);
  });

  it('NFR-04: logs hold session ids and outcomes only: no URL, key, name or score', () => {
    const text = logged.join('\n');
    expect(text).not.toMatch(
      /storage\.invalid|identity\/\d\/(?:id|selfie)-|sealed\/|0\.93|auraface/i,
    );
  });
});
