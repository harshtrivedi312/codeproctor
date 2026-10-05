// TC-003 (FR-102) cold start: the first Redis commands after a fresh boot may arrive together
// (the client is lazy, enableOfflineQueue is off). Parallel 2FA sign-ins for different users must
// all work; none may answer 503 "Verification is temporarily unavailable." while Redis is healthy.
import { UserRole } from '../../src/generated/prisma/client';
import { boot, createUser, Harness, signInWithTotp, TOTP_SECRET } from '../support/harness';

describe('TC-003 (FR-102): parallel 2FA sign-ins right after boot', () => {
  let h: Harness;
  let users: { id: string; email: string }[];
  beforeAll(async () => {
    h = await boot();
    users = [];
    // Set-up errors here fail the suite (red); they must never be mistaken for the known defect.
    for (let i = 0; i < 5; i++) {
      users.push(await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET }));
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  // QA-D-04 (owner backend-engineer, fix in backend/redis-cold-start): ensureConnected() returns at
  // once while the lazy client is 'connecting', so a concurrent command meets enableOfflineQueue:false
  // and /2fa/verify answers 503. Reproduced 8 of 8 runs on a fresh boot (QA-04a).
  // `it.failing` passes only when the body THROWS. The body throws only when the known defect
  // reproduced: at least one sign-in failed and EVERY failure is the 503 "temporarily unavailable".
  // It returns normally (so the test goes red) when all five succeed (defect fixed: make this a
  // plain test) and when any failure is something else (a real 2FA regression is not masked).
  it.failing(
    'TC-003 KNOWN DEFECT QA-D-04: five parallel 2FA sign-ins on a cold API all succeed (no 503 from the Redis connect race)',
    async () => {
      // No Redis command has run yet in this process: every sign-in below races the first connect.
      const results = await Promise.allSettled(users.map((u) => signInWithTotp(h, u.email)));
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
      const known = failures.filter((f) => /got 503 /.test(f));
      if (failures.length > 0 && known.length === failures.length) {
        throw new Error(`QA-D-04 reproduced: ${known.length} of 5 answered 503`);
      }
    },
  );
});
