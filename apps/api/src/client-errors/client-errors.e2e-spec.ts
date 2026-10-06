import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { ProblemDetails } from '../common/problem.filter';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const EMAIL = 'candidate.person@private-mail.example';
const OBJECT_KEY = 'orgs/42/sessions/sess-9/chunk-0001.webm';
const SIGNED =
  'https://bkt.s3.amazonaws.com/orgs/42/sessions/chunk.webm?X-Amz-Signature=SIGSECRET123&X-Amz-Credential=AKIACRED';
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

const MAIN_ENV = {
  THROTTLE_DEFAULT_LIMIT: '1000',
  THROTTLE_AUTH_LIMIT: '1000',
  CLIENT_ERROR_THROTTLE_LIMIT: '1000',
  CLIENT_ERROR_GLOBAL_LIMIT: '1000',
};

interface RawResponse {
  status: number;
  body: string;
}

/** A POST with no Content-Length (chunked framing), written chunk by chunk. */
async function rawChunkedPost(
  app: INestApplication<App>,
  path: string,
  chunks: Buffer[],
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Promise<RawResponse> {
  const server = app.getHttpServer() as unknown as Server;
  if (server.address() === null) await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

describe('POST /client-errors (C-32, NFR-04, FR-103)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let lines: Record<string, unknown>[];

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, MAIN_ENV);
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
      userAgent: 'TestBrowser/1.0',
      route: '/candidate/session/[id]',
      release: 'web@1.0.0',
      url: 'https://app.example.test/candidate/s',
    });
    // FU-BE-95: the inbound x-request-id is ignored on this public route.
    expect(line['traceId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(line['traceId']);
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

  it('C-32: a 16 KB User-Agent is bounded and scrubbed quickly (no ReDoS)', async () => {
    const ua = `x@${'.'.repeat(8000)}a ${'a@'.repeat(3000)}`;
    const start = performance.now();
    await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .set('user-agent', ua)
      .send({ message: 'ua' })
      .expect(204);
    expect(performance.now() - start).toBeLessThan(500);
    expect(String(lines[0]?.['userAgent']).length).toBeLessThanOrEqual(200);
  });

  it('C-32: Content-Length is no longer required; a small chunked body is accepted (no 411)', async () => {
    const res = await rawChunkedPost(app, '/api/v1/client-errors', [
      Buffer.from('{"message":"chunk'),
      Buffer.from('ed"}'),
    ]);
    expect(res.status).toBe(204);
    expect(lines[0]).toMatchObject({ message: 'chunked' });
  });

  it('C-32: a chunked body that streams past 16 KB is 413 problem+json and logs nothing', async () => {
    const chunk = Buffer.from('a'.repeat(6000));
    const res = await rawChunkedPost(app, '/api/v1/client-errors', [
      Buffer.from('{"message":"'),
      chunk,
      chunk,
      chunk,
      Buffer.from('"}'),
    ]);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ status: 413 });
    expect(lines).toHaveLength(0);
  });

  it('C-32: a compressed body is refused (415), never inflated', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .set('content-encoding', 'gzip')
      .set('content-type', 'application/json')
      .send(gzipSync(Buffer.from(JSON.stringify({ message: 'z'.repeat(100) }))))
      .expect(415);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(lines).toHaveLength(0);
  });

  it('C-32: malformed JSON is 400 problem+json', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .set('content-type', 'application/json')
      .send('{"message": PLANTED-ECHO')
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('PLANTED-ECHO');
  });

  it('C-32: a non-JSON body is 415 even when chunked, so the global form parser is never reached', async () => {
    const form = Buffer.from(`message=${'a'.repeat(50_000)}`);
    const res = await rawChunkedPost(app, '/api/v1/client-errors', [form], {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(415);
    const small = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .type('form')
      .send({ message: 'cross-site form post' })
      .expect(415);
    expect(small.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(lines).toHaveLength(0);
  });

  it('C-32: a request with no body is 400 from validation', async () => {
    await request(app.getHttpServer()).post('/api/v1/client-errors').expect(400);
    expect(lines).toHaveLength(0);
  });

  it('C-32: an array body and a deeply nested body are 400, never 500', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .set('content-type', 'application/json')
      .send('[{"message":"x"}]')
      .expect(400);
    const deep = `${'['.repeat(8000)}${']'.repeat(8000)}`;
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .set('content-type', 'application/json')
      .send(deep)
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('C-32: an aborted body does not break the server', async () => {
    const server = app.getHttpServer() as unknown as Server;
    if (server.address() === null) await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/api/v1/client-errors',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      req.on('error', () => resolve());
      req.write('{"message":"abo');
      setTimeout(() => req.destroy(), 50);
    });
    await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'after abort' })
      .expect(204);
    expect(lines).toHaveLength(1);
  });

  it('C-32: the mixed-case path hits the same body limit', async () => {
    await request(app.getHttpServer())
      .post('/API/V1/Client-Errors')
      .send({ message: 'x'.repeat(20_000) })
      .expect(413);
  });

  async function restart(env: Record<string, string>): Promise<void> {
    await app.close();
    applyEnv(infra, { ...MAIN_ENV, ...env });
    // Throttle counters live in Redis and outlive an app (FU-BE-1): start each case empty.
    const { Redis } = await import('ioredis');
    const redis = new Redis(infra.redis.getConnectionUrl());
    try {
      await redis.flushall();
    } finally {
      redis.disconnect();
    }
    ({ app, lines } = await createApp());
  }

  it('C-32: the 11th request in a window from one IP is 429, also on a mixed-case path', async () => {
    await restart({ CLIENT_ERROR_THROTTLE_LIMIT: '10' });
    for (let i = 0; i < 10; i += 1) {
      await request(app.getHttpServer())
        .post('/API/V1/Client-Errors')
        .send({ message: `n${i}` })
        .expect(204);
    }
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'n11' })
      .expect(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    // Other areas keep their own budget: a default-area and an auth-area route are not 429.
    const def = await request(app.getHttpServer()).get('/api/v1/admin/users');
    expect(def.status).toBe(401);
    const auth = await request(app.getHttpServer()).post('/api/v1/auth/login').send({});
    expect(auth.status).not.toBe(429);
  });

  it('C-32: the whole-instance budget caps reports even when the per-IP budget is not used up', async () => {
    await restart({ CLIENT_ERROR_THROTTLE_LIMIT: '100', CLIENT_ERROR_GLOBAL_LIMIT: '5' });
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/client-errors')
        .send({ message: `g${i}` })
        .expect(204);
    }
    await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'g6' })
      .expect(429);
  });

  it('C-32: a body that arrives too slowly is 408 (read deadline)', async () => {
    await restart({ CLIENT_ERROR_BODY_TIMEOUT_MS: '300' });
    const server = app.getHttpServer() as unknown as Server;
    if (server.address() === null) await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/client-errors',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
      req.write('{"message":"slow');
    });
    expect(status).toBe(408);
    delete process.env['CLIENT_ERROR_BODY_TIMEOUT_MS'];
  });

  it('C-32, FU-BE-100: rejected bodies (413, 415, 400) count against the per-IP budget, then 429', async () => {
    await restart({ CLIENT_ERROR_THROTTLE_LIMIT: '4' });
    const url = '/api/v1/client-errors';
    await request(app.getHttpServer())
      .post(url)
      .send({ message: 'x'.repeat(20_000) })
      .expect(413);
    await request(app.getHttpServer())
      .post(url)
      .set('content-type', 'text/plain')
      .send('hello')
      .expect(415);
    await request(app.getHttpServer())
      .post(url)
      .set('content-type', 'application/json')
      .send('{"message": ')
      .expect(400);
    const chunked = await rawChunkedPost(app, url, [Buffer.alloc(20_000, 0x61)]);
    expect(chunked.status).toBe(413);
    const res = await request(app.getHttpServer()).post(url).send({ message: 'ok' }).expect(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(lines).toHaveLength(0);
  });

  it('C-32, FU-BE-100: rejected bodies count against the whole-instance budget', async () => {
    await restart({ CLIENT_ERROR_THROTTLE_LIMIT: '100', CLIENT_ERROR_GLOBAL_LIMIT: '2' });
    for (let i = 0; i < 2; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/client-errors')
        .send({ message: 'x'.repeat(20_000) })
        .expect(413);
    }
    await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'ok' })
      .expect(429);
  });

  it('C-32, FU-BE-100: a body that arrives too slowly (408) is counted too', async () => {
    await restart({ CLIENT_ERROR_BODY_TIMEOUT_MS: '300', CLIENT_ERROR_THROTTLE_LIMIT: '1' });
    const server = app.getHttpServer() as unknown as Server;
    if (server.address() === null) await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/client-errors',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
      req.write('{"message":"slow');
    });
    expect(status).toBe(408);
    await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .send({ message: 'ok' })
      .expect(429);
    delete process.env['CLIENT_ERROR_BODY_TIMEOUT_MS'];
  });

  it('C-32, FU-BE-95: an inbound x-request-id is not the traceId of a rejected report either', async () => {
    await restart({});
    const res = await request(app.getHttpServer())
      .post('/api/v1/client-errors')
      .set('x-request-id', 'victim-trace-0001')
      .send({ message: 'x'.repeat(20_000) })
      .expect(413);
    expect((res.body as ProblemDetails).traceId).not.toBe('victim-trace-0001');
    expect(res.headers['x-request-id']).toBe((res.body as ProblemDetails).traceId);
  });

  it('C-32, FU-BE-100: a rejected report carries Connection: close and the client still reads the 413 while streaming a declared 1 MB body slowly', async () => {
    await restart({});
    const server = app.getHttpServer() as unknown as Server;
    if (server.address() === null) await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const total = 1024 * 1024;
    const result = await new Promise<{ status: number; connection: string | undefined }>(
      (resolve, reject) => {
        let gotResponse = false;
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/api/v1/client-errors',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': String(total) },
          },
          (res) => {
            // The status line and headers are what matter: the server may close the socket right
            // after answering, so the rest of the exchange can end in an RST that is not a failure.
            gotResponse = true;
            clearInterval(timer);
            resolve({ status: res.statusCode ?? 0, connection: res.headers['connection'] });
            res.resume();
            res.on('error', () => undefined);
          },
        );
        req.on('error', (e) => {
          if (!gotResponse) reject(e);
        });
        let sent = 0;
        const timer = setInterval(() => {
          if (sent >= total || req.destroyed || gotResponse) return clearInterval(timer);
          sent += 64 * 1024;
          req.write(Buffer.alloc(64 * 1024, 0x61));
        }, 20);
        timer.unref();
      },
    );
    expect(result.status).toBe(413);
    expect(result.connection).toBe('close');
  });
});
