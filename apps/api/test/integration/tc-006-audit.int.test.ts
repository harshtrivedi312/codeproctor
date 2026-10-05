// TC-006 (FR-105): audit completeness for the BE-03 routes. Every mutating route, and every read of
// candidate data, writes exactly ONE audit_logs row with org, actor, server time and caller IP, and
// no secret in any column or in metadata. A refused call (401, 403, 404, 400) writes no row.
//
// Tests marked "[BE-03 pending]" (staff user routes) and "[BE-13 pending]" (review routes) are real
// but switched off until the routes exist: set BE03_READY / BE13_READY in support/be03-routes.ts.
// The append-only and row-shape tests of the existing audit table are in tc-006.int.test.ts.
import { AuditLog, UserRole } from '../../src/generated/prisma/client';
import { boot, Harness } from '../support/harness';
import { actor, Actor, call, tokenFromUrl } from '../support/be03-helpers';
import { BE03_READY, BE03_ROUTES, BE13_READY, Be03Route, routesFor } from '../support/be03-routes';
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
    const roleFor = (r: Be03Route): UserRole => {
      const role = (['SUPER_ADMIN', 'REVIEWER', 'RECRUITER', 'AUTHOR'] as const).find((x) =>
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
      const label = `${route.method} ${route.template}`;

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
          const entityId = t.entityId ?? (await t.resolveEntityId?.());
          if (entityId) expect(row.entityId).toBe(entityId);
          expect(row.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
          // Server time: the DB clock, not a client value. Allow 5 s of skew in the harness.
          expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(t0 - 5000);
          expect(row.createdAt.getTime()).toBeLessThanOrEqual(t1 + 5000);

          const mailTokens = h.mails.slice(mailsBefore).map((m) => tokenFromUrl(m.url));
          expectNoSecrets(row, [...t.secrets, ...mailTokens, who.token]);
        });

        it(`TC-006: ${label} writes no audit row when refused (401, 403) or when the target is in another org (404)`, async () => {
          const holder = roleFor(route);
          const denied = (['SUPER_ADMIN', 'REVIEWER', 'RECRUITER', 'AUTHOR'] as const).find(
            (x) => !hasPermission(x, route.permission),
          );
          const t = await route.prepare(h, h.orgId);
          const before = await lastId();
          await call(h, route.method, t.path, undefined, t.body).expect(401);
          if (denied) {
            const lowly = await as(UserRole[denied]);
            await call(h, route.method, t.path, lowly.token, t.body).expect(403);
          }
          if (route.template.includes(':id')) {
            const outsider = await actor(h, holder, orgB);
            await call(h, route.method, t.path, outsider.token, t.body).expect(404);
          }
          // ASSUMED: BE-03 documents no audit row for refused calls. If it adds one (for example
          // ACCESS_DENIED), replace this with an assertion on that row and its fields.
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
      await Promise.all(targets.map((t) => call(h, route.method, t.path, admin.token, t.body)));
      const rows = await h.owner.auditLog.findMany({ where: { id: { gt: before } } });
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((r) => r.entityId)).size).toBe(10);
    });
  },
);
