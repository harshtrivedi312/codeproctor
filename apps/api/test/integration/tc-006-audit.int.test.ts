// TC-006 (FR-105): audit completeness for the BE-03 routes. Every mutating route, and every read of
// candidate data, writes exactly ONE audit_logs row with org, actor, server time and caller IP, and
// no secret in any column or in metadata. A refused call (401, 403, 404, 400) writes no row.
//
// Tests marked "[BE-03 pending]" (staff user routes) and "[BE-13 pending]" (review routes) are real
// but switched off until the routes exist: set BE03_READY / BE13_READY in support/be03-routes.ts.
// The append-only and row-shape tests of the existing audit table are in tc-006.int.test.ts.
import { AuditLog, UserRole } from '../../src/generated/prisma/client';
import { Body, boot, expectReauthFailed, Harness, login, PASSWORD } from '../support/harness';
import { actor, Actor, call, tokenFromUrl } from '../support/be03-helpers';
import {
  ADMIN_USERS,
  BE03_READY,
  BE03_ROUTES,
  BE13_READY,
  Be03Route,
  hasPathId,
  routeLabel,
  routesFor,
} from '../support/be03-routes';
import request from 'supertest';
import { hasPermission } from '../../../../packages/shared/src/permissions';

const FORBIDDEN_KEY = /password|token|secret|hash|otp|recovery|\bcode\b|key|authorization|cookie/i;

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  }
  return [];
}

