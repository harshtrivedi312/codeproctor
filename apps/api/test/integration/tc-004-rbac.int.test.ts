// TC-004 (FR-103): RBAC enforcement, table-driven from the packages/shared permission matrix
// (ROLE_PERMISSIONS, hasPermission) and the BE-03 route list in support/be03-routes.ts.
// Per route and role: no token and bad tokens 401; a role without the permission 403 and nothing
// changes; a user of another org 404 and nothing changes; an allowed role succeeds.
//
// The tests marked "[BE-03 pending]" are real but switched off until BE-03's routes exist:
// set BE03_READY = true in support/be03-routes.ts (or run with BE03_READY=1). Same for
// "[BE-13 pending]" and BE13_READY. The matrix-only tests at the top always run.
// Contract: the FINAL BE-03 routes under /admin/users (see support/be03-routes.ts). The three
// mutating routes need the acting admin's own currentPassword; a wrong one is 403 REAUTH_FAILED
// and the 404 for a missing or other-org id is only given after a correct password.
import jwt from 'jsonwebtoken';
import { ModulesContainer } from '@nestjs/core';
import { UserRole } from '../../src/generated/prisma/client';
import {
  Body,
  boot,
  createUser,
  expectReauthFailed,
  Harness,
  login,
  PASSWORD,
  signInWithTotp,
  stableProblem,
} from '../support/harness';
import { actor, Actor, call } from '../support/be03-helpers';
import {
  ADMIN_USERS,
  allowedRoles,
  BE03_READY,
  BE03_ROUTES,
  BE13_READY,
  Be03Route,
  COVERED_ELSEWHERE,
  hasPathId,
  loadBackendRegistry,
  PRINCIPALS,
  randomIdOf,
  routeKey,
  routeLabel,
  routesFor,
  sessionFixture,
  USER_ROLES,
  withReplacedId,
} from '../support/be03-routes';
import { hasPermission } from '../../../../packages/shared/src/permissions';

describe('TC-004 (FR-103): permission matrix and route list agree (always runs)', () => {
  it('TC-004: every route in the BE-03 list names a permission that exists, and some role holds it', () => {
    for (const r of BE03_ROUTES) {
      expect(PRINCIPALS.some((p) => hasPermission(p, r.permission))).toBe(true);
    }
  });

  it('TC-004: CANDIDATE and SERVICE hold no staff route permission (deny by default)', () => {
    for (const r of BE03_ROUTES) {
      expect(hasPermission('CANDIDATE', r.permission)).toBe(false);
      expect(hasPermission('SERVICE', r.permission)).toBe(false);
    }
  });

  it('TC-004: staff user management is SUPER_ADMIN only (FR-103, backend.md Step 3)', () => {
    for (const r of BE03_ROUTES.filter((x) => x.permission === 'user:manage')) {
      expect(allowedRoles(r.permission)).toEqual([UserRole.SUPER_ADMIN]);
    }
  });

  it('TC-004: every route that is audited or mutating is in the list with a permission (no unlisted mutation)', () => {
    for (const r of BE03_ROUTES.filter((x) => x.mutating)) {
      expect(r.audit).not.toBeNull();
    }
  });
});

