// BE-09 end to end: candidate media presign and confirm over HTTP against real Postgres 16
// (app_user, real grants, real migrations) and real Redis (Testcontainers; the dev stack is never
// touched). Object storage is the in-memory FakeStorage, which applies the real key-scope rules.
// Covers FR-701, FR-702, FR-703 and TC-070 (API side), TC-071, and ADR 0013 sections 5.1, 5.5, 5.7,
// 5.10 (CS-1 to CS-3).
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CandidateMailPort } from '../candidate/candidate-mail.port';
import type { CandidateTokenService } from '../candidate/candidate-token.service';
import { createInvitation, createTenant } from '../candidate/testing/fixtures';
import type { InvitationOptions, Tenant } from '../candidate/testing/fixtures';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { MediaPlaybackService } from './media-playback.service';
import { mediaChunkKey } from './storage-keys';
import { FakeStorage } from './testing/fake-storage';

const API = '/api/v1/candidate/session/media';
const MIB = 1024 * 1024;
const GRACE_SECONDS = 300;

const noMail: CandidateMailPort = {
  sendOtp: () => Promise.resolve(),
  sendOtpLockout: () => Promise.resolve(),
  sendConsentCopy: () => Promise.resolve(),
};

describe('Candidate media presign and confirm (FR-701, FR-702, FR-703, TC-070, TC-071, ADR 0013 section 5.5)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let redis: Redis;
  let app: INestApplication<App>;
  let tokens: CandidateTokenService;
  let playback: MediaPlaybackService;
  let orgContext: { runInOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> };
  let tenant: Tenant;
  let other: Tenant;
  const storage = new FakeStorage();
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
    tenant = await createTenant(owner, 'media');
    other = await createTenant(owner, 'media-other');

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
      PROCTOR_INGEST_GRACE_SECONDS: String(GRACE_SECONDS),
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
    const storageSvc = jest.requireActual<typeof import('./storage.service')>('./storage.service');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(mailPort.CandidateMailPort)
      .useValue(noMail)
      .overrideProvider(storageSvc.StorageService)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    tokens = app.get(
      jest.requireActual<typeof import('../candidate/candidate-token.service')>(
        '../candidate/candidate-token.service',
      ).CandidateTokenService,
    );
    playback = app.get(
      jest.requireActual<typeof import('./media-playback.service')>('./media-playback.service')
        .MediaPlaybackService,
    );
    orgContext = app.get(
      jest.requireActual<typeof import('../database/org-context')>('../database/org-context')
        .OrgContextService,
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

  // ---------- helpers ----------

  interface Candidate {
    readonly sessionId: string;
    readonly orgId: string;
    readonly token: string;
  }

  async function session(options: InvitationOptions = {}, t: Tenant = tenant): Promise<Candidate> {
    const startedAt = new Date(Date.now() - 5 * 60_000);
    const inv = await createInvitation(owner, t, {
      status: 'IN_PROGRESS',
      session: { startedAt, deadlineAt: new Date(Date.now() + 55 * 60_000) },
      ...options,
    });
    const token = tokens.sign({ sid: inv.sessionId, oid: t.orgId, epoch: 0 }).token;
    return { sessionId: inv.sessionId, orgId: t.orgId, token };
  }

  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    stream: 'SCREEN',
    segment: 0,
    seq: 0,
    bytes: 2 * MIB,
    contentType: 'video/webm',
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    durationMs: 10_000,
    ...over,
  });

  const post = (path: string, token: string, payload: object): request.Test =>
    request(app.getHttpServer())
      .post(`${API}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

  const key = (
    c: Candidate,
    stream: 'SCREEN' | 'WEBCAM' | 'AUDIO' | 'ROOM_SCAN',
    seg: number,
    seq: number,
  ) => mediaChunkKey({ orgId: c.orgId, sessionId: c.sessionId }, stream, seg, seq);

  const rows = (sessionId: string) =>
    owner.mediaChunk.findMany({
      where: { sessionId },
      orderBy: [{ stream: 'asc' }, { seq: 'asc' }],
    });

  async function upload(
    c: Candidate,
    over: Record<string, unknown> = {},
    size?: number,
    type?: string,
  ): Promise<void> {
    const b = body(over);
    const res = await post('/presign', c.token, b);
    expect(res.status).toBe(200);
    const stream = b.stream as 'SCREEN' | 'WEBCAM' | 'AUDIO' | 'ROOM_SCAN';
    storage.upload(
      key(c, stream, b.segment as number, b.seq as number),
      size ?? (b.bytes as number),
      type ?? (b.contentType as string),
    );
  }

  // ---------- TC-070: presign, upload, confirm ----------

  it('TC-070: presign records a pending row, confirm after the upload marks it uploaded (API side)', async () => {
    const c = await session();
    const res = await post('/presign', c.token, body({ seq: 4 }));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
    });
    expect(typeof (res.body as { url: string }).url).toBe('string');
    const expires = new Date((res.body as { expiresAt: string }).expiresAt).getTime();
    expect(expires - Date.now()).toBeLessThanOrEqual(60_000);
    expect(expires - Date.now()).toBeGreaterThan(50_000);

    const [pending] = await rows(c.sessionId);
    expect(pending).toMatchObject({
      stream: 'SCREEN',
      segment: 0,
      seq: 4,
      uploadedAt: null,
      objectKey: key(c, 'SCREEN', 0, 4),
    });
    expect(Number(pending?.sizeBytes)).toBe(2 * MIB);

    storage.upload(key(c, 'SCREEN', 0, 4), 2 * MIB, 'video/webm');
    const confirmed = await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 4 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({ uploaded: true, sizeBytes: 2 * MIB });
    const [done] = await rows(c.sessionId);
    expect(done?.uploadedAt).not.toBeNull();
    expect(Number(done?.sizeBytes)).toBe(2 * MIB);
    // The ETag is kept in Redis for the ingest-close sweep, not in the database.
    expect(await redis.hget(`etag:${c.sessionId}`, 'SCREEN:4')).toMatch(/etag/);
    // Only SessionStateService changes the status: the media routes never do.
    expect((await owner.session.findUniqueOrThrow({ where: { id: c.sessionId } })).status).toBe(
      'IN_PROGRESS',
    );
  });

  it('TC-070: SCREEN, WEBCAM and AUDIO all upload, and a restart is a new segment with its own first seq', async () => {
    const c = await session();
    await upload(c, { stream: 'SCREEN', seq: 0 });
    await upload(c, { stream: 'WEBCAM', seq: 0 });
    await upload(c, { stream: 'AUDIO', seq: 0, contentType: 'audio/webm', bytes: 1 * MIB });
    // The recorder restarts: segment 1 continues the same seq counter.
    await upload(c, { stream: 'SCREEN', segment: 1, seq: 1 });
    for (const ref of [
      { stream: 'SCREEN', segment: 0, seq: 0 },
      { stream: 'WEBCAM', segment: 0, seq: 0 },
      { stream: 'AUDIO', segment: 0, seq: 0 },
      { stream: 'SCREEN', segment: 1, seq: 1 },
    ]) {
      expect((await post('/confirm', c.token, ref)).status).toBe(200);
    }
    const all = await rows(c.sessionId);
    expect(all.map((r) => `${r.stream}:${String(r.segment)}:${String(r.seq)}`).sort()).toEqual([
      'AUDIO:0:0',
      'SCREEN:0:0',
      'SCREEN:1:1',
      'WEBCAM:0:0',
    ]);
    expect(all.every((r) => r.uploadedAt !== null)).toBe(true);
  });

  it('FR-701: a retried presign upserts the same row (new size and URL), never a second row', async () => {
    const c = await session();
    const first = await post('/presign', c.token, body({ seq: 7, bytes: MIB }));
    const second = await post('/presign', c.token, body({ seq: 7, bytes: 3 * MIB }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as { url: string }).url).not.toBe((first.body as { url: string }).url);
    const all = await rows(c.sessionId);
    expect(all).toHaveLength(1);
    expect(Number(all[0]?.sizeBytes)).toBe(3 * MIB);
    // The retry signed the new size.
    expect(storage.presigned.at(-1)?.bytes).toBe(3 * MIB);
  });

  it('FR-701: a confirmed chunk gets { alreadyUploaded: true } and no URL; confirm is idempotent', async () => {
    const c = await session();
    await upload(c, { seq: 1 });
    const ref = { stream: 'SCREEN', segment: 0, seq: 1 };
    expect((await post('/confirm', c.token, ref)).status).toBe(200);
    const again = await post('/presign', c.token, body({ seq: 1 }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ alreadyUploaded: true });
    const confirmAgain = await post('/confirm', c.token, ref);
    expect(confirmAgain.status).toBe(200);
    expect(confirmAgain.body).toEqual({ uploaded: true, sizeBytes: 2 * MIB });
    expect(await rows(c.sessionId)).toHaveLength(1);
  });

  it('FR-702: the same stream and seq under another segment is 409 SEQ_CONFLICT and changes nothing', async () => {
    const c = await session();
    await post('/presign', c.token, body({ seq: 3, segment: 0 })).expect(200);
    const res = await post('/presign', c.token, body({ seq: 3, segment: 1 }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SEQ_CONFLICT' });
    const [row] = await rows(c.sessionId);
    expect(row?.segment).toBe(0);
  });

  it('FR-701: startedAt is clamped to the server clock, so a future time cannot be stored', async () => {
    const c = await session();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await post('/presign', c.token, body({ seq: 9, startedAt: future })).expect(200);
    const [row] = await rows(c.sessionId);
    expect((row?.startedAt.getTime() ?? Infinity) <= Date.now()).toBe(true);
  });

  // ---------- confirm failures ----------

  it('FR-701: confirm without a presign is 404 CHUNK_NOT_PRESIGNED; with another segment too', async () => {
    const c = await session();
    const res = await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CHUNK_NOT_PRESIGNED' });
    await post('/presign', c.token, body({ seq: 2, segment: 0 })).expect(200);
    const wrong = await post('/confirm', c.token, { stream: 'SCREEN', segment: 5, seq: 2 });
    expect(wrong.status).toBe(404);
  });

  it('FR-701: confirm before the PUT landed is 409 UPLOAD_NOT_FOUND and the row stays pending', async () => {
    const c = await session();
    await post('/presign', c.token, body({ seq: 0 })).expect(200);
    const res = await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    expect((await rows(c.sessionId))[0]?.uploadedAt).toBeNull();
  });

  it('FR-701: a wrong size at confirm is 422 UPLOAD_MISMATCH, the object is deleted, the row stays pending, a retry works', async () => {
    const c = await session();
    await upload(c, { seq: 0 }, 5 * MIB); // presigned for 2 MiB, 5 MiB stored
    const res = await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'UPLOAD_MISMATCH' });
    expect(storage.objects.has(key(c, 'SCREEN', 0, 0))).toBe(false);
    expect((await rows(c.sessionId))[0]?.uploadedAt).toBeNull();
    // Presign again, upload the right bytes, confirm.
    await upload(c, { seq: 0 });
    expect((await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 })).status).toBe(
      200,
    );
  });

  it('FR-701: a wrong content type at confirm is 422 and the object is deleted', async () => {
    const c = await session();
    await upload(c, { seq: 0 }, 2 * MIB, 'text/html');
    const res = await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 });
    expect(res.status).toBe(422);
    expect(storage.objects.has(key(c, 'SCREEN', 0, 0))).toBe(false);
  });

  it('FR-701: a storage outage on confirm is 503 STORAGE_UNAVAILABLE with no SDK detail', async () => {
    const c = await session();
    await upload(c, { seq: 0 });
    storage.failHead = true;
    try {
      const res = await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(JSON.stringify(res.body)).not.toContain('orgs/');
      expect(JSON.stringify(res.body)).not.toContain('boom');
    } finally {
      storage.failHead = false;
    }
  });

  it('NFR-04: with no storage settings both routes answer 503 STORAGE_UNCONFIGURED', async () => {
    const c = await session();
    storage.enabled = false;
    try {
      const res = await post('/presign', c.token, body());
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'STORAGE_UNCONFIGURED' });
      expect(
        (await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 })).status,
      ).toBe(503);
      expect(await rows(c.sessionId)).toHaveLength(0);
    } finally {
      storage.enabled = true;
    }
  });

  // ---------- validation ----------

  it('FR-701: type, size, stream, segment and seq limits are refused with 400', async () => {
    const c = await session();
    const bad: Array<Record<string, unknown>> = [
      { contentType: 'video/webm;codecs=vp8,opus' },
      { contentType: 'text/html' },
      { contentType: 'VIDEO/WEBM' },
      { bytes: 16 * MIB + 1 },
      { bytes: 0 },
      { bytes: 1.5 },
      { stream: 'AUDIO', contentType: 'audio/webm', bytes: 4 * MIB + 1 },
      { stream: 'SIDE_CAMERA' },
      { stream: 'screen' },
      { segment: 10_000 },
      { segment: -1 },
      { seq: 100_000_000 },
      { durationMs: 60_001 },
      { durationMs: 0 },
      { startedAt: 'yesterday' },
    ];
    for (const over of bad) {
      const res = await post('/presign', c.token, body(over));
      expect(res.status).toBe(400);
    }
    expect(await rows(c.sessionId)).toHaveLength(0);
  });

  it('FR-701: AUDIO may be exactly 4 MiB and other streams exactly 16 MiB', async () => {
    const c = await session();
    await post(
      '/presign',
      c.token,
      body({ stream: 'AUDIO', contentType: 'audio/webm', bytes: 4 * MIB }),
    ).expect(200);
    await post('/presign', c.token, body({ stream: 'WEBCAM', bytes: 16 * MIB })).expect(200);
  });

  it('CS-1, CS-3: a body that names a session or carries an object key is refused and never used', async () => {
    const a = await session();
    const b = await session();
    for (const extra of [
      { sessionId: b.sessionId },
      { objectKey: key(b, 'SCREEN', 0, 0) },
      { key: key(b, 'SCREEN', 0, 0) },
      { orgId: other.orgId },
    ]) {
      const res = await post('/presign', a.token, body(extra));
      expect(res.status).toBe(400);
      expect(
        (await post('/confirm', a.token, { stream: 'SCREEN', segment: 0, seq: 0, ...extra }))
          .status,
      ).toBe(400);
    }
    expect(await rows(b.sessionId)).toHaveLength(0);
    expect(await rows(a.sessionId)).toHaveLength(0);
  });

  // ---------- states ----------

  it('FR-701: ROOM_SCAN is allowed in CONSENTED only; the other streams are refused there', async () => {
    const consented = await session({ status: 'CONSENTED', session: {} });
    await post('/presign', consented.token, body({ stream: 'ROOM_SCAN' })).expect(200);
    const res = await post('/presign', consented.token, body({ stream: 'SCREEN' }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });

    const running = await session();
    const scan = await post('/presign', running.token, body({ stream: 'ROOM_SCAN' }));
    expect(scan.status).toBe(409);
    expect(scan.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
  });

  it('FR-701: recording continues while PAUSED, including a proctor pause (no SESSION_PAUSED)', async () => {
    const paused = await session({
      status: 'PAUSED',
      session: {
        startedAt: new Date(Date.now() - 600_000),
        deadlineAt: new Date(Date.now() + 3_000_000),
        pauseReasons: ['PROCTOR', 'SCREEN_SHARE_STOPPED'],
      },
    });
    await post('/presign', paused.token, body({ stream: 'WEBCAM' })).expect(200);
  });

  it('FR-701: a SUBMITTED session may still upload within the ingest grace, not after it', async () => {
    const within = await session({ status: 'SUBMITTED' });
    await owner.session.update({
      where: { id: within.sessionId },
      data: { submittedAt: new Date(Date.now() - 30_000) },
    });
    await post('/presign', within.token, body()).expect(200);

    const late = await session({ status: 'SUBMITTED' });
    await owner.session.update({
      where: { id: late.sessionId },
      data: { submittedAt: new Date(Date.now() - (GRACE_SECONDS + 30) * 1000) },
    });
    const res = await post('/presign', late.token, body());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
  });

  it('FR-701: states with no upload (INVITED, OPENED, DECLINED, EXPIRED, GRADED) answer 409', async () => {
    for (const status of ['INVITED', 'OPENED', 'DECLINED', 'EXPIRED', 'GRADED'] as const) {
      const c = await session({ status, session: {} });
      const res = await post('/presign', c.token, body());
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    }
  });

  // ---------- isolation (CS-2, CS-3, TC-008) ----------

  it('CS-3, TC-008: keys are built from the token session, and the same seq in two sessions never collides', async () => {
    const a = await session();
    const b = await session();
    const c = await session({}, other);
    for (const who of [a, b, c]) await post('/presign', who.token, body({ seq: 0 })).expect(200);
    const keys = storage.presigned.slice(-3).map((p) => p.key);
    expect(keys).toEqual([key(a, 'SCREEN', 0, 0), key(b, 'SCREEN', 0, 0), key(c, 'SCREEN', 0, 0)]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toContain(`orgs/${other.orgId}/sessions/${c.sessionId}/`);
    for (const [i, who] of [a, b, c].entries()) {
      const row = (await rows(who.sessionId))[0];
      expect(row?.objectKey).toBe(keys[i]);
    }
  });

  it('CS-2: confirming a chunk of another candidate session is 404 in your own scope', async () => {
    const a = await session();
    const b = await session();
    await upload(a, { seq: 0 });
    // B never presigned seq 0, so B's confirm finds nothing, even though A's object exists.
    const res = await post('/confirm', b.token, { stream: 'SCREEN', segment: 0, seq: 0 });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CHUNK_NOT_PRESIGNED' });
    expect((await rows(a.sessionId))[0]?.uploadedAt).toBeNull();
  });

  it('FR-701: no token, a malformed token and a token for a session in another org are 401', async () => {
    await request(app.getHttpServer()).post(`${API}/presign`).send(body()).expect(401);
    await post('/presign', 'not.a.token', body()).expect(401);
    const real = await session();
    const forged = tokens.sign({ sid: real.sessionId, oid: other.orgId, epoch: 0 }).token;
    await post('/presign', forged, body()).expect(401);
    expect(await rows(real.sessionId)).toHaveLength(0);
  });

  // ---------- limits ----------

  it('FR-701: more than 60 presigns a minute for one stream is 429 RATE_LIMITED with a retry hint', async () => {
    const c = await session();
    let last = 200;
    let limited: request.Response | undefined;
    for (let seq = 0; seq < 62; seq++) {
      const res = await post(
        '/presign',
        c.token,
        body({ stream: 'AUDIO', contentType: 'audio/webm', bytes: 1000, seq }),
      );
      last = res.status;
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(last).toBe(429);
    expect(limited?.body).toMatchObject({ code: 'RATE_LIMITED' });
    // Another stream of the same session has its own bucket.
    await post('/presign', c.token, body({ stream: 'SCREEN', seq: 0 })).expect(200);
  });

  it('FR-702: the per-stream presign cap (ceil(duration / 10 s) x 1.5 + 50) answers 429 PRESIGN_QUOTA_EXCEEDED', async () => {
    const c = await session(); // 60 minutes + 300 s grace: 390 x 1.5 + 50 = 636
    await redis.set(`presigns:${c.sessionId}:SCREEN`, '636');
    const res = await post('/presign', c.token, body({ seq: 0 }));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'PRESIGN_QUOTA_EXCEEDED' });
    expect(await rows(c.sessionId)).toHaveLength(0); // refused before any row or URL
    // Another stream is unaffected.
    await post('/presign', c.token, body({ stream: 'WEBCAM', seq: 0 })).expect(200);
  });

  // ---------- races, quota and failure paths (review) ----------

  it('FR-701: concurrent presigns of one chunk leave one row; a racing other segment is SEQ_CONFLICT', async () => {
    const c = await session();
    const same = await Promise.all(
      Array.from({ length: 6 }, () => post('/presign', c.token, body({ seq: 20, segment: 0 }))),
    );
    expect(same.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await rows(c.sessionId)).toHaveLength(1);

    const mixed = await Promise.all(
      [0, 1, 0, 1].map((segment) => post('/presign', c.token, body({ seq: 21, segment }))),
    );
    const statuses = mixed.map((r) => r.status);
    expect(statuses.filter((x) => x === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((x) => x === 200 || x === 409)).toBe(true);
    const row = (await rows(c.sessionId)).filter((r) => r.seq === 21);
    expect(row).toHaveLength(1);
    for (const r of mixed.filter((x) => x.status === 409)) {
      expect(r.body).toMatchObject({ code: 'SEQ_CONFLICT' });
    }
  });

  it('FR-701: stream and content type must agree (AUDIO is audio/webm, the others video/webm)', async () => {
    const c = await session();
    await post('/presign', c.token, body({ stream: 'AUDIO', contentType: 'video/webm' })).expect(
      400,
    );
    await post('/presign', c.token, body({ stream: 'WEBCAM', contentType: 'audio/webm' })).expect(
      400,
    );
    expect(await rows(c.sessionId)).toHaveLength(0);
  });

  it('FR-702: the ROOM_SCAN cap has a floor of 140 presigns before the deadline exists', async () => {
    const c = await session({ status: 'CONSENTED', session: {} });
    await redis.set(`presigns:${c.sessionId}:ROOM_SCAN`, '139');
    await post('/presign', c.token, body({ stream: 'ROOM_SCAN', seq: 0 })).expect(200);
    const res = await post('/presign', c.token, body({ stream: 'ROOM_SCAN', seq: 1 }));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'PRESIGN_QUOTA_EXCEEDED' });
  });

  it('FR-702: a long running proctor pause widens the cap (effective deadline and ingest grace)', async () => {
    const opts = (paused: boolean): InvitationOptions =>
      paused
        ? {
            status: 'PAUSED',
            session: {
              startedAt: new Date(Date.now() - 5 * 60_000),
              deadlineAt: new Date(Date.now() + 5 * 60_000),
              pauseReasons: ['PROCTOR'],
            },
          }
        : {
            session: {
              startedAt: new Date(Date.now() - 5 * 60_000),
              deadlineAt: new Date(Date.now() + 5 * 60_000),
            },
          };
    const paused = await session(opts(true));
    await owner.session.update({
      where: { id: paused.sessionId },
      data: { proctorPausedAt: new Date(Date.now() - 25 * 60_000) },
    });
    const plain = await session(opts(false));
    // 10 minutes plus 300 s grace: cap 185. With a 25-minute running credit: 35 min + grace: cap 410.
    await redis.set(`presigns:${paused.sessionId}:SCREEN`, '300');
    await redis.set(`presigns:${plain.sessionId}:SCREEN`, '300');
    await post('/presign', paused.token, body({ seq: 0 })).expect(200);
    const res = await post('/presign', plain.token, body({ seq: 0 }));
    expect(res.status).toBe(429);
  });

  it('FR-702: a retried presign counts against the quota', async () => {
    const c = await session();
    await post('/presign', c.token, body({ seq: 5 })).expect(200);
    await post('/presign', c.token, body({ seq: 5 })).expect(200);
    expect(await redis.get(`presigns:${c.sessionId}:SCREEN`)).toBe('2');
    expect(await redis.ttl(`presigns:${c.sessionId}:SCREEN`)).toBeGreaterThan(0);
  });

  it('FR-701: confirm still succeeds when Redis fails to keep the ETag', async () => {
    const c = await session();
    await upload(c, { seq: 0 });
    const client = app.get<Redis>(
      jest.requireActual<typeof import('../infrastructure/infrastructure.module')>(
        '../infrastructure/infrastructure.module',
      ).REDIS_CLIENT,
    );
    const spy = jest.spyOn(client, 'hset').mockRejectedValue(new Error('redis down'));
    try {
      const res = await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 });
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect((await rows(c.sessionId))[0]?.uploadedAt).not.toBeNull();
    expect(await redis.hget(`etag:${c.sessionId}`, 'SCREEN:0')).toBeNull();
  });

  it('FR-701: a signer failure after the row write is 503 STORAGE_UNAVAILABLE, the pending row stays and a retry works', async () => {
    const c = await session();
    storage.failPresign = true;
    try {
      const res = await post('/presign', c.token, body({ seq: 0 }));
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(JSON.stringify(res.body)).not.toContain('orgs/');
      expect(JSON.stringify(res.body)).not.toContain('signer down');
    } finally {
      storage.failPresign = false;
    }
    expect((await rows(c.sessionId))[0]?.uploadedAt).toBeNull();
    await post('/presign', c.token, body({ seq: 0 })).expect(200);
    expect(await rows(c.sessionId)).toHaveLength(1);
  });

  // ---------- playback (FR-703, TC-071) ----------

  it('FR-703, TC-071: the playlist groups uploaded chunks by stream and segment in seq order, 15-minute URLs', async () => {
    const c = await session();
    // Uploaded out of order across two segments, plus one pending chunk that must not appear.
    for (const [segment, seq] of [
      [1, 12],
      [0, 1],
      [0, 0],
      [1, 11],
    ] as const) {
      await upload(c, { stream: 'SCREEN', segment, seq });
      await post('/confirm', c.token, { stream: 'SCREEN', segment, seq }).expect(200);
    }
    await upload(c, { stream: 'AUDIO', contentType: 'audio/webm', bytes: MIB, seq: 0 });
    await post('/confirm', c.token, { stream: 'AUDIO', segment: 0, seq: 0 }).expect(200);
    await post('/presign', c.token, body({ stream: 'WEBCAM', seq: 0 })).expect(200); // pending

    const list = await orgContext.runInOrg(c.orgId, () => playback.playlist(c.sessionId));
    expect(list.streams.map((s) => s.stream).sort()).toEqual(['AUDIO', 'SCREEN']);
    const screen = list.streams.find((s) => s.stream === 'SCREEN');
    expect(screen?.segments.map((s) => s.segment)).toEqual([0, 1]);
    expect(screen?.segments[0]?.chunks.map((x) => x.seq)).toEqual([0, 1]);
    expect(screen?.segments[1]?.chunks.map((x) => x.seq)).toEqual([11, 12]);
    expect(screen?.segments[0]?.chunks[0]?.url).toMatch(/^https:\/\//);
    expect(
      storage.gets
        .slice(-5)
        .map((g) => g.contentType)
        .sort(),
    ).toEqual(['audio/webm', 'video/webm', 'video/webm', 'video/webm', 'video/webm']);
    const ttl = list.expiresAt.getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(ttl).toBeGreaterThan(14 * 60_000);
  });

  it('FR-703, TC-008: a playlist for a session of another org is 404 and no URL is signed', async () => {
    const c = await session();
    await upload(c, { seq: 0 });
    await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 }).expect(200);
    const before = storage.gets.length;
    await expect(
      orgContext.runInOrg(other.orgId, () => playback.playlist(c.sessionId)),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.gets.length).toBe(before);
  });

  it('FR-704: the candidate module binds ObjectStoragePort to the StorageService (consent PDF job)', () => {
    const port = jest.requireActual<typeof import('../candidate/object-storage.port')>(
      '../candidate/object-storage.port',
    ).ObjectStoragePort;
    expect(app.get(port)).toBe(storage);
  });

  it('FR-704: the app boots RetentionModule on the S3ObjectStore built from MediaModule', () => {
    const port = jest.requireActual<typeof import('../retention/object-store.port')>(
      '../retention/object-store.port',
    ).ObjectStorePort;
    const impl =
      jest.requireActual<typeof import('./s3-object-store')>('./s3-object-store').S3ObjectStore;
    const retention = jest.requireActual<typeof import('../retention/retention.service')>(
      '../retention/retention.service',
    ).RetentionService;
    expect(app.get(port, { strict: false })).toBeInstanceOf(impl);
    expect(app.get(retention, { strict: false })).toBeDefined();
  });

  // ---------- logs (ADR 0013 section 5.1) ----------

  it('NFR-05, ADR 0013 5.1: no object key, URL, ETag or token reaches the logs', async () => {
    const c = await session();
    await upload(c, { seq: 0 });
    await post('/confirm', c.token, { stream: 'SCREEN', segment: 0, seq: 0 }).expect(200);
    const text = logged.join('\n');
    expect(text).not.toContain('orgs/');
    expect(text).not.toContain('storage.invalid');
    expect(text).not.toContain('etag-');
    expect(text).not.toContain(c.token);
    expect(text).not.toContain('.webm');
    // The safe fields are logged: session id, stream, seq and outcome.
    expect(text).toContain('media.confirm');
    expect(text).toContain(c.sessionId);
  });

  // ---------- verify-session after the room scan (pilot blocker, FR-404, FR-605, ADR 0013 CS-4.7) ----------

  describe('the confirmed room scan queues verify-session (the last step in the web order)', () => {
    async function consented(opts: {
      identity: boolean;
      systemCheck: boolean;
    }): Promise<Candidate> {
      const inv = await createInvitation(owner, tenant, {
        status: 'CONSENTED',
        session: {
          authEpoch: 0,
          ...(opts.systemCheck
            ? {
                deviceInfo: {
                  systemCheck: { passed: true, blocking: [], checkedAt: new Date().toISOString() },
                },
              }
            : {}),
        },
      });
      if (opts.identity) {
        await owner.identityCheck.create({ data: { sessionId: inv.sessionId, status: 'PASSED' } });
      }
      return {
        sessionId: inv.sessionId,
        orgId: tenant.orgId,
        token: tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token,
      };
    }
    const status = async (c: Candidate) =>
      (await owner.session.findUniqueOrThrow({ where: { id: c.sessionId } })).status;
    async function waitFor(c: Candidate, want: string): Promise<string> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const s = await status(c);
        if (s === want || Date.now() > deadline) return s;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    const scan = { stream: 'ROOM_SCAN', segment: 0, seq: 0, contentType: 'video/webm' } as const;

    it('FR-404, FR-605: system check and identity first, room scan LAST: the confirm takes the session to VERIFIED', async () => {
      const c = await consented({ identity: true, systemCheck: true });
      await upload(c, { ...scan });
      expect(await status(c)).toBe('CONSENTED');
      await post('/confirm', c.token, { stream: 'ROOM_SCAN', segment: 0, seq: 0 }).expect(200);
      expect(await waitFor(c, 'VERIFIED')).toBe('VERIFIED');
    });

    it('FR-404: with the identity check still missing the confirmed room scan leaves the session CONSENTED (the job re-checks)', async () => {
      const c = await consented({ identity: false, systemCheck: true });
      await upload(c, { ...scan });
      await post('/confirm', c.token, { stream: 'ROOM_SCAN', segment: 0, seq: 0 }).expect(200);
      await new Promise((r) => setTimeout(r, 2500));
      expect(await status(c)).toBe('CONSENTED');
      // The identity result then lands (its route queues verify-session itself); the scan is on file.
      await owner.identityCheck.create({ data: { sessionId: c.sessionId, status: 'PASSED' } });
      await post('/confirm', c.token, { stream: 'ROOM_SCAN', segment: 0, seq: 0 }).expect(200);
      expect(await waitFor(c, 'VERIFIED')).toBe('VERIFIED');
    });

    it('FR-404: a failed queue is a 503 and the retried confirm (the chunk is already stored) queues it again', async () => {
      const c = await consented({ identity: true, systemCheck: true });
      await upload(c, { ...scan });
      const { VerifySessionJobs } = jest.requireActual<
        typeof import('../session/verify-session.jobs')
      >('../session/verify-session.jobs');
      const jobs = app.get(VerifySessionJobs);
      const spy = jest
        .spyOn(jobs, 'enqueueVerifySession')
        .mockRejectedValueOnce(new Error('queue down'));
      try {
        const first = await post('/confirm', c.token, { stream: 'ROOM_SCAN', segment: 0, seq: 0 });
        expect(first.status).toBe(503);
        expect(first.headers['retry-after']).toBeDefined();
      } finally {
        spy.mockRestore();
      }
      // The upload was stored by that first confirm; nothing is queued yet.
      expect((await rows(c.sessionId))[0]?.uploadedAt).not.toBeNull();
      expect(await status(c)).toBe('CONSENTED');
      await post('/confirm', c.token, { stream: 'ROOM_SCAN', segment: 0, seq: 0 }).expect(200);
      expect(await waitFor(c, 'VERIFIED')).toBe('VERIFIED');
    });
  });
});
