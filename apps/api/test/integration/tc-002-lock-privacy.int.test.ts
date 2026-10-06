// TC-002 (FR-101, FU-BE-22): the lock state (`locked`, `lockedUntil`) never leaves the API except
// to a SUPER_ADMIN of the same org on GET /admin/users. It must not appear in any login, refresh, 2FA,
// setup, re-auth, logout or password response, for any user, locked or not, and not to
// non-SUPER_ADMINs. The auth-response table runs now against the existing routes; the
// /admin/users cases run against the BE-03 routes.
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
  PASSWORD,
  refreshCookie,
  TOTP_SECRET,
} from '../support/harness';
import { actor, call, tokenFromUrl } from '../support/be03-helpers';
import { ADMIN_USERS, BE03_READY, lockEventsPath } from '../support/be03-routes';

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
    // Every response is recorded AND its status asserted: a route that fails early (400, 401)
    // would otherwise pass this test by never reaching the code that could leak.
    const record = (name: string, res: request.Response, status: number): request.Response => {
      expect([name, res.status]).toEqual([name, status]);
      seen.push([name, res]);
      return res;
    };

    const ok = await createUser(h, { role: UserRole.AUTHOR });
    const okLogin = record('login ok', await login(h, ok.email), 200);
    const cookie = refreshCookie(okLogin);
    const token = (okLogin.body as Body).session.accessToken;
    const auth = { Authorization: `Bearer ${token}` };
    const refreshed = record('refresh', await post('/auth/refresh').set('Cookie', cookie), 200);
    const rotated = refreshCookie(refreshed); // the first cookie is spent; logout needs the new one

    const setup = record(
      '2fa setup start',
      await post('/auth/2fa/setup/start').set(auth).send({ currentPassword: PASSWORD }),
      200,
    );
    record(
      '2fa setup confirm',
      await post('/auth/2fa/setup/confirm')
        .set(auth)
        .send({
          currentPassword: PASSWORD,
          code: authenticator.generate((setup.body as Body).manualKey),
        }),
      200,
    );
    record('login wrong password', await login(h, ok.email, 'wrong-password'), 401);
    record('login unknown email', await login(h, 'nobody-qa@example.com'), 401);
    record('logout', await post('/auth/logout').set('Cookie', rotated), 204);

    record('password forgot', await post('/auth/password/forgot').send({ email: ok.email }), 202);
    await h.settle(); // the mail is sent after the response
    const reset = h.mails.at(-1);
    expect([reset?.method, reset?.to]).toEqual(['sendPasswordReset', ok.email]);
    record(
      'password reset',
      await post('/auth/password/reset').send({
        token: tokenFromUrl(reset?.url ?? ''),
        newPassword: 'Another-Correct-Horse-9',
      }),
      204,
    );

    const twofa = await createUser(h, { role: UserRole.REVIEWER, totp: TOTP_SECRET });
    const challenge = record('login 2fa', await login(h, twofa.email), 200);
    record(
      '2fa verify',
      await post('/auth/2fa/verify').send({
        challengeToken: (challenge.body as Body).challengeToken,
        code: authenticator.generate(TOTP_SECRET),
      }),
      200,
    );

    const fresh = await createUser(h, { role: UserRole.REVIEWER });
    const enrol = record('login enrol', await login(h, fresh.email), 200);
    const challengeToken = (enrol.body as Body).challengeToken;
    const started = record(
      '2fa enroll start',
      await post('/auth/2fa/enroll/start').send({ challengeToken }),
      200,
    );
    record(
      '2fa enroll confirm',
      await post('/auth/2fa/enroll/confirm').send({
        challengeToken,
        code: authenticator.generate((started.body as Body).manualKey),
      }),
      200,
    );

    const locked = await createUser(h);
    for (let i = 0; i < 5; i++) {
      record('login failing', await login(h, locked.email, `bad-${i}`), 401);
    }
    record('login while locked (correct password)', await login(h, locked.email), 401);
    record(
      'password forgot (locked)',
      await post('/auth/password/forgot').send({ email: locked.email }),
      202,
    );

    expect(seen.length).toBeGreaterThan(15);
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