function rbacSuite(title: string, ready: boolean, routes: Be03Route[]): void {
  const suite = ready ? describe : describe.skip;
  suite(title, () => {
    let h: Harness;
    let orgB: string;
    let challengeToken: string;
    const byRole = {} as Record<UserRole, Actor>;
    const orgBActors: Partial<Record<UserRole, Actor>> = {};
    const orgBActor = async (role: UserRole): Promise<Actor> =>
      (orgBActors[role] ??= await actor(h, role, orgB));

    beforeAll(async () => {
      h = await boot();
      for (const role of USER_ROLES) byRole[role] = await actor(h, UserRole[role]);
      orgB = (await h.owner.organization.create({ data: { name: 'QA Org B' } })).id;
      // A 2FA challenge token is signed with a staff secret but is not a session (FR-102).
      const reviewer = await createUser(h, { role: UserRole.REVIEWER });
      challengeToken = ((await login(h, reviewer.email).expect(200)).body as Body).challengeToken;
    });
    afterAll(async () => {
      await h?.close();
    });

    const expired = (): string =>
      jwt.sign(
        { sub: byRole.SUPER_ADMIN.id, org: h.orgId, role: 'SUPER_ADMIN', kind: 'access' },
        process.env.JWT_ACCESS_SECRET ?? '',
        { expiresIn: -10 },
      );
    const forged = (): string =>
      jwt.sign(
        { sub: byRole.SUPER_ADMIN.id, org: h.orgId, role: 'SUPER_ADMIN', kind: 'access' },
        'a-different-secret-that-is-at-least-32-chars-long',
        { expiresIn: 900 },
      );

    describe.each(routes.map((r) => [r.id, r] as const))('%s', (_id, route) => {
      const label = routeLabel(route);
      const holders = USER_ROLES.filter((r) => hasPermission(r, route.permission));

      it(`TC-004: ${label} gives 401 with no token, a garbage token, a forged token, an expired token and a 2FA challenge token`, async () => {
        const t = await route.prepare(h, h.orgId);
        for (const token of [undefined, 'garbage', forged(), expired(), challengeToken]) {
          await call(h, route.method, t.path, token, t.body).expect(401);
        }
        expect(await t.unchanged()).toBe(true);
      });

      it.each(USER_ROLES.map((r) => [r] as const))(
        `TC-004: ${label} as %s follows the matrix (permission ${route.permission})`,
        async (role) => {
          const t = await route.prepare(h, h.orgId);
          const res = await call(h, route.method, t.path, byRole[role].token, t.body);
          if (hasPermission(role, route.permission)) {
            expect(route.ok).toContain(res.status);
            // A success must have an effect; a status code alone proves nothing.
            if (route.mutating) expect(await t.unchanged()).toBe(false);
          } else {
            expect(res.status).toBe(403);
            expect(await t.unchanged()).toBe(true);
          }
        },
      );

      it.each(holders.map((r) => [r] as const))(
        `TC-004 TC-008: ${label} as org B %s on an org A target is 404, leaks nothing and changes nothing`,
        async (role) => {
          const caller = await orgBActor(role);
          if (hasPathId(route)) {
            const t = await route.prepare(h, h.orgId);
            const res = await call(h, route.method, t.path, caller.token, t.body);
            expect(res.status).toBe(404);
            expect(JSON.stringify(res.body)).not.toContain(h.orgId);
            expect(JSON.stringify(res.body)).not.toContain(t.entityId ?? 'no-entity');
            expect(await t.unchanged()).toBe(true);
          } else {
            // No id in the path: the call must act inside the caller's org only. Seed org A with
            // known rows and assert none of them appears in the answer (not only the org id).
            const leaks = Object.values(byRole).flatMap((a) => [a.id, a.email]);
            if (route.template.startsWith('/review')) {
              leaks.push((await sessionFixture(h, h.orgId)).sessionId);
            }
            const t = await route.prepare(h, orgB);
            const res = await call(h, route.method, t.path, caller.token, t.body);
            expect(route.ok).toContain(res.status);
            const text = JSON.stringify(res.body);
            for (const x of [...leaks, h.orgId]) expect(text).not.toContain(x);
          }
        },
      );

      if (hasPathId(route)) {
        it(`TC-004 TC-008: ${label} gives the same 404 for another org's id and for a random id (no existence oracle)`, async () => {
          const holder = holders[0];
          if (holder === undefined) throw new Error(`no role holds ${route.permission}`);
          const caller = await orgBActor(holder);
          const t = await route.prepare(h, h.orgId);
          const realId = t.entityId;
          if (!realId) throw new Error(`${route.id}: prepare() must set entityId for an id route`);
          const randomId = randomIdOf(route.idKind ?? 'uuid');
          const missingPath = withReplacedId(t.path, realId, randomId);
          expect(missingPath).not.toBe(t.path); // the id segment really was replaced
          const cross = await call(h, route.method, t.path, caller.token, t.body);
          const missing = await call(h, route.method, missingPath, caller.token, t.body);
          expect(cross.status).toBe(404);
          expect(missing.status).toBe(404);
          // Compare the bodies with the volatile and id-bearing parts removed.
          const norm = (res: { body: unknown }, id: string): string =>
            JSON.stringify(stableProblem(res as never))
              .split(id)
              .join('ID');
          expect(norm(cross, realId)).toBe(norm(missing, randomId));
        });
      }

      if (route.reauth) {
        it(`TC-004 FR-102: ${label} without currentPassword is 400 and with a wrong, or another user's, password is 403 REAUTH_FAILED, nothing changed`, async () => {
          const admin = byRole.SUPER_ADMIN;
          const t = await route.prepare(h, h.orgId);
          const body = t.body as Record<string, unknown>;
          const { currentPassword: _dropped, ...without } = body;
          void _dropped;
          await call(h, route.method, t.path, admin.token, without).expect(400);
          const wrong = await call(h, route.method, t.path, admin.token, {
            ...body,
            currentPassword: 'Wrong-Password-1',
          });
          expectReauthFailed(wrong);
          // The password is checked before the target exists for the caller: an org B admin with a
          // wrong password gets the same 403 for an org A id, not a 404 (no existence oracle).
          const crossWrong = await call(
            h,
            route.method,
            t.path,
            (await orgBActor('SUPER_ADMIN')).token,
            {
              ...body,
              currentPassword: 'Wrong-Password-1',
            },
          );
          expectReauthFailed(crossWrong);
          expect(stableProblem(crossWrong)).toEqual(stableProblem(wrong));
          // The same applies to an id that does not exist at all.
          if (hasPathId(route) && t.entityId) {
            const missing = await call(
              h,
              route.method,
              withReplacedId(t.path, t.entityId, randomIdOf(route.idKind ?? 'uuid')),
              admin.token,
              { ...body, currentPassword: 'Wrong-Password-1' },
            );
            expectReauthFailed(missing);
            expect(stableProblem(missing)).toEqual(stableProblem(wrong));
          }
          expect(await t.unchanged()).toBe(true);
        });
      }
    });
  });
}

