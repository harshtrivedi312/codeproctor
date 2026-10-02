import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { ProblemDetails } from './common/problem.filter';
import { applyEnv, startInfra, TestInfra } from './test/containers';

// Stand-ins for the real /auth and /candidate controllers (Steps 2 and 7).
@Controller('auth')
class AuthProbeController {
  @Post('ping') ping(): { ok: true } {
    return { ok: true };
  }
}
@Controller('candidate')
class CandidateProbeController {
  @Get('ping') ping(): { ok: true } {
    return { ok: true };
  }
}
@Controller('boom')
class BoomController {
  @Get() boom(): never {
    throw new Error('secret internal detail');
  }
}

// ConfigModule reads the environment when app.module is first loaded, so each app gets a fresh
// module registry after the test environment has been applied.
async function createApp(): Promise<INestApplication<App>> {
  jest.resetModules();
  const { AppModule } = jest.requireActual<typeof import('./app.module')>('./app.module');
  const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
  const { configureApp } = jest.requireActual<typeof import('./bootstrap')>('./bootstrap');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [AuthProbeController, CandidateProbeController, BoomController],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

describe('API foundation (NFR-04, NFR-09)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;

  beforeAll(async () => {
    infra = await startInfra();
    applyEnv(infra, {
      THROTTLE_DEFAULT_LIMIT: '1000',
      THROTTLE_AUTH_LIMIT: '3',
      THROTTLE_CANDIDATE_LIMIT: '5',
    });
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('NFR-09: GET /api/v1/health is ok with Postgres and Redis up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });

  it('NFR-09: every response carries a trace id; an inbound id is reused', async () => {
    const generated = await request(app.getHttpServer()).get('/api/v1/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .set('x-request-id', 'trace-abc-12345')
      .expect(404);
    expect(echoed.headers['x-request-id']).toBe('trace-abc-12345');
    expect((echoed.body as ProblemDetails).traceId).toBe('trace-abc-12345');
  });

  it('NFR-09: errors are RFC 7807 problem JSON', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, title: 'Not Found', instance: '/api/v1/nope' });
  });

  it('NFR-09: unhandled errors return 500 problem JSON without leaking internals', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/boom').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });

  it('NFR-04: routes live only under /api/v1', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('NFR-04: helmet headers are set and CORS is limited to the web origin', async () => {
    const ok = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const other = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('NFR-04: /auth is throttled more strictly than the default', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) await request(server).post('/api/v1/auth/ping').expect(201);
    const res = await request(server).post('/api/v1/auth/ping').expect(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect((res.body as ProblemDetails).status).toBe(429);
  });

  it('NFR-04: /candidate has its own stricter limit and does not share the auth bucket', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 5; i++) await request(server).get('/api/v1/candidate/ping').expect(200);
    await request(server).get('/api/v1/candidate/ping').expect(429);
  });

  it('NFR-04: Swagger UI is served at /api/docs outside production', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(200);
    const json = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect((json.body as { paths: Record<string, unknown> }).paths['/api/v1/health']).toBeDefined();
  });

  it('NFR-09: /health returns 503 problem JSON when Redis is down', async () => {
    await infra.redis.stop();
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const { detail } = res.body as ProblemDetails;
    expect(detail).toContain('redis');
    expect(detail).not.toContain('postgres');
  });
});

describe('API foundation in production (NFR-04)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;

  beforeAll(async () => {
    infra = await startInfra();
    applyEnv(infra, { NODE_ENV: 'production', APP_ENV: 'production' });
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('NFR-04: OpenAPI docs are disabled in production', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(404);
    await request(app.getHttpServer()).get('/api/docs-json').expect(404);
  });
});
