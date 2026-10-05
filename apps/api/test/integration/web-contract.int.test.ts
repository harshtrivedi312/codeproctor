// Contract check between the web app's OpenAPI file (apps/web/openapi/openapi.yaml, which the
// frontend mocks follow) and the real API: every /v1/auth route the web calls must exist on the API
// when the web base URL points at it, and the login and session bodies must have the fields the web
// reads. Cases: FR-101, FR-102, FR-104, FR-107 (the TC-001, TC-003, TC-098 browser flows depend on it).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authenticator } from 'otplib';
import request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import {
  API,
  Body,
  boot,
  createUser,
  expectNoTotpEnabled,
  Harness,
  login,
  refresh,
  refreshCookie,
  sessionUser,
  TOTP_SECRET,
} from '../support/harness';

function webAuthRoutes(): { method: string; path: string }[] {
  const yaml = readFileSync(resolve(__dirname, '../../../web/openapi/openapi.yaml'), 'utf8').split(
    '\n',
  );
  const routes: { method: string; path: string }[] = [];
  let current: string | null = null;
  for (const line of yaml) {
    const p = /^ {2}(\/v1\/auth\/[^:]+):\s*$/.exec(line);
    if (p) current = p[1] ?? null;
    else if (/^ {2}\S/.test(line)) current = null;
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m && current) routes.push({ method: m[1] ?? 'get', path: current });
  }
  return routes;
}

describe('Web OpenAPI contract against the real API (FR-101, FR-102, FR-104, FR-107)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('FR-101: the web file lists the auth routes this test relies on', () => {
    const paths = webAuthRoutes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'post /v1/auth/login',
        'post /v1/auth/2fa/verify',
        'post /v1/auth/refresh',
        'post /v1/auth/password/forgot',
        'post /v1/auth/password/reset',
      ]),
    );
  });

  it('FR-101: every auth route the web calls is served by the API under the /api prefix', async () => {
    const notFound: string[] = [];
    for (const r of webAuthRoutes()) {
      const res = await (
        request(h.app.getHttpServer()) as unknown as Record<string, (u: string) => request.Test>
      )[r.method]!(`/api${r.path}`).send({});
      if (res.status === 404) notFound.push(`${r.method.toUpperCase()} /api${r.path}`);
    }
    expect(notFound).toEqual([]);
  });

  // QA-D-02: the web default API URL has no /api prefix, so its own paths miss the API.
  it('FR-101: the web paths exactly as written in the OpenAPI file (no /api prefix) are not served, so NEXT_PUBLIC_API_URL must end in /api', async () => {
    await request(h.app.getHttpServer()).post('/v1/auth/login').send({}).expect(404);
  });

  it('FR-104: the login session and the refresh response carry the user fields the web reads (id, email, name, role, orgName)', async () => {
    const u = await createUser(h);
    const res = await login(h, u.email).expect(200);
    const user = sessionUser(res.body as Body);
    const wanted = ['id', 'email', 'name', 'role', 'orgName'];
    expect(wanted.filter((f) => typeof user[f] !== 'string')).toEqual([]);
    const refreshed = sessionUser((await refresh(h, refreshCookie(res)).expect(200)).body as Body);
    expect(wanted.filter((f) => typeof refreshed[f] !== 'string')).toEqual([]);
  });

  it('FR-102: every session user (login, refresh) carries a boolean totpEnabled: false for a user without 2FA', async () => {
    const u = await createUser(h);
    const res = await login(h, u.email).expect(200);
    const user = sessionUser(res.body as Body);
    expect(typeof user.totpEnabled).toBe('boolean');
    expect(user.totpEnabled).toBe(false);
    const refreshed = sessionUser((await refresh(h, refreshCookie(res)).expect(200)).body as Body);
    expect(typeof refreshed.totpEnabled).toBe('boolean');
    expect(refreshed.totpEnabled).toBe(false);
  });

  it('FR-102: 2fa/verify, enroll/confirm and refresh carry totpEnabled: true; challenge and error bodies never carry it', async () => {
    const post = (path: string): request.Test =>
      request(h.app.getHttpServer()).post(`${API}/auth/${path}`);

    // Existing TOTP user: challenge has none, verify and refresh say true.
    const t = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
    const challenge = await login(h, t.email).expect(200);
    expect((challenge.body as Body).status).toBe('two_factor_required');
    expectNoTotpEnabled(challenge);
    const wrong = await post('2fa/verify')
      .send({ challengeToken: (challenge.body as Body).challengeToken, code: '000000' })
      .expect(400);
    expectNoTotpEnabled(wrong);
    const verified = await post('2fa/verify')
      .send({
        challengeToken: (challenge.body as Body).challengeToken,
        code: authenticator.generate(TOTP_SECRET),
      })
      .expect(200);
    const vUser = sessionUser(verified.body as Body);
    expect(typeof vUser.totpEnabled).toBe('boolean');
    expect(vUser.totpEnabled).toBe(true);
    const rUser = sessionUser((await refresh(h, refreshCookie(verified)).expect(200)).body as Body);
    expect(typeof rUser.totpEnabled).toBe('boolean');
    expect(rUser.totpEnabled).toBe(true);

    // Forced enrolment: challenge has none, confirm says true (the row was just updated).
    const r = await createUser(h, { role: UserRole.REVIEWER });
    const enrol = await login(h, r.email).expect(200);
    expect((enrol.body as Body).status).toBe('two_factor_enrollment_required');
    expectNoTotpEnabled(enrol);
    const challengeToken = (enrol.body as Body).challengeToken;
    const start = (await post('2fa/enroll/start').send({ challengeToken }).expect(200))
      .body as Body;
    expectNoTotpEnabled(
      await post('2fa/enroll/confirm').send({ challengeToken, code: '000000' }).expect(400),
    );
    const done = await post('2fa/enroll/confirm')
      .send({ challengeToken, code: authenticator.generate(start.manualKey) })
      .expect(200);
    const eUser = sessionUser(done.body as Body);
    expect(typeof eUser.totpEnabled).toBe('boolean');
    expect(eUser.totpEnabled).toBe(true);

    // Error bodies.
    expectNoTotpEnabled(await login(h, t.email, 'wrong-password-1').expect(401));
    expectNoTotpEnabled(await post('refresh').expect(401));
  });
});
