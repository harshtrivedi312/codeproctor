// TC-003 (FR-102) cold start: the first Redis commands after a fresh boot may arrive together
// (the client is lazy, enableOfflineQueue is off). Since FU-BE-1 the password sign-in is the first
// Redis use (its throttle counter), so five parallel first uses of a cold client must all succeed,
// and so must the five 2FA verifies that follow (replay store). None may answer 503
// ("Service is" from the throttler, "Verification is" from a handler) while Redis is healthy.
import type { Redis } from 'ioredis';
import request from 'supertest';
import { authenticator } from 'otplib';
import { UserRole } from '../../src/generated/prisma/client';
import { API, Body, boot, createUser, Harness, login, TOTP_SECRET } from '../support/harness';

// Polls a condition for up to 10 s; fails with the last status text if it never holds.
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the Redis client state.');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('TC-003 (FR-102): parallel first Redis uses right after boot', () => {
  let h: Harness;
  let users: { id: string; email: string }[];
  beforeAll(async () => {
    h = await boot();
    users = [];
    // Set-up errors fail the suite (red) before the test body runs.
    for (let i = 0; i < 5; i++) {
      users.push(await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET }));
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  // QA-D-04 (fixed in backend PR #60, FU-BE-33): ensureConnected() used to return at once while the
  // lazy client was 'connecting', so a concurrent command met enableOfflineQueue:false and
  // /2fa/verify answered 503. Now every caller waits for the shared ready promise. This is a plain
  // regression test: any failure of any kind among the five sign-ins fails it.
  it('TC-003 QA-D-04 (FR-102): five parallel first uses of a cold Redis client (password logins, then 2FA verifies) all succeed, never 503', async () => {
    // Since FU-BE-194 the app starts the Redis connect at boot, so the client is no longer cold when
    // the test starts. Make it cold again: let the boot connect finish, then close the connection.
    // 'end' is a cold client for ensureConnected() (it connects on first use, like 'wait').
    // boot() resets the module registry, so the token must come from the same registry as the app.
    const { REDIS_CLIENT } = jest.requireActual<
      typeof import('../../src/infrastructure/infrastructure.module')
    >('../../src/infrastructure/infrastructure.module');
    const redis = h.app.get<Redis>(REDIS_CLIENT, { strict: false });
    await until(() => redis.status === 'ready');
    redis.disconnect();
    await until(() => redis.status === 'end');
    // Premise guard: the client is unconnected, or this stops testing a cold start.
    expect(redis.status).toBe('end');
    // Phase 1: since FU-BE-1 the throttler keeps its counters in Redis, so these five password
    // sign-ins already make the first Redis use of the cold client together (all must be 200).
    const challenges = await Promise.all(
      users.map(async (u) => ((await login(h, u.email).expect(200)).body as Body).challengeToken),
    );
    // Phase 2: five verifies fired together (replay store and throttler on a now-connected client).
    const code = authenticator.generate(TOTP_SECRET);
    const results = await Promise.allSettled(
      challenges.map((challengeToken) =>
        request(h.app.getHttpServer())
          .post(`${API}/auth/2fa/verify`)
          .send({ challengeToken, code })
          .expect(200),
      ),
    );
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
    expect(failures).toEqual([]);
    for (const r of results) {
      const token = r.status === 'fulfilled' ? (r.value.body as Body).accessToken : undefined;
      expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    }
  });
});
