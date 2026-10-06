import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { ProblemDetails } from '../common/problem.filter';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const EMAIL = 'candidate.person@private-mail.example';
const OBJECT_KEY = 'org/42/media/sess-9/chunk-0001.webm';
const SIGNED =
  'https://bkt.s3.amazonaws.com/org/42/media/chunk.webm?X-Amz-Signature=SIGSECRET123&X-Amz-Credential=AKIACRED';
const OTP = '482913';

interface Loaded {
  app: INestApplication<App>;
  lines: Record<string, unknown>[];
}

async function createApp(): Promise<Loaded> {
  jest.resetModules();
  const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
  const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
  const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
  const { PinoLogger } = jest.requireActual<typeof import('nestjs-pino')>('nestjs-pino');
  const lines: Record<string, unknown>[] = [];
  const capture =
    (level: string) =>
    (obj: unknown): void => {
      lines.push({ level, ...(obj as Record<string, unknown>) });
    };
  jest.spyOn(PinoLogger.prototype, 'warn').mockImplementation(capture('warn'));
  jest.spyOn(PinoLogger.prototype, 'error').mockImplementation(capture('error'));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return { app, lines };
}

describe('POST /client-errors (C-32, NFR-04, FR-103)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let lines: Record<string, unknown>[];

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_DEFAULT_LIMIT: '1000', CLIENT_ERROR_THROTTLE_LIMIT: '10' });
    ({ app, lines } = await createApp());
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('C-32: a valid report without Authorization returns 204, logs scrubbed fields and traceId, no secrets, no ip', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .set('x-request-id', 'trace-client-err-1')
      .set('user-agent', 'TestBrowser/1.0')
      .send({
        message: `Boom for ${EMAIL} with otp ${OTP} using ${JWT} at ${OBJECT_KEY} ${SIGNED}`,
        stack: `Error: x\n at f (https://app.example.test/a.js?token=${JWT}#h:1:2)`,
        url: 'https://app.example.test/candidate/s?invite=SECRETINVITE#frag',
        route: '/candidate/session/[id]',
        release: 'web@1.0.0',
        level: 'warn',
      })
      .expect(204);
    expect(res.text).toBe('');
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    expect(line).toMatchObject({
      event: 'client_error',
      level: 'warn',
      reportedLevel: 'warn',
      traceId: 'trace-client-err-1',
      userAgent: 'TestBrowser/1.0',
      route: '/candidate/session/[id]',
      release: 'web@1.0.0',
      url: 'https://app.example.test/candidate/s',
    });
    expect(String(line['message'])).toContain('Boom for');
    const dump = JSON.stringify(line);
    for (const secret of [
      EMAIL,
      'private-mail',
      JWT,
      'eyJ',
      OTP,
      'SIGSECRET123',
      'AKIACRED',
      OBJECT_KEY,
      'chunk-0001',
      'SECRETINVITE',
    ]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toMatch(/127\.0\.0\.1|::1|"ip"|remoteAddress|authorization/i);
  });

  it('C-32: level defaults to error', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'plain' })
      .expect(204);
    expect(lines[0]).toMatchObject({ level: 'error', reportedLevel: 'error' });
  });

  it('C-32: an oversize body is 413 problem+json and logs nothing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'x'.repeat(20_000) })
      .expect(413);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect((res.body as ProblemDetails).status).toBe(413);
    expect(lines).toHaveLength(0);
  });

  it('C-32: an invalid body is 400 problem+json and does not echo the input', async () => {
    for (const body of [
      {},
      { message: 'ok', extra: 'PLANTED-ECHO-VALUE' },
      { message: 'ok', level: 'fatal-PLANTED-ECHO-VALUE' },
      { message: 'y'.repeat(1001) },
    ]) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/client-errors')
        .send(body)
        .expect(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(JSON.stringify(res.body)).not.toContain('PLANTED-ECHO-VALUE');
    }
    expect(lines).toHaveLength(0);
  });

  it('C-32: adds no audit_logs row', async () => {
    const { Client } = await import('pg');
    const db = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await db.connect();
    try {
      const count = async (): Promise<number> =>
        Number(
          ((await db.query('SELECT count(*) AS n FROM audit_logs')).rows[0] as { n: string }).n,
        );
      const before = await count();
      await request(app.getHttpServer())
        .post('/api/v1/client-errors')
        .send({ message: 'audit check' })
        .expect(204);
      expect(await count()).toBe(before);
    } finally {
      await db.end();
    }
  });

  it('C-32: the 11th request in a window from one IP is 429 (own throttler)', async () => {
    // Earlier tests used some of this IP's budget; restart the app for a clean window.
    await app.close();
    ({ app, lines } = await createApp());
    for (let i = 0; i < 10; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/client-errors')
        .send({ message: `n${i}` })
        .expect(204);
    }
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'n11' })
      .expect(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    // Other areas keep their own budget.
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });
});
