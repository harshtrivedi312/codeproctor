// TC-003 (FR-102) cold start: the first Redis commands after a fresh boot may arrive together
// (the client is lazy, enableOfflineQueue is off). Parallel 2FA sign-ins for different users must
// all work (200 each); none may answer 503 "Verification is temporarily unavailable." while Redis is healthy.
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

  // QA-D-04 (fixed in backend PR #60, FU-BE-33): ensureConnected() used to return at once while the
  // lazy client was 'connecting', so a concurrent command met enableOfflineQueue:false and
  // /2fa/verify answered 503. Now every caller waits for the shared ready promise. This is a plain
  // regression test: any failure of any kind among the five sign-ins fails it.
  it('TC-003 QA-D-04 (FR-102): five parallel 2FA sign-ins on a cold API all succeed (no 503 from the Redis connect race)', async () => {
    // No Redis command has run yet in this process: every sign-in below races the first connect.
    const results = await Promise.allSettled(users.map((u) => signInWithTotp(h, u.email)));
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
    expect(failures).toEqual([]);
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
      if (r.status === 'fulfilled') expect(r.value.Authorization).toMatch(/^Bearer .+/);
    }
  });
});