describe('TC-006: audit list is complete by construction (always runs)', () => {
  it('TC-006: every mutating route in the BE-03 list names an audit action and entity type', () => {
    for (const r of BE03_ROUTES.filter((x) => x.mutating)) {
      expect(r.audit?.action).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(r.audit?.entityType).toBeTruthy();
    }
  });

  it('TC-006: no two routes share one audit action (a row identifies its route)', () => {
    const actions = BE03_ROUTES.flatMap((r) => (r.audit ? [r.audit.action] : []));
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('TC-006: the no-secrets key filter flags the keys it must flag and passes IDs', () => {
    expect(keysOf({ a: { passwordHash: 1 } }).some((k) => FORBIDDEN_KEY.test(k))).toBe(true);
    expect(keysOf({ resetToken: 1 }).some((k) => FORBIDDEN_KEY.test(k))).toBe(true);
    expect(
      keysOf({ userId: 'x', fromRole: 'A', toRole: 'B' }).some((k) => FORBIDDEN_KEY.test(k)),
    ).toBe(false);
  });
});

function auditSuite(title: string, ready: boolean, routes: Be03Route[]): void {
  const suite = ready ? describe : describe.skip;
  suite(title, () => {
    let h: Harness;
    let orgB: string;
    const staff: Partial<Record<UserRole, Actor>> = {};
    const orgBStaff: Partial<Record<UserRole, Actor>> = {};
    const roleFor = (r: Be03Route): UserRole => {
      // Least-privileged allowed role first, so a route that is open to REVIEWER is exercised as
      // REVIEWER, not as SUPER_ADMIN.
      const role = (['REVIEWER', 'RECRUITER', 'AUTHOR', 'SUPER_ADMIN'] as const).find((x) =>
        hasPermission(x, r.permission),
      );
      if (!role) throw new Error(`no role holds ${r.permission}`);
      return UserRole[role];
    };
    const as = async (role: UserRole): Promise<Actor> => (staff[role] ??= await actor(h, role));

    beforeAll(async () => {
      h = await boot();
      orgB = (await h.owner.organization.create({ data: { name: 'QA Org B' } })).id;
    });
    afterAll(async () => {
      await h?.close();
    });

    const lastId = async (): Promise<bigint> =>
      (await h.owner.auditLog.findFirst({ orderBy: { id: 'desc' } }))?.id ?? 0n;
    const since = (id: bigint): Promise<AuditLog[]> =>
      h.owner.auditLog.findMany({ where: { id: { gt: id } }, orderBy: { id: 'asc' } });

    function expectNoSecrets(row: AuditLog, secrets: string[]): void {
      const text = JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
      for (const s of secrets) if (s) expect(text).not.toContain(s);
      expect(keysOf(row.metadata).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
      expect(text).not.toMatch(/\$argon2|eyJ[A-Za-z0-9_-]{10,}\./); // no hash or JWT in any column
      expect(text).not.toMatch(/@example\.com/); // IDs only, no email addresses (ADR 0001 C-3)
    }

    describe.each(routes.map((r) => [r.id, r] as const))('%s', (_id, route) => {
      const label = routeLabel(route);

      if (route.audit) {
        const audit = route.audit;
        it(`TC-006: ${label} writes exactly one ${audit.action} row with org, actor, server time, IP and no secrets`, async () => {
          const who = await as(roleFor(route));
          const t = await route.prepare(h, h.orgId);
          const mailsBefore = h.mails.length;
          const before = await lastId();
          const t0 = Date.now();
          const res = await call(h, route.method, t.path, who.token, t.body);
          expect(route.ok).toContain(res.status);
          const t1 = Date.now();

          const rows = await since(before);
          expect(rows).toHaveLength(1); // exactly one: not zero, not a duplicate
          const row = rows[0] as AuditLog;
          expect(row.action).toBe(audit.action);
          expect(row.entityType).toBe(audit.entityType);
          expect(row.orgId).toBe(h.orgId);
          expect(row.actorId).toBe(who.id);
          if (route.interceptor) {
            // Interceptor rows (list reads): no single target, metadata only {method, route template}.
            expect(row.entityId).toBeNull();
            const meta = row.metadata as { method?: string; route?: string } | null;
            expect(Object.keys(meta ?? {}).sort()).toEqual(['method', 'route']);
            expect(meta?.method).toBe(route.method);
            expect(meta?.route?.endsWith(route.template)).toBe(true); // template, never the concrete URL
            expect(meta?.route).not.toContain('page=');
          } else {
            const entityId = t.entityId ?? (await t.resolveEntityId?.());
            expect(entityId).toBeDefined(); // every audited route names its entity
            expect(row.entityId).toBe(entityId);
          }
          expect(row.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
          // Server time: the DB clock, not a client value. Allow 5 s of skew in the harness.
          expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(t0 - 5000);
          expect(row.createdAt.getTime()).toBeLessThanOrEqual(t1 + 5000);

          const mailTokens = h.mails.slice(mailsBefore).map((m) => tokenFromUrl(m.url));
          if (route.sendsMail) expect(mailTokens.filter((x) => x !== '').length).toBeGreaterThan(0);
          expectNoSecrets(row, [...t.secrets, ...mailTokens, who.token]);
        });

        it(`TC-006: ${label} writes no audit row when refused (401, 403) or when the target is in another org (404)`, async () => {
          const holder = roleFor(route);
          const denied = (['SUPER_ADMIN', 'REVIEWER', 'RECRUITER', 'AUTHOR'] as const).find(
            (x) => !hasPermission(x, route.permission),
          );
          // Create every actor and fixture BEFORE the baseline: sign-ins may write audit rows.
          const lowly = denied ? await as(UserRole[denied]) : undefined;
          const outsider = hasPathId(route)
            ? (orgBStaff[holder] ??= await actor(h, holder, orgB))
            : undefined;
          const t = await route.prepare(h, h.orgId);
          const before = await lastId();
          await call(h, route.method, t.path, undefined, t.body).expect(401);
          if (lowly) {
            await call(h, route.method, t.path, lowly.token, t.body).expect(403);
          }
          if (outsider) {
            await call(h, route.method, t.path, outsider.token, t.body).expect(404);
          }
          // Final BE-03 contract: failed requests (400/401/403/404) write no audit row.
          expect(await since(before)).toEqual([]);
        });

        it(`TC-006: ${label} with an invalid body (400) writes no audit row and changes nothing`, async () => {
          if (!route.mutating || route.takesBody === false) return;
          const who = await as(roleFor(route));
          const t = await route.prepare(h, h.orgId);
          const before = await lastId();
          const res = await call(h, route.method, t.path, who.token, {
            unexpected: 'x'.repeat(10),
          });
          expect(res.status).toBe(400);
          expect(await t.unchanged()).toBe(true);
          expect(await since(before)).toEqual([]);
        });
        if (route.reauth) {
          it(`TC-006 FR-102: ${label} with a missing (400) or wrong (403 REAUTH_FAILED) currentPassword writes no audit row and changes nothing`, async () => {
            const who = await as(roleFor(route));
            const outsider = hasPathId(route)
              ? (orgBStaff[roleFor(route)] ??= await actor(h, roleFor(route), orgB))
              : undefined;
            const t = await route.prepare(h, h.orgId);
            const body = t.body as Record<string, unknown>;
            const { currentPassword: _p, ...without } = body;
            void _p;
            const wrong = { ...body, currentPassword: 'Wrong-Password-1' };
            const before = await lastId();
            await call(h, route.method, t.path, who.token, without).expect(400);
            expectReauthFailed(await call(h, route.method, t.path, who.token, wrong));
            if (outsider) {
              // Wrong password from another org: still REAUTH_FAILED, never a 404 first.
              expectReauthFailed(await call(h, route.method, t.path, outsider.token, wrong));
            }
            expect(await t.unchanged()).toBe(true);
            expect(await since(before)).toEqual([]);
          });
        }
      } else {
        it(`TC-006: ${label} is not audited and writes no row`, async () => {
          const who = await as(roleFor(route));
          const t = await route.prepare(h, h.orgId);
          const before = await lastId();
          const res = await call(h, route.method, t.path, who.token);
          expect(route.ok).toContain(res.status);
          expect(await since(before)).toEqual([]);
        });
      }
    });
  });
}

auditSuite('TC-006 [BE-03 pending]: staff user routes are audited', BE03_READY, routesFor('BE-03'));
auditSuite(
  'TC-006 [BE-13 pending]: review routes are audited (a reviewer opening a review)',
  BE13_READY,
  routesFor('BE-13'),
);

(BE03_READY ? describe : describe.skip)(
  'TC-006 [BE-03 pending]: audit rows hold up under repeat and concurrent calls',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('TC-006 [BE-03 pending]: ten parallel role changes write exactly ten rows (no lost or doubled rows)', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const route = BE03_ROUTES.find((r) => r.id === 'users-role') as Be03Route;
      const targets = await Promise.all(
        Array.from({ length: 10 }, () => route.prepare(h, h.orgId)),
      );
      const before = (await h.owner.auditLog.findFirst({ orderBy: { id: 'desc' } }))?.id ?? 0n;
      const results = await Promise.all(
        targets.map((t) => call(h, route.method, t.path, admin.token, t.body)),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      const rows = await h.owner.auditLog.findMany({ where: { id: { gt: before } } });
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((r) => r.entityId)).size).toBe(10);
    });
  },
);

(BE03_READY ? describe : describe.skip)(
  'TC-006 [BE-03 pending]: invite acceptance and audit write failure',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('TC-006 [BE-03 pending]: an invite mailed as staff-invite with a /admin/set-password#token link is accepted through POST /auth/password/reset and writes one AUTH_INVITE_ACCEPTED row (FR-105, FR-107)', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      const email = `qa-accept-${Date.now()}@example.com`;
      const mailsBefore = h.mails.length;
      const invited = (
        await call(h, 'POST', ADMIN_USERS, admin.token, {
          email,
          name: 'Accept Test',
          role: 'RECRUITER',
          currentPassword: PASSWORD,
        }).expect(201)
      ).body as Body;
      const id = invited.id as string;
      expect(invited.status).toBe('invited');
      await h.settle();
      const mail = h.mails.slice(mailsBefore).find((m) => m.method === 'sendStaffInvite');
      expect(mail?.to).toBe(email);
      expect(mail?.url).toMatch(/\/admin\/set-password#token=[^&]+$/);
      const token = tokenFromUrl(mail?.url ?? '');
      expect(token.length).toBeGreaterThanOrEqual(20);
      // Only the SHA-256 of the token is stored (ADR 0003), 72 h single use.
      const stored = await h.owner.user.findUniqueOrThrow({ where: { id } });
      expect(JSON.stringify(stored)).not.toContain(token);
      await login(h, email).expect(401); // not usable until the password is set

      const before = (await h.owner.auditLog.findFirst({ orderBy: { id: 'desc' } }))?.id ?? 0n;
      await request(h.app.getHttpServer())
        .post('/api/v1/auth/password/reset')
        .send({ token, newPassword: 'Brand-New-Passphrase-77' })
        .expect(204);
      const rows = await h.owner.auditLog.findMany({
        where: { id: { gt: before }, action: 'AUTH_INVITE_ACCEPTED' },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0] as AuditLog;
      expect([row.entityType, row.entityId, row.orgId]).toEqual(['user', id, h.orgId]);
      expect([id, null]).toContain(row.actorId); // the invitee (or none): never the inviting admin
      expect(row.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
      const text = JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
      expect(text).not.toContain(token);
      expect(text).not.toContain('Brand-New-Passphrase-77');
      expect(keysOf(row.metadata).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);

      await login(h, email, 'Brand-New-Passphrase-77').expect(200);
      const list = (await call(h, 'GET', ADMIN_USERS, admin.token).expect(200)).body as {
        items: { id: string; status: string }[];
      };
      expect(list.items.find((u) => u.id === id)?.status).toBe('active');
      // Single use: the same link does not work twice.
      await request(h.app.getHttpServer())
        .post('/api/v1/auth/password/reset')
        .send({ token, newPassword: 'Another-Passphrase-88' })
        .expect(400);
    });

    it('TC-006 [BE-03 pending]: when the audit write fails the request fails with 500 and an empty body (fail closed), on an interceptor route and on an invite', async () => {
      const admin = await actor(h, UserRole.SUPER_ADMIN);
      // Sign-ins above wrote their rows; now remove the app role's right to insert audit rows.
      await h.owner.$executeRawUnsafe('REVOKE INSERT ON audit_logs FROM app_user');
      const email = `qa-auditfail-${Date.now()}@example.com`;
      const list = await call(h, 'GET', ADMIN_USERS, admin.token);
      expect(list.status).toBe(500);
      expect(list.text).toBe(''); // the data the route read is not returned
      const invite = await call(h, 'POST', ADMIN_USERS, admin.token, {
        email,
        name: 'Audit Fail',
        role: 'RECRUITER',
        currentPassword: PASSWORD,
      });
      expect(invite.status).toBe(500);
      expect(invite.text).toBe('');
      // No audit row, so no change either: the user row is not left behind without its row.
      expect(await h.owner.user.count({ where: { email } })).toBe(0);
    });
  },
);