rbacSuite(
  'TC-004 [BE-03 pending]: BE-03 routes by role (401, 403, 404, success)',
  BE03_READY,
  routesFor('BE-03'),
);
rbacSuite(
  'TC-004 [BE-13 pending]: review routes by role (401, 403, 404, success)',
  BE13_READY,
  routesFor('BE-13'),
);

(BE03_READY ? describe : describe.skip)(
  'TC-004 [BE-03 pending]: route registry matches the QA list',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('TC-004 [BE-03 pending]: the backend matrix agrees with the controllers, and every non-public route is in the QA route list or covered in tc-003', () => {
      const { ROUTE_PERMISSIONS, listRoutes, matrixProblems } = loadBackendRegistry();
      const routes = listRoutes(h.app.get(ModulesContainer));
      expect(matrixProblems(routes)).toEqual([]);

      const listed = new Set(BE03_ROUTES.map(routeKey));
      const missing = Object.entries(ROUTE_PERMISSIONS)
        .filter(([key, access]) => access !== 'public' && !COVERED_ELSEWHERE.includes(key))
        .map(([key]) => key)
        .filter((key) => !listed.has(key));
      // A new backend route with no QA entry fails here: add it to be03-routes.ts with its audit
      // action, body and fixtures (or to COVERED_ELSEWHERE with the file that tests it).
      expect(missing).toEqual([]);

      // Every BE-03 route QA lists is served, with the permission QA expects.
      for (const r of routesFor('BE-03')) {
        const entry = ROUTE_PERMISSIONS[routeKey(r)];
        expect(entry).toBeDefined();
        expect(entry === 'public' ? 'public' : entry?.permission).toBe(r.permission);
      }
      // Staff user routes are SUPER_ADMIN only in the matrix itself.
      for (const [key, access] of Object.entries(ROUTE_PERMISSIONS)) {
        if (access !== 'public' && access.permission === 'user:manage') {
          expect([key, access.roles]).toEqual([key, ['SUPER_ADMIN']]);
        }
      }
    });

    it('TC-004 TC-006 [BE-03 pending]: the matrix `audited` flag agrees with the QA audit list (checked once the flag exists)', () => {
      const { ROUTE_PERMISSIONS } = loadBackendRegistry();
      const entries = Object.entries(ROUTE_PERMISSIONS).flatMap(([key, a]) =>
        a === 'public' ? [] : [[key, a] as const],
      );
      if (!entries.some(([, a]) => typeof a.audited === 'boolean')) {
        console.warn('[BE-03 pending] ROUTE_PERMISSIONS has no `audited` flag yet; check skipped');
        return;
      }
      for (const [key, access] of entries) {
        expect([key, typeof access.audited]).toEqual([key, 'boolean']); // every entry must say
        const mine = BE03_ROUTES.filter((r) => routeKey(r) === key);
        if (mine.length > 0) {
          expect([key, access.audited]).toEqual([key, mine.some((r) => r.audit !== null)]);
        }
      }
    });
  },
);

