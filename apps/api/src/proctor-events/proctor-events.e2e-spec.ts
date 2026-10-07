// BE-10 end to end: signed event and keystroke batches over HTTP against real Postgres 16 (app_user,
// real grants and migrations) and real Redis (Testcontainers). Covers FR-608, FR-801, NFR-04,
// TC-050, TC-055, TC-063, TC-065 and the verification order of ADR 0013 section 2.
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { CandidateTokenService } from '../candidate/candidate-token.service';
import type { SessionKeyService } from '../session/session-key.service';
import type { SessionStateService } from '../session/session-state.service';
import { createInvitation, createTenant } from '../candidate/testing/fixtures';
import type { InvitationFixture, InvitationOptions, Tenant } from '../candidate/testing/fixtures';

const API = '/api/v1/candidate/session';
const WRAP_KEY = randomBytes(32).toString('base64');

/** Canonical JSON as the SDK writes it (sorted keys, no whitespace, undefined dropped). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v ?? null)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

const sign = (key: Buffer, body: string): string =>
  createHmac('sha256', key).update(body, 'utf8').digest('hex');

describe('Proctor event and keystroke batches (FR-608, FR-801, ADR 0013 section 2)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let app: INestApplication<App>;
  let tokens: CandidateTokenService;
  let keys: SessionKeyService;
  let states: SessionStateService;
  let tenant: Tenant;
  let other: Tenant;
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
    tenant = await createTenant(owner, 'main');
    other = await createTenant(owner, 'other');
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
      SESSION_KEY_ENC_KEY_k1: WRAP_KEY,
      CANDIDATE_TOKEN_TTL_SECONDS: '900',
      PROCTOR_INGEST_GRACE_SECONDS: '300',
      THROTTLE_DEFAULT_LIMIT: '100000',
      THROTTLE_AUTH_LIMIT: '100000',
      THROTTLE_CANDIDATE_LIMIT: '100000',
      REQUIRE_LEGAL_APPROVED_CONSENT: 'false',
    });
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    tokens = app.get(
      jest.requireActual<typeof import('../candidate/candidate-token.service')>(
        '../candidate/candidate-token.service',
      ).CandidateTokenService,
    );
    keys = app.get(
      jest.requireActual<typeof import('../session/session-key.service')>(
        '../session/session-key.service',
      ).SessionKeyService,
    );
    states = app.get(
      jest.requireActual<typeof import('../session/session-state.service')>(
        '../session/session-state.service',
      ).SessionStateService,
    );
  }, 240_000);

  afterAll(async () => {
    stdout.mockRestore();
    await app?.close();
    await owner?.$disconnect();
    await redisBox?.stop();
    await db?.stop();
  });

  // ---------- helpers ----------

  interface Running {
    readonly inv: InvitationFixture;
    readonly master: Buffer;
  }

  async function running(
    t: Tenant = tenant,
    session: InvitationOptions['session'] = {},
    status: InvitationOptions['status'] = 'IN_PROGRESS',
  ): Promise<Running> {
    const inv = await createInvitation(owner, t, {
      status,
      session: {
        startedAt: new Date(Date.now() - 10 * 60_000),
        deadlineAt: new Date(Date.now() + 50 * 60_000),
        authEpoch: 3,
        ...session,
      },
    });
    const wrapped = keys.generateWrapped(inv.sessionId);
    await owner.session.update({ where: { id: inv.sessionId }, data: { hmacKeyEnc: wrapped } });
    return { inv, master: keys.unwrap(wrapped, inv.sessionId) };
  }

  const tokenFor = (r: Running, t: Tenant = tenant, epoch = 3): string =>
    tokens.sign({ sid: r.inv.sessionId, oid: t.orgId, epoch }).token;
  const keyAt = (r: Running, epoch = 3): Buffer =>
    keys.deriveBatchKey(r.master, r.inv.sessionId, epoch);

  const event = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type,
    occurredAt: new Date(Date.now() - 1000).toISOString(),
    payload: {},
    ...extra,
  });

  function postBatch(
    route: 'events' | 'keystrokes',
    token: string,
    body: string,
    signature: string | undefined,
    headers: Record<string, string> = {},
  ): request.Test {
    let req = request(app.getHttpServer())
      .post(`${API}/${route}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json');
    if (signature !== undefined) req = req.set('X-Signature', signature);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(body);
  }

  /** A correctly signed events batch. */
  function sendEvents(
    r: Running,
    seq: number,
    events: unknown[],
    over: { epoch?: number; token?: string } = {},
  ): request.Test {
    const body = canonical({ seq, events });
    return postBatch(
      'events',
      over.token ?? tokenFor(r),
      body,
      sign(keyAt(r, over.epoch ?? 3), body),
    );
  }

  const rows = (r: Running) =>
    owner.proctorEvent.findMany({ where: { sessionId: r.inv.sessionId, source: 'CLIENT' } });
  const batches = (r: Running) =>
    owner.proctorEventBatch.findMany({ where: { sessionId: r.inv.sessionId } });
  const sessionRow = (r: Running) =>
    owner.session.findUniqueOrThrow({ where: { id: r.inv.sessionId } });

  /** A POST with exact bytes (supertest re-encodes a Buffer body, which would change the signature). */
  function rawPost(
    route: 'events' | 'keystrokes',
    token: string,
    body: Buffer,
    signature: string,
  ): Promise<{ status: number; body: string }> {
    const { port } = (app.getHttpServer() as unknown as http.Server).address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          port,
          path: `${API}/${route}`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
            'X-Signature': signature,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  // ---------- events ----------

  describe('POST /candidate/session/events', () => {
    it('FR-801: a signed batch is stored with server-assigned severity, source CLIENT and the batch row', async () => {
      const r = await running();
      const res = await sendEvents(r, 0, [
        event('TAB_SWITCH', { durationMs: 1200, severity: 'LOW' }), // client severity is ignored
        event('PHONE_DETECTED', { confidence: 0.91 }),
        event('PASTE_ATTEMPT', { payload: { length: 40 } }),
      ]).expect(200);
      expect(res.body).toEqual({ seq: 0, duplicate: false });
      expect(res.headers['cache-control']).toBe('no-store');
      const stored = await rows(r);
      expect(stored).toHaveLength(3);
      const bySeverity = Object.fromEntries(stored.map((e) => [e.type, e.severity]));
      expect(bySeverity).toEqual({
        TAB_SWITCH: 'MEDIUM',
        PHONE_DETECTED: 'HIGH',
        PASTE_ATTEMPT: 'LOW',
      });
      expect(stored.every((e) => e.source === 'CLIENT' && e.batchSeq === 0)).toBe(true);
      expect(stored.every((e) => e.evidenceKey === null)).toBe(true);
      const batch = (await batches(r))[0];
      expect(batch).toMatchObject({ seq: 0, eventCount: 3 });
      expect(batch?.signature).toHaveLength(32);
    });

    it('FR-801 (ADR 0013 section 3 invariant): every CLIENT row written by the batch route has a batch_seq', async () => {
      const r = await running();
      await sendEvents(r, 4, [event('FOCUS_LOST'), event('RIGHT_CLICK')]).expect(200);
      const stored = await rows(r);
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((e) => e.source !== 'CLIENT' || e.batchSeq !== null)).toBe(true);
    });

    it('TC-065: a batch with a wrong signature is rejected 403 SIGNATURE_INVALID and nothing is stored', async () => {
      const r = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      const res = await postBatch('events', tokenFor(r), body, sign(randomBytes(32), body)).expect(
        403,
      );
      expect(res.body).toMatchObject({ code: 'SIGNATURE_INVALID' });
      expect(await rows(r)).toHaveLength(0);
      expect(await batches(r)).toHaveLength(0);
    });

    it('TC-065: a captured batch replayed with a modified payload fails the HMAC check', async () => {
      const r = await running();
      const original = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      const signature = sign(keyAt(r), original);
      await postBatch('events', tokenFor(r), original, signature).expect(200);
      const tampered = original.replace('TAB_SWITCH', 'FOCUS_LOST');
      const res = await postBatch('events', tokenFor(r), tampered, signature).expect(403);
      expect(res.body).toMatchObject({ code: 'SIGNATURE_INVALID' });
      expect((await rows(r)).map((e) => e.type)).toEqual(['TAB_SWITCH']);
    });

    it('TC-065: a missing or malformed X-Signature is 403 SIGNATURE_INVALID', async () => {
      const r = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      await postBatch('events', tokenFor(r), body, undefined).expect(403);
      await postBatch('events', tokenFor(r), body, 'ABC').expect(403);
      await postBatch('events', tokenFor(r), body, sign(keyAt(r), body).toUpperCase()).expect(403);
      expect(await rows(r)).toHaveLength(0);
    });

    it("TC-065: a batch signed with another session's key is rejected (per-session keys)", async () => {
      const mine = await running();
      const theirs = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      const res = await postBatch('events', tokenFor(mine), body, sign(keyAt(theirs), body)).expect(
        403,
      );
      expect(res.body).toMatchObject({ code: 'SIGNATURE_INVALID' });
    });

    it('ADR 0013 section 2: a batch signed with an older epoch key is 409 KEY_EPOCH_STALE (the SDK re-signs)', async () => {
      const r = await running();
      const res = await sendEvents(r, 0, [event('TAB_SWITCH')], { epoch: 2 }).expect(409);
      expect(res.body).toMatchObject({ code: 'KEY_EPOCH_STALE' });
      expect(await batches(r)).toHaveLength(0);
      // Nine epochs back is outside the window: plain SIGNATURE_INVALID.
      const far = await running(tenant, { authEpoch: 20 });
      const farBody = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      const res2 = await postBatch(
        'events',
        tokenFor(far, tenant, 20),
        farBody,
        sign(keys.deriveBatchKey(far.master, far.inv.sessionId, 10), farBody),
      ).expect(403);
      expect(res2.body).toMatchObject({ code: 'SIGNATURE_INVALID' });
    });

    it('TC-063 (ADR 0005 section 3): a retry with the same seq and signature is 200 duplicate and stores nothing', async () => {
      const r = await running();
      const body = canonical({ seq: 7, events: [event('TAB_SWITCH')] });
      const signature = sign(keyAt(r), body);
      await postBatch('events', tokenFor(r), body, signature).expect(200);
      const again = await postBatch('events', tokenFor(r), body, signature).expect(200);
      expect(again.body).toEqual({ seq: 7, duplicate: true });
      expect(await rows(r)).toHaveLength(1);
      expect(await batches(r)).toHaveLength(1);
    });

    it('TC-063: a re-signed retry (same bytes, newer epoch key) is a duplicate, not a conflict', async () => {
      const r = await running(tenant, { authEpoch: 3 });
      const body = canonical({ seq: 1, events: [event('TAB_SWITCH')] });
      await postBatch('events', tokenFor(r), body, sign(keyAt(r, 2), body)).expect(409); // stale key
      // First store it with the epoch-3 key, then the device signs in again (epoch 4) and re-sends.
      await postBatch('events', tokenFor(r), body, sign(keyAt(r, 3), body)).expect(200);
      await owner.session.update({ where: { id: r.inv.sessionId }, data: { authEpoch: 4 } });
      const res = await postBatch(
        'events',
        tokenFor(r, tenant, 4),
        body,
        sign(keyAt(r, 4), body),
      ).expect(200);
      expect(res.body).toEqual({ seq: 1, duplicate: true });
      expect(await rows(r)).toHaveLength(1);
    });

    it('TC-065: the same seq with a different (validly signed) batch is 409 SEQ_CONFLICT', async () => {
      const r = await running();
      await sendEvents(r, 2, [event('TAB_SWITCH')]).expect(200);
      const res = await sendEvents(r, 2, [event('FOCUS_LOST')]).expect(409);
      expect(res.body).toMatchObject({ code: 'SEQ_CONFLICT' });
      expect((await rows(r)).map((e) => e.type)).toEqual(['TAB_SWITCH']);
    });

    it('TC-063: batches that arrive out of order after an outage are all accepted', async () => {
      const r = await running();
      await sendEvents(r, 5, [event('TAB_SWITCH')]).expect(200);
      await sendEvents(r, 3, [event('FOCUS_LOST')]).expect(200);
      await sendEvents(r, 4, [event('RIGHT_CLICK')]).expect(200);
      expect((await batches(r)).map((b) => b.seq).sort()).toEqual([3, 4, 5]);
    });

    it('FR-801: an unknown event type, a server-only type and a bad shape are 400 VALIDATION_FAILED without echoing values', async () => {
      const r = await running();
      const sentinel = 'secret-sentinel-value';
      for (const events of [
        [event('NOT_A_REAL_TYPE', { payload: { note: sentinel } })],
        [event('PASTE_BURST', { payload: { insertedChars: 100, windowMs: 10, sentinel } })],
        [event('TAB_SWITCH', { occurredAt: sentinel })],
        [],
      ]) {
        const res = await sendEvents(r, 0, events).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
        expect(JSON.stringify(res.body)).not.toContain(sentinel);
      }
      expect(await rows(r)).toHaveLength(0);
      expect(await batches(r)).toHaveLength(0);
    });

    it('FR-801: more than 100 events, invalid UTF-8 and invalid JSON are 400', async () => {
      const r = await running();
      const many = Array.from({ length: 101 }, () => event('RIGHT_CLICK'));
      await sendEvents(r, 0, many).expect(400);
      const bad = Buffer.concat([
        Buffer.from('{"seq":0,"events":"'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}'),
      ]);
      const sig = createHmac('sha256', keyAt(r)).update(bad).digest('hex');
      const raw = await rawPost('events', tokenFor(r), bad, sig);
      expect(raw.status).toBe(400);
      expect(raw.body).toContain('VALIDATION_FAILED');
      const junk = '{"seq":';
      await postBatch('events', tokenFor(r), junk, sign(keyAt(r), junk)).expect(400);
    });

    it("CS-1: a session id in the body is stripped; the batch is stored for the token's session", async () => {
      const r = await running();
      const victim = await running();
      const body = canonical({
        seq: 0,
        sessionId: victim.inv.sessionId,
        events: [event('TAB_SWITCH', { sessionId: victim.inv.sessionId })],
      });
      await postBatch('events', tokenFor(r), body, sign(keyAt(r), body)).expect(200);
      expect(await rows(r)).toHaveLength(1);
      expect(await rows(victim)).toHaveLength(0);
    });

    it('FR-801 (TB-1): occurredAt is clamped to the session window [started_at, now]', async () => {
      const r = await running();
      await sendEvents(r, 0, [
        event('TAB_SWITCH', { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }),
        event('FOCUS_LOST', { occurredAt: '2001-01-01T00:00:00.000Z' }),
      ]).expect(200);
      const session = await sessionRow(r);
      for (const e of await rows(r)) {
        expect(e.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect(e.occurredAt.getTime()).toBeGreaterThanOrEqual(session.startedAt?.getTime() ?? 0);
      }
    });

    it('TC-055: SCREEN_SHARE_STOPPED pauses the test without touching the clock; SCREEN_SHARE_RESUMED resumes it', async () => {
      const r = await running();
      const before = await sessionRow(r);
      await sendEvents(r, 0, [
        event('SCREEN_SHARE_STOPPED', { payload: { reason: 'TRACK_ENDED' } }),
      ]).expect(200);
      const paused = await sessionRow(r);
      expect(paused.status).toBe('PAUSED');
      expect(paused.pauseReasons).toEqual(['SCREEN_SHARE_STOPPED']);
      expect(paused.deadlineAt?.getTime()).toBe(before.deadlineAt?.getTime());
      expect(paused.pausedMs).toBe(before.pausedMs);
      await sendEvents(r, 1, [event('SCREEN_SHARE_RESUMED')]).expect(200); // PAUSED still accepts batches
      const resumed = await sessionRow(r);
      expect(resumed.status).toBe('IN_PROGRESS');
      expect(resumed.pauseReasons).toEqual([]);
    });

    it('TC-050: FULLSCREEN_EXIT is logged and pauses; with two reasons the session resumes only when none is left', async () => {
      const r = await running();
      await sendEvents(r, 0, [event('FULLSCREEN_EXIT'), event('SIDE_CAMERA_DISCONNECTED')]).expect(
        200,
      );
      expect((await sessionRow(r)).pauseReasons.sort()).toEqual([
        'FULLSCREEN_EXIT',
        'SIDE_CAMERA_LOST',
      ]);
      await sendEvents(r, 1, [event('FULLSCREEN_RESTORED')]).expect(200);
      // One reason is still active (derived from the events), so the session stays paused. The stored
      // reason list is not edited while PAUSED (no PAUSED to PAUSED edge in SessionStateService yet).
      expect((await sessionRow(r)).status).toBe('PAUSED');
      await sendEvents(r, 2, [event('SIDE_CAMERA_RECONNECTED')]).expect(200);
      const resumed = await sessionRow(r);
      expect(resumed.status).toBe('IN_PROGRESS');
      expect(resumed.pauseReasons).toEqual([]);
      expect((await rows(r)).map((e) => e.type)).toContain('FULLSCREEN_EXIT');
    });

    it('FR-801: a proctor pause is never lifted by a candidate resume event', async () => {
      const r = await running(tenant, { pauseReasons: ['PROCTOR'] }, 'PAUSED');
      await sendEvents(r, 0, [event('FULLSCREEN_RESTORED')]).expect(200);
      const row = await sessionRow(r);
      expect(row.status).toBe('PAUSED');
      expect(row.pauseReasons).toEqual(['PROCTOR']);
    });

    it('FR-801 / CS-4.4a: lifting a candidate reason keeps a PROCTOR pause and its proctor_paused_at', async () => {
      const pausedAt = new Date(Date.now() - 120_000);
      const r = await running(tenant, { pauseReasons: ['PROCTOR', 'FULLSCREEN_EXIT'] }, 'PAUSED');
      await owner.session.update({
        where: { id: r.inv.sessionId },
        data: { proctorPausedAt: pausedAt },
      });
      await sendEvents(r, 0, [event('FULLSCREEN_RESTORED')]).expect(200);
      const row = await sessionRow(r);
      expect(row.status).toBe('PAUSED');
      expect(row.pauseReasons).toContain('PROCTOR');
      expect(row.proctorPausedAt?.getTime()).toBe(pausedAt.getTime());
    });

    it('FR-801 / CS-4.4a: a PROCTOR pause added between the read and the lift is not overwritten (compare-and-set)', async () => {
      const r = await running(tenant, { pauseReasons: ['FULLSCREEN_EXIT'] }, 'PAUSED');
      const original = states.transition.bind(states);
      const spy = jest.spyOn(states, 'transition').mockImplementationOnce(async (req) => {
        // A proctor pauses the session right before the candidate's resume is written.
        await owner.session.update({
          where: { id: r.inv.sessionId },
          data: { pauseReasons: ['FULLSCREEN_EXIT', 'PROCTOR'], proctorPausedAt: new Date() },
        });
        return original(req);
      });
      try {
        await sendEvents(r, 0, [event('FULLSCREEN_EXIT'), event('FULLSCREEN_RESTORED')]).expect(
          200,
        );
      } finally {
        spy.mockRestore();
      }
      const row = await sessionRow(r);
      expect(row.status).toBe('PAUSED'); // the stale lift lost, the retry saw PROCTOR and did nothing
      expect(row.pauseReasons).toContain('PROCTOR');
      expect(row.proctorPausedAt).not.toBeNull();
    });

    it('FR-801 / CS-4.4a: a proctor pause that starts while a candidate pause is being written is kept', async () => {
      const r = await running();
      const original = states.transition.bind(states);
      const spy = jest.spyOn(states, 'transition').mockImplementationOnce(async (req) => {
        await owner.session.update({
          where: { id: r.inv.sessionId },
          data: { status: 'PAUSED', pauseReasons: ['PROCTOR'], proctorPausedAt: new Date() },
        });
        return original(req);
      });
      try {
        await sendEvents(r, 0, [
          event('SCREEN_SHARE_STOPPED', { payload: { reason: 'TRACK_ENDED' } }),
        ]).expect(200);
      } finally {
        spy.mockRestore();
      }
      const row = await sessionRow(r);
      expect(row.status).toBe('PAUSED');
      expect(row.pauseReasons).toEqual(['PROCTOR']);
      expect(row.proctorPausedAt).not.toBeNull();
    });

    it('FR-801: a duplicate resend re-applies a pause that was missed', async () => {
      const r = await running();
      const body = canonical({
        seq: 0,
        events: [event('SCREEN_SHARE_STOPPED', { payload: { reason: 'TRACK_ENDED' } })],
      });
      const signature = sign(keyAt(r), body);
      await postBatch('events', tokenFor(r), body, signature).expect(200);
      expect((await sessionRow(r)).status).toBe('PAUSED');
      // The pause is lost (for example by an older build); the retry puts it back.
      await owner.session.update({
        where: { id: r.inv.sessionId },
        data: { status: 'IN_PROGRESS', pauseReasons: [] },
      });
      const again = await postBatch('events', tokenFor(r), body, signature).expect(200);
      expect(again.body).toEqual({ seq: 0, duplicate: true });
      expect((await sessionRow(r)).status).toBe('PAUSED');
      expect(await rows(r)).toHaveLength(1);
    });

    it('FR-801: a duplicate of an older batch does not re-pause a session that was resumed later', async () => {
      const r = await running();
      const stop = canonical({
        seq: 0,
        events: [event('SCREEN_SHARE_STOPPED', { payload: { reason: 'TRACK_ENDED' } })],
      });
      const stopSig = sign(keyAt(r), stop);
      await postBatch('events', tokenFor(r), stop, stopSig).expect(200);
      await sendEvents(r, 1, [
        event('SCREEN_SHARE_RESUMED', { occurredAt: new Date().toISOString() }),
      ]).expect(200);
      expect((await sessionRow(r)).status).toBe('IN_PROGRESS');
      await postBatch('events', tokenFor(r), stop, stopSig).expect(200); // late duplicate of batch 0
      expect((await sessionRow(r)).status).toBe('IN_PROGRESS');
    });

    it('FR-801: the batch and its pause are one transaction; a failed pause stores nothing and the retry succeeds', async () => {
      const r = await running();
      const spy = jest.spyOn(states, 'transition').mockRejectedValueOnce(new Error('boom'));
      const body = canonical({ seq: 0, events: [event('FULLSCREEN_EXIT')] });
      const signature = sign(keyAt(r), body);
      try {
        const failed = await postBatch('events', tokenFor(r), body, signature);
        expect(failed.status).toBe(500); // 5xx: the SDK retries
      } finally {
        spy.mockRestore();
      }
      expect(await batches(r)).toHaveLength(0);
      expect(await rows(r)).toHaveLength(0);
      await postBatch('events', tokenFor(r), body, signature).expect(200);
      expect((await sessionRow(r)).status).toBe('PAUSED');
    });

    it('NFR-04: text that jsonb cannot store (U+0000, a lone surrogate) is 400 VALIDATION_FAILED, never a 500 the SDK would retry', async () => {
      const r = await running();
      for (const bad of ['a\u0000b', '\ud800', 'x\udc00y']) {
        const res = await sendEvents(r, 0, [
          event('EXTENSION_INTERFERENCE', { payload: { signal: bad } }),
        ]).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      const key = canonical({
        seq: 1,
        events: [event('TAB_SWITCH', { payload: { 'k\u0000': 1 } })],
      });
      await postBatch('events', tokenFor(r), key, sign(keyAt(r), key)).expect(400);
      expect(await batches(r)).toHaveLength(0);
    });

    it('TC-063: the same signed batch sent twice at once stores one batch; one answer is duplicate', async () => {
      const r = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH'), event('FOCUS_LOST')] });
      const signature = sign(keyAt(r), body);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => postBatch('events', tokenFor(r), body, signature)),
      );
      expect(results.map((x) => x.status)).toEqual([200, 200, 200, 200]);
      const flags = results.map((x) => (x.body as { duplicate: boolean }).duplicate);
      expect(flags.filter((d) => !d)).toHaveLength(1);
      expect(await batches(r)).toHaveLength(1);
      expect(await rows(r)).toHaveLength(2);
    });

    it('TC-065: two different batches with the same seq at once: one is stored, the other is 409 SEQ_CONFLICT', async () => {
      const r = await running();
      const [a, b] = await Promise.all([
        sendEvents(r, 0, [event('TAB_SWITCH')]),
        sendEvents(r, 0, [event('FOCUS_LOST')]),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body).toMatchObject({ code: 'SEQ_CONFLICT' });
      expect(await batches(r)).toHaveLength(1);
      expect(await rows(r)).toHaveLength(1);
    });

    it('FR-801 (backend.md Step 10): HIGH events are published to live:{orgId}', async () => {
      const r = await running();
      const sub = new Redis(redisBox.getConnectionUrl());
      const got: string[] = [];
      await sub.subscribe(`live:${tenant.orgId}`);
      sub.on('message', (_c, m) => got.push(m));
      await sendEvents(r, 0, [
        event('MULTIPLE_FACES', { payload: { faceCount: 2 } }),
        event('RIGHT_CLICK'),
      ]).expect(200);
      const deadline = Date.now() + 5000;
      while (got.length === 0 && Date.now() < deadline) await new Promise((x) => setTimeout(x, 50));
      sub.disconnect();
      expect(got).toHaveLength(1);
      expect(JSON.parse(got[0] ?? '{}')).toMatchObject({
        sessionId: r.inv.sessionId,
        type: 'MULTIPLE_FACES',
        severity: 'HIGH',
      });
    });
  });

  // ---------- state, scope, limits ----------

  describe('state, scope and limits (ADR 0013 sections 2, 5.1 and 5.10)', () => {
    it('ADR 0013 section 2: a session that is not running answers 409 SESSION_NOT_ACTIVE', async () => {
      for (const status of ['VERIFIED', 'GRADED', 'UNDER_REVIEW', 'COMPLETED'] as const) {
        const r = await running(tenant, {}, status);
        const res = await sendEvents(r, 0, [event('TAB_SWITCH')]).expect(409);
        expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
        expect(await batches(r)).toHaveLength(0);
      }
    });

    it('TC-063: SUBMITTED accepts late batches within the ingest grace and refuses after it', async () => {
      const inGrace = await running(tenant, {}, 'SUBMITTED');
      await owner.session.update({
        where: { id: inGrace.inv.sessionId },
        data: { submittedAt: new Date(Date.now() - 60_000) },
      });
      await sendEvents(inGrace, 0, [event('TAB_SWITCH')]).expect(200);
      const late = await running(tenant, {}, 'SUBMITTED');
      await owner.session.update({
        where: { id: late.inv.sessionId },
        data: { submittedAt: new Date(Date.now() - 600_000) },
      });
      const res = await sendEvents(late, 0, [event('TAB_SWITCH')]).expect(409);
      expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    });

    it('ADR 0013 section 2: a session whose key was destroyed (ingest closed) is 409 SESSION_NOT_ACTIVE', async () => {
      const r = await running();
      await owner.session.update({ where: { id: r.inv.sessionId }, data: { hmacKeyEnc: null } });
      await sendEvents(r, 0, [event('TAB_SWITCH')]).expect(409);
    });

    it('ADR 0013 section 5.10: no token, a garbage token and an old-epoch token are 401', async () => {
      const r = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      const sig = sign(keyAt(r), body);
      await request(app.getHttpServer())
        .post(`${API}/events`)
        .set('Content-Type', 'application/json')
        .set('X-Signature', sig)
        .send(body)
        .expect(401);
      await postBatch('events', 'not-a-jwt', body, sig).expect(401);
      const stale = await postBatch('events', tokenFor(r, tenant, 2), body, sig).expect(401);
      expect(stale.body).toMatchObject({ code: 'SESSION_TAKEN_OVER' });
      expect(await batches(r)).toHaveLength(0);
    });

    it("TC-008 (cross-org): a token naming another org's session cannot ingest into it", async () => {
      const victim = await running(other);
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      // The attacker presents the victim\'s session id under the wrong org id.
      const forged = tokens.sign({ sid: victim.inv.sessionId, oid: tenant.orgId, epoch: 3 }).token;
      await postBatch('events', forged, body, sign(keyAt(victim), body)).expect(401);
      expect(await rows(victim)).toHaveLength(0);
    });

    it('NFR-04 (zip bomb): a Content-Encoding body is 415 and never inflated; other content types are 415', async () => {
      const r = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      const res = await request(app.getHttpServer())
        .post(`${API}/events`)
        .set('Authorization', `Bearer ${tokenFor(r)}`)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .set('X-Signature', sign(keyAt(r), body))
        .send(gzipSync(Buffer.from(body)))
        .expect(415);
      expect(res.body).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
      const text = await request(app.getHttpServer())
        .post(`${API}/events`)
        .set('Authorization', `Bearer ${tokenFor(r)}`)
        .set('Content-Type', 'text/plain')
        .set('X-Signature', sign(keyAt(r), body))
        .send(body)
        .expect(415);
      expect(text.body).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    });

    it('NFR-04: an events body over 256 KiB is 413 before any signature check or parsing', async () => {
      const r = await running();
      const big = 'x'.repeat(256 * 1024 + 1);
      const res = await postBatch('events', tokenFor(r), big, 'a'.repeat(64)).expect(413);
      expect(res.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      expect(await batches(r)).toHaveLength(0);
    });

    it('NFR-04: a chunked body (no Content-Length) is cut off at the limit while streaming', async () => {
      const r = await running();
      const { port } = (app.getHttpServer() as unknown as http.Server).address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            port,
            path: `${API}/events`.replace(/^/, ''),
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenFor(r)}`,
              'Content-Type': 'application/json',
              'X-Signature': 'a'.repeat(64),
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        const chunk = Buffer.alloc(64 * 1024, 120);
        for (let i = 0; i < 6; i += 1) req.write(chunk);
        req.end();
      });
      expect(status).toBe(413);
    });

    it('ADR 0013 section 5.1: events are limited to 120 per minute per session (429 with Retry-After)', async () => {
      const r = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      let last = 0;
      for (let i = 0; i < 121; i += 1) {
        last = (await postBatch('events', tokenFor(r), body, 'a'.repeat(64))).status;
      }
      expect(last).toBe(429);
    }, 120_000);

    it('NFR-04: signatures and keys never appear in the logs', async () => {
      const r = await running();
      const body = canonical({ seq: 0, events: [event('TAB_SWITCH')] });
      const signature = sign(keyAt(r), body);
      await postBatch('events', tokenFor(r), body, signature).expect(200);
      await postBatch('events', tokenFor(r), body, 'b'.repeat(64)).expect(403);
      const text = logged.join('');
      expect(text).not.toContain(signature);
      expect(text).not.toContain('b'.repeat(64));
      expect(text).not.toContain(keyAt(r).toString('base64'));
      expect(text).not.toContain(keyAt(r).toString('hex'));
    });
  });

  // ---------- keystrokes ----------

  describe('POST /candidate/session/keystrokes', () => {
    async function questionOf(r: Running): Promise<string> {
      const tq = tenant.test.testQuestionIds[0];
      const version = tenant.test.fixedVersionIds[0];
      const created = await owner.sessionQuestion.create({
        data: {
          sessionId: r.inv.sessionId,
          testQuestionId: tq,
          questionVersionId: version,
          position: 1,
          points: 10,
        },
        select: { id: true },
      });
      return created.id;
    }

    function sendKeys(
      r: Running,
      seq: number,
      sessionQuestionId: string,
      events: unknown[],
      over: { token?: string } = {},
    ): request.Test {
      const body = canonical({
        seq,
        sessionQuestionId,
        startedAt: new Date(Date.now() - 5000).toISOString(),
        events,
      });
      return postBatch('keystrokes', over.token ?? tokenFor(r), body, sign(keyAt(r), body));
    }

    const edit = (t: number, text: string): Record<string, unknown> => ({
      kind: 'EDIT',
      t,
      offset: 0,
      deleteLength: 0,
      text,
    });

    it('FR-608: a signed keystroke batch is stored with its signature and events', async () => {
      const r = await running();
      const q = await questionOf(r);
      const res = await sendKeys(r, 0, q, [
        { kind: 'RESET', t: 0, language: 'python', text: '' },
        edit(10, 'x = 1'),
      ]).expect(200);
      expect(res.body).toEqual({ seq: 0, duplicate: false });
      const stored = await owner.keystrokeBatch.findMany({ where: { sessionId: r.inv.sessionId } });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ seq: 0, sessionQuestionId: q });
      expect(stored[0]?.signature).toHaveLength(32);
      expect(JSON.stringify(stored[0]?.events)).toContain('x = 1');
      expect(await owner.keystrokeBatch.count({ where: { sessionId: r.inv.sessionId } })).toBe(1);
    });

    it('FR-608 / TC-063: an exact keystroke resend is 200 duplicate; a different batch with that seq is 409 SEQ_CONFLICT', async () => {
      const r = await running();
      const q = await questionOf(r);
      const body = canonical({
        seq: 3,
        sessionQuestionId: q,
        startedAt: new Date(Date.now() - 5000).toISOString(),
        events: [edit(1, 'a')],
      });
      const signature = sign(keyAt(r), body);
      await postBatch('keystrokes', tokenFor(r), body, signature).expect(200);
      const dup = await postBatch('keystrokes', tokenFor(r), body, signature).expect(200);
      expect(dup.body).toEqual({ seq: 3, duplicate: true });
      const other2 = canonical({
        seq: 3,
        sessionQuestionId: q,
        startedAt: new Date(Date.now() - 5000).toISOString(),
        events: [edit(1, 'b')],
      });
      const res = await postBatch('keystrokes', tokenFor(r), other2, sign(keyAt(r), other2)).expect(
        409,
      );
      expect(res.body).toMatchObject({ code: 'SEQ_CONFLICT' });
    });

    it('TC-065: a keystroke batch with a bad signature is 403 and stores nothing', async () => {
      const r = await running();
      const q = await questionOf(r);
      const body = canonical({
        seq: 0,
        sessionQuestionId: q,
        startedAt: new Date().toISOString(),
        events: [edit(1, 'a')],
      });
      await postBatch('keystrokes', tokenFor(r), body, sign(randomBytes(32), body)).expect(403);
      expect(await owner.keystrokeBatch.count({ where: { sessionId: r.inv.sessionId } })).toBe(0);
    });

    it('CS-2: a sessionQuestionId from another session is 404, never stored', async () => {
      const mine = await running();
      const theirs = await running();
      const theirQuestion = await questionOf(theirs);
      const res = await sendKeys(mine, 0, theirQuestion, [edit(1, 'a')]).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(await owner.keystrokeBatch.count({ where: { sessionId: mine.inv.sessionId } })).toBe(
        0,
      );
    });

    it('FR-608: invalid batches are 400 VALIDATION_FAILED (unordered times, empty edit, text over the cap)', async () => {
      const r = await running();
      const q = await questionOf(r);
      await sendKeys(r, 0, q, [edit(50, 'a'), edit(10, 'b')]).expect(400);
      await sendKeys(r, 0, q, [
        { kind: 'EDIT', t: 1, offset: 0, deleteLength: 0, text: '' },
      ]).expect(400);
      await sendKeys(r, 0, 'not-a-uuid', [edit(1, 'a')]).expect(400);
    });

    it('NFR-04: a keystroke body over 2 MiB is 413; a body over 256 KiB but under 2 MiB passes the size gate', async () => {
      const r = await running();
      const huge = 'x'.repeat(2 * 1024 * 1024 + 1);
      await postBatch('keystrokes', tokenFor(r), huge, 'a'.repeat(64)).expect(413);
      const medium = 'x'.repeat(300 * 1024);
      const res = await postBatch('keystrokes', tokenFor(r), medium, 'a'.repeat(64));
      expect(res.status).toBe(403); // past the size limit; the signature check refuses it
    });

    it('NFR-04 (C-5): keystroke text never reaches the logs', async () => {
      const r = await running();
      const q = await questionOf(r);
      const secret = `typed-secret-${randomUUID()}`;
      await sendKeys(r, 0, q, [edit(1, secret)]).expect(200);
      await sendKeys(r, 1, q, [
        { kind: 'EDIT', t: 1, offset: 0, deleteLength: 0, text: '' },
      ]).expect(400);
      expect(logged.join('')).not.toContain(secret);
    });

    it('ADR 0013 section 2: a keystroke batch signed with an older epoch key is 409 KEY_EPOCH_STALE', async () => {
      const r = await running();
      const q = await questionOf(r);
      const body = canonical({
        seq: 0,
        sessionQuestionId: q,
        startedAt: new Date().toISOString(),
        events: [edit(1, 'a')],
      });
      const res = await postBatch('keystrokes', tokenFor(r), body, sign(keyAt(r, 2), body)).expect(
        409,
      );
      expect(res.body).toMatchObject({ code: 'KEY_EPOCH_STALE' });
      expect(await owner.keystrokeBatch.count({ where: { sessionId: r.inv.sessionId } })).toBe(0);
    });

    it('NFR-04: keystroke text with U+0000 or a lone surrogate is 400 VALIDATION_FAILED, not a 500', async () => {
      const r = await running();
      const q = await questionOf(r);
      for (const bad of ['a\u0000b', '\ud83d']) {
        const res = await sendKeys(r, 0, q, [edit(1, bad)]).expect(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(await owner.keystrokeBatch.count({ where: { sessionId: r.inv.sessionId } })).toBe(0);
    });

    it('TC-063: the same keystroke batch sent twice at once is stored once', async () => {
      const r = await running();
      const q = await questionOf(r);
      const body = canonical({
        seq: 0,
        sessionQuestionId: q,
        startedAt: new Date(Date.now() - 5000).toISOString(),
        events: [edit(1, 'a')],
      });
      const signature = sign(keyAt(r), body);
      const results = await Promise.all(
        Array.from({ length: 3 }, () => postBatch('keystrokes', tokenFor(r), body, signature)),
      );
      expect(results.map((x) => x.status)).toEqual([200, 200, 200]);
      expect(results.filter((x) => !(x.body as { duplicate: boolean }).duplicate)).toHaveLength(1);
      expect(await owner.keystrokeBatch.count({ where: { sessionId: r.inv.sessionId } })).toBe(1);
    });

    it('ADR 0013 section 2: keystrokes need a running session too', async () => {
      const r = await running(tenant, {}, 'GRADED');
      const res = await sendKeys(r, 0, randomUUID(), [edit(1, 'a')]).expect(409);
      expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    });
  });
});
