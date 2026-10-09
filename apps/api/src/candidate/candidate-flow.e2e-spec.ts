// The candidate API path end to end over HTTP (the internal pilot run, D-84): consent, system check,
// verify-session, test start, render, draft, run (local stub), submit, section finish, finish,
// heartbeat and the pause write gate. Real Postgres, real Redis, real queues; only the mail port,
// object storage and the Judge0 client (the local stub, as in development) are fakes.
// FR-106, FR-301, FR-401, FR-402, FR-502, FR-504..FR-506, FR-609, DL-58, TC-024, TC-040.
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { CandidateTokenService } from './candidate-token.service';
import { CandidateMailPort } from './candidate-mail.port';
import type { ConsentCopyMail, OtpLockoutMail, OtpMail } from './candidate-mail.port';
import { createInvitation, createTenant } from './testing/fixtures';
import type { Tenant } from './testing/fixtures';
import { InMemoryObjectStorage } from './testing/in-memory-storage';

const API = '/api/v1/candidate';

class FakeMail extends CandidateMailPort {
  readonly copies: Array<ConsentCopyMail & { to: string }> = [];
  sendOtp(_to: string, _mail: OtpMail): Promise<void> {
    return Promise.resolve();
  }
  sendOtpLockout(_to: string, _mail: OtpLockoutMail): Promise<void> {
    return Promise.resolve();
  }
  sendConsentCopy(to: string, mail: ConsentCopyMail): Promise<void> {
    this.copies.push({ ...mail, to });
    return Promise.resolve();
  }
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('Candidate flow end to end (D-84; FR-106, FR-301, FR-401, FR-402, FR-502, FR-504..FR-506, FR-609, DL-58)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let redis: Redis;
  let app: INestApplication<App>;
  let tokens: CandidateTokenService;
  let tenant: Tenant;
  const mail = new FakeMail();
  const storage = new InMemoryObjectStorage();
  let stdout: jest.SpyInstance;

  async function buildApp(): Promise<INestApplication<App>> {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      LOG_LEVEL: 'error',
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: db.appUserUrl,
      REDIS_URL: redisBox.getConnectionUrl(),
      HEALTH_TIMEOUT_MS: '1500',
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64'),
      COOKIE_SECRET: randomBytes(32).toString('base64'),
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      JWT_CANDIDATE_SECRET: randomBytes(32).toString('base64'),
      OTP_PEPPER: randomBytes(32).toString('base64'),
      QUESTION_OPTION_ID_SECRET: randomBytes(32).toString('base64'),
      SESSION_KEY_ENC_ACTIVE_KID: 'k1',
      SESSION_KEY_ENC_KEY_k1: randomBytes(32).toString('base64'),
      CANDIDATE_TOKEN_TTL_SECONDS: '900',
      THROTTLE_DEFAULT_LIMIT: '100000',
      THROTTLE_AUTH_LIMIT: '100000',
      THROTTLE_CANDIDATE_LIMIT: '100000',
      REQUIRE_LEGAL_APPROVED_CONSENT: 'false',
    });
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const mailToken =
      jest.requireActual<typeof import('./candidate-mail.port')>('./candidate-mail.port');
    const storageToken =
      jest.requireActual<typeof import('./object-storage.port')>('./object-storage.port');
    const judge =
      jest.requireActual<typeof import('../judge0/judge0.types')>('../judge0/judge0.types');
    const { StubJudge0Client } = jest.requireActual<typeof import('../judge0/stub-judge0.client')>(
      '../judge0/stub-judge0.client',
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(mailToken.CandidateMailPort)
      .useValue(mail)
      .overrideProvider(storageToken.ObjectStoragePort)
      .useValue(storage)
      .overrideProvider(judge.JUDGE0_CLIENT)
      .useValue(new StubJudge0Client())
      .compile();
    const created = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(created);
    await created.init();
    return created;
  }

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    [db, redisBox] = await Promise.all([
      startMigratedDatabase(),
      new RedisContainer('redis:8.8').start(),
    ]);
    owner = createPrismaClient(db.ownerUrl);
    redis = new Redis(redisBox.getConnectionUrl());
    tenant = await createTenant(owner, 'flow');
    // The fixture questions carry no test cases: give every version one sample so Run has work.
    for (const questionVersionId of [
      ...tenant.test.fixedVersionIds,
      ...tenant.test.randomPoolVersionIds,
    ]) {
      await owner.testCase.create({
        data: { questionVersionId, input: '1', expectedOutput: '1', isHidden: false, position: 0 },
      });
    }
    app = await buildApp();
    const { CandidateTokenService: T } = jest.requireActual<
      typeof import('./candidate-token.service')
    >('./candidate-token.service');
    tokens = app.get(T);
  }, 240_000);

  afterAll(async () => {
    stdout.mockRestore();
    await app?.close();
    redis?.disconnect();
    await owner?.$disconnect();
    await redisBox?.stop();
    await db?.stop();
  });

  const call = (method: 'get' | 'post' | 'put', path: string, token: string, body?: object) => {
    const req = request(app.getHttpServer())
      [method](`${API}${path}`)
      .set('Authorization', `Bearer ${token}`);
    return method === 'get' ? req : req.send(body ?? {});
  };
  const sessionRow = (id: string) => owner.session.findUniqueOrThrow({ where: { id } });

  it('a candidate goes from OPENED to SUBMITTED through every step of the API, with the local stub', async () => {
    const inv = await createInvitation(owner, tenant, {
      status: 'OPENED',
      session: { authEpoch: 1 },
    });
    const token = tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 1 }).token;

    // The state before anything: OPENED, a server clock.
    const state0 = await call('get', '/session', token).expect(200);
    expect(state0.body).toMatchObject({ status: 'OPENED' });

    // Consent: read, accommodations projection is not needed here; sign with the typed name.
    const consent = await call('get', '/session/consent', token).expect(200);
    const signed = await call('post', '/session/consent/sign', token, {
      consentTextId: (consent.body as { consentTextId: string }).consentTextId,
      signedName: 'Ada Lovelace',
      confirmedAge18: true,
    }).expect(200);
    expect(signed.body).toMatchObject({ status: 'CONSENTED' });

    // The evidence the verify-session job re-checks: an identity check that finished and a room scan.
    await owner.identityCheck.create({ data: { sessionId: inv.sessionId, status: 'PASSED' } });
    await owner.mediaChunk.create({
      data: {
        sessionId: inv.sessionId,
        stream: 'ROOM_SCAN',
        seq: 0,
        startedAt: new Date(),
        durationMs: 5000,
        sizeBytes: 1000n,
        uploadedAt: new Date(),
        objectKey: 'media/ROOM_SCAN/x',
      },
    });

    // System check: passes and queues verify-session, which moves CONSENTED to VERIFIED.
    const check = await call('post', '/session/system-check', token, {
      browser: { brand: 'Google Chrome', majorVersion: 124 },
      devices: { camera: true, microphone: true, screenShare: 'MONITOR' },
      findings: [],
      capabilities: [{ id: 'multi-screen', status: 'SUPPORTED' }],
    }).expect(200);
    expect(check.body).toEqual({ passed: true, blocking: [] });
    const verified = await eventually(
      () => sessionRow(inv.sessionId),
      (r) => r.status === 'VERIFIED',
    );
    expect(verified.status).toBe('VERIFIED');

    // Start: the layout comes back and a reload (GET) gives the same outline.
    const started = await call('post', '/session/test/start', token).expect(200);
    const layout = started.body as {
      status: string;
      sections: Array<{ position: number; questions: Array<{ sessionQuestionId: string }> }>;
    };
    expect(layout.status).toBe('IN_PROGRESS');
    const reload = await call('get', '/session/test', token).expect(200);
    expect((reload.body as typeof layout).sections.map((s) => s.questions.length)).toEqual(
      layout.sections.map((s) => s.questions.length),
    );

    // The open section's questions render: statement, languages, never hidden or reference content.
    const open = layout.sections[0];
    expect(open).toBeDefined();
    for (const q of open?.questions ?? []) {
      const view = await call('get', `/questions/${q.sessionQuestionId}`, token).expect(200);
      expect(view.body).toMatchObject({ sessionQuestionId: q.sessionQuestionId });
      expect(JSON.stringify(view.body)).not.toMatch(/REFERENCE-SOLUTION-MARKER|correctOptionIds/);
    }
    // A question of a section that has not opened is refused.
    const later = layout.sections[1]?.questions[0];
    if (later !== undefined) {
      await call('get', `/questions/${later.sessionQuestionId}`, token).expect(409);
    }

    // Draft, run (the local stub: nothing runs and it says so), submit.
    const first = open?.questions[0]?.sessionQuestionId as string;
    await call('put', `/answers/${first}/draft`, token, {
      code: 'print(42)',
      language: 'python',
    }).expect(200);
    const run = await call('post', `/answers/${first}/run`, token, {
      code: 'print(42)',
      language: 'python',
    }).expect(200);
    expect(JSON.stringify(run.body)).toMatch(/stub/i);
    expect(JSON.stringify(run.body)).not.toMatch(/"passed":\s*true|"status":\s*"passed"/);
    await call('post', `/answers/${first}/submit`, token, {
      code: 'print(42)',
      language: 'python',
    }).expect(200);

    // Heartbeat while running.
    await call('post', '/session/heartbeat', token, {}).expect(200);

    // Finish the first section; the next one opens when the job runs.
    await call('post', '/session/section/finish', token, { position: 1 }).expect(202);
    await eventually(
      async () =>
        (await call('get', '/session/test', token)).body as {
          sections: Array<{ position: number; startedAt: string | null }>;
        },
      (b) => b.sections.some((s) => s.position === 2 && s.startedAt !== null),
    );

    // The pause write gate: a proctor pause refuses a write with 409 and reads still work.
    await owner.session.update({
      where: { id: inv.sessionId },
      data: { status: 'PAUSED', pauseReasons: ['PROCTOR'], proctorPausedAt: new Date() },
    });
    await call('put', `/answers/${first}/draft`, token, {
      code: 'print(1)',
      language: 'python',
    }).expect(409);
    await call('get', '/session/test', token).expect(200);
    await owner.session.update({
      where: { id: inv.sessionId },
      data: { status: 'IN_PROGRESS', pauseReasons: [], proctorPausedAt: null },
    });

    // Finish: SUBMITTED, idempotent, and the candidate-visible status is SUBMITTED.
    const done = await call('post', '/session/finish', token).expect(200);
    expect(done.body).toMatchObject({ status: 'SUBMITTED' });
    await call('post', '/session/finish', token).expect(200);
    const end = await call('get', '/session', token).expect(200);
    expect(end.body).toMatchObject({ status: 'SUBMITTED' });
    expect((await sessionRow(inv.sessionId)).submittedAt).not.toBeNull();
  }, 180_000);
});
