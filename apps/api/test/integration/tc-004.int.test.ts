// TC-004 (FR-103): RBAC enforcement. Expected: a recruiter calling PATCH /questions/:id directly
// gets 403 and nothing changes. The question routes arrive with BE-04, so the end-to-end case is
// recorded as a todo (the recruiter PATCH case now runs in tc-004-rbac.int.test.ts); what exists today is tested: deny by default on every registered route,
// forged and expired tokens, a challenge token that is not a session, and a role claim that the
// server (not the client) decides.
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { IS_PUBLIC, ROLES } from '../../src/common/auth/decorators';
import { UserRole } from '../../src/generated/prisma/client';
import { hash } from '@node-rs/argon2';
import {
  API,
  Body,
  boot,
  createUser,
  Harness,
  login,
  PASSWORD,
  signIn,
  signInWithTotp,
  TOTP_SECRET,
} from '../support/harness';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
// Nest stores the HTTP verb as the RequestMethod enum index in 'method'.
const VERB = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

describe('TC-004 (FR-103): RBAC enforcement', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('TC-004: every registered route is either @Public() or lists its allowed roles (permissions are checked on every route)', () => {
    // The app was built from a fresh module registry (jest.resetModules), so use the same one.
    const { ModulesContainer } = jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core');
    const modules = h.app.get(ModulesContainer);
    const missing: string[] = [];
    let seen = 0;
    for (const mod of modules.values()) {
      for (const wrapper of mod.controllers.values()) {
        const proto = (wrapper.metatype as { prototype: Record<string, unknown> }).prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (typeof handler !== 'function') continue;
          const verb = Reflect.getMetadata('method', handler) as number | undefined;
          if (verb === undefined) continue; // not a route
          seen++;
          const isPublic = (Reflect.getMetadata(IS_PUBLIC, handler) ??
            Reflect.getMetadata(IS_PUBLIC, wrapper.metatype as object)) as boolean | undefined;
          const roles = (Reflect.getMetadata(ROLES, handler) ??
            Reflect.getMetadata(ROLES, wrapper.metatype as object)) as UserRole[] | undefined;
          if (!isPublic && !(roles && roles.length > 0)) {
            missing.push(`${VERB[verb]} ${wrapper.metatype?.name}.${name}`);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });

  it('TC-004: the staff routes that exist refuse a call with no token, a malformed token and a token signed with another key', async () => {
    const u = await createUser(h);
    const real = (await login(h, u.email).expect(200)).body as Body;
    const forged = jwt.sign(
      { sub: u.id, org: h.orgId, role: 'SUPER_ADMIN', kind: 'access' },
      'a-different-secret-that-is-at-least-32-chars-long',
      { expiresIn: 900 },
    );
    const none =
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
      '.' +
      Buffer.from(
        JSON.stringify({ sub: u.id, org: h.orgId, role: 'SUPER_ADMIN', kind: 'access' }),
      ).toString('base64url') +
      '.';
    for (const bearer of [undefined, 'garbage', forged, none]) {
      const req = request(h.app.getHttpServer())
        .post(`${API}/auth/2fa/setup/start`)
        .send({ currentPassword: PASSWORD });
      if (bearer !== undefined) req.set('Authorization', `Bearer ${bearer}`);
      await req.expect(401);
    }
    // And the genuine token still works, so the 401s above are about the token and not the route.
    await request(h.app.getHttpServer())
      .post(`${API}/auth/2fa/setup/start`)
      .set('Authorization', `Bearer ${real.session.accessToken}`)
      .send({ currentPassword: PASSWORD })
      .expect(200);
  });

  it('TC-004: an expired access token is refused', async () => {
    const u = await createUser(h);
    const expired = jwt.sign(
      { sub: u.id, org: h.orgId, role: 'RECRUITER', kind: 'access' },
      process.env.JWT_ACCESS_SECRET ?? '',
      { expiresIn: -10 },
    );
    await request(h.app.getHttpServer())
      .post(`${API}/auth/2fa/setup/start`)
      .set('Authorization', `Bearer ${expired}`)
      .send({ currentPassword: PASSWORD })
      .expect(401);
  });

  describe('TC-004: the guard re-reads the user on every request (FU-BE-19), so a token never outlives the account state it was issued for', () => {
    const probe = (auth: { Authorization: string }): request.Test =>
      request(h.app.getHttpServer())
        .post(`${API}/auth/2fa/setup/start`)
        .set(auth)
        .send({ currentPassword: PASSWORD });

    it('TC-004: a deactivated user is refused at once with a still-valid token', async () => {
      const u = await createUser(h);
      const auth = await signIn(h, u.email);
      await h.owner.user.update({ where: { id: u.id }, data: { isActive: false } });
      await probe(auth).expect(401);
    });

    it('TC-004: a role change takes effect at once: a token minted as SUPER_ADMIN stops opening the super admin route', async () => {
      const u = await createUser(h, { role: UserRole.SUPER_ADMIN, totp: TOTP_SECRET });
      const auth = await signInWithTotp(h, u.email);
      const target = '00000000-0000-4000-8000-000000000000';
      const reset = (): request.Test =>
        request(h.app.getHttpServer())
          .post(`${API}/auth/2fa/reset/${target}`)
          .set(auth)
          .send({ currentPassword: PASSWORD });
      expect((await reset()).status).toBe(404); // allowed through the guard, no such user
      await h.owner.user.update({ where: { id: u.id }, data: { role: UserRole.RECRUITER } });
      await reset().expect(401); // claim no longer matches the stored role
    });

    it('TC-004: moving the user to another organization invalidates the token', async () => {
      const u = await createUser(h);
      const auth = await signIn(h, u.email);
      const other = await h.owner.organization.create({ data: { name: 'QA Org C' } });
      await h.owner.user.update({ where: { id: u.id }, data: { orgId: other.id } });
      await probe(auth).expect(401);
    });

    it('TC-004: a password change invalidates access tokens issued before it', async () => {
      const u = await createUser(h);
      const auth = await signIn(h, u.email);
      await h.owner.user.update({
        where: { id: u.id },
        data: { passwordHash: await hash('Another-Passphrase-42', { algorithm: 2 }) },
      });
      await probe(auth).expect(401);
    });

    it('TC-004: a 2FA challenge token is not a session', async () => {
      const u = await createUser(h, { role: UserRole.REVIEWER });
      const { challengeToken } = (await login(h, u.email).expect(200)).body as Body;
      await probe({ Authorization: `Bearer ${challengeToken}` }).expect(401);
    });
  });

  it('TC-004: an unauthenticated call to a route from the FSD route table is never answered with data', async () => {
    // Routes not built yet answer 404; once built they must answer 401. Either way no 2xx.
    const calls: [string, string][] = [
      ['PATCH', '/questions/00000000-0000-4000-8000-000000000000'],
      ['GET', '/questions'],
      ['POST', '/tests'],
      ['GET', '/review/queue'],
      ['GET', '/review/sessions/00000000-0000-4000-8000-000000000000'],
      ['POST', '/review/sessions/00000000-0000-4000-8000-000000000000/verdict'],
    ];
    for (const [method, path] of calls) {
      expect(METHODS).toContain(method);
      const res = await request(h.app.getHttpServer())[method.toLowerCase() as 'get'](
        `${API}${path}`,
      );
      expect([401, 404]).toContain(res.status);
    }
  });

  // The reviewer POST /tests case runs in tc-004-rbac.int.test.ts since BE-06 (slice 6a).
  it.todo('TC-004: author cannot POST /review/sessions/:id/verdict (needs BE-13)');
});
