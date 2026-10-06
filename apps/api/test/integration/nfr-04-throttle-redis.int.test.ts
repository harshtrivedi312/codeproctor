// NFR-04 (rate limits) / FU-BE-1 (Redis throttle store, #175): the counters live in Redis, so they
// are shared across API instances and outlive an app restart, and a dead Redis fails closed at the
// throttle guard. No TC id covers this in test-cases.md, so the tests carry NFR-04 and FU-BE-1.
// Limits are lowered for this file: default 5 and auth 3 per window.
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import { API, boot, createUser, Harness, login, PASSWORD, signIn } from '../support/harness';

const DEFAULT_LIMIT = 5;
const AUTH_LIMIT = 3;

const getTests = (h: Harness, token: string): request.Test =>
  request(h.app.getHttpServer()).get(`${API}/tests`).set('Authorization', `Bearer ${token}`);

async function statusesUntilLimited(
  next: () => request.Test,
  max: number,
): Promise<{ limitedAt: number; res: request.Response }> {
  let last: request.Response | undefined;
  for (let i = 1; i <= max; i++) {
    last = await next();
    if (last.status === 429) return { limitedAt: i, res: last };
  }
  throw new Error(`no 429 within ${max} calls (last status ${last?.status})`);
}

describe('NFR-04 FU-BE-1: throttle counters are shared across instances and survive a restart', () => {
  let a: Harness;
  let b: Harness | undefined;
  let c: Harness | undefined;
  let token: string;
  let email: string;

  beforeAll(async () => {
    a = await boot({
      env: {
        THROTTLE_DEFAULT_LIMIT: String(DEFAULT_LIMIT),
        THROTTLE_AUTH_LIMIT: String(AUTH_LIMIT),
      },
    });
    const u = await createUser(a, { role: UserRole.RECRUITER });
    email = u.email;
    // One auth hit (1 of 3) is spent here, on purpose and counted below.
    token = (await signIn(a, u.email)).Authorization.replace('Bearer ', '');
    b = await boot({ join: a });
  });
  afterAll(async () => {
    await c?.close();
    await b?.close();
    await a?.close();
  });

  it('NFR-04 FU-BE-1: a GET limit used up on instance A is still a 429 problem+json on instance B (same Redis)', async () => {
    const first = await statusesUntilLimited(() => getTests(a, token), DEFAULT_LIMIT + 3);
    expect(first.limitedAt).toBe(DEFAULT_LIMIT + 1); // calls 1..5 pass, the 6th is limited
    const onB = await getTests(b as Harness, token);
    expect(onB.status).toBe(429);
    expect(onB.headers['content-type']).toContain('application/problem+json');
  });

  it('NFR-04 FU-BE-1: a login limit used up on A also limits B, even with correct credentials', async () => {
    // The sign-in in beforeAll was auth hit 1; wrong passwords take 2 and 3; the 4th is limited.
    const wrong = (): request.Test =>
      request(a.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'Wrong-Password-1' });
    const first = await statusesUntilLimited(wrong, AUTH_LIMIT + 3);
    expect(first.limitedAt).toBe(AUTH_LIMIT); // hit 1 was the setup sign-in
    expect((await login(b as Harness, email, PASSWORD)).status).toBe(429);
  });

  it('NFR-04 FU-BE-1: counters are stored as throttle:{name}:{sha256}, with no address, email or token in any key', async () => {
    const redis = new Redis(a.infra.redis.getConnectionUrl());
    try {
      const keys = await redis.keys('throttle:*');
      expect(keys.length).toBeGreaterThan(0);
      const shape =
        /^throttle:(default|auth|candidate|client-errors|client-errors-global):[0-9a-f]{64}(:block)?$/;
      for (const k of keys) expect(k).toMatch(shape);
      expect(keys.some((k) => k.startsWith('throttle:default:'))).toBe(true);
      expect(keys.some((k) => k.startsWith('throttle:auth:'))).toBe(true);
      const joined = keys.join('\n');
      expect(joined).not.toContain('127.0.0.1');
      expect(joined).not.toContain(email);
      expect(joined).not.toContain(token);
      expect(joined).not.toContain(createHash('sha256').update(email).digest('hex'));
      // Every counter has a TTL (a key without one would limit for ever).
      for (const k of keys.filter((x) => !x.endsWith(':block'))) {
        expect(await redis.pttl(k)).toBeGreaterThan(0);
      }
    } finally {
      redis.disconnect();
    }
  });

  it('NFR-04 FU-BE-1: counters survive an API restart: the limit is still hit on a fresh instance after A stops', async () => {
    await a.stopApp();
    c = await boot({ join: a });
    expect((await getTests(c, token)).status).toBe(429);
    expect((await login(c, email, PASSWORD)).status).toBe(429);
  });
});

// Last in the file: Redis is stopped for good. Default store (Redis) on purpose: this is the ONE
// test of the throttler-level failure. The handler-level outage tests live in tc-003.int.test.ts
// and tc-006-reissue.int.test.ts and boot with memoryThrottle so they reach their handlers.
describe('NFR-04 FU-BE-1: Redis down at the throttle guard', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('NFR-04 FU-BE-1: a public route answers 503 problem+json "Service is temporarily unavailable." before its handler, with no Redis detail; /health is not throttled and reports the outage itself', async () => {
    await h.infra.redis.stop();
    const res = await request(h.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .timeout({ response: 30000, deadline: 40000 });
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect((res.body as { detail: string }).detail).toBe('Service is temporarily unavailable.');
    const text = JSON.stringify(res.body).toLowerCase();
    for (const leak of ['redis', 'econn', 'ioredis', '127.0.0.1', 'throttle', 'lua', 'script']) {
      expect(text).not.toContain(leak);
    }
    // @SkipThrottle: /health never gets the throttler body; it answers with its own NFR-09 report.
    const health = await request(h.app.getHttpServer())
      .get(`${API}/health`)
      .timeout({ response: 30000, deadline: 40000 });
    expect(health.status).toBe(503);
    expect((health.body as { detail: string }).detail).toContain('redis');
    expect(JSON.stringify(health.body)).not.toContain('Service is temporarily unavailable.');
  }, 120000);
});
