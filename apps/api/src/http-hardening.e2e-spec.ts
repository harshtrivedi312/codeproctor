import { connect } from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, INestApplication, Post } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Public } from './common/auth/decorators';
import type { ProblemDetails } from './common/problem.filter';
import { applyEnv, startInfra, TestInfra } from './test/containers';

// Stand-in public POST route: any JSON body is accepted, so only the body parser can refuse it.
@Public()
@Controller('hardening')
class EchoProbeController {
  @Post() accept(): { ok: true } {
    return { ok: true };
  }
}

async function createApp(): Promise<INestApplication<App>> {
  jest.resetModules();
  const { AppModule } = jest.requireActual<typeof import('./app.module')>('./app.module');
  const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
  const { configureApp } = jest.requireActual<typeof import('./bootstrap')>('./bootstrap');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [EchoProbeController],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

const BASE_ENV = {
  THROTTLE_DEFAULT_LIMIT: '1000',
  THROTTLE_AUTH_LIMIT: '1000',
  THROTTLE_CANDIDATE_LIMIT: '1000',
};

describe('HTTP hardening (FU-BE-98, FU-BE-103, FU-BE-104, FU-BE-12, FU-BE-13)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;

  beforeAll(async () => {
    infra = await startInfra();
    applyEnv(infra, BASE_ENV);
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('FU-BE-104: a 200 KB JSON body to /auth/login is 413 problem+json (default 100 KB parser)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'a@b.test', password: 'x'.repeat(200_000) })
      .expect(413);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 413, title: 'Payload Too Large' });
    expect(JSON.stringify(res.body)).not.toContain('xxxxxxxx');
  });

  it('FU-BE-104: other public and candidate routes keep the 100 KB limit', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/hardening')
      .send({ a: 'x'.repeat(150_000) })
      .expect(413);
    await request(app.getHttpServer())
      .post('/api/v1/candidate/bootstrap')
      .send({ a: 'x'.repeat(150_000) })
      .expect(413);
    await request(app.getHttpServer())
      .post('/api/v1/hardening')
      .send({ a: 'x'.repeat(50_000) })
      .expect(201);
  });

  it('FU-BE-104, FR-201: /questions parses up to 1 MB (past the body parser to the auth guard), also mixed case', async () => {
    const body = { statementMd: 'x'.repeat(300_000) };
    await request(app.getHttpServer()).post('/api/v1/questions').send(body).expect(401);
    await request(app.getHttpServer()).post('/API/V1/Questions').send(body).expect(401);
    const over = await request(app.getHttpServer())
      .post('/api/v1/questions')
      .send({ statementMd: 'x'.repeat(1_200_000) })
      .expect(413);
    expect(over.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('FU-BE-103: malformed JSON is 400 problem+json that echoes neither body nor parser message', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/hardening')
      .set('content-type', 'application/json')
      .send('{"password":"SECRET-BODY-VALUE", ')
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-BODY-VALUE');
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected|position/i);
  });

  it('FU-BE-12: a body-parser failure never reflects a raw inbound x-request-id as traceId', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/hardening')
      .set('content-type', 'application/json')
      .set('x-request-id', 'not valid <script>')
      .send('{bad')
      .expect(400);
    const traceId = (res.body as ProblemDetails).traceId;
    expect(traceId).not.toContain('<script>');
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('FU-BE-13: a 404 with a secret query string does not echo it', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope?token=SECRETTOKEN')
      .expect(404);
    expect(JSON.stringify(res.body)).not.toContain('SECRETTOKEN');
    expect(res.body).toMatchObject({ status: 404, instance: '/api/v1/nope' });
  });

  it('FU-BE-98: the configured server timeouts are applied to the HTTP server', () => {
    const server = app.getHttpServer() as unknown as Server;
    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBe(65_000);
  });

  it('FU-BE-98: a client that sends headers, then stalls the body, is cut off within the request timeout', async () => {
    await app.close();
    applyEnv(infra, {
      ...BASE_ENV,
      HTTP_HEADERS_TIMEOUT_MS: '500',
      HTTP_REQUEST_TIMEOUT_MS: '1000',
      HTTP_TIMEOUT_CHECK_INTERVAL_MS: '100',
    });
    app = await createApp();
    const server = app.getHttpServer() as unknown as Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    const outcome = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let first = '';
      socket.on('data', (d: Buffer) => {
        if (first === '') first = d.toString('utf8').split('\r\n')[0] ?? '';
      });
      socket.on('close', () => resolve(first === '' ? 'destroyed' : first));
      socket.on('error', reject);
      socket.write(
        'POST /api/v1/hardening HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
          'Content-Length: 5000\r\n\r\n{"a":"par',
      );
      setTimeout(() => socket.destroy(), 8000).unref();
    });
    const elapsed = Date.now() - started;
    expect(outcome).toMatch(/destroyed|408/);
    expect(elapsed).toBeLessThan(5000);
  }, 15_000);

  it('FU-BE-98: a client that never finishes the headers is cut off within the headers timeout', async () => {
    const server = app.getHttpServer() as unknown as Server;
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      // The server answers 408 and half-closes: the client seeing the end of the stream is enough.
      socket.resume();
      socket.on('end', () => resolve());
      socket.on('close', () => resolve());
      socket.on('error', reject);
      socket.write('POST /api/v1/hardening HTTP/1.1\r\nHost: x\r\n');
      setTimeout(() => socket.destroy(), 8000).unref();
    });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15_000);
});
