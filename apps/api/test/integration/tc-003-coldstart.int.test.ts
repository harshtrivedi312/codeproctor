// TC-003 (FR-102) cold start: the first Redis commands after a fresh boot may arrive together
// (the client is lazy, enableOfflineQueue is off). Parallel 2FA sign-ins for different users must
// all work; none may answer 503 "Verification is temporarily unavailable." while Redis is healthy.
import { UserRole } from '../../src/generated/prisma/client';
import { boot, createUser, Harness, signInWithTotp, TOTP_SECRET } from '../support/harness';

describe('TC-003 (FR-102): parallel 2FA sign-ins right after boot', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  // QA-D-04 (owner backend-engineer): ensureConnected() returns at once while the lazy client is
  // 'connecting', so a concurrent command meets enableOfflineQueue:false and the verify route answers
  // 503. `it.failing` keeps CI green while the defect is open; change it to `it` when fixed.
  it.failing(
    'TC-003 KNOWN DEFECT QA-D-04: five parallel 2FA sign-ins on a cold API all succeed (no 503 from the Redis connect race)',
    async () => {
      const users = [];
      for (let i = 0; i < 5; i++) {
        users.push(await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET }));
      }
      // No Redis command has run yet in this process: every sign-in below races the first connect.
      const results = await Promise.allSettled(users.map((u) => signInWithTotp(h, u.email)));
      // A rejection carries the supertest message, for example 'expected 200 "OK", got 503 ...'.
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
      expect(failures).toEqual([]);
    },
  );
});
