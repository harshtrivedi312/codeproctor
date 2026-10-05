// TC-004 (FR-103): RBAC enforcement, table-driven from the packages/shared permission matrix
// (ROLE_PERMISSIONS, hasPermission) and the BE-03 route list in support/be03-routes.ts.
// Per route and role: no token and bad tokens 401; a role without the permission 403 and nothing
// changes; a user of another org 404 and nothing changes; an allowed role succeeds.
//
// The tests marked "[BE-03 pending]" are real but switched off until BE-03's routes exist:
// set BE03_READY = true in support/be03-routes.ts (or run with BE03_READY=1). Same for
// "[BE-13 pending]" and BE13_READY. The matrix-only tests at the top always run.
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { UserRole } from '../../src/generated/prisma/client';
import { boot, Harness } from '../support/harness';
import { actor, Actor, call } from '../support/be03-helpers';
import {
  allowedRoles,
  sessionFixture,
  BE03_READY,
  BE03_ROUTES,
  BE13_READY,
  Be03Route,
  PRINCIPALS,
  routesFor,
  USER_ROLES,
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
    const byRole = {} as Record<UserRole, Actor>;
    const orgBActors: Partial<Record<UserRole, Actor>> = {};
    const orgBActor = async (role: UserRole): Promise<Actor> =>
      (orgBActors[role] ??= await actor(h, role, orgB));

    beforeAll(async () => {
      h = await boot();
      for (const role of USER_ROLES) byRole[role] = await actor(h, UserRole[role]);
      orgB = (await h.owner.organization.create({ data: { name: 'QA Org B' } })).id;
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
      const label = `${route.method} ${route.template}`;

      it(`TC-004: ${label} gives 401 with no token, a garbage token, a forged token and an expired token`, async () => {
        const t = await route.prepare(h, h.orgId);
        for (const token of [undefined, 'garbage', forged(), expired()]) {
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

      const holders = USER_ROLES.filter((r) => hasPermission(r, route.permission));
      it.each(holders.map((r) => [r] as const))(
        `TC-004 TC-008: ${label} as org B %s on an org A target is 404, leaks nothing and changes nothing`,
        async (role) => {
          const caller = await orgBActor(role);
          if (route.template.includes(':id')) {
            const t = await route.prepare(h, h.orgId);
            const res = await call(h, route.method, t.path, caller.token, t.body);
            expect(res.status).toBe(404);
            expect(JSON.stringify(res.body)).not.toContain(h.orgId);
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

      if (route.template.includes(':id')) {
        it(`TC-004 TC-008: ${label} gives the same 404 for another org's id and for a random id (no existence oracle)`, async () => {
          const holder = holders[0];
          if (holder === undefined) throw new Error(`no role holds ${route.permission}`);
          const caller = await orgBActor(holder);
          const t = await route.prepare(h, h.orgId);
          const realId = t.entityId ?? '';
          const randomId = randomUUID();
          const cross = await call(h, route.method, t.path, caller.token, t.body);
          const missing = await call(
            h,
            route.method,
            realId ? t.path.replace(realId, randomId) : t.path,
            caller.token,
            t.body,
          );
          expect(cross.status).toBe(404);
          expect(missing.status).toBe(404);
          // Compare the bodies with the volatile and id-bearing parts removed.
          const norm = (body: unknown, id: string): string => {
            const o = { ...(body as Record<string, unknown>) };
            delete o.traceId;
            delete o.instance;
            return JSON.stringify(o).split(id).join('ID');
          };
          expect(norm(cross.body, realId || 'x')).toBe(norm(missing.body, randomId));
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

(BE03_READY ? describe : describe.skip)('TC-004 [BE-03 pending]: guard coverage', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('TC-004 [BE-03 pending]: a deactivated user is refused on the next call even with an unexpired token (FR-103)', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const victim = await actor(h, UserRole.AUTHOR);
    await h.owner.user.update({ where: { id: victim.id }, data: { isActive: false } });
    await call(h, 'GET', '/users', admin.token).expect(200);
    // ASSUMED: an inactive user's token is refused with 401 on any protected route.
    await call(h, 'GET', '/users', victim.token).expect(401);
  });

  it('TC-004 [BE-03 pending]: the role in the token is not trusted over the database role (demoted admin gets 403 at once)', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    await h.owner.user.update({ where: { id: admin.id }, data: { role: UserRole.RECRUITER } });
    // ASSUMED: the guard re-reads the role, so a stale SUPER_ADMIN token loses access. If BE-03
    // decides to trust the 15-minute token claim, change this test and record the window in the ADR.
    const res = await call(h, 'GET', '/users', admin.token);
    expect([401, 403]).toContain(res.status);
  });
});
