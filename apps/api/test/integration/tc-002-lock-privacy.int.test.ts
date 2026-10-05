// TC-002 (FR-101, FU-BE-22): the lock state (`locked`, `lockedUntil`) never leaves the API except
// to a SUPER_ADMIN of the same org on GET /users. It must not appear in any login, refresh, 2FA,
// setup, re-auth, logout or password response, for any user, locked or not, and not to
// non-SUPER_ADMINs. The auth-response table runs now against the existing routes; the GET /users
// cases are staged "[BE-03 pending]" behind BE03_READY.
import request from 'supertest';
import { authenticator } from 'otplib';
import { UserRole } from '../../src/generated/prisma/client';
import {
  API,
  Body,
  boot,
  createUser,
  Harness,
  login,
  refreshCookie,
  TOTP_SECRET,
} from '../support/harness';
import { actor, call, tokenFromUrl } from '../support/be03-helpers';
import { BE03_READY, lockEventsPath } from '../support/be03-routes';

const LOCK_KEY = /^(locked|lockedUntil|locked_until|failedLogins|failed_logins)$/i;
function keys(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keys);
  if (v !== null && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]);
  return [];
}
const lockKeysIn = (body: unknown, headers?: unknown): string[] =>
  [...keys(body), ...Object.keys((headers as object | undefined) ?? {})].filter((k) =>
    LOCK_KEY.test(k),
  );

describe('TC-002 (FR-101, FU-BE-22): lock state is not exposed by auth responses', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  const post = (path: string): request.Test => request(h.app.getHttpServer()).post(`${API}${path}`);

  it('TC-002: no auth response, for a locked or an unlocked user, carries locked or lockedUntil', async () => {
    const seen: [string, request.Response][] = [];
    const record = (name: string, res: request.Response): request.Response => {
      seen.push([name, res]);
      return res;
    };

    const ok = await createUser(h, { role: UserRole.AUTHOR });
    const okLogin = record('login ok', await login(h, ok.email));
    const cookie = refreshCookie(okLogin);
    const token = (okLogin.body as Body).session.accessToken;
    record('refresh', await post('/auth/refresh').set('Cookie', cookie));
    record(
      '2fa setup start',
      await post('/auth/2fa/setup/start').set('Authorization', `Bearer ${token}`),
    );
    record('login wrong password', await login(h, ok.email, 'wrong-password'));
    record('login unknown email', await login(h, 'nobody-qa@example.com'));
    record('password forgot', await post('/auth/password/forgot').send({ email: ok.email }));
    const reset = h.mails.at(-1);
    if (reset)
      record(
        'password reset',
        await post('/auth/password/reset').send({
          token: tokenFromUrl(reset.url),
          password: 'Another-Correct-Horse-9',
        }),
      );

    const twofa = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const challenge = record('login 2fa', await login(h, twofa.email));
    record(
      '2fa verify',
      await post('/auth/2fa/verify').send({
        challengeToken: (challenge.body as Body).challengeToken,
        code: authenticator.generate(TOTP_SECRET),
      }),
    );

    const locked = await createUser(h);
    for (let i = 0; i < 5; i++) record('login failing', await login(h, locked.email, `bad-${i}`));
    record('login while locked (correct password)', await login(h, locked.email));
    record(
      'password forgot (locked)',
      await post('/auth/password/forgot').send({ email: locked.email }),
    );

    record('logout', await post('/auth/logout').set('Cookie', cookie));

    expect(seen.length).toBeGreaterThan(12);
    for (const [name, res] of seen) {
      expect(lockKeysIn(res.body, res.headers).map((k) => `${name}: ${k}`)).toEqual([]);
      expect(JSON.stringify(res.body).match(/locked/i) ? name : null).toBeNull();
    }
  });

  it('TC-002: a locked user and an unlocked user with a wrong password get the same status and body shape (no lock oracle)', async () => {
    const a = await createUser(h);
    const b = await createUser(h);
    for (let i = 0; i < 5; i++) await login(h, b.email, `bad-${i}`).expect(401);
    const unlockedRes = await login(h, a.email, 'bad-x').expect(401);
    const lockedRes = await login(h, b.email, 'bad-x').expect(401);
    expect(Object.keys(lockedRes.body as object).sort()).toEqual(
      Object.keys(unlockedRes.body as object).sort(),
    );
    expect((lockedRes.body as Body).detail).toBe((unlockedRes.body as Body).detail);
  });
});

(BE03_READY ? describe : describe.skip)(
  'TC-002 [BE-03 pending]: GET /users and the lock events list',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('TC-002 [BE-03 pending]: GET /users shows locked and lockedUntil to a SUPER_ADMIN of the org only', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const u = await createUser(h);
      for (let i = 0; i < 5; i++) await login(h, u.email, `bad-${i}`).expect(401);
      const res = await call(h, 'GET', '/users', admin.token).expect(200);
      const rows = (
        Array.isArray(res.body) ? res.body : ((res.body as { items?: unknown[] }).items ?? [])
      ) as {
        id: string;
        locked?: boolean;
        lockedUntil?: string | null;
      }[]; // ASSUMED list shape: array or { items }
      const row = rows.find((r) => r.id === u.id);
      expect(row?.locked).toBe(true);
      expect(new Date(row?.lockedUntil ?? 0).getTime()).toBeGreaterThan(Date.now());
      const other = rows.find((r) => r.id === admin.id);
      expect(other?.locked).toBe(false);
    });

    it.each([UserRole.RECRUITER, UserRole.AUTHOR, UserRole.REVIEWER])(
      'TC-002 [BE-03 pending]: a %s never sees lock fields anywhere (GET /users is 403 or has none)',
      async (role) => {
        const who = await actor(h, role);
        const res = await call(h, 'GET', '/users', who.token);
        expect([200, 403]).toContain(res.status);
        expect(lockKeysIn(res.body)).toEqual([]);
      },
    );

    it('TC-002 [BE-03 pending]: a SUPER_ADMIN of another org gets 404 for the user and sees no lock fields in its own list', async () => {
      const orgB = (await h.owner.organization.create({ data: { name: 'QA Org B lock' } })).id;
      const adminB = await actor(h, UserRole.SUPER_ADMIN, orgB);
      const u = await createUser(h);
      for (let i = 0; i < 5; i++) await login(h, u.email, `bad-${i}`).expect(401);
      await call(h, 'POST', `/users/${u.id}/unlock`, adminB.token).expect(404); // ASSUMED path
      const list = await call(h, 'GET', '/users', adminB.token).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(u.id);
    });

    it('TC-002 [BE-03 pending]: the admin lock alert is the AUTH_ACCOUNT_LOCKED audit event, listed for SUPER_ADMIN only and scoped to the org', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const reviewer = await actor(h, UserRole.REVIEWER);
      const u = await createUser(h);
      for (let i = 0; i < 5; i++) await login(h, u.email, `bad-${i}`).expect(401);
      await call(h, 'GET', lockEventsPath, reviewer.token).expect(403);
      const res = await call(h, 'GET', lockEventsPath, admin.token).expect(200);
      expect(JSON.stringify(res.body)).toContain(u.id);
      expect(lockKeysIn(res.body)).toEqual([]);
    });
  },
);
