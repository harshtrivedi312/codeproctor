// Practice question over HTTP against real Postgres 16 and Redis (Testcontainers). FR-406.
import { INestApplication } from '@nestjs/common';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CandidateMailPort } from '../candidate/candidate-mail.port';
import type { CandidateTokenService } from '../candidate/candidate-token.service';
import { createInvitation, createTenant } from '../candidate/testing/fixtures';
import type { Tenant } from '../candidate/testing/fixtures';
import { InMemoryObjectStorage } from '../candidate/testing/in-memory-storage';
import { createPrismaClient } from '../database/create-prisma-client';
import { startMigratedDatabase } from '../database/testing/migrated-postgres';
import type { MigratedDatabase } from '../database/testing/migrated-postgres';
import type { PrismaClient } from '../generated/prisma/client.js';
import { FakeJudge0Client, fakeResult } from '../judge0/fake-judge0.client';
import { JUDGE0_STATUS } from '../judge0/judge0.types';
import type { Judge0Client, Judge0RawResult, Judge0Submission } from '../judge0/judge0.types';
import type { SessionStatus } from '../generated/prisma/enums.js';

interface RunBody {
  outcome: string;
  stderr: string;
  stub?: true;
  tests: Array<{ id: string; status: string; actualOutput?: string }>;
}
interface QuestionBody {
  sampleTests: unknown[];
  starterCode: Record<string, string>;
}
const runBody = (r: request.Response): RunBody => r.body as RunBody;

const BASE = '/api/v1/candidate/session/practice';

class NoMail extends CandidateMailPort {
  sendOtp(): Promise<void> {
    return Promise.resolve();
  }
  sendOtpLockout(): Promise<void> {
    return Promise.resolve();
  }
  sendConsentCopy(): Promise<void> {
    return Promise.resolve();
  }
}

/** Switchable runner: a fake, or a stub that runs nothing. */
class SwitchClient implements Judge0Client {
  readonly fake = new FakeJudge0Client();
  stub = false;
  get isStub(): boolean {
    return this.stub;
  }
  runBatch(s: readonly Judge0Submission[]): Promise<Judge0RawResult[]> {
    if (this.stub) {
      return Promise.resolve(
        s.map(() =>
          fakeResult({
            statusId: JUDGE0_STATUS.INTERNAL_ERROR,
            stderr: 'local stub, not real execution',
          }),
        ),
      );
    }
    return this.fake.runBatch(s);
  }
}

const sum = (stdin: string): string =>
  String(
    stdin
      .split('\n')
      .filter(Boolean)
      .reduce((a, b) => a + Number(b), 0),
  );

