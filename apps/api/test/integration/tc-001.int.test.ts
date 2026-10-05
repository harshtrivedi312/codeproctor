// TC-001 (FR-101, FR-104): valid staff login. Written from docs/test-cases.md and docs/fsd.md.
// Expected result: "2FA prompt (if enabled) or dashboard", i.e. a session for a user without 2FA
// and a 2FA challenge (no session) for a user with it.
import { authenticator } from 'otplib';
import request from 'supertest';
import { UserRole } from '../../src/generated/prisma/client';
import {
  API,
  Body,
  boot,
  claimsOf,
  createUser,
  Harness,
  login,
  refreshCookie,
  TOTP_SECRET,
} from '../support/harness';

describe('TC-001 (FR-101): valid staff login', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('TC-001: a recruiter with the right password gets a 15 minute access token carrying role and org (FR-104)', async () => {
    const u = await createUser(h, { role: UserRole.RECRUITER });
    const res = await login(h, u.email).expect(200);
    const body = res.body as Body;
    expect(body.status).toBe('authenticated');
    // The shape the web app's OpenAPI contract expects (AuthSession).
    expect(body.session.user).toEqual({
      id: u.id,
      email: u.email,
      name: expect.any(String),
      role: 'RECRUITER',
      orgName: 'QA Org A',
    });
    const claims = claimsOf(body.session.accessToken);
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(claims.role).toBe('RECRUITER');
    expect(claims.org).toBe(h.orgId);
  });

  it.each([UserRole.RECRUITER, UserRole.AUTHOR])(
    'TC-001: a %s without 2FA reaches a session directly (no 2FA prompt)',
    async (role) => {
      const u = await createUser(h, { role });
      const body = (await login(h, u.email).expect(200)).body as Body;
      expect(body.status).toBe('authenticated');
      expect(body.challengeToken).toBeUndefined();
    },
  );

  it('TC-001: a user with TOTP gets the 2FA prompt and no session or cookie until the code is verified', async () => {
    const u = await createUser(h, { role: UserRole.AUTHOR, totp: TOTP_SECRET });
    const first = await login(h, u.email).expect(200);
    const body = first.body as Body;
    expect(body.status).toBe('two_factor_required');
    expect(body.session).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
    expect(first.headers['set-cookie']).toBeUndefined();
    // A challenge token is not a session.
    await request(h.app.getHttpServer())
      .post(`${API}/auth/2fa/setup/start`)
      .set('Authorization', `Bearer ${body.challengeToken}`)
      .expect(401);

    const done = await request(h.app.getHttpServer())
      .post(`${API}/auth/2fa/verify`)
      .send({ challengeToken: body.challengeToken, code: authenticator.generate(TOTP_SECRET) })
      .expect(200);
    expect((done.body as Body).accessToken).toEqual(expect.any(String));
    expect(refreshCookie(done)).toMatch(/^cp_refresh=/);
  });

  it('TC-001: the refresh token is an httpOnly, Secure, SameSite=Strict cookie that expires in 7 days and is stored only as a hash (FR-104)', async () => {
    const u = await createUser(h);
    const res = await login(h, u.email).expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cp_refresh='),
    );
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const [row] = await h.owner.refreshToken.findMany({ where: { userId: u.id } });
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const days = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    // The raw token is not what the database holds.
    expect(decodeURIComponent(cookie ?? '')).not.toContain(row?.tokenHash ?? 'x');
  });

  it('TC-001: the login response never carries a password hash, TOTP secret or recovery codes', async () => {
    const u = await createUser(h, { role: UserRole.RECRUITER });
    const res = await login(h, u.email).expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/argon2|passwordHash|totpSecret|recoveryCode/i);
  });

  it('FR-101: stored passwords are Argon2id', async () => {
    const u = await createUser(h);
    const row = await h.owner.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('TC-001: wrong password, unknown email, deactivated user and pending invite give one identical 401', async () => {
    const ok = await createUser(h);
    const off = await createUser(h);
    await h.owner.user.update({ where: { id: off.id }, data: { isActive: false } });
    const pending = await createUser(h, { password: null });
    const answers = [
      await login(h, ok.email, 'wrong-password-1').expect(401),
      await login(h, 'nobody@example.com').expect(401),
      await login(h, off.email).expect(401),
      await login(h, pending.email, 'anything-at-all').expect(401),
    ];
    for (const a of answers) {
      expect((a.body as Body).detail).toBe((answers[0]?.body as Body).detail);
      expect(a.headers['set-cookie']).toBeUndefined();
    }
  });

  it('TC-001: malformed login bodies are 400 problem+json, not a 500', async () => {
    for (const payload of [{}, { email: 'not-an-email', password: 'x' }, { email: 'a@b.co' }]) {
      const res = await request(h.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send(payload)
        .expect(400);
      expect(res.headers['content-type']).toMatch(/json/);
    }
  });
});
