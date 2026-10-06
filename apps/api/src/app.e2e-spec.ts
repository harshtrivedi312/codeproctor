import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import request from 'supertest';
import { Public } from './common/auth/decorators';
import type { App } from 'supertest/types';
import type { ProblemDetails } from './common/problem.filter';
import { applyEnv, startInfra, TestInfra } from './test/containers';

// Stand-ins for the real /auth and /candidate controllers (Steps 2 and 7).
@Public()
@Controller('auth')
class AuthProbeController {
  @Post('ping') ping(): { ok: true } {
    return { ok: true };
  }
}
@Public()
@Controller('candidate')
class CandidateProbeController {
  @Get('ping') ping(): { ok: true } {
    return { ok: true };
  }
}
@Controller('unmarked')
class UnmarkedController {
  @Get() unmarked(): { ok: true } {
    return { ok: true };
  }
}
@Public()
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
    controllers: [
      AuthProbeController,
      CandidateProbeController,
      BoomController,
      UnmarkedController,
    ],
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
      ENABLE_API_DOCS: 'true',
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

  it('FU-BE-04: a route with no @Public() or @Roles() is denied by default', async () => {
    await request(app.getHttpServer()).get('/api/v1/unmarked').expect(401);
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

  it('FU-BE-10: Swagger UI is served at /api/docs when ENABLE_API_DOCS is true', async () => {
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
    // Production refuses to start without the code runner settings (FR-503) and the candidate
    // secrets and Legal-approved consent (BE-07, env.ts); synthetic values.
    applyEnv(infra, {
      NODE_ENV: 'production',
      APP_ENV: 'production',
      // Production requires an https web origin (FU-BE-11).
      WEB_ORIGIN: 'https://app.test.invalid',
      // Behind Caddy in production (FU-BE-97).
      TRUST_PROXY_HOPS: '1',
      // Pilot and production require the code runner settings (FR-503); synthetic values.
      JUDGE0_URL: 'https://judge0.test.invalid',
      JUDGE0_AUTH_TOKEN: 'a'.repeat(32),
      JUDGE0_AUTHZ_TOKEN: 'b'.repeat(32),
      JWT_CANDIDATE_SECRET: 'x'.repeat(48),
      OTP_PEPPER: 'y'.repeat(48),
      SESSION_KEY_ENC_KEY_k1: Buffer.alloc(32, 9).toString('base64'),
      REQUIRE_LEGAL_APPROVED_CONSENT: 'true',
      // Pilot and production require SES (C-31); nothing is sent in this suite.
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@test.invalid',
    });
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('FU-BE-10: OpenAPI docs are off when ENABLE_API_DOCS is not set (production)', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(404);
    await request(app.getHttpServer()).get('/api/docs-json').expect(404);
  });
});

describe('Throttle client identity and path matching (NFR-04)', () => {
  let infra: TestInfra;

  beforeAll(async () => {
    infra = await startInfra();
  });
  afterAll(async () => {
    await infra?.stop();
  });

  async function appWith(hops: string): Promise<INestApplication<App>> {
    applyEnv(infra, {
      THROTTLE_AUTH_LIMIT: '3',
      TRUST_PROXY_HOPS: hops,
    });
    // Counters now live in Redis and outlive an app (FU-BE-1): each test starts from empty buckets.
    const { Redis } = await import('ioredis');
    const redis = new Redis(infra.redis.getConnectionUrl());
    try {
      await redis.flushall();
    } finally {
      redis.disconnect();
    }
    return createApp();
  }

  it('FU-BE-08: with TRUST_PROXY_HOPS=0 a spoofed X-Forwarded-For does not escape the throttle', async () => {
    const app = await appWith('0');
    try {
      const server = app.getHttpServer();
      for (let i = 1; i <= 3; i++) {
        await request(server)
          .post('/api/v1/auth/ping')
          .set('X-Forwarded-For', `203.0.113.${i}`)
          .expect(201);
      }
      await request(server)
        .post('/api/v1/auth/ping')
        .set('X-Forwarded-For', '203.0.113.99')
        .expect(429);
    } finally {
      await app.close();
    }
  });

  it('FU-BE-08: with TRUST_PROXY_HOPS=1 each client behind the proxy gets its own bucket', async () => {
    const app = await appWith('1');
    try {
      const server = app.getHttpServer();
      for (let i = 1; i <= 6; i++) {
        await request(server)
          .post('/api/v1/auth/ping')
          .set('X-Forwarded-For', `203.0.113.${i}`)
          .expect(201);
      }
      // The same client still hits its own limit.
      for (let i = 0; i < 2; i++) {
        await request(server)
          .post('/api/v1/auth/ping')
          .set('X-Forwarded-For', '198.51.100.7')
          .expect(201);
      }
      await request(server)
        .post('/api/v1/auth/ping')
        .set('X-Forwarded-For', '198.51.100.7')
        .expect(201);
      await request(server)
        .post('/api/v1/auth/ping')
        .set('X-Forwarded-For', '198.51.100.7')
        .expect(429);
    } finally {
      await app.close();
    }
  });

  it('FU-BE-08: with TRUST_PROXY_HOPS=1 and a client-supplied chain the bucket follows the rightmost address', async () => {
    const app = await appWith('1');
    try {
      const server = app.getHttpServer();
      for (const spoofed of ['1.2.3.4', '5.6.7.8', '9.9.9.9']) {
        await request(server)
          .post('/api/v1/auth/ping')
          .set('X-Forwarded-For', `${spoofed}, 198.51.100.7`)
          .expect(201);
      }
      await request(server)
        .post('/api/v1/auth/ping')
        .set('X-Forwarded-For', '1.2.3.4, 198.51.100.7')
        .expect(429);
    } finally {
      await app.close();
    }
  });

  it('FU-BE-09: mixed-case /AUTH paths are throttled as auth, not as other', async () => {
    const app = await appWith('0');
    try {
      const server = app.getHttpServer();
      await request(server).post('/api/v1/AUTH/ping').expect(201);
      await request(server).post('/api/v1/Auth/ping').expect(201);
      await request(server).post('/api/v1/aUTH/ping').expect(201);
      await request(server).post('/api/v1/AUTH/ping').expect(429);
    } finally {
      await app.close();
    }
  });
});

describe('Shared Redis throttle store (FU-BE-1, NFR-04)', () => {
  let infra: TestInfra;

  beforeAll(async () => {
    infra = await startInfra();
  });
  afterAll(async () => {
    await infra?.stop();
  });

  // Every test starts from empty buckets, so the tests do not depend on each other's order.
  const useEnv = async (): Promise<void> => {
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '4', THROTTLE_DEFAULT_LIMIT: '1000' });
    const { Redis } = await import('ioredis');
    const redis = new Redis(infra.redis.getConnectionUrl());
    try {
      await redis.flushall();
    } finally {
      redis.disconnect();
    }
  };

  it('FU-BE-1: two API instances on one Redis share one limit', async () => {
    await useEnv();
    const a = await createApp();
    const b = await createApp();
    try {
      await request(a.getHttpServer()).post('/api/v1/auth/ping').expect(201);
      await request(b.getHttpServer()).post('/api/v1/auth/ping').expect(201);
      await request(a.getHttpServer()).post('/api/v1/auth/ping').expect(201);
      await request(b.getHttpServer()).post('/api/v1/auth/ping').expect(201);
      await request(a.getHttpServer()).post('/api/v1/auth/ping').expect(429);
      await request(b.getHttpServer()).post('/api/v1/auth/ping').expect(429);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('FU-BE-1: a restarted instance keeps the counter (limit survives a restart)', async () => {
    await useEnv();
    const first = await createApp();
    try {
      for (let i = 0; i < 4; i++)
        await request(first.getHttpServer()).post('/api/v1/auth/ping').expect(201);
    } finally {
      await first.close();
    }
    // A new app on the same Redis is still limited.
    const restarted = await createApp();
    try {
      await request(restarted.getHttpServer()).post('/api/v1/auth/ping').expect(429);
    } finally {
      await restarted.close();
    }
  });

  it('FU-BE-1: no throttle key in Redis contains the client address', async () => {
    await useEnv();
    const keyApp = await createApp();
    try {
      await request(keyApp.getHttpServer())
        .post('/api/v1/auth/ping')
        .set('X-Forwarded-For', '203.0.113.9')
        .expect(201);
    } finally {
      await keyApp.close();
    }
    const { Redis } = await import('ioredis');
    const redis = new Redis(infra.redis.getConnectionUrl());
    try {
      const keys = await redis.keys('throttle:*');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatch(/^throttle:[a-z-]+:[0-9a-f]{64}(:block)?$/);
      }
    } finally {
      redis.disconnect();
    }
  });

  it('FU-BE-1: with Redis down a throttled route answers 503 (fail closed) and /health still answers', async () => {
    await useEnv();
    const app = await createApp();
    try {
      await infra.redis.stop();
      const res = await request(app.getHttpServer()).post('/api/v1/auth/ping').expect(503);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(JSON.stringify(res.body)).not.toMatch(/ECONN|redis|127\.0\.0\.1/i);
      await request(app.getHttpServer()).get('/api/v1/health').expect(503);
    } finally {
      await app.close();
    }
  });
});