describe('Practice question (FR-406)', () => {
  let db: MigratedDatabase;
  let redisBox: StartedRedisContainer;
  let owner: PrismaClient;
  let app: INestApplication<App>;
  let tokens: CandidateTokenService;
  let tenant: Tenant;
  const runner = new SwitchClient();

  beforeAll(async () => {
    [db, redisBox] = await Promise.all([
      startMigratedDatabase(),
      new RedisContainer('redis:8.8').start(),
    ]);
    owner = createPrismaClient(db.ownerUrl);
    tenant = await createTenant(owner, 'practice');
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
    const mailToken = jest.requireActual<typeof import('../candidate/candidate-mail.port')>(
      '../candidate/candidate-mail.port',
    );
    const storageToken = jest.requireActual<typeof import('../candidate/object-storage.port')>(
      '../candidate/object-storage.port',
    );
    const types =
      jest.requireActual<typeof import('../judge0/judge0.types')>('../judge0/judge0.types');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(mailToken.CandidateMailPort)
      .useValue(new NoMail())
      .overrideProvider(storageToken.ObjectStoragePort)
      .useValue(new InMemoryObjectStorage())
      .overrideProvider(types.JUDGE0_CLIENT)
      .useValue(runner)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    tokens = app.get(
      jest.requireActual<typeof import('../candidate/candidate-token.service')>(
        '../candidate/candidate-token.service',
      ).CandidateTokenService,
    );
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await redisBox?.stop();
    await db?.stop();
  });

  beforeEach(() => {
    runner.stub = false;
    runner.fake.setDefault((s) => fakeResult({ stdout: sum(s.stdin) }));
  });

  async function session(status: SessionStatus = 'CONSENTED'): Promise<string> {
    const inv = await createInvitation(owner, tenant, { status });
    return tokens.sign({ sid: inv.sessionId, oid: tenant.orgId, epoch: 0 }).token;
  }
  const get = (token: string): request.Test =>
    request(app.getHttpServer()).get(BASE).set('Authorization', `Bearer ${token}`);
  const run = (token: string, body: object): request.Test =>
    request(app.getHttpServer())
      .post(`${BASE}/run`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('FR-406: GET serves the fixed question with two sample tests and no-store', async () => {
    const res = await get(await session()).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      title: 'Add two numbers',
      languages: ['python', 'javascript', 'java'],
    });
    expect((res.body as QuestionBody).sampleTests).toHaveLength(2);
    expect(Object.keys((res.body as QuestionBody).starterCode).sort()).toEqual([
      'java',
      'javascript',
      'python',
    ]);
  });

  it('FR-406: a passing run maps to completed with both tests passed', async () => {
    const res = await run(await session(), { language: 'python', code: 'print(1)' }).expect(200);
    expect(runBody(res).outcome).toBe('completed');
    expect(runBody(res).tests.map((t) => t.status)).toEqual(['passed', 'passed']);
    expect(runBody(res).tests[0]).toMatchObject({
      id: 'sample-1',
      actualOutput: '5',
      expectedOutput: '5',
    });
    expect(runBody(res).stub).toBeUndefined();
  });

  it('FR-406: a wrong answer is completed with failed tests', async () => {
    runner.fake.setDefault(() => fakeResult({ stdout: '0' }));
    const res = await run(await session('VERIFIED'), { language: 'javascript', code: 'x' }).expect(
      200,
    );
    expect(runBody(res).outcome).toBe('completed');
    expect(runBody(res).tests.map((t) => t.status)).toEqual(['failed', 'failed']);
  });

  it('FR-406: a compile error maps to compile_error with the compiler text in stderr', async () => {
    runner.fake.setDefault(() =>
      fakeResult({
        statusId: JUDGE0_STATUS.COMPILATION_ERROR,
        compileOutput: 'Main.java:1: error',
      }),
    );
    const res = await run(await session('OPENED'), { language: 'java', code: 'class' }).expect(200);
    expect(runBody(res).outcome).toBe('compile_error');
    expect(runBody(res).stderr).toContain('Main.java:1: error');
    expect(runBody(res).tests.every((t) => t.status === 'failed')).toBe(true);
  });

  it('FR-406: time limit and runtime error map to their outcomes', async () => {
    runner.fake.setDefault(() => fakeResult({ statusId: JUDGE0_STATUS.TIME_LIMIT_EXCEEDED }));
    const tle = await run(await session(), { language: 'python', code: 'x' }).expect(200);
    expect(runBody(tle).outcome).toBe('time_limit_exceeded');
    runner.fake.setDefault(() =>
      fakeResult({ statusId: JUDGE0_STATUS.RUNTIME_ERROR_NZEC, stderr: 'Traceback' }),
    );
    const rte = await run(await session(), { language: 'python', code: 'x' }).expect(200);
    expect(runBody(rte).outcome).toBe('runtime_error');
    expect(runBody(rte).stderr).toContain('Traceback');
  });

  it('FR-406, DL-58: the local stub is never a pass and never a fail', async () => {
    runner.stub = true;
    const res = await run(await session(), { language: 'python', code: 'x' }).expect(200);
    expect(res.body).toEqual({
      outcome: 'completed',
      tests: [],
      stdout: '',
      stderr: 'local stub, not real execution',
      stub: true,
      message: 'local stub, not real execution',
    });
  });

  it('FR-406: an unsupported language and an oversize or empty body are 400', async () => {
    const token = await session();
    await run(token, { language: 'cobol', code: 'x' }).expect(400);
    await run(token, { language: 'python', code: 'x'.repeat(20_001) }).expect(400);
    await run(token, { language: 'python', code: '' }).expect(400);
    await run(token, { language: 'python', code: 'x'.repeat(20_000) }).expect(200);
  });

  it('FR-406: after the test has started the run is 409 SESSION_NOT_ACTIVE with the status', async () => {
    const res = await run(await session('IN_PROGRESS'), { language: 'python', code: 'x' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SESSION_NOT_ACTIVE', sessionStatus: 'IN_PROGRESS' });
  });

  it('FR-406: runs are limited per session (12 per minute), another session is unaffected', async () => {
    const token = await session();
    for (let i = 0; i < 12; i++) {
      await run(token, { language: 'python', code: 'x' }).expect(200);
    }
    const over = await run(token, { language: 'python', code: 'x' });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: 'RATE_LIMITED' });
    await run(await session(), { language: 'python', code: 'x' }).expect(200);
  });

  it('FR-406: nothing is written to the database', async () => {
    const token = await session();
    const count = async (): Promise<number[]> => [
      await owner.session.count(),
      await owner.submission.count(),
      await owner.auditLog.count(),
      await owner.proctorEvent.count(),
    ];
    const before = await count();
    const snapshot = await owner.session.findMany({ orderBy: { id: 'asc' } });
    await get(token).expect(200);
    await run(token, { language: 'python', code: 'print(1)' }).expect(200);
    expect(await count()).toEqual(before);
    expect(await owner.session.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
  });

  it('TC-008: no token or an expired token is 401, and the session comes only from the token', async () => {
    await request(app.getHttpServer()).get(BASE).expect(401);
    const inv = await createInvitation(owner, tenant, { status: 'CONSENTED' });
    const old = tokens.sign(
      { sid: inv.sessionId, oid: tenant.orgId, epoch: 0 },
      new Date(Date.now() - 3_600_000),
    );
    const res = await get(old.token);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_EXPIRED' });
    // A foreign session id in the body is rejected, never used.
    await run(await session(), { language: 'python', code: 'x', sessionId: inv.sessionId }).expect(
      400,
    );
  });
});
