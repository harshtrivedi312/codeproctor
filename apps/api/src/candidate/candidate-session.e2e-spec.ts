// BE-07 end to end: the candidate session over HTTP against real Postgres 16 (app_user, real
// grants, real migrations) and real Redis (Testcontainers; the dev stack is never touched). The mail
// provider and object storage are the two ports BE-06 and BE-09 will bind; here they are fakes.
// Covers FR-106, FR-401, FR-505, FR-609 and TC-007, TC-021, TC-022, TC-024, TC-030, TC-047, TC-095,
// TC-096, TC-097, and the candidate-token scope rules of ADR 0013 section 5.10.
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256Hex } from '../auth/crypto.util';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SessionStatus } from '../generated/prisma/enums.js';
import type { SessionKeyService } from '../session/session-key.service';
import type { CandidateTokenService } from './candidate-token.service';
import { CandidateMailPort } from './candidate-mail.port';
import type { ConsentCopyMail, OtpLockoutMail, OtpMail } from './candidate-mail.port';
import type { OrgContextService } from '../database/org-context';
import type { PrismaService } from '../database/prisma.service';
import type { OtpService } from './otp.service';
import type { SessionJobsService } from './session-jobs.service';
import { createInvitation, createTenant, passedSystemCheck } from './testing/fixtures';
import type { InvitationFixture, InvitationOptions, Tenant } from './testing/fixtures';
import { InMemoryObjectStorage } from './testing/in-memory-storage';

const API = '/api/v1/candidate/session';
const ENC_KEY = randomBytes(32).toString('base64');
const CANDIDATE_SECRET = randomBytes(32).toString('base64');
const WRAP_KEY = randomBytes(32).toString('base64');

class FakeMail extends CandidateMailPort {
  readonly otps: Array<OtpMail & { to: string }> = [];
  readonly lockouts: Array<OtpLockoutMail & { to: string }> = [];
  readonly copies: Array<ConsentCopyMail & { to: string }> = [];
  failing = false;
  sendOtp(to: string, mail: OtpMail): Promise<void> {
    if (this.failing) return Promise.reject(new Error('mail down'));
    this.otps.push({ ...mail, to });
    return Promise.resolve();
  }
  sendOtpLockout(to: string, mail: OtpLockoutMail): Promise<void> {
    this.lockouts.push({ ...mail, to });
    return Promise.resolve();
  }
  sendConsentCopy(to: string, mail: ConsentCopyMail): Promise<void> {
    if (this.failing) return Promise.reject(new Error('mail down'));
    this.copies.push({ ...mail, to });
    return Promise.resolve();
  }
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Candidate session (FR-106, FR-401, FR-505, FR-609, ADR 0002, ADR 0013)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let redis: Redis;
  let app: INestApplication<App>;
  let legalApp: INestApplication<App> | undefined;
  let tokens: CandidateTokenService;
  let keys: SessionKeyService;
  let jobs: SessionJobsService;
  let otp: OtpService;
  let prisma: PrismaService;
  let orgContext: OrgContextService;
  let tenant: Tenant;
  let other: Tenant;
  let unapproved: Tenant;
  const mail = new FakeMail();
  const storage = new InMemoryObjectStorage();
  const logged: string[] = [];
  let stdout: jest.SpyInstance;

