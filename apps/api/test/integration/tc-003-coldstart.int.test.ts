// TC-003 (FR-102) cold start: the first Redis commands after a fresh boot may arrive together
// (the client is lazy, enableOfflineQueue is off). Parallel 2FA sign-ins for different users must
// all work (200 each); none may answer 503 "Verification is temporarily unavailable." while Redis is healthy.
import type { Redis } from 'ioredis';
import request from 'supertest';
import { authenticator } from 'otplib';
import { UserRole } from '../../src/generated/prisma/client';
import { API, Body, boot, createUser, Harness, login, TOTP_SECRET } from '../support/harness';

describe('TC-003 (FR-102): parallel 2FA sign-ins right after boot', () => {
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
  it('TC-003 QA-D-04 (FR-102): five parallel 2FA sign-ins on a cold API all succeed (no 503 on the first Redis use of a cold client)', async () => {
    // Premise guard: the Redis client must still be unconnected, or this stops testing a cold start.
    // boot() resets the module registry, so the token must come from the same registry as the app.
    const { REDIS_CLIENT } = jest.requireActual<
      typeof import('../../src/infrastructure/infrastructure.module')
    >('../../src/infrastructure/infrastructure.module');
    expect(h.app.get<Redis>(REDIS_CLIENT, { strict: false }).status).toBe('wait');
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