(BE03_READY ? describe : describe.skip)('TC-004 [BE-03 pending]: guard coverage', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  const patch = (admin: Actor, id: string, body: object) =>
    call(h, 'PATCH', `${ADMIN_USERS}/${id}`, admin.token, { currentPassword: PASSWORD, ...body });

  it('TC-004 [BE-03 pending]: a deactivated user is refused on the next call even with an unexpired token (FR-103)', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const victim = await actor(h, UserRole.SUPER_ADMIN);
    await h.owner.user.update({ where: { id: victim.id }, data: { isActive: false } });
    await call(h, 'GET', ADMIN_USERS, admin.token).expect(200);
    await call(h, 'GET', ADMIN_USERS, victim.token).expect(401);
  });

  it('TC-004 [BE-03 pending]: a role changed directly in the database is not trusted from the token (stale SUPER_ADMIN token loses access at once)', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    await h.owner.user.update({ where: { id: admin.id }, data: { role: UserRole.RECRUITER } });
    // The guard re-reads the user on every request (tc-004.int.test.ts, FU-BE-19): 401.
    await call(h, 'GET', ADMIN_USERS, admin.token).expect(401);
  });

  it('TC-004 [BE-03 pending]: an access token issued before a deactivate then reactivate is still refused (401), a fresh sign-in works', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const victim = await actor(h, UserRole.SUPER_ADMIN);
    await call(h, 'GET', ADMIN_USERS, victim.token).expect(200);
    await patch(admin, victim.id, { active: false }).expect(200);
    await call(h, 'GET', ADMIN_USERS, victim.token).expect(401);
    await patch(admin, victim.id, { active: true }).expect(200);
    // Deactivation ended the token for good: reactivating the account does not revive it.
    await call(h, 'GET', ADMIN_USERS, victim.token).expect(401);
    const fresh = await signInWithTotp(
      h,
      (await h.owner.user.findUniqueOrThrow({ where: { id: victim.id } })).email,
    );
    await call(h, 'GET', ADMIN_USERS, fresh.Authorization.replace('Bearer ', '')).expect(200);
  });

  it('TC-004 [BE-03 pending]: an access token issued before a role flip is refused (401) after the demotion and still after the role is restored', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const victim = await actor(h, UserRole.SUPER_ADMIN);
    await call(h, 'GET', ADMIN_USERS, victim.token).expect(200);
    await patch(admin, victim.id, { role: 'AUTHOR' }).expect(200);
    await call(h, 'GET', ADMIN_USERS, victim.token).expect(401);
    await patch(admin, victim.id, { role: 'SUPER_ADMIN' }).expect(200);
    await call(h, 'GET', ADMIN_USERS, victim.token).expect(401); // the claim matches again, the token is still stale
    const fresh = await signInWithTotp(h, victim.email);
    await call(h, 'GET', ADMIN_USERS, fresh.Authorization.replace('Bearer ', '')).expect(200);
  });

  it('TC-004 [BE-03 pending]: a deactivation or role change revokes the refresh sessions of the target', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const victim = await createUser(h, { role: UserRole.AUTHOR });
    await login(h, victim.email).expect(200);
    expect(
      await h.owner.refreshToken.count({ where: { userId: victim.id, revokedAt: null } }),
    ).toBeGreaterThan(0);
    await patch(admin, victim.id, { active: false }).expect(200);
    expect(
      await h.owner.refreshToken.count({ where: { userId: victim.id, revokedAt: null } }),
    ).toBe(0);
  });

  it('TC-004 [BE-03 pending]: 429 once an organization sends too many invites, and the limit is per organization (another org is not slowed)', async () => {
    const orgC = (await h.owner.organization.create({ data: { name: 'QA Org C rate' } })).id;
    const orgD = (await h.owner.organization.create({ data: { name: 'QA Org D rate' } })).id;
    const adminC = await actor(h, UserRole.SUPER_ADMIN, orgC);
    const adminD = await actor(h, UserRole.SUPER_ADMIN, orgD);
    const invite = (a: Actor, email: string) =>
      call(h, 'POST', ADMIN_USERS, a.token, {
        email,
        name: 'Rate Test',
        role: 'RECRUITER',
        currentPassword: PASSWORD,
      });
    let created = 0;
    let limited: Awaited<ReturnType<typeof invite>> | undefined;
    const emailOf = (i: number): string => `qa-rate-${i}-${Date.now()}@example.com`;
    for (let i = 0; i < 300 && !limited; i++) {
      const res = await invite(adminC, emailOf(i));
      if (res.status === 429) limited = res;
      else {
        expect(res.status).toBe(201);
        created++;
      }
    }
    expect(limited).toBeDefined(); // a finite per-org limit exists
    expect(created).toBeGreaterThan(0);
    expect(limited?.headers['content-type']).toContain('application/problem+json');
    // The refused call created nothing.
    expect(await h.owner.user.count({ where: { orgId: orgC, role: UserRole.RECRUITER } })).toBe(
      created,
    );
    // Another org, same client IP: not limited.
    await invite(adminD, emailOf(9999)).expect(201);
  });

  it('TC-004 [BE-03 pending]: GET /admin/users has the contracted shape, statuses and pagination', async () => {
    const orgE = (await h.owner.organization.create({ data: { name: 'QA Org E list' } })).id;
    const admin = await actor(h, UserRole.SUPER_ADMIN, orgE);
    const active = await createUser(h, { orgId: orgE });
    const invited = await createUser(h, { orgId: orgE, password: null });
    const gone = await createUser(h, { orgId: orgE });
    await h.owner.user.update({ where: { id: gone.id }, data: { isActive: false } });

    const res = await call(h, 'GET', `${ADMIN_USERS}?page=1&pageSize=100`, admin.token).expect(200);
    const body = res.body as {
      items: Record<string, unknown>[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(Object.keys(body).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect([body.page, body.pageSize, body.total]).toEqual([1, 100, 4]);
    const statusOf = (id: string): unknown => body.items.find((i) => i.id === id)?.status;
    expect(statusOf(active.id)).toBe('active');
    expect(statusOf(invited.id)).toBe('invited');
    expect(statusOf(gone.id)).toBe('deactivated');
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'locked',
        'lockedUntil',
        'name',
        'role',
        'status',
        'totpEnabled',
      ]);
      expect(new Date(item.createdAt as string).toISOString()).toBe(item.createdAt);
    }
    const page1 = (
      await call(h, 'GET', `${ADMIN_USERS}?page=1&pageSize=2`, admin.token).expect(200)
    ).body as typeof body;
    const page2 = (
      await call(h, 'GET', `${ADMIN_USERS}?page=2&pageSize=2`, admin.token).expect(200)
    ).body as typeof body;
    expect([page1.items.length, page2.items.length, page1.total, page2.total]).toEqual([
      2, 2, 4, 4,
    ]);
    const ids = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(4);
    const beyond = (
      await call(h, 'GET', `${ADMIN_USERS}?page=3&pageSize=2`, admin.token).expect(200)
    ).body as typeof body;
    expect(beyond.items).toEqual([]);
    for (const q of ['page=0', 'pageSize=0', 'pageSize=101', 'page=abc', 'pageSize=-1']) {
      await call(h, 'GET', `${ADMIN_USERS}?${q}`, admin.token).expect(400);
    }
  });

  it('TC-004 [BE-03 pending]: invite validation and duplicates (400 bad body or unknown field, 409 duplicate email, one user row)', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const email = `qa-dup-${Date.now()}@example.com`;
    const good = { email, name: 'Dup Test', role: 'AUTHOR', currentPassword: PASSWORD };
    const post = (b: object) => call(h, 'POST', ADMIN_USERS, admin.token, b);
    for (const bad of [
      { ...good, email: 'not-an-email' },
      { ...good, role: 'GOD' },
      { ...good, name: '' },
      { ...good, extra: 'x' },
      { email, role: 'AUTHOR', currentPassword: PASSWORD },
    ]) {
      await post(bad).expect(400);
    }
    expect(await h.owner.user.count({ where: { email } })).toBe(0);
    const created = (await post(good).expect(201)).body as Record<string, unknown>;
    expect(created).toMatchObject({ email, name: 'Dup Test', role: 'AUTHOR', status: 'invited' });
    await post(good).expect(409);
    expect(await h.owner.user.count({ where: { email } })).toBe(1);
  });

  it('TC-004 [BE-03 pending]: PATCH validation (400 for a non-uuid id, an empty body or a bad role) and the self-change rules (409, nothing changes)', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const target = await createUser(h, { role: UserRole.AUTHOR });
    await patch(admin, 'not-a-uuid', { active: false }).expect(400);
    await patch(admin, target.id, {}).expect(400);
    await patch(admin, target.id, { role: 'GOD' }).expect(400);
    await patch(admin, admin.id, { role: 'RECRUITER' }).expect(409);
    await patch(admin, admin.id, { active: false }).expect(409);
    const row = await h.owner.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect([row.role, row.isActive]).toEqual([UserRole.SUPER_ADMIN, true]);
    await call(h, 'GET', ADMIN_USERS, admin.token).expect(200); // still signed in
  });

  it('TC-004 [BE-03 pending]: two admins demoting or deactivating each other at the same moment never leave the org with no active SUPER_ADMIN', async () => {
    const orgF = (await h.owner.organization.create({ data: { name: 'QA Org F last admin' } })).id;
    const a = await actor(h, UserRole.SUPER_ADMIN, orgF);
    const b = await actor(h, UserRole.SUPER_ADMIN, orgF);
    const results = await Promise.all([
      patch(a, b.id, { role: 'RECRUITER' }),
      patch(b, a.id, { role: 'RECRUITER' }),
      patch(a, b.id, { active: false }),
      patch(b, a.id, { active: false }),
    ]);
    for (const r of results) expect(r.status).toBeLessThan(500);
    const left = await h.owner.user.count({
      where: { orgId: orgF, role: UserRole.SUPER_ADMIN, isActive: true },
    });
    expect(left).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.status === 409 || r.status === 401)).toBe(true);
  });

  it('TC-004 [BE-03 pending]: a SUPER_ADMIN may unlock their own account (204) and a non-uuid id is 400', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    await h.owner.user.update({
      where: { id: admin.id },
      data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) },
    });
    await call(h, 'POST', `${ADMIN_USERS}/${admin.id}/unlock`, admin.token, {
      currentPassword: PASSWORD,
    }).expect(204);
    const row = await h.owner.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect([row.failedLogins, row.lockedUntil]).toEqual([0, null]);
    await call(h, 'POST', `${ADMIN_USERS}/not-a-uuid/unlock`, admin.token, {
      currentPassword: PASSWORD,
    }).expect(400);
  });
});