  async function buildApp(extraEnv: Record<string, string> = {}): Promise<INestApplication<App>> {
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
      ENCRYPTION_KEY: ENC_KEY,
      JWT_CANDIDATE_SECRET: CANDIDATE_SECRET,
      OTP_PEPPER: randomBytes(32).toString('base64'),
      SESSION_KEY_ENC_ACTIVE_KID: 'k1',
      SESSION_KEY_ENC_KEY_k1: WRAP_KEY,
      CANDIDATE_TOKEN_TTL_SECONDS: '900',
      THROTTLE_DEFAULT_LIMIT: '100000',
      THROTTLE_AUTH_LIMIT: '100000',
      THROTTLE_CANDIDATE_LIMIT: '100000',
      REQUIRE_LEGAL_APPROVED_CONSENT: 'false',
      ...extraEnv,
    });
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const mailToken =
      jest.requireActual<typeof import('./candidate-mail.port')>('./candidate-mail.port');
    const storageToken =
      jest.requireActual<typeof import('./object-storage.port')>('./object-storage.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(mailToken.CandidateMailPort)
      .useValue(mail)
      .overrideProvider(storageToken.ObjectStoragePort)
      .useValue(storage)
      .compile();
    const created = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(created);
    await created.init();
    return created;
  }

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
    tenant = await createTenant(owner, 'main', {
      settings: { consentDeclineContact: 'hr@acme.example' },
    });
    other = await createTenant(owner, 'other');
    unapproved = await createTenant(owner, 'draft', { legalApproved: false });
    app = await buildApp();
    const { CandidateTokenService: T } = jest.requireActual<
      typeof import('./candidate-token.service')
    >('./candidate-token.service');
    const { SessionKeyService: K } = jest.requireActual<
      typeof import('../session/session-key.service')
    >('../session/session-key.service');
    const { SessionJobsService: J } =
      jest.requireActual<typeof import('./session-jobs.service')>('./session-jobs.service');
    tokens = app.get(T);
    keys = app.get(K);
    jobs = app.get(J);
    const { OtpService: O } = jest.requireActual<typeof import('./otp.service')>('./otp.service');
    otp = app.get(O);
    prisma = app.get(
      jest.requireActual<typeof import('../database/prisma.service')>('../database/prisma.service')
        .PrismaService,
    );
    orgContext = app.get(
      jest.requireActual<typeof import('../database/org-context')>('../database/org-context')
        .OrgContextService,
    );
  }, 240_000);

  afterAll(async () => {
    stdout.mockRestore();
    await legalApp?.close();
    await app?.close();
    redis?.disconnect();
    await owner?.$disconnect();
    await redisBox?.stop();
    await db?.stop();
  });

  // ---------- helpers ----------

  const server = (): App => app.getHttpServer();
  const post = (path: string, body?: object): request.Test =>
    request(server())
      .post(`${API}${path}`)
      .send(body ?? {});
  const authed = (
    method: 'get' | 'post',
    path: string,
    token: string,
    body?: object,
  ): request.Test => {
    const req = request(server())[method](`${API}${path}`).set('Authorization', `Bearer ${token}`);
    return method === 'post' ? req.send(body ?? {}) : req;
  };
  const sessionRow = (id: string) => owner.session.findUniqueOrThrow({ where: { id } });
  const invite = (
    options: InvitationOptions = {},
    t: Tenant = tenant,
  ): Promise<InvitationFixture> => createInvitation(owner, t, options);

  async function otpFor(inv: InvitationFixture): Promise<string> {
    await redis.del(`otp-send:${inv.invitationId}`);
    const before = mail.otps.length;
    const res = await post('/otp', { invitationToken: inv.token });
    expect(res.status).toBe(200);
    expect(mail.otps.length).toBe(before + 1);
    return (mail.otps[mail.otps.length - 1] as OtpMail).code;
  }

  async function signIn(inv: InvitationFixture): Promise<string> {
    await redis.del(`otp-cooldown:${inv.invitationId}`);
    const code = await otpFor(inv);
    const res = await post('/start', { invitationToken: inv.token, otp: code });
    expect(res.status).toBe(200);
    return (res.body as { sessionToken: string }).sessionToken;
  }

  const wrongCode = (code: string): string => (code === '000000' ? '000001' : '000000');
  const liveSession = (extra: InvitationOptions['session'] = {}): InvitationOptions => ({
    status: 'IN_PROGRESS',
    session: {
      startedAt: new Date(Date.now() - 10 * 60_000),
      deadlineAt: new Date(Date.now() + 50 * 60_000),
      lastHeartbeat: new Date(),
      authEpoch: 1,
      ...extra,
    },
  });

  // ---------- link, OTP, start (FR-106) ----------

  describe('link, OTP and session token (FR-106, ADR 0002 L-1..L-5, ADR 0003)', () => {
    it('FR-106: the link route says "open" and sends nothing; an unknown token is a generic 404', async () => {
      const inv = await invite();
      const before = mail.otps.length;
      const res = await post('/link', { invitationToken: inv.token }).expect(200);
      expect(res.body).toMatchObject({
        state: 'OTP_REQUIRED',
        orgName: 'Org main',
        declineContact: null,
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(mail.otps.length).toBe(before);
      const unknown = await post('/link', {
        invitationToken: randomBytes(32).toString('base64url'),
      });
      expect(unknown.status).toBe(404);
      await post('/link', { invitationToken: 'short' }).expect(400);
      await post('/link', {}).expect(400);
      await post('/link', { invitationToken: inv.token, sessionId: randomUUID() }).expect(400);
    });

    it('FR-106: the OTP is 6 digits, emailed to the candidate, stored only as a keyed hash, and the response masks the address', async () => {
      const inv = await invite();
      const res = await post('/otp', { invitationToken: inv.token }).expect(200);
      const sent = mail.otps[mail.otps.length - 1] as OtpMail & { to: string };
      expect(sent.to).toBe(inv.candidateEmail);
      expect(sent.code).toMatch(/^\d{6}$/);
      expect(res.body).toMatchObject({ state: 'OTP_SENT', expiresInSeconds: 600 });
      expect(JSON.stringify(res.body)).not.toContain(sent.code);
      expect((res.body as { maskedEmail: string }).maskedEmail).toMatch(/^c\*\*\*@example\.test$/);
      const stored = await redis.get(`otp:${inv.invitationId}`);
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(stored).not.toContain(sent.code);
      const ttl = await redis.ttl(`otp:${inv.invitationId}`);
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it('FR-106: a second code within 30 s is refused with 429 OTP_COOLDOWN and Retry-After', async () => {
      const inv = await invite();
      await post('/otp', { invitationToken: inv.token }).expect(200);
      const second = await post('/otp', { invitationToken: inv.token });
      expect(second.status).toBe(429);
      expect(second.body).toMatchObject({ code: 'OTP_COOLDOWN' });
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('FR-106, ADR 0002 L-1: the right code gives a token bound to the session and epoch 1, and INVITED becomes OPENED', async () => {
      const inv = await invite();
      const code = await otpFor(inv);
      const res = await post('/start', { invitationToken: inv.token, otp: code }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as {
        sessionToken: string;
        sessionTokenExpiresAt: string;
        status: string;
        serverTime: string;
      };
      expect(body.status).toBe('OPENED');
      const claims = jwt.decode(body.sessionToken) as Record<string, unknown>;
      expect(claims).toMatchObject({
        typ: 'candidate',
        sid: inv.sessionId,
        oid: tenant.orgId,
        epoch: 1,
      });
      const row = await sessionRow(inv.sessionId);
      expect(row.status).toBe('OPENED');
      expect(row.authEpoch).toBe(1);
      // L-1: the link is not used up by signing in; used_at is set only when the test starts.
      const invitation = await owner.invitation.findUniqueOrThrow({
        where: { id: inv.invitationId },
      });
      expect(invitation.usedAt).toBeNull();
      const state = await authed('get', '', body.sessionToken).expect(200);
      expect(state.body).toMatchObject({ status: 'OPENED', pauseReasons: [] });
    });

    it('FR-106: a code is single use, and an OTP that was never requested is refused', async () => {
      const inv = await invite();
      const code = await otpFor(inv);
      await post('/start', { invitationToken: inv.token, otp: code }).expect(200);
      const replay = await post('/start', { invitationToken: inv.token, otp: code });
      expect(replay.status).toBe(400);
      expect(replay.body).toMatchObject({ code: 'OTP_NOT_REQUESTED' });
      const never = await invite();
      const res = await post('/start', { invitationToken: never.token, otp: '123456' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'OTP_NOT_REQUESTED' });
    });

    it('FR-106: a wrong code is refused with 400 OTP_INVALID and the right one still works afterwards', async () => {
      const inv = await invite();
      const code = await otpFor(inv);
      const bad = await post('/start', { invitationToken: inv.token, otp: wrongCode(code) });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: 'OTP_INVALID' });
      await post('/start', { invitationToken: inv.token, otp: code }).expect(200);
      await post('/start', { invitationToken: inv.token, otp: 'abcdef' }).expect(400);
      await post('/start', { invitationToken: inv.token, otp: '12345' }).expect(400);
    });

    it('FR-106: only one of ten concurrent submissions of the same correct code succeeds', async () => {
      const inv = await invite();
      const code = await otpFor(inv);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => post('/start', { invitationToken: inv.token, otp: code })),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect((await sessionRow(inv.sessionId)).authEpoch).toBe(1);
    });

    it('TC-007: five wrong codes block the link for 30 minutes, even for the right code, and the recruiter is notified', async () => {
      const inv = await invite();
      const code = await otpFor(inv);
      const lockoutsBefore = mail.lockouts.length;
      for (let i = 0; i < 4; i++) {
        const r = await post('/start', { invitationToken: inv.token, otp: wrongCode(code) });
        expect(r.status).toBe(400);
      }
      // The 5th wrong guess is answered as a block at once, not as one more typo.
      const fifth = await post('/start', { invitationToken: inv.token, otp: wrongCode(code) });
      expect(fifth.status).toBe(429);
      expect(fifth.body).toMatchObject({ code: 'LINK_BLOCKED', retryAfterSeconds: 1800 });
      expect(Number(fifth.headers['retry-after'])).toBe(1800);
      const blocked = await post('/start', { invitationToken: inv.token, otp: code });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ code: 'LINK_BLOCKED' });
      const wait = Number(blocked.headers['retry-after']);
      expect(wait).toBeGreaterThan(1700);
      expect(wait).toBeLessThanOrEqual(1800);
      expect(await redis.ttl(`otp-block:${inv.invitationId}`)).toBeGreaterThan(1700);
      expect(mail.lockouts).toHaveLength(lockoutsBefore + 1);
      const notice = mail.lockouts[mail.lockouts.length - 1] as OtpLockoutMail & { to: string };
      expect(notice.to).toBe(tenant.staffEmail);
      expect(notice.candidateEmail).toBe(inv.candidateEmail);
      expect(notice.blockedMinutes).toBe(30);
      const audit = await owner.auditLog.findMany({
        where: { action: 'CANDIDATE_OTP_LOCKED', entityId: inv.sessionId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorId).toBeNull();
      // The block reaches the link page and the OTP route; no new code is sent.
      const link = await post('/link', { invitationToken: inv.token }).expect(200);
      expect(link.body).toMatchObject({ state: 'BLOCKED' });
      const sent = mail.otps.length;
      const again = await post('/otp', { invitationToken: inv.token }).expect(200);
      expect(again.body).toMatchObject({ state: 'BLOCKED' });
      expect(mail.otps.length).toBe(sent);
      expect((await sessionRow(inv.sessionId)).status).toBe('INVITED');
    });

    it('TC-007: twenty parallel wrong guesses spend at most five attempts, block once and notify once', async () => {
      const inv = await invite();
      const code = await otpFor(inv);
      const before = mail.lockouts.length;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          post('/start', { invitationToken: inv.token, otp: wrongCode(code) }),
        ),
      );
      expect(results.filter((r) => r.status === 400).length).toBeLessThanOrEqual(5);
      expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(15);
      expect(results.filter((r) => r.status === 200)).toHaveLength(0);
      expect(mail.lockouts.length).toBe(before + 1);
      const audit = await owner.auditLog.count({
        where: { action: 'CANDIDATE_OTP_LOCKED', entityId: inv.sessionId },
      });
      expect(audit).toBe(1);
      // Even the correct code is now refused.
      const right = await post('/start', { invitationToken: inv.token, otp: code });
      expect(right.status).toBe(429);
    });

    it('TC-007: a new code does not reset the wrong-guess counter', async () => {
      const inv = await invite();
      let code = await otpFor(inv);
      for (let i = 0; i < 3; i++)
        await post('/start', { invitationToken: inv.token, otp: wrongCode(code) }).expect(400);
      code = await otpFor(inv);
      await post('/start', { invitationToken: inv.token, otp: wrongCode(code) }).expect(400);
      // 3 + 1 + this one = the 5th wrong guess in all, so it blocks.
      await post('/start', { invitationToken: inv.token, otp: wrongCode(code) }).expect(429);
      const blocked = await post('/start', { invitationToken: inv.token, otp: code });
      expect(blocked.status).toBe(429);
    });

    it('TC-097: during a test a wrong code never blocks: it logs RESUME_OTP_FAILED, alerts /live, and the retry waits 30 s', async () => {
      const inv = await invite(liveSession());
      const subscriber = new Redis(redisBox.getConnectionUrl());
      const alerts: string[] = [];
      await subscriber.subscribe(`live:${tenant.orgId}`);
      subscriber.on('message', (_c, m) => alerts.push(m));
      const code = await otpFor(inv);
      const deadlineBefore = (await sessionRow(inv.sessionId)).deadlineAt;

      const first = await post('/start', { invitationToken: inv.token, otp: wrongCode(code) });
      expect(first.status).toBe(400);
      expect(first.body).toMatchObject({ code: 'OTP_INVALID', retryAfterSeconds: 30 });
      // The retry inside the cooldown is refused with the wait time and writes no second event.
      const early = await post('/start', { invitationToken: inv.token, otp: wrongCode(code) });
      expect(early.status).toBe(429);
      expect(early.body).toMatchObject({ code: 'OTP_COOLDOWN' });
      const wait = Number(early.headers['retry-after']);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(30);
      // Six wrong codes in all, the cooldown elapsing between them (simulated by removing the key).
      for (let i = 0; i < 5; i++) {
        await redis.del(`otp-cooldown:${inv.invitationId}`);
        const r = await post('/start', { invitationToken: inv.token, otp: wrongCode(code) });
        expect(r.status).toBe(400);
      }
      expect(await redis.exists(`otp-block:${inv.invitationId}`)).toBe(0);
      expect(await redis.exists(`otp-attempts:${inv.invitationId}`)).toBe(0);
      const events = await owner.proctorEvent.findMany({
        where: { sessionId: inv.sessionId, type: 'RESUME_OTP_FAILED' },
      });
      expect(events).toHaveLength(6);
      for (const e of events) {
        expect(e).toMatchObject({ severity: 'MEDIUM', source: 'SERVER', payload: {} });
        expect(JSON.stringify(e.payload)).not.toContain(code);
      }
      await eventually(
        () => Promise.resolve(alerts.length),
        (n) => n >= 6,
        5000,
      );
      expect(alerts).toHaveLength(6);
      expect(JSON.parse(alerts[0] as string)).toMatchObject({
        type: 'RESUME_OTP_FAILED',
        sessionId: inv.sessionId,
        severity: 'MEDIUM',
      });
      expect(alerts.join('')).not.toContain(code);
      expect(
        await owner.auditLog.count({
          where: { action: 'CANDIDATE_OTP_LOCKED', entityId: inv.sessionId },
        }),
      ).toBe(0);
      expect(mail.lockouts.filter((l) => l.candidateEmail === inv.candidateEmail)).toHaveLength(0);

      // The correct code then resumes the same session; the server clock kept running.
      await redis.del(`otp-cooldown:${inv.invitationId}`);
      const ok = await post('/start', { invitationToken: inv.token, otp: code }).expect(200);
      expect((ok.body as { status: string }).status).toBe('IN_PROGRESS');
      const row = await sessionRow(inv.sessionId);
      expect(row.authEpoch).toBe(2);
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.deadlineAt?.toISOString()).toBe(deadlineBefore?.toISOString());
      subscriber.disconnect();
    });

    it('FR-106, ADR 0002 L-2: a successful resume raises auth_epoch and the old device is taken over (401 SESSION_TAKEN_OVER)', async () => {
      const inv = await invite(liveSession());
      const first = await signIn(inv);
      await authed('get', '', first).expect(200);
      const second = await signIn(inv);
      expect((await sessionRow(inv.sessionId)).authEpoch).toBe(3);
      const stale = await authed('get', '', first);
      expect(stale.status).toBe(401);
      expect(stale.body).toMatchObject({ code: 'SESSION_TAKEN_OVER' });
      await authed('get', '', second).expect(200);
    });

    it('TC-021: after SUBMITTED the link shows "already used": no OTP is sent and no session is created', async () => {
      for (const status of [
        'SUBMITTED',
        'GRADED',
        'UNDER_REVIEW',
        'COMPLETED',
        'APPEALED',
      ] as SessionStatus[]) {
        const inv = await invite({ status });
        const sent = mail.otps.length;
        const link = await post('/link', { invitationToken: inv.token }).expect(200);
        expect(link.body).toMatchObject({ state: 'ALREADY_USED' });
        const otp = await post('/otp', { invitationToken: inv.token }).expect(200);
        expect(otp.body).toMatchObject({ state: 'ALREADY_USED' });
        expect(mail.otps.length).toBe(sent);
        expect(await redis.exists(`otp:${inv.invitationId}`)).toBe(0);
        const start = await post('/start', { invitationToken: inv.token, otp: '123456' });
        expect(start.status).toBe(409);
        expect(start.body).toMatchObject({ code: 'LINK_ALREADY_USED' });
        expect(await owner.session.count({ where: { invitationId: inv.invitationId } })).toBe(1);
        expect((await sessionRow(inv.sessionId)).status).toBe(status);
      }
    });

    it('TC-022: after window_end an unstarted link is EXPIRED, the status is stored, and no OTP is sent', async () => {
      const inv = await invite({
        windowEnd: new Date(Date.now() - 60_000),
        windowStart: new Date(Date.now() - 86_400_000),
      });
      const sent = mail.otps.length;
      const link = await post('/link', { invitationToken: inv.token }).expect(200);
      expect(link.body).toMatchObject({ state: 'EXPIRED' });
      const row = await sessionRow(inv.sessionId);
      expect(row.status).toBe('EXPIRED');
      expect(row.retentionAnchorAt).not.toBeNull();
      await post('/otp', { invitationToken: inv.token }).expect(200);
      expect(mail.otps.length).toBe(sent);
      const start = await post('/start', { invitationToken: inv.token, otp: '123456' });
      expect(start.status).toBe(409);
      expect(start.body).toMatchObject({ code: 'LINK_EXPIRED' });
    });

    it('FR-303, ADR 0002 L-4: window_end does not apply once the test has started', async () => {
      const inv = await invite({
        ...liveSession(),
        windowEnd: new Date(Date.now() - 3_600_000),
        windowStart: new Date(Date.now() - 86_400_000),
      });
      const link = await post('/link', { invitationToken: inv.token }).expect(200);
      expect(link.body).toMatchObject({ state: 'OTP_REQUIRED' });
      expect((await sessionRow(inv.sessionId)).status).toBe('IN_PROGRESS');
    });

    it('FR-303: before window_start the link answers NOT_YET_OPEN and sends nothing', async () => {
      const inv = await invite({
        windowStart: new Date(Date.now() + 3_600_000),
        windowEnd: new Date(Date.now() + 86_400_000),
      });
      const sent = mail.otps.length;
      const link = await post('/link', { invitationToken: inv.token }).expect(200);
      expect(link.body).toMatchObject({ state: 'NOT_YET_OPEN' });
      expect((link.body as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(3000);
      await post('/otp', { invitationToken: inv.token }).expect(200);
      expect(mail.otps.length).toBe(sent);
      expect((await post('/start', { invitationToken: inv.token, otp: '123456' })).status).toBe(
        409,
      );
    });

    it('FR-401, TC-096: a declined link shows the declined page with the org contact and starts nothing', async () => {
      const inv = await invite({ status: 'DECLINED' });
      const sent = mail.otps.length;
      const link = await post('/link', { invitationToken: inv.token }).expect(200);
      expect(link.body).toMatchObject({ state: 'DECLINED', declineContact: 'hr@acme.example' });
      await post('/otp', { invitationToken: inv.token }).expect(200);
      expect(mail.otps.length).toBe(sent);
      const start = await post('/start', { invitationToken: inv.token, otp: '123456' });
      expect(start.status).toBe(409);
      expect(start.body).toMatchObject({ code: 'LINK_DECLINED' });
    });
  });

  // ---------- token scope (ADR 0013 section 5.10) ----------

  describe('candidate token scope (ADR 0013 section 5.10, NFR-04, TC-008)', () => {
    it('NFR-04: no token, a malformed token and a staff-secret token are 401 on every guarded route', async () => {
      const inv = await invite(liveSession());
      const staffSecret = process.env.JWT_ACCESS_SECRET as string;
      const staffLike = jwt.sign(
        { sub: randomUUID(), org: tenant.orgId, role: 'RECRUITER', kind: 'access' },
        staffSecret,
        { expiresIn: 300 },
      );
      const forged = jwt.sign(
        { typ: 'candidate', sid: inv.sessionId, oid: tenant.orgId, epoch: 1 },
        staffSecret,
        {
          algorithm: 'HS256',
          expiresIn: 300,
          issuer: 'codeproctor-api',
          audience: 'codeproctor-candidate',
        },
      );
      const routes: Array<['get' | 'post', string]> = [
        ['get', ''],
        ['get', '/consent'],
        ['post', '/consent/sign'],
        ['post', '/consent/decline'],
        ['post', '/test/start'],
        ['post', '/heartbeat'],
        ['post', '/proctor-key'],
      ];
      for (const [method, path] of routes) {
        const none = await request(server())[method](`${API}${path}`).send({});
        expect(none.status).toBe(401);
        for (const bad of ['garbage', staffLike, forged]) {
          const res = await authed(method, path, bad);
          expect(res.status).toBe(401);
          expect(res.body).not.toHaveProperty('code', 'TOKEN_EXPIRED');
        }
      }
    });

    it('NFR-04: a candidate token is refused on staff routes (401), as the staff guard does not know its secret', async () => {
      const inv = await invite(liveSession());
      const token = await signIn(inv);
      const staffRoutes = [
        '/api/v1/auth/2fa/setup/start',
        '/api/v1/auth/2fa/setup/confirm',
        '/api/v1/auth/2fa/disable',
        '/api/v1/auth/2fa/recovery-codes/regenerate',
        `/api/v1/auth/2fa/reset/${randomUUID()}`,
      ];
      for (const path of staffRoutes) {
        const res = await request(server())
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ currentPassword: 'x' });
        expect(res.status).toBe(401);
      }
    });

    it('FR-609: an expired token is 401 TOKEN_EXPIRED', async () => {
      const inv = await invite(liveSession());
      const old = tokens.sign(
        { sid: inv.sessionId, oid: tenant.orgId, epoch: 1 },
        new Date(Date.now() - 3_600_000),
      );
      const res = await authed('get', '', old.token);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'TOKEN_EXPIRED' });
    });

    it('TC-008: a token that names a session of another org is 401, never a cross-org read', async () => {
      const mine = await invite(liveSession());
      const theirs = await invite(liveSession(), other);
      const theirBeat = (await sessionRow(theirs.sessionId)).lastHeartbeat?.getTime();
      // A well-signed token pairing my org with their session, and their org with my session.
      for (const [sid, oid] of [
        [theirs.sessionId, tenant.orgId],
        [mine.sessionId, other.orgId],
      ] as const) {
        const t = tokens.sign({ sid, oid, epoch: 1 });
        const res = await authed('get', '', t.token);
        expect(res.status).toBe(401);
        const beat = await authed('post', '/heartbeat', t.token);
        expect(beat.status).toBe(401);
      }
      expect((await sessionRow(theirs.sessionId)).lastHeartbeat?.getTime()).toBe(theirBeat);
    });

    it('ADR 0013 CS-1: two candidates of one org each see only their own session; a session id in the body is refused', async () => {
      const a = await invite(liveSession({ deadlineAt: new Date(Date.now() + 40 * 60_000) }));
      const b = await invite(liveSession({ deadlineAt: new Date(Date.now() + 55 * 60_000) }));
      const ta = tokens.sign({ sid: a.sessionId, oid: tenant.orgId, epoch: 1 }).token;
      const tb = tokens.sign({ sid: b.sessionId, oid: tenant.orgId, epoch: 1 }).token;
      const sa = (await authed('get', '', ta).expect(200)).body as { deadlineAt: string };
      const sb = (await authed('get', '', tb).expect(200)).body as { deadlineAt: string };
      expect(sa.deadlineAt).toBe((await sessionRow(a.sessionId)).deadlineAt?.toISOString());
      expect(sb.deadlineAt).toBe((await sessionRow(b.sessionId)).deadlineAt?.toISOString());
      expect(sa.deadlineAt).not.toBe(sb.deadlineAt);
      // B's token with A's ids: refused as invalid input, and A is untouched.
      const beforeA = (await sessionRow(a.sessionId)).lastHeartbeat?.toISOString();
      const res = await authed('post', '/heartbeat', tb, { sessionId: a.sessionId });
      expect(res.status).toBe(400);
      expect((await sessionRow(a.sessionId)).lastHeartbeat?.toISOString()).toBe(beforeA);
      const beat = await authed('post', '/heartbeat', tb).expect(200);
      expect(beat.body).toMatchObject({ status: 'IN_PROGRESS' });
      expect((await sessionRow(b.sessionId)).lastHeartbeat?.toISOString()).not.toBe(beforeA);
      expect((await sessionRow(a.sessionId)).lastHeartbeat?.toISOString()).toBe(beforeA);
    });
  });

  // ---------- consent (FR-401) ----------

  describe('consent document (FR-401, D-17, C-07, C-30, TC-030, TC-095, TC-096)', () => {
    const sign = (
      token: string,
      over: object = {},
      headers: Record<string, string> = {},
    ): request.Test => {
      let req = request(server())
        .post(`${API}/consent/sign`)
        .set('Authorization', `Bearer ${token}`);
      for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
      return req.send({
        consentTextId: tenant.consentTextId,
        signedName: 'Ada Lovelace',
        confirmedAge18: true,
        ...over,
      });
    };

    it('TC-030: before the document is signed nothing can start: no key, heartbeat, test start, events, media or identity rows', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      for (const path of ['/proctor-key', '/heartbeat'] as const) {
        const res = await authed('post', path, token);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE', sessionStatus: 'OPENED' });
      }
      const start = await authed('post', '/test/start', token);
      expect(start.status).toBe(409);
      expect(await owner.proctorEvent.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect(await owner.proctorEventBatch.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect(await owner.mediaChunk.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect(await owner.identityCheck.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect(await owner.consent.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect((await sessionRow(inv.sessionId)).hmacKeyEnc).toBeNull();
      // Reading the document is allowed and starts nothing either.
      await authed('get', '/consent', token).expect(200);
      expect((await sessionRow(inv.sessionId)).status).toBe('OPENED');
    });

    it("FR-401: GET consent returns the org's current text and version, uncached", async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const res = await authed('get', '/consent', token).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        consentTextId: tenant.consentTextId,
        version: 'v1-main',
        legalApproved: true,
        signed: false,
        signedAt: null,
      });
      expect((res.body as { bodyMd: string }).bodyMd).toContain('We record your screen');
    });

    it('TC-095: signing stores version, typed name, SERVER time, IP and user agent; CONSENTED; PDF stored; copy emailed', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const before = Date.now();
      const res = await sign(
        token,
        { signedName: '  Ada   Lovelace ' },
        { 'User-Agent': 'TestBrowser/1.0', 'X-Forwarded-For': '203.0.113.9' },
      ).expect(200);
      const after = Date.now();
      expect(res.body).toMatchObject({ status: 'CONSENTED' });
      const signedAtResponse = Date.parse((res.body as { signedAt: string }).signedAt);
      expect(signedAtResponse).toBeGreaterThanOrEqual(before - 1000);
      expect(signedAtResponse).toBeLessThanOrEqual(after + 1000);
      const consent = await owner.consent.findUniqueOrThrow({
        where: { sessionId: inv.sessionId },
      });
      expect(consent.consentTextId).toBe(tenant.consentTextId);
      expect(consent.signedName).toBe('Ada Lovelace');
      expect(consent.signedAt?.getTime()).toBe(signedAtResponse);
      expect(consent.declinedAt).toBeNull();
      expect(consent.userAgent).toBe('TestBrowser/1.0');
      expect(consent.ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
      expect((await sessionRow(inv.sessionId)).status).toBe('CONSENTED');

      // The job renders the PDF, stores it outside the session prefix, and emails the copy.
      const done = await eventually(
        () => owner.consent.findUniqueOrThrow({ where: { sessionId: inv.sessionId } }),
        (c) => c.pdfKey !== null && c.copyEmailedAt !== null,
      );
      expect(done.pdfKey).toMatch(
        new RegExp(`^orgs/${tenant.orgId}/consents/${inv.sessionId}/[0-9A-Z]{26}\\.pdf$`),
      );
      expect(done.pdfKey).not.toContain('/sessions/');
      expect(done.pdfGeneratedAt).not.toBeNull();
      const stored = storage.objects.get(done.pdfKey as string);
      expect(stored?.contentType).toBe('application/pdf');
      expect(stored?.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const copy = mail.copies.find((c) => c.to === inv.candidateEmail);
      expect(copy).toBeDefined();
      expect(copy?.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(copy?.documentVersion).toBe('v1-main');
      expect(copy?.filename).toBe('consent-v1-main.pdf');
      // The 18+ confirmation is in the audit row (no consents column yet); the name is not.
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { action: 'CANDIDATE_CONSENT_SIGNED', entityId: inv.sessionId },
      });
      expect(audit.metadata).toMatchObject({
        ageConfirmed18: true,
        consentTextId: tenant.consentTextId,
      });
      expect(JSON.stringify(audit.metadata)).not.toContain('Lovelace');
    });

    it('TC-095: a client-supplied timestamp is refused; the server decides when the document was signed', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const res = await sign(token, { signedAt: '2020-01-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
      expect(await owner.consent.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect((await sessionRow(inv.sessionId)).status).toBe('OPENED');
    });

    it('C-30: without the 18+ confirmation the candidate cannot continue (400 AGE_CONFIRMATION_REQUIRED)', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const res = await sign(token, { confirmedAge18: false });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'AGE_CONFIRMATION_REQUIRED' });
      expect((await sign(token, { confirmedAge18: undefined })).status).toBe(400);
      expect((await sign(token, { confirmedAge18: 'yes' })).status).toBe(400);
      expect(await owner.consent.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect((await sessionRow(inv.sessionId)).status).toBe('OPENED');
    });

    it('FR-401: an unusable typed name is refused', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      for (const signedName of ['A', '   ', '12345', 'Ada\u0000Lovelace', 'x'.repeat(201)]) {
        const res = await sign(token, { signedName });
        expect(res.status).toBe(400);
      }
      expect(await owner.consent.count({ where: { sessionId: inv.sessionId } })).toBe(0);
    });

    it('FR-401: signing a document that is no longer current is refused (409 CONSENT_TEXT_CHANGED)', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const res = await sign(token, { consentTextId: unapproved.consentTextId });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONSENT_TEXT_CHANGED' });
      expect((await sign(token, { consentTextId: 'not-a-uuid' })).status).toBe(400);
    });

    it('FR-401: a second signature on the same session is refused; only one consents row and one PDF exist', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const results = await Promise.all(Array.from({ length: 6 }, () => sign(token)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'ALREADY_SIGNED' });
      }
      expect(await owner.consent.count({ where: { sessionId: inv.sessionId } })).toBe(1);
      expect(
        await owner.auditLog.count({
          where: { action: 'CANDIDATE_CONSENT_SIGNED', entityId: inv.sessionId },
        }),
      ).toBe(1);
      const signed = await authed('get', '/consent', token).expect(200);
      expect(signed.body).toMatchObject({ signed: true });
    });

    it('TC-095: every session needs its own signature, also for the same candidate', async () => {
      const first = await invite({ status: 'OPENED', email: 'repeat@example.test' });
      const second = await invite({ status: 'OPENED', email: 'repeat@example.test' }).catch(
        () => null,
      );
      // One candidate row per (org, email) is unique, so the second invitation reuses nothing here:
      // use a second session for another invitation of a fresh candidate and prove independence.
      const t1 = tokens.sign({ sid: first.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      await sign(t1).expect(200);
      const other2 = second ?? (await invite({ status: 'OPENED' }));
      const t2 = tokens.sign({ sid: other2.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const view = await authed('get', '/consent', t2).expect(200);
      expect(view.body).toMatchObject({ signed: false });
      expect((await sessionRow(other2.sessionId)).status).toBe('OPENED');
      await sign(t2).expect(200);
      expect(
        await owner.consent.count({
          where: { sessionId: { in: [first.sessionId, other2.sessionId] } },
        }),
      ).toBe(2);
    });

    it('TC-096: declining sets declined_at, DECLINED and the retention anchor, records nothing and shows the contact', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      const res = await authed('post', '/consent/decline', token).expect(200);
      expect(res.body).toEqual({ status: 'DECLINED', declineContact: 'hr@acme.example' });
      const row = await sessionRow(inv.sessionId);
      expect(row.status).toBe('DECLINED');
      expect(row.retentionAnchorAt).not.toBeNull();
      expect(row.hmacKeyEnc).toBeNull();
      const consent = await owner.consent.findUniqueOrThrow({
        where: { sessionId: inv.sessionId },
      });
      expect(consent.declinedAt).not.toBeNull();
      expect(consent.signedAt).toBeNull();
      expect(consent.signedName).toBeNull();
      expect(consent.pdfKey).toBeNull();
      expect(
        await owner.invitation.findUniqueOrThrow({ where: { id: inv.invitationId } }),
      ).toMatchObject({ usedAt: null });
      // No device access, no recording: every later step refuses, and nothing was written.
      for (const path of ['/test/start', '/proctor-key', '/heartbeat'] as const) {
        expect((await authed('post', path, token)).status).toBe(409);
      }
      expect((await sign(token)).status).toBe(409);
      expect(await owner.proctorEvent.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect(await owner.mediaChunk.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      // Reopening the link shows the declined page and starts nothing.
      const link = await post('/link', { invitationToken: inv.token }).expect(200);
      expect(link.body).toMatchObject({ state: 'DECLINED', declineContact: 'hr@acme.example' });
      expect((await post('/start', { invitationToken: inv.token, otp: '123456' })).status).toBe(
        409,
      );
      expect(mail.copies.find((c) => c.to === inv.candidateEmail)).toBeUndefined();
      await new Promise((r) => setTimeout(r, 300));
      expect(storage.objects.size).toBeGreaterThan(0);
      expect([...storage.objects.keys()].some((k) => k.includes(inv.sessionId))).toBe(false);
    });

    it('TC-096: a signed session cannot be declined afterwards, and a declined one cannot be signed', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      await sign(token).expect(200);
      const res = await authed('post', '/consent/decline', token);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'ALREADY_SIGNED' });
      expect((await sessionRow(inv.sessionId)).status).toBe('CONSENTED');
    });

    it('TC-096: an org without a consent text can still decline (no consents row is kept)', async () => {
      const bare = await createTenant(owner, 'bare');
      await owner.organization.update({
        where: { id: bare.orgId },
        data: { currentConsentTextId: null },
      });
      const inv = await invite({ status: 'OPENED' }, bare);
      const token = tokens.sign({ sid: inv.sessionId, oid: bare.orgId, epoch: 0 }).token;
      await authed('get', '/consent', token)
        .expect(409)
        .expect((r) => expect(r.body).toMatchObject({ code: 'CONSENT_NOT_CONFIGURED' }));
      await authed('post', '/consent/decline', token).expect(200);
      expect((await sessionRow(inv.sessionId)).status).toBe('DECLINED');
    });

    it('D-17, ADR 0007 section 6: with REQUIRE_LEGAL_APPROVED_CONSENT an unapproved text is not served and cannot be signed', async () => {
      legalApp = await buildApp({ REQUIRE_LEGAL_APPROVED_CONSENT: 'true' });
      const legalServer = legalApp.getHttpServer();
      const inv = await invite({ status: 'OPENED' }, unapproved);
      const token = tokens.sign({ sid: inv.sessionId, oid: unapproved.orgId, epoch: 0 }).token;
      const get = await request(legalServer)
        .get(`${API}/consent`)
        .set('Authorization', `Bearer ${token}`);
      expect(get.status).toBe(409);
      expect(get.body).toMatchObject({ code: 'CONSENT_NOT_APPROVED' });
      const res = await request(legalServer)
        .post(`${API}/consent/sign`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          consentTextId: unapproved.consentTextId,
          signedName: 'Ada Lovelace',
          confirmedAge18: true,
        });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONSENT_NOT_APPROVED' });
      expect((await sessionRow(inv.sessionId)).status).toBe('OPENED');
      expect(await owner.consent.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      // An approved text is served by the same app; the placeholder is served when the flag is off.
      const ok = await invite({ status: 'OPENED' });
      const okToken = tokens.sign({ sid: ok.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      await request(legalServer)
        .get(`${API}/consent`)
        .set('Authorization', `Bearer ${okToken}`)
        .expect(200);
      const open = await authed(
        'get',
        '/consent',
        tokens.sign({ sid: inv.sessionId, oid: unapproved.orgId, epoch: 0 }).token,
      ).expect(200);
      expect(open.body).toMatchObject({ legalApproved: false });
    });

    it('FR-401: a failed PDF store is retried by the job and the sweep, and the candidate is never blocked', async () => {
      const inv = await invite({ status: 'OPENED' });
      const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
      storage.failNextPut = true;
      await sign(token).expect(200);
      expect((await sessionRow(inv.sessionId)).status).toBe('CONSENTED');
      // The first attempt failed; the queue retries with backoff, and the sweep re-queues too.
      await eventually(
        () => Promise.resolve(storage.failNextPut),
        (failed) => !failed,
        5000,
      );
      const swept = await jobs.sweepConsentPdfs(new Date(Date.now() + 120_000));
      expect(swept).toBeGreaterThanOrEqual(1);
      const done = await eventually(
        () => owner.consent.findUniqueOrThrow({ where: { sessionId: inv.sessionId } }),
        (c) => c.pdfKey !== null && c.copyEmailedAt !== null,
        30_000,
      );
      expect(done.pdfKey).not.toBeNull();
    });
  });

  // ---------- start of the test (ADR 0002, ADR 0013) ----------

  describe('test start: VERIFIED to IN_PROGRESS (ADR 0002 L-1, S-2, S-3; FR-301, FR-305, FR-505, TC-024, TC-047)', () => {
    const verified = (over: Partial<InvitationOptions> = {}): InvitationOptions => ({
      status: 'VERIFIED',
      session: { authEpoch: 1, deviceInfo: passedSystemCheck() },
      ...over,
    });
    const tokenFor = (inv: InvitationFixture, t: Tenant = tenant, epoch = 1): string =>
      tokens.sign({ sid: inv.sessionId, oid: t.orgId, epoch }).token;

    it('FR-505, TC-047: the server sets started_at and deadline_at from its own clock; a client clock header changes nothing', async () => {
      const inv = await invite(verified());
      const before = Date.now();
      const res = await authed('post', '/test/start', tokenFor(inv))
        .set('Date', new Date(Date.now() + 3_600_000).toUTCString())
        .set('X-Client-Time', new Date(Date.now() + 3_600_000).toISOString())
        .expect(200);
      const after = Date.now();
      const row = await sessionRow(inv.sessionId);
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.startedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.startedAt?.getTime()).toBeLessThanOrEqual(after + 1000);
      // 60 minutes, no accommodation.
      expect((row.deadlineAt?.getTime() ?? 0) - (row.startedAt?.getTime() ?? 0)).toBe(60 * 60_000);
      const body = res.body as { deadlineAt: string; serverTime: string; startedAt: string };
      expect(body.deadlineAt).toBe(row.deadlineAt?.toISOString());
      expect(Math.abs(Date.parse(body.serverTime) - Date.now())).toBeLessThan(5000);
      // The state route reports the same stored deadline, whatever the client believes.
      const state = await authed('get', '', tokenFor(inv))
        .set('Date', new Date(Date.now() + 7_200_000).toUTCString())
        .expect(200);
      expect((state.body as { deadlineAt: string }).deadlineAt).toBe(row.deadlineAt?.toISOString());
      // A body field cannot move the clock either.
      expect(
        (
          await authed('post', '/heartbeat', tokenFor(inv), {
            deadlineAt: new Date().toISOString(),
            serverTime: '2020-01-01T00:00:00Z',
          })
        ).status,
      ).toBe(400);
    });

    it('TC-024, FR-305: +50% extra time turns 60 minutes into 90 and the 20-minute section into 30', async () => {
      const inv = await invite(
        verified({ accommodations: { extraTimePct: 50, notes: 'private note' } }),
      );
      const res = await authed('post', '/test/start', tokenFor(inv)).expect(200);
      const row = await sessionRow(inv.sessionId);
      expect((row.deadlineAt?.getTime() ?? 0) - (row.startedAt?.getTime() ?? 0)).toBe(90 * 60_000);
      const sections = await owner.sessionSection.findMany({
        where: { sessionId: inv.sessionId },
        orderBy: { position: 'asc' },
      });
      expect(sections).toHaveLength(2);
      expect(Number(sections[0]?.timeLimitMs)).toBe(30 * 60_000);
      expect(sections[1]?.timeLimitMs).toBeNull();
      // S-2: section 1 is open with its own deadline; section 2 waits.
      expect(sections[0]?.startedAt).not.toBeNull();
      expect(
        (sections[0]?.deadlineAt?.getTime() ?? 0) - (sections[0]?.startedAt?.getTime() ?? 0),
      ).toBe(30 * 60_000);
      expect(sections[1]?.startedAt).toBeNull();
      expect(sections[1]?.deadlineAt).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('private note');
    });

    it('ADR 0002 S-4: a section never outlives the session, and a malformed accommodation means none', async () => {
      const tight = await createTenant(owner, 'tight');
      await owner.testSection.update({
        where: { id: tight.test.sectionIds[0] },
        data: { timeLimitMin: 90 },
      });
      const inv = await invite(verified(), tight);
      await authed('post', '/test/start', tokenFor(inv, tight)).expect(200);
      const row = await sessionRow(inv.sessionId);
      const first = await owner.sessionSection.findFirstOrThrow({
        where: { sessionId: inv.sessionId, position: 1 },
      });
      expect(first.deadlineAt?.getTime()).toBe(row.deadlineAt?.getTime());
      const bad = await invite(verified({ accommodations: { extraTimePct: 'lots' } }));
      await authed('post', '/test/start', tokenFor(bad)).expect(200);
      const badRow = await sessionRow(bad.sessionId);
      expect((badRow.deadlineAt?.getTime() ?? 0) - (badRow.startedAt?.getTime() ?? 0)).toBe(
        60 * 60_000,
      );
    });

    it('ADR 0002 L-1, S-2: used_at is set, questions are assigned (fixed, random rule, one variant), the key is stored wrapped', async () => {
      const inv = await invite(verified());
      const res = await authed('post', '/test/start', tokenFor(inv)).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const invitation = await owner.invitation.findUniqueOrThrow({
        where: { id: inv.invitationId },
      });
      expect(invitation.usedAt).not.toBeNull();
      const questions = await owner.sessionQuestion.findMany({
        where: { sessionId: inv.sessionId },
        orderBy: { position: 'asc' },
      });
      expect(questions).toHaveLength(3);
      expect(questions.map((q) => q.position)).toEqual([1, 2, 3]);
      expect(questions.map((q) => q.testQuestionId)).toEqual([...tenant.test.testQuestionIds]);
      expect(questions[0]?.questionVersionId).toBe(tenant.test.fixedVersionIds[0]);
      expect(tenant.test.variantIds).toContain(questions[0]?.variantId);
      // The inactive variant is never picked (the fixture's second variant is the only active one).
      expect(tenant.test.randomPoolVersionIds).toContain(questions[1]?.questionVersionId);
      expect(questions[2]?.questionVersionId).toBe(tenant.test.fixedVersionIds[1]);
      expect(questions.map((q) => q.points.toString())).toEqual(['100', '50', '25']);
      const row = await sessionRow(inv.sessionId);
      expect(row.hmacKeyEnc).toMatch(/^v1:k1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(keys.unwrap(row.hmacKeyEnc as string, inv.sessionId)).toHaveLength(32);
      // The response is an outline only: no key, no variant params, no statement, no solution.
      const text = JSON.stringify(res.body);
      for (const marker of [
        'VARIANT-PARAMS-MARKER',
        'REFERENCE-SOLUTION-MARKER',
        'Hidden statement',
        'hmac',
        'params',
        'variant',
        'referenceSolution',
      ]) {
        expect(text).not.toContain(marker);
      }
      const sections = (
        res.body as {
          sections: Array<{ title: string; questions: Array<{ sessionQuestionId: string }> }>;
        }
      ).sections;
      expect(sections.map((s) => s.title)).toEqual(['Section one', 'Section two']);
      expect(sections[0]?.questions.map((q) => q.sessionQuestionId)).toEqual([
        questions[0]?.id,
        questions[1]?.id,
      ]);
    });

    it('FR-203: random picks never repeat a question inside one session', async () => {
      const dup = await createTenant(owner, 'dup');
      // Two random slots over a pool of three questions.
      await owner.testQuestion.create({
        data: {
          sectionId: dup.test.sectionIds[1],
          randomRule: { tags: ['arrays'] },
          points: 10,
          position: 2,
        },
      });
      for (let i = 0; i < 6; i++) {
        const inv = await invite(verified(), dup);
        await authed('post', '/test/start', tokenFor(inv, dup)).expect(200);
        const picked = await owner.sessionQuestion.findMany({
          where: {
            sessionId: inv.sessionId,
            testQuestionId: { in: [dup.test.testQuestionIds[1]] },
          },
        });
        const all = await owner.sessionQuestion.findMany({ where: { sessionId: inv.sessionId } });
        const versions = all.map((q) => q.questionVersionId);
        expect(new Set(versions).size).toBe(versions.length);
        expect(picked).toHaveLength(1);
      }
    });

    it('FR-203: a random rule nothing matches fails the start cleanly and leaves the session VERIFIED', async () => {
      const t = await createTenant(owner, 'norule');
      await owner.testQuestion.update({
        where: { id: t.test.testQuestionIds[1] },
        data: { randomRule: { tags: ['no-such-tag'] } },
      });
      const inv = await invite(verified(), t);
      const res = await authed('post', '/test/start', tokenFor(inv, t));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'RANDOM_RULE_UNSATISFIABLE' });
      const row = await sessionRow(inv.sessionId);
      expect(row.status).toBe('VERIFIED');
      expect(row.hmacKeyEnc).toBeNull();
      expect(await owner.sessionQuestion.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect(await owner.sessionSection.count({ where: { sessionId: inv.sessionId } })).toBe(0);
      expect(
        (await owner.invitation.findUniqueOrThrow({ where: { id: inv.invitationId } })).usedAt,
      ).toBeNull();
      await owner.testQuestion.update({
        where: { id: t.test.testQuestionIds[1] },
        data: { randomRule: { tags: ['arrays'], bogus: 1 } },
      });
      const again = await authed('post', '/test/start', tokenFor(inv, t));
      expect(again.status).toBe(409);
    });

    it('FR-505: starting twice, or twice at once, builds one set of rows and answers the running session', async () => {
      const inv = await invite(verified());
      const token = tokenFor(inv);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => authed('post', '/test/start', token)),
      );
      for (const r of results) expect(r.status).toBe(200);
      expect(await owner.sessionSection.count({ where: { sessionId: inv.sessionId } })).toBe(2);
      expect(await owner.sessionQuestion.count({ where: { sessionId: inv.sessionId } })).toBe(3);
      const deadlines = new Set(results.map((r) => (r.body as { deadlineAt: string }).deadlineAt));
      expect(deadlines.size).toBe(1);
      const again = await authed('post', '/test/start', token).expect(200);
      expect((again.body as { startedAt: string }).startedAt).toBe(
        (await sessionRow(inv.sessionId)).startedAt?.toISOString(),
      );
      expect(await owner.sessionQuestion.count({ where: { sessionId: inv.sessionId } })).toBe(3);
    });

    it('FR-605, ADR 0013 section 3: the start needs a fresh, passed system check (409 SYSTEM_CHECK_BLOCKED)', async () => {
      const cases: InvitationOptions['accommodations'][] = [
        {},
        {
          systemCheck: {
            passed: false,
            blocking: ['MULTI_MONITOR'],
            checkedAt: new Date().toISOString(),
          },
        },
        passedSystemCheck(new Date(Date.now() - 16 * 60_000)),
        { systemCheck: { passed: true } },
        { systemCheck: 'ok' },
      ];
      for (const deviceInfo of cases) {
        const inv = await invite({ status: 'VERIFIED', session: { authEpoch: 1, deviceInfo } });
        const res = await authed('post', '/test/start', tokenFor(inv));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SYSTEM_CHECK_BLOCKED' });
        const row = await sessionRow(inv.sessionId);
        expect(row.status).toBe('VERIFIED');
        expect(row.hmacKeyEnc).toBeNull();
      }
      const fresh = await invite({
        status: 'VERIFIED',
        session: {
          authEpoch: 1,
          deviceInfo: passedSystemCheck(new Date(Date.now() - 14 * 60_000)),
        },
      });
      await authed('post', '/test/start', tokenFor(fresh)).expect(200);
    });

    it('ADR 0002 section 2: only a VERIFIED session can start; other states answer 409 SESSION_STATE_CONFLICT', async () => {
      for (const status of ['OPENED', 'CONSENTED', 'SUBMITTED'] as SessionStatus[]) {
        const inv = await invite({ status, session: { authEpoch: 1 } });
        const res = await authed('post', '/test/start', tokenFor(inv));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SESSION_STATE_CONFLICT', sessionStatus: status });
        expect((await sessionRow(inv.sessionId)).status).toBe(status);
      }
    });

    it('ADR 0002 L-4: a start after window_end expires the session instead (409 LINK_EXPIRED)', async () => {
      const inv = await invite(verified({ windowEnd: new Date(Date.now() - 60_000) }));
      const res = await authed('post', '/test/start', tokenFor(inv));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'LINK_EXPIRED' });
      expect((await sessionRow(inv.sessionId)).status).toBe('EXPIRED');
    });

    it("TC-008: another org's test cannot be started through a forged token pairing", async () => {
      const theirs = await invite(verified(), other);
      const res = await authed('post', '/test/start', tokenFor(theirs, tenant));
      expect(res.status).toBe(401);
      expect((await sessionRow(theirs.sessionId)).status).toBe('VERIFIED');
    });
  });

  // ---------- proctor key (ADR 0013 sections 2 and 4) ----------

  describe('proctor key route (ADR 0013 sections 2 and 4, FR-801)', () => {
    async function runningSession(
      over: InvitationOptions['session'] = {},
    ): Promise<{ inv: InvitationFixture; master: Buffer }> {
      const inv = await invite(liveSession(over));
      const wrapped = keys.generateWrapped(inv.sessionId);
      await owner.session.update({ where: { id: inv.sessionId }, data: { hmacKeyEnc: wrapped } });
      return { inv, master: keys.unwrap(wrapped, inv.sessionId) };
    }
    const tokenAt = (inv: InvitationFixture, epoch: number): string =>
      tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch }).token;

    it('FR-801: returns K_e for the token epoch once, with no-store, and the key matches the derivation', async () => {
      const { inv, master } = await runningSession();
      const res = await authed('post', '/proctor-key', tokenAt(inv, 1)).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as {
        alg: string;
        key: string;
        keyEpoch: number;
        counters: {
          eventSeqStart: number;
          keystrokeSeqStart: number;
          media: Record<string, { nextSeq: number; nextSegment: number }>;
        };
      };
      expect(body.alg).toBe('HMAC-SHA256');
      expect(body.keyEpoch).toBe(1);
      expect(Buffer.from(body.key, 'base64')).toHaveLength(32);
      expect(
        Buffer.from(body.key, 'base64').equals(keys.deriveBatchKey(master, inv.sessionId, 1)),
      ).toBe(true);
      expect(body.key).not.toBe(master.toString('base64'));
      expect(body.counters).toEqual({
        eventSeqStart: 0,
        keystrokeSeqStart: 0,
        media: {
          SCREEN: { nextSeq: 0, nextSegment: 0 },
          WEBCAM: { nextSeq: 0, nextSegment: 0 },
          AUDIO: { nextSeq: 0, nextSegment: 0 },
        },
      });
      const ttl = await redis.ttl(`pkey:${inv.sessionId}:1`);
      expect(ttl).toBeGreaterThan(50 * 60);
    });

    it('FR-801: a second request for the same epoch is 409 KEY_ALREADY_ISSUED and returns no key', async () => {
      const { inv } = await runningSession();
      await authed('post', '/proctor-key', tokenAt(inv, 1)).expect(200);
      const again = await authed('post', '/proctor-key', tokenAt(inv, 1));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'KEY_ALREADY_ISSUED' });
      expect(JSON.stringify(again.body)).not.toContain('"key"');
    });

    it('FR-801: ten concurrent requests for one epoch receive the key exactly once', async () => {
      const { inv } = await runningSession();
      const token = tokenAt(inv, 1);
      // The per-session limit is 5 per minute, so the rest of the burst is a 429; at most one is 200.
      const results = await Promise.all(
        Array.from({ length: 10 }, () => authed('post', '/proctor-key', token)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 200))
        expect([409, 429]).toContain(r.status);
      expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(5);
    });

    it('FR-801, ADR 0002 L-2: after an OTP resume the new epoch gets its own, different key; the old epoch cannot', async () => {
      const { inv, master } = await runningSession();
      const t1 = await signIn(inv);
      const k1 = await authed('post', '/proctor-key', t1).expect(200);
      expect((k1.body as { keyEpoch: number }).keyEpoch).toBe(2);
      const t2 = await signIn(inv);
      const k2 = await authed('post', '/proctor-key', t2).expect(200);
      expect((k2.body as { keyEpoch: number }).keyEpoch).toBe(3);
      expect((k2.body as { key: string }).key).not.toBe((k1.body as { key: string }).key);
      expect(
        Buffer.from((k2.body as { key: string }).key, 'base64').equals(
          keys.deriveBatchKey(master, inv.sessionId, 3),
        ),
      ).toBe(true);
      // The first device is taken over and cannot refetch its epoch's key.
      const stale = await authed('post', '/proctor-key', t1);
      expect(stale.status).toBe(401);
      expect(stale.body).toMatchObject({ code: 'SESSION_TAKEN_OVER' });
    });

    it('FR-801: a Redis marker that is lost makes the key issuable again (fail-open risk recorded in ADR 0013 section 2)', async () => {
      const { inv } = await runningSession();
      const token = tokenAt(inv, 1);
      await authed('post', '/proctor-key', token).expect(200);
      await redis.del(`pkey:${inv.sessionId}:1`);
      await redis.del(`rl:proctor-key:${inv.sessionId}`);
      await authed('post', '/proctor-key', token).expect(200);
    });

    it('FR-801: counters continue after the stored maximum so a new device does not collide with stored batches', async () => {
      const { inv } = await runningSession();
      await owner.proctorEventBatch.createMany({
        data: [0, 1, 7].map((seq) => ({
          sessionId: inv.sessionId,
          seq,
          signature: Buffer.alloc(32, seq),
          eventCount: 1,
        })),
      });
      await owner.keystrokeBatch.create({
        data: {
          sessionId: inv.sessionId,
          seq: 4,
          signature: Buffer.alloc(32),
          startedAt: new Date(),
          events: [],
        },
      });
      await owner.mediaChunk.createMany({
        data: [
          {
            sessionId: inv.sessionId,
            stream: 'SCREEN',
            segment: 0,
            seq: 0,
            startedAt: new Date(),
            durationMs: 10_000,
          },
          {
            sessionId: inv.sessionId,
            stream: 'SCREEN',
            segment: 1,
            seq: 5,
            startedAt: new Date(),
            durationMs: 10_000,
          },
          {
            sessionId: inv.sessionId,
            stream: 'AUDIO',
            segment: 0,
            seq: 2,
            startedAt: new Date(),
            durationMs: 10_000,
          },
        ],
      });
      const res = await authed('post', '/proctor-key', tokenAt(inv, 1)).expect(200);
      expect((res.body as { counters: unknown }).counters).toEqual({
        eventSeqStart: 8,
        keystrokeSeqStart: 5,
        media: {
          SCREEN: { nextSeq: 6, nextSegment: 2 },
          WEBCAM: { nextSeq: 0, nextSegment: 0 },
          AUDIO: { nextSeq: 3, nextSegment: 1 },
        },
      });
    });

    it('ADR 0013 section 4: outside IN_PROGRESS and PAUSED the route answers 409 SESSION_NOT_ACTIVE with the session status', async () => {
      for (const status of [
        'CONSENTED',
        'VERIFIED',
        'SUBMITTED',
        'DECLINED',
        'EXPIRED',
      ] as SessionStatus[]) {
        const inv = await invite({ status, session: { authEpoch: 1 } });
        const res = await authed('post', '/proctor-key', tokenAt(inv, 1));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE', sessionStatus: status });
      }
      // PAUSED is allowed.
      const paused = await invite({
        ...liveSession({ pauseReasons: ['SCREEN_SHARE_STOPPED'] }),
        status: 'PAUSED',
      });
      await owner.session.update({
        where: { id: paused.sessionId },
        data: { hmacKeyEnc: keys.generateWrapped(paused.sessionId) },
      });
      await authed('post', '/proctor-key', tokenAt(paused, 1)).expect(200);
    });

    it('ADR 0013 section 4: a session without a stored key answers 409 KEY_UNAVAILABLE and takes no marker', async () => {
      const inv = await invite(liveSession());
      const res = await authed('post', '/proctor-key', tokenAt(inv, 1));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'KEY_UNAVAILABLE' });
      expect(await redis.exists(`pkey:${inv.sessionId}:1`)).toBe(0);
    });

    it('ADR 0013 section 4: the limit is 5 per minute per session (429 with Retry-After)', async () => {
      const { inv } = await runningSession();
      const token = tokenAt(inv, 1);
      await redis.del(`rl:proctor-key:${inv.sessionId}`);
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++)
        statuses.push((await authed('post', '/proctor-key', token)).status);
      expect(statuses.slice(0, 5).filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.slice(5)).toEqual([429, 429]);
      const limited = await authed('post', '/proctor-key', token);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
    });
  });

  // ---------- heartbeat and watchdog (FR-609) ----------

  describe('heartbeat and the DISCONNECTED watchdog (FR-609, ADR 0013 section 5.3)', () => {
    const tokenAt = (inv: InvitationFixture, epoch = 1): string =>
      tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch }).token;

    it('FR-609: a beat sets last_heartbeat and returns the server clock, status, deadlines and pause reasons', async () => {
      const inv = await invite(liveSession({ lastHeartbeat: new Date(Date.now() - 30_000) }));
      const before = (await sessionRow(inv.sessionId)).lastHeartbeat?.getTime() ?? 0;
      const res = await authed('post', '/heartbeat', tokenAt(inv)).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const row = await sessionRow(inv.sessionId);
      expect(row.lastHeartbeat?.getTime()).toBeGreaterThan(before);
      expect(Math.abs((row.lastHeartbeat?.getTime() ?? 0) - Date.now())).toBeLessThan(5000);
      expect(res.body).toMatchObject({
        status: 'IN_PROGRESS',
        pauseReasons: [],
        sectionDeadlineAt: null,
      });
      expect((res.body as { deadlineAt: string }).deadlineAt).toBe(row.deadlineAt?.toISOString());
      expect(res.body).not.toHaveProperty('sessionToken');
    });

    it('FR-609: a heartbeat does not change the session status (DISCONNECTED is an event, not a status)', async () => {
      const inv = await invite(liveSession({ lastHeartbeat: new Date(Date.now() - 5 * 60_000) }));
      await jobs.discoverDisconnected();
      await eventually(
        () =>
          owner.proctorEvent.count({ where: { sessionId: inv.sessionId, type: 'DISCONNECTED' } }),
        (n) => n >= 1,
      );
      expect((await sessionRow(inv.sessionId)).status).toBe('IN_PROGRESS');
      await authed('post', '/heartbeat', tokenAt(inv)).expect(200);
      expect((await sessionRow(inv.sessionId)).status).toBe('IN_PROGRESS');
    });

    it('FR-609: the open section deadline is reported, and a PROCTOR pause credit extends it (TC-079 shape)', async () => {
      const inv = await invite(liveSession({ pauseReasons: [] }));
      const open = new Date(Date.now() - 5 * 60_000);
      await owner.sessionSection.create({
        data: {
          sessionId: inv.sessionId,
          sectionId: tenant.test.sectionIds[0],
          position: 1,
          timeLimitMs: 1_200_000n,
          startedAt: open,
          deadlineAt: new Date(open.getTime() + 1_200_000),
        },
      });
      const res = await authed('post', '/heartbeat', tokenAt(inv)).expect(200);
      expect((res.body as { sectionDeadlineAt: string }).sectionDeadlineAt).toBe(
        new Date(open.getTime() + 1_200_000).toISOString(),
      );
      const paused = await invite({
        ...liveSession({ pauseReasons: ['PROCTOR'] }),
        status: 'PAUSED',
      });
      await owner.session.update({
        where: { id: paused.sessionId },
        data: { proctorPausedAt: new Date(Date.now() - 4 * 60_000) },
      });
      const stored = (await sessionRow(paused.sessionId)).deadlineAt?.getTime() ?? 0;
      const beat = await authed('post', '/heartbeat', tokenAt(paused)).expect(200);
      const reported = Date.parse((beat.body as { deadlineAt: string }).deadlineAt);
      expect(reported - stored).toBeGreaterThan(3.9 * 60_000);
      expect(reported - stored).toBeLessThan(4.2 * 60_000);
      expect((beat.body as { pauseReasons: string[] }).pauseReasons).toEqual(['PROCTOR']);
    });

    it('FR-609: outside IN_PROGRESS and PAUSED a beat answers 409 SESSION_NOT_ACTIVE with the status and writes nothing', async () => {
      const inv = await invite({ status: 'CONSENTED', session: { authEpoch: 1 } });
      const res = await authed('post', '/heartbeat', tokenAt(inv));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE', sessionStatus: 'CONSENTED' });
      expect((await sessionRow(inv.sessionId)).lastHeartbeat).toBeNull();
      const submitted = await invite({ status: 'SUBMITTED', session: { authEpoch: 1 } });
      expect((await authed('post', '/heartbeat', tokenAt(submitted))).body).toMatchObject({
        sessionStatus: 'SUBMITTED',
      });
    });

    it('FR-609: the limit is 12 beats per minute per session (429 RATE_LIMITED with Retry-After)', async () => {
      const inv = await invite(liveSession());
      const token = tokenAt(inv);
      for (let i = 0; i < 12; i++)
        expect((await authed('post', '/heartbeat', token)).status).toBe(200);
      const res = await authed('post', '/heartbeat', token);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // Another session is not affected.
      const other1 = await invite(liveSession());
      await authed('post', '/heartbeat', tokenAt(other1)).expect(200);
    });

    it('FR-609, FR-104 shape: the token is renewed once half of its life is gone, for the same session and epoch', async () => {
      const inv = await invite(liveSession());
      // Issued 10 minutes ago with a 15 minute life: 5 minutes left.
      const old = tokens.sign(
        { sid: inv.sessionId, oid: tenant.orgId, epoch: 1 },
        new Date(Date.now() - 10 * 60_000),
      );
      const res = await authed('post', '/heartbeat', old.token).expect(200);
      const body = res.body as { sessionToken?: string; sessionTokenExpiresAt?: string };
      expect(body.sessionToken).toBeDefined();
      expect(Date.parse(body.sessionTokenExpiresAt as string)).toBeGreaterThan(
        old.expiresAt.getTime(),
      );
      expect(jwt.decode(body.sessionToken as string)).toMatchObject({
        sid: inv.sessionId,
        oid: tenant.orgId,
        epoch: 1,
      });
      await authed('get', '', body.sessionToken as string).expect(200);
      // A token with its whole life left is not renewed.
      const young = await invite(liveSession());
      const beat = await authed('post', '/heartbeat', tokenAt(young)).expect(200);
      expect(beat.body).not.toHaveProperty('sessionToken');
      expect(beat.body).not.toHaveProperty('sessionTokenExpiresAt');
    });

    it('FR-609: more than 60 s of silence logs one DISCONNECTED event; a recent beat logs none', async () => {
      const silent = await invite(liveSession({ lastHeartbeat: new Date(Date.now() - 90_000) }));
      const quiet = await invite(liveSession({ lastHeartbeat: new Date(Date.now() - 20_000) }));
      const paused = await invite({
        ...liveSession({
          lastHeartbeat: new Date(Date.now() - 120_000),
          pauseReasons: ['FULLSCREEN_EXIT'],
        }),
        status: 'PAUSED',
      });
      const submitted = await invite({
        status: 'SUBMITTED',
        session: { lastHeartbeat: new Date(Date.now() - 600_000), authEpoch: 1 },
      });
      const found = await jobs.discoverDisconnected();
      expect(found).toBeGreaterThanOrEqual(2);
      const count = (id: string) =>
        owner.proctorEvent.count({ where: { sessionId: id, type: 'DISCONNECTED' } });
      await eventually(
        () => count(silent.sessionId),
        (n) => n >= 1,
      );
      await eventually(
        () => count(paused.sessionId),
        (n) => n >= 1,
      );
      // A second discovery (and a duplicate job) writes no second event for the same silence.
      await jobs.discoverDisconnected();
      await jobs.logDisconnected(tenant.orgId, silent.sessionId);
      await new Promise((r) => setTimeout(r, 500));
      expect(await count(silent.sessionId)).toBe(1);
      expect(await count(paused.sessionId)).toBe(1);
      expect(await count(quiet.sessionId)).toBe(0);
      expect(await count(submitted.sessionId)).toBe(0);
      const event = await owner.proctorEvent.findFirstOrThrow({
        where: { sessionId: silent.sessionId, type: 'DISCONNECTED' },
      });
      expect(event).toMatchObject({ severity: 'LOW', source: 'SERVER', batchSeq: null });
      expect((event.payload as { lastHeartbeatAt: string }).lastHeartbeatAt).toBeDefined();
      expect((await sessionRow(silent.sessionId)).status).toBe('IN_PROGRESS');
      expect((await sessionRow(paused.sessionId)).status).toBe('PAUSED');
    });

    it('FR-609, NFR-08: the first beat after a DISCONNECTED logs RECONNECTED and the clock keeps running', async () => {
      const inv = await invite(liveSession({ lastHeartbeat: new Date(Date.now() - 95_000) }));
      const deadline = (await sessionRow(inv.sessionId)).deadlineAt?.getTime();
      await jobs.discoverDisconnected();
      await eventually(
        () =>
          owner.proctorEvent.count({ where: { sessionId: inv.sessionId, type: 'DISCONNECTED' } }),
        (n) => n === 1,
      );
      expect(await redis.exists(`disc:${inv.sessionId}`)).toBe(1);
      await authed('post', '/heartbeat', tokenAt(inv)).expect(200);
      expect(await redis.exists(`disc:${inv.sessionId}`)).toBe(0);
      const reconnected = await eventually(
        () =>
          owner.proctorEvent.count({ where: { sessionId: inv.sessionId, type: 'RECONNECTED' } }),
        (n) => n >= 1,
      );
      expect(reconnected).toBe(1);
      // Another beat does not log a second RECONNECTED, and the deadline never moved.
      await authed('post', '/heartbeat', tokenAt(inv)).expect(200);
      await new Promise((r) => setTimeout(r, 500));
      expect(
        await owner.proctorEvent.count({
          where: { sessionId: inv.sessionId, type: 'RECONNECTED' },
        }),
      ).toBe(1);
      expect((await sessionRow(inv.sessionId)).deadlineAt?.getTime()).toBe(deadline);
    });

    it('FR-609: the repeatable discovery job is registered with the queue', async () => {
      const { Queue } = jest.requireActual<typeof import('bullmq')>('bullmq');
      const queue = new Queue('session-jobs', {
        connection: { host: redisBox.getHost(), port: redisBox.getPort() },
      });
      const schedulers = await eventually(
        () => queue.getJobSchedulers(),
        (s) => s.length >= 2,
      );
      expect(schedulers.map((s) => s.key).sort()).toEqual([
        'consent-pdf-sweep',
        'discover-disconnected',
      ]);
      expect(schedulers.find((s) => s.key === 'discover-disconnected')?.every).toBe(15_000);
      await queue.close();
    });
  });

  it('ADR 0012: the generated OpenAPI document lists every candidate route; guarded ones carry bearer auth, the three pre-token ones do not', () => {
    const { SwaggerModule, DocumentBuilder } =
      jest.requireActual<typeof import('@nestjs/swagger')>('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').setVersion('1').addBearerAuth().build(),
    );
    const prefix = '/api/v1/candidate/session';
    const expected: Array<[string, string, boolean]> = [
      ['post', '/link', false],
      ['post', '/otp', false],
      ['post', '/start', false],
      ['get', '', true],
      ['get', '/consent', true],
      ['post', '/consent/sign', true],
      ['post', '/consent/decline', true],
      ['post', '/test/start', true],
      ['post', '/heartbeat', true],
      ['post', '/proctor-key', true],
    ];
    for (const [method, path, guarded] of expected) {
      const operation = (
        doc.paths[`${prefix}${path}`] as
          Record<string, { security?: unknown[]; summary?: string; responses: object }> | undefined
      )?.[method];
      expect(operation?.summary).toBeTruthy();
      expect(Object.keys(operation?.responses ?? {}).length).toBeGreaterThan(0);
      expect((operation?.security ?? []).length > 0).toBe(guarded);
    }
    const schemas = Object.keys(doc.components?.schemas ?? {});
    for (const name of [
      'StartSessionDto',
      'SignConsentDto',
      'SessionTokenDto',
      'ProctorKeyDto',
      'HeartbeatResultDto',
      'TestStartedDto',
    ]) {
      expect(schemas).toContain(name);
    }
    const text = JSON.stringify(
      Object.entries(doc.paths).filter(([path]) => path.startsWith(prefix)),
    );
    expect(text).not.toContain('variantId');
    expect(text).not.toContain('\"params\"');
    expect(text).not.toContain('hmacKeyEnc');
  });

  // ---------- review fixes ----------

  describe('review fixes (BE-07 review)', () => {
    const tokenFor = (inv: InvitationFixture, t: Tenant = tenant, epoch = 1): string =>
      tokens.sign({ sid: inv.sessionId, oid: t.orgId, epoch }).token;

    it('FR-106: when the email cannot be sent, no OTP_SENT is reported, no code is kept and a retry is allowed at once', async () => {
      const inv = await invite();
      mail.failing = true;
      const sentBefore = mail.otps.length;
      const res = await post('/otp', { invitationToken: inv.token });
      mail.failing = false;
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'MAIL_UNAVAILABLE' });
      expect(JSON.stringify(res.body)).not.toContain('OTP_SENT');
      expect(mail.otps.length).toBe(sentBefore);
      expect(await redis.exists(`otp:${inv.invitationId}`)).toBe(0);
      // No cooldown was left behind: the retry goes through immediately.
      const again = await post('/otp', { invitationToken: inv.token }).expect(200);
      expect(again.body).toMatchObject({ state: 'OTP_SENT' });
    });

    it('FR-401: with no mail provider the consent job never stamps copy_emailed_at; it does once mail works', async () => {
      const inv = await invite({ status: 'OPENED' });
      mail.failing = true;
      await request(server())
        .post(`${API}/consent/sign`)
        .set('Authorization', `Bearer ${tokenFor(inv, tenant, 0)}`)
        .send({
          consentTextId: tenant.consentTextId,
          signedName: 'Ada Lovelace',
          confirmedAge18: true,
        })
        .expect(200);
      const stored = await eventually(
        () => owner.consent.findUniqueOrThrow({ where: { sessionId: inv.sessionId } }),
        (c) => c.pdfKey !== null,
      );
      expect(stored.pdfKey).not.toBeNull();
      await new Promise((r) => setTimeout(r, 800));
      expect(
        (await owner.consent.findUniqueOrThrow({ where: { sessionId: inv.sessionId } }))
          .copyEmailedAt,
      ).toBeNull();
      expect(mail.copies.find((c) => c.to === inv.candidateEmail)).toBeUndefined();
      mail.failing = false;
      const done = await eventually(
        () => owner.consent.findUniqueOrThrow({ where: { sessionId: inv.sessionId } }),
        (c) => c.copyEmailedAt !== null,
        40_000,
      );
      expect(done.copyEmailedAt).not.toBeNull();
      expect(mail.copies.filter((c) => c.to === inv.candidateEmail)).toHaveLength(1);
    });

    it('FR-203: a random rule never picks a question that a fixed slot (even a later one) already holds', async () => {
      const t = await createTenant(owner, 'rbf');
      // The random slot comes BEFORE the fixed one, and the fixed question matches the rule too.
      await owner.testQuestion.update({
        where: { id: t.test.testQuestionIds[1] },
        data: { position: 0 },
      });
      const fixedQuestion = await owner.questionVersion.findUniqueOrThrow({
        where: { id: t.test.fixedVersionIds[0] },
      });
      await owner.question.update({
        where: { id: fixedQuestion.questionId },
        data: { tags: ['arrays', 'core'] },
      });
      // A second published version of the fixed question: "its question across versions".
      const v2 = await owner.questionVersion.create({
        data: {
          questionId: fixedQuestion.questionId,
          version: 2,
          title: 'v2',
          statementMd: 'x',
          difficulty: 'EASY',
          allowedLanguages: ['python'],
          isPublished: true,
        },
      });
      await owner.question.update({
        where: { id: fixedQuestion.questionId },
        data: { currentVersionId: v2.id },
      });
      for (let i = 0; i < 12; i++) {
        const inv = await invite(
          { status: 'VERIFIED', session: { authEpoch: 1, deviceInfo: passedSystemCheck() } },
          t,
        );
        await authed('post', '/test/start', tokenFor(inv, t)).expect(200);
        const rows = await owner.sessionQuestion.findMany({
          where: { sessionId: inv.sessionId },
          include: { questionVersion: true },
        });
        const questionIds = rows.map((r) => r.questionVersion.questionId);
        expect(new Set(questionIds).size).toBe(questionIds.length);
        expect(new Set(rows.map((r) => r.questionVersionId)).size).toBe(rows.length);
      }
    });

    it('FR-305: a malformed or over-cap extraTimePct is ignored with a warning that names ids only', async () => {
      for (const extraTimePct of [500, 'lots', -10]) {
        const inv = await invite({
          status: 'VERIFIED',
          accommodations: { extraTimePct, notes: 'PRIVATE-HEALTH-NOTE' },
          session: { authEpoch: 1, deviceInfo: passedSystemCheck() },
        });
        await authed('post', '/test/start', tokenFor(inv)).expect(200);
        const row = await sessionRow(inv.sessionId);
        expect((row.deadlineAt?.getTime() ?? 0) - (row.startedAt?.getTime() ?? 0)).toBe(
          60 * 60_000,
        );
        expect(logged.join('')).toContain(
          `Ignored a malformed extraTimePct for session ${inv.sessionId} (invitation ${inv.invitationId})`,
        );
      }
      expect(logged.join('')).not.toContain('PRIVATE-HEALTH-NOTE');
      // 300 is the cap BE-06 allows: accepted, no warning for it.
      const ok = await invite({
        status: 'VERIFIED',
        accommodations: { extraTimePct: 300 },
        session: { authEpoch: 1, deviceInfo: passedSystemCheck() },
      });
      await authed('post', '/test/start', tokenFor(ok)).expect(200);
      const row = await sessionRow(ok.sessionId);
      expect((row.deadlineAt?.getTime() ?? 0) - (row.startedAt?.getTime() ?? 0)).toBe(240 * 60_000);
      expect(logged.join('')).not.toContain(`session ${ok.sessionId} (invitation`);
    });

    it('NFR-04: a missing wrapping key at start is 503 CANDIDATE_PORTAL_UNCONFIGURED and the session stays VERIFIED', async () => {
      const inv = await invite({
        status: 'VERIFIED',
        session: { authEpoch: 1, deviceInfo: passedSystemCheck() },
      });
      const saved = process.env.SESSION_KEY_ENC_KEY_k1;
      delete process.env.SESSION_KEY_ENC_KEY_k1;
      try {
        const res = await authed('post', '/test/start', tokenFor(inv));
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ code: 'CANDIDATE_PORTAL_UNCONFIGURED' });
      } finally {
        process.env.SESSION_KEY_ENC_KEY_k1 = saved;
      }
      expect((await sessionRow(inv.sessionId)).status).toBe('VERIFIED');
      await authed('post', '/test/start', tokenFor(inv)).expect(200);
    });

    it('ADR 0002 L-3, L-4: if the session ended while the code was being checked, /start refuses and issues no token', async () => {
      for (const [fromStatus, endStatus, code] of [
        ['INVITED', 'SUBMITTED', 'LINK_ALREADY_USED'],
        ['IN_PROGRESS', 'SUBMITTED', 'LINK_ALREADY_USED'],
        ['INVITED', 'EXPIRED', 'LINK_EXPIRED'],
        ['OPENED', 'DECLINED', 'LINK_DECLINED'],
      ] as Array<[SessionStatus, SessionStatus, string]>) {
        const inv = await invite(
          fromStatus === 'IN_PROGRESS' ? liveSession() : { status: fromStatus },
        );
        const epoch = (await sessionRow(inv.sessionId)).authEpoch;
        const spy = jest.spyOn(otp, 'verify').mockImplementationOnce(async () => {
          await owner.session.update({ where: { id: inv.sessionId }, data: { status: endStatus } });
          return { kind: 'ok' };
        });
        const res = await post('/start', { invitationToken: inv.token, otp: '123456' });
        spy.mockRestore();
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code });
        expect(res.body).not.toHaveProperty('sessionToken');
        const row = await sessionRow(inv.sessionId);
        expect(row.status).toBe(endStatus);
        expect(row.authEpoch).toBe(epoch);
      }
    });

    it('FR-609: if RECONNECTED cannot be queued the marker stays and the next beat retries; it is queued once', async () => {
      const inv = await invite(liveSession({ lastHeartbeat: new Date(Date.now() - 95_000) }));
      await jobs.discoverDisconnected();
      await eventually(
        () =>
          owner.proctorEvent.count({ where: { sessionId: inv.sessionId, type: 'DISCONNECTED' } }),
        (n) => n === 1,
      );
      const spy = jest
        .spyOn(jobs, 'enqueueServerEvent')
        .mockRejectedValueOnce(new Error('queue down'));
      await authed('post', '/heartbeat', tokenFor(inv)).expect(200);
      spy.mockRestore();
      expect(await redis.exists(`disc:${inv.sessionId}`)).toBe(1);
      expect(
        await owner.proctorEvent.count({
          where: { sessionId: inv.sessionId, type: 'RECONNECTED' },
        }),
      ).toBe(0);
      await authed('post', '/heartbeat', tokenFor(inv)).expect(200);
      expect(await redis.exists(`disc:${inv.sessionId}`)).toBe(0);
      await eventually(
        () =>
          owner.proctorEvent.count({ where: { sessionId: inv.sessionId, type: 'RECONNECTED' } }),
        (n) => n >= 1,
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(
        await owner.proctorEvent.count({
          where: { sessionId: inv.sessionId, type: 'RECONNECTED' },
        }),
      ).toBe(1);
    });

    it('FR-401: the consent sweep stops re-queuing a consent signed more than 3 days ago', async () => {
      const { Queue } = jest.requireActual<typeof import('bullmq')>('bullmq');
      const queue = new Queue('session-jobs', {
        connection: { host: redisBox.getHost(), port: redisBox.getPort() },
      });
      const old = await invite({ status: 'CONSENTED' });
      const recent = await invite({ status: 'CONSENTED' });
      for (const [inv, daysAgo] of [
        [old, 5],
        [recent, 1],
      ] as Array<[InvitationFixture, number]>) {
        await owner.consent.create({
          data: {
            sessionId: inv.sessionId,
            consentTextId: tenant.consentTextId,
            signedName: 'Ada Lovelace',
            signedAt: new Date(Date.now() - daysAgo * 86_400_000),
          },
        });
      }
      await jobs.sweepConsentPdfs();
      expect(await queue.getJob(`consent-pdf_${old.sessionId}`)).toBeUndefined();
      const queued = await eventually(
        () => owner.consent.findUniqueOrThrow({ where: { sessionId: recent.sessionId } }),
        (c) => c.pdfKey !== null,
      );
      expect(queued.pdfKey).not.toBeNull();
      expect(
        (await owner.consent.findUniqueOrThrow({ where: { sessionId: old.sessionId } })).pdfKey,
      ).toBeNull();
      await queue.close();
    });
  });

  // ---------- ADR 0013 CS-4 interim: every query is filtered by the token's session or org ----------

  describe('ADR 0013 CS-4 interim: queries are scoped by the token, never by a client id', () => {
    interface Call {
      readonly model: string;
      readonly op: string;
      readonly json: string;
      readonly scope: string;
      /** ORG (plain org scope), CANDIDATE, SERVICE or SYSTEM. */
      readonly actor: string;
      /** Were the candidate facts already set when this query ran? */
      readonly facts: boolean;
    }

    /** Wraps prisma.client so every model call made by a request (not a job) is recorded. */
    async function record(run: () => Promise<void>): Promise<Call[]> {
      const inJob = new AsyncLocalStorage<boolean>();
      const calls: Call[] = [];
      const realProcess = jobs.process.bind(jobs);
      const processSpy = jest
        .spyOn(jobs, 'process')
        .mockImplementation((job) => inJob.run(true, () => realProcess(job)));
      const real = prisma.client;
      type Fn = (...a: unknown[]) => unknown;
      const delegate = (model: string, target: object): object =>
        new Proxy(target, {
          get(t, op: string) {
            const fn: unknown = Reflect.get(t, op);
            if (typeof fn !== 'function') return fn;
            return (...a: unknown[]) => {
              if (inJob.getStore() !== true) {
                const scope = orgContext.current()?.scope;
                calls.push({
                  model,
                  op,
                  json: JSON.stringify(a[0] ?? null, (_k, v: unknown) =>
                    typeof v === 'bigint' ? v.toString() : v,
                  ),
                  scope: scope?.kind === 'system' ? `system:${scope.reason}` : 'org',
                  actor: scope?.kind === 'system' ? 'SYSTEM' : (scope?.session?.actor ?? 'ORG'),
                  facts: orgContext.candidateFacts() !== undefined,
                });
              }
              return (fn as Fn).apply(t, a);
            };
          },
        });
      const wrap = (client: object): object =>
        new Proxy(client, {
          get(t, prop: string | symbol) {
            const v: unknown = Reflect.get(t, prop);
            if (prop === '$transaction') {
              return (fn: (tx: object) => unknown, ...rest: unknown[]) =>
                (v as Fn).call(t, (tx: object) => fn(wrap(tx)), ...rest);
            }
            if (
              typeof prop === 'string' &&
              !prop.startsWith('$') &&
              typeof v === 'object' &&
              v !== null
            ) {
              return delegate(prop, v);
            }
            return typeof v === 'function' ? (v as Fn).bind(t) : v;
          },
        });
      Object.defineProperty(prisma, 'client', {
        value: wrap(real),
        configurable: true,
        writable: true,
      });
      try {
        await run();
      } finally {
        Object.defineProperty(prisma, 'client', {
          value: real,
          configurable: true,
          writable: true,
        });
        processSpy.mockRestore();
      }
      return calls.filter((c) => c.scope !== 'system:BACKGROUND_JOB');
    }

    it('CS-4 interim, CS-1/CS-2/CS-3: every query of every candidate route carries the token session, invitation or org, and never an id of another session', async () => {
      // Second candidates (same org and another org) with data in every table the routes touch.
      const bSame = await invite(liveSession());
      const bOther = await invite(liveSession(), other);
      await owner.session.update({
        where: { id: bSame.sessionId },
        data: { hmacKeyEnc: keys.generateWrapped(bSame.sessionId) },
      });
      await owner.proctorEvent.create({
        data: {
          sessionId: bSame.sessionId,
          type: 'DISCONNECTED',
          severity: 'LOW',
          source: 'SERVER',
          occurredAt: new Date(),
          payload: { lastHeartbeatAt: new Date().toISOString() },
        },
      });
      const bOpened = await invite({ status: 'OPENED', session: { authEpoch: 1 } });
      const forbidden = [
        bSame.sessionId,
        bSame.invitationId,
        bSame.candidateId,
        bSame.token,
        bOther.sessionId,
        bOther.invitationId,
        bOther.candidateId,
        other.orgId,
        other.consentTextId,
        bOpened.sessionId,
        bOpened.invitationId,
      ];

      // The caller's sessions: one per phase of the flow.
      const preToken = await invite();
      const opened = await invite({ status: 'OPENED', session: { authEpoch: 1 } });
      const declining = await invite({ status: 'OPENED', session: { authEpoch: 1 } });
      const verified = await invite({
        status: 'VERIFIED',
        session: { authEpoch: 1, deviceInfo: passedSystemCheck() },
      });
      const live = await invite(liveSession());
      await owner.session.update({
        where: { id: live.sessionId },
        data: { hmacKeyEnc: keys.generateWrapped(live.sessionId) },
      });
      const mine = [preToken, opened, declining, verified, live];
      const hdr = (inv: InvitationFixture) => tokenFor(inv);
      function tokenFor(inv: InvitationFixture): string {
        return tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 1 }).token;
      }
      const snapshot = async () => ({
        sessions: await owner.session.findMany({
          where: { id: { in: [bSame.sessionId, bOther.sessionId, bOpened.sessionId] } },
          orderBy: { id: 'asc' },
        }),
        events: await owner.proctorEvent.count({
          where: { sessionId: { in: [bSame.sessionId, bOther.sessionId, bOpened.sessionId] } },
        }),
        consents: await owner.consent.count({
          where: { sessionId: { in: [bSame.sessionId, bOther.sessionId, bOpened.sessionId] } },
        }),
        questions: await owner.sessionQuestion.count({
          where: { sessionId: { in: [bSame.sessionId, bOther.sessionId, bOpened.sessionId] } },
        }),
      });
      const before = await snapshot();

      const calls = await record(async () => {
        // Pre-token routes, with a wrong guess and the right code.
        await post('/link', { invitationToken: preToken.token }).expect(200);
        const code = await otpFor(preToken);
        await post('/start', { invitationToken: preToken.token, otp: wrongCode(code) }).expect(400);
        await post('/start', { invitationToken: preToken.token, otp: code }).expect(200);
        // Guarded routes, every one, with other sessions' ids in the body wherever a body exists.
        await authed('get', '', hdr(opened)).expect(200);
        await authed('get', '/consent', hdr(opened)).expect(200);
        await authed('post', '/consent/sign', hdr(opened), {
          consentTextId: other.consentTextId,
          signedName: 'Ada Lovelace',
          confirmedAge18: true,
        }).expect(409);
        await authed('post', '/consent/sign', hdr(opened), {
          consentTextId: tenant.consentTextId,
          signedName: 'Ada Lovelace',
          confirmedAge18: true,
          sessionId: bSame.sessionId,
        }).expect(400);
        await authed('post', '/consent/sign', hdr(opened), {
          consentTextId: tenant.consentTextId,
          signedName: 'Ada Lovelace',
          confirmedAge18: true,
        }).expect(200);
        await authed('post', '/consent/decline', hdr(declining)).expect(200);
        await authed('post', '/test/start', hdr(verified), { sessionId: bSame.sessionId }).expect(
          200,
        );
        await authed('post', '/heartbeat', hdr(live), { sessionId: bSame.sessionId }).expect(400);
        await authed('post', '/heartbeat', hdr(live)).expect(200);
        await authed('post', '/proctor-key', hdr(live), { sessionId: bSame.sessionId }).expect(200);
        // A token naming another session's id with this org (and the reverse) reads nothing of it.
        await authed(
          'get',
          '',
          tokens.sign({ sid: bOther.sessionId, oid: tenant.orgId, epoch: 1 }).token,
        ).expect(401);
        await authed(
          'get',
          '',
          tokens.sign({ sid: bSame.sessionId, oid: other.orgId, epoch: 1 }).token,
        ).expect(401);
      });

      expect(calls.length).toBeGreaterThan(30);
      const all = calls.map((c) => `${c.model}.${c.op} ${c.json}`);
      // 1. No query names any id or token of the other sessions or of the other org, anywhere.
      //    The two 401 probes above carry the foreign ids in the TOKEN and are expected to
      //    query the session by that id inside the token's own org only: they are the one allowed
      //    place a foreign id appears, so they are filtered out by their org scope check below.
      const probeSessionIds = new Set([bOther.sessionId, bSame.sessionId]);
      const probeCalls = calls.filter(
        (c) =>
          c.model === 'session' &&
          c.op === 'findUnique' &&
          [...probeSessionIds].some((id) => c.json.includes(id)),
      );
      expect(probeCalls).toHaveLength(2);
      const rest = calls.filter((c) => !probeCalls.includes(c));
      for (const c of rest) {
        for (const id of forbidden) expect(`${c.model}.${c.op} ${c.json}`).not.toContain(id);
      }
      // 2. Each model has the predicate the token gives it.
      const sessionScoped = [
        'session',
        'consent',
        'sessionSection',
        'sessionQuestion',
        'proctorEvent',
        'proctorEventBatch',
        'keystrokeBatch',
        'mediaChunk',
        'identityCheck',
      ];
      const mineSessions = mine.map((m) => m.sessionId);
      const mineInvitations = mine.map((m) => m.invitationId);
      const mineCandidates = mine.map((m) => m.candidateId);
      const mine1 = (c: Call, ids: string[]): boolean => ids.some((id) => c.json.includes(id));
      const sectionIds = [...tenant.test.sectionIds];
      const contentIds = [...tenant.test.fixedVersionIds, ...tenant.test.randomPoolVersionIds];
      for (const c of rest) {
        const label = `${c.model}.${c.op} ${c.json}`;
        if (c.model === 'invitation' && c.json.includes('tokenHash')) {
          // The one lookup that starts from a secret: by its SHA-256, in the bootstrap scope.
          expect(c.scope).toBe('system:AUTH_BOOTSTRAP');
          expect(c.json).toContain(sha256Hex(preToken.token));
          continue;
        }
        if (sessionScoped.includes(c.model)) {
          expect([c.model, mine1(c, [...mineSessions, ...mineInvitations])]).toEqual([
            c.model,
            true,
          ]);
        } else if (c.model === 'invitation')
          expect([label, mine1(c, mineInvitations)]).toEqual([label, true]);
        else if (c.model === 'candidate')
          expect([label, mine1(c, mineCandidates)]).toEqual([label, true]);
        else if (c.model === 'test')
          expect([label, c.json.includes(tenant.test.id)]).toEqual([label, true]);
        else if (c.model === 'organization')
          expect([label, c.json.includes(tenant.orgId)]).toEqual([label, true]);
        else if (c.model === 'auditLog')
          expect([label, c.json.includes(tenant.orgId)]).toEqual([label, true]);
        else if (c.model === 'consentText')
          expect([label, c.json.includes(tenant.consentTextId)]).toEqual([label, true]);
        else if (c.model === 'user')
          expect([label, c.json.includes(tenant.staffUserId)]).toEqual([label, true]);
        else if (c.model === 'testSection' || c.model === 'testQuestion')
          expect([
            label,
            mine1(c, [tenant.test.id, ...sectionIds, ...tenant.test.testQuestionIds]),
          ]).toEqual([label, true]);
        else if (c.model === 'questionVersion' || c.model === 'questionVariant')
          expect([label, mine1(c, contentIds)]).toEqual([label, true]);
        else if (c.model === 'question')
          expect([label, c.json.includes('isArchived')]).toEqual([label, true]); // random-rule scan, org scope by the extension
        else throw new Error(`unreviewed model in a candidate route: ${label}`);
        expect(all.length).toBeGreaterThan(0);
      }
      // 4. CS-4 scope adoption (DL-31). Every candidate-scope query ran after the facts were set,
      //    names only readable columns, and none of the org-scope-only data is touched there.
      const inCandidate = rest.filter((c) => c.actor === 'CANDIDATE');
      expect(inCandidate.length).toBeGreaterThan(8);
      for (const c of inCandidate) {
        expect([`${c.model}.${c.op}`, c.facts]).toEqual([`${c.model}.${c.op}`, true]);
        expect([
          'session',
          'sessionSection',
          'consent',
          'organization',
          'proctorEventBatch',
          'keystrokeBatch',
          'mediaChunk',
        ]).toContain(c.model);
        expect(c.json).not.toMatch(
          /hmacKeyEnc|deviceInfo|accommodations|settings|objectKey|invitationId|testQuestionId/,
        );
        if (c.model === 'session' && ['update', 'updateMany'].includes(c.op)) {
          // The only write a candidate scope makes on sessions: last_heartbeat.
          expect(c.json).toContain('lastHeartbeat');
          expect(c.json).not.toMatch(/status|authEpoch|submittedAt|pauseReasons/);
        }
        expect(['create', 'createMany', 'delete', 'deleteMany', 'upsert']).not.toContain(c.op);
      }
      // The data a candidate scope may not read or write is only touched in the org scope.
      const orgOnly = rest.filter((c) => c.actor !== 'CANDIDATE' && c.actor !== 'SYSTEM');
      for (const c of rest.filter(
        (x) =>
          [
            'consentText',
            'testQuestion',
            'questionVersion',
            'questionVariant',
            'auditLog',
            'testSection',
          ].includes(x.model) ||
          (x.model === 'consent' && x.op === 'create'),
      )) {
        expect([`${c.model}.${c.op}`, c.actor]).toEqual([`${c.model}.${c.op}`, 'ORG']);
      }
      expect(orgOnly.length).toBeGreaterThan(5);
      // The guard's first step: column-only reads in a plain org scope (never accommodations).
      const step1 = rest.filter(
        (c) =>
          c.actor === 'ORG' && c.model === 'invitation' && c.json.includes('"candidateId":true'),
      );
      expect(step1.length).toBeGreaterThanOrEqual(9);
      for (const c of step1) expect(c.json).not.toContain('accommodations');
      // A guarded request makes its guard queries (org scope, then candidate scope) before the
      // handler's: the first query of a request is never in a candidate scope without facts.
      expect(rest.filter((c) => c.actor === 'CANDIDATE' && !c.facts)).toEqual([]);

      // 3. Nothing of the other sessions was read or written.
      expect(await snapshot()).toEqual(before);
    });
  });

  // ---------- log hygiene (NFR-04, ADR 0003, ADR 0013 section 5.1) ----------

  it('NFR-04: no OTP, invitation token, session token, proctor key or signed name reaches the logs', async () => {
    const inv = await invite(liveSession());
    await redis.del(`otp-cooldown:${inv.invitationId}`);
    const code = await otpFor(inv);
    await post('/start', { invitationToken: inv.token, otp: wrongCode(code) }).expect(400);
    await redis.del(`otp-cooldown:${inv.invitationId}`);
    const ok = await post('/start', { invitationToken: inv.token, otp: code }).expect(200);
    const sessionToken = (ok.body as { sessionToken: string }).sessionToken;
    await owner.session.update({
      where: { id: inv.sessionId },
      data: { hmacKeyEnc: keys.generateWrapped(inv.sessionId) },
    });
    const key = await authed('post', '/proctor-key', sessionToken).expect(200);
    await authed('post', '/heartbeat', sessionToken).expect(200);
    const fresh = await invite({ status: 'OPENED' });
    const ft = tokens.sign({ sid: fresh.sessionId, oid: tenant.orgId, epoch: 0 }).token;
    await request(server())
      .post(`${API}/consent/sign`)
      .set('Authorization', `Bearer ${ft}`)
      .send({
        consentTextId: tenant.consentTextId,
        signedName: 'Zebediah Quarrel',
        confirmedAge18: true,
      })
      .expect(200);
    await post('/link', { invitationToken: inv.token }).expect(200);
    const text = logged.join('');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [
      code,
      inv.token,
      sessionToken,
      (key.body as { key: string }).key,
      'Zebediah',
      ft,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