(BE03_READY ? describe : describe.skip)('TC-002: GET /admin/users and the lock events list', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  interface Row {
    id: string;
    locked?: boolean;
    lockedUntil?: string | null;
  }
  const lockOut = async (email: string): Promise<void> => {
    for (let i = 0; i < 5; i++) await login(h, email, `bad-${i}`).expect(401);
  };

  it('TC-002: GET /admin/users shows locked and lockedUntil to a SUPER_ADMIN of the org only', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const u = await createUser(h);
    await lockOut(u.email);
    const res = await call(h, 'GET', `${ADMIN_USERS}?page=1&pageSize=100`, admin.token).expect(200);
    const rows = (res.body as { items: Row[] }).items;
    const row = rows.find((r) => r.id === u.id);
    expect(row?.locked).toBe(true);
    expect(new Date(row?.lockedUntil ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(rows.find((r) => r.id === admin.id)?.locked).toBe(false);
  });

  it.each([UserRole.RECRUITER, UserRole.AUTHOR, UserRole.REVIEWER])(
    'TC-002: a %s gets 403 on both admin lists and never sees lock fields anywhere',
    async (role) => {
      const who = await actor(h, role);
      for (const path of [ADMIN_USERS, lockEventsPath]) {
        const res = await call(h, 'GET', path, who.token).expect(403);
        expect(lockKeysIn(res.body)).toEqual([]);
      }
    },
  );

  it('TC-002: a SUPER_ADMIN of another org gets 404 on unlock (account stays locked) and sees nothing of the user in its own lists', async () => {
    const orgB = (await h.owner.organization.create({ data: { name: 'QA Org B lock' } })).id;
    const adminB = await actor(h, UserRole.SUPER_ADMIN, orgB);
    const u = await createUser(h);
    await lockOut(u.email);
    const before = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    await call(h, 'POST', `${ADMIN_USERS}/${u.id}/unlock`, adminB.token, {
      currentPassword: PASSWORD,
    }).expect(404);
    const after = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect([after.failedLogins, after.lockedUntil]).toEqual([
      before.failedLogins,
      before.lockedUntil,
    ]);
    expect(after.lockedUntil).not.toBeNull();
    for (const path of [ADMIN_USERS, lockEventsPath]) {
      const list = await call(h, 'GET', path, adminB.token).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(u.id);
      expect(JSON.stringify(list.body)).not.toContain(u.email);
    }
  });

  it('TC-002: GET /admin/users/lock-events lists one event per lock, newest first, with the contracted fields, for SUPER_ADMIN only and scoped to the org', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const first = await createUser(h);
    const second = await createUser(h);
    await lockOut(first.email);
    await lockOut(second.email);
    await login(h, second.email).expect(401); // more attempts while locked add no event
    const res = await call(h, 'GET', `${lockEventsPath}?page=1&pageSize=100`, admin.token).expect(
      200,
    );
    const body = res.body as {
      items: { id: string; userId: string; email: string; name: string; lockedAt: string }[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(Object.keys(body).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    const mine = body.items.filter((i) => [first.id, second.id].includes(i.userId));
    expect(mine.map((i) => i.userId)).toEqual([second.id, first.id]); // newest first, one each
    for (const item of mine) {
      expect(Object.keys(item).sort()).toEqual(['email', 'id', 'lockedAt', 'name', 'userId']);
      expect(typeof item.id).toBe('string');
      expect(Math.abs(Date.now() - new Date(item.lockedAt).getTime())).toBeLessThan(60_000);
    }
    expect(mine[0]?.email).toBe(second.email);
    expect(lockKeysIn(res.body)).toEqual([]);
    const paged = (
      await call(h, 'GET', `${lockEventsPath}?page=1&pageSize=1`, admin.token).expect(200)
    ).body as typeof body;
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBeGreaterThanOrEqual(2);
    await call(h, 'GET', `${lockEventsPath}?pageSize=101`, admin.token).expect(400);
  });
});
