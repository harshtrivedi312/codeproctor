// TC-004 / TC-006 (FR-103, FR-105, FR-107): the staff invite re-issue route
// POST /admin/users/:userId/invite (Backend A, branch backend/invite-reissue). Confirmed contract:
// SUPER_ADMIN only (user:manage); body {currentPassword}: missing 400, wrong, locked or changed
// mid-request 403 REAUTH_FAILED with identical bodies, a cross-org or missing id 404 only after a
// correct password (identical bodies); 200 StaffUserDto (status 'invited', no token fields); 409 when
// the user has a password or is deactivated; 429 shares the per-org invite limit; 503 when Redis is
// down; refused calls write no audit row. Audit USER_INVITE_REISSUED (entity user, id the target,
// org, actor, ip, metadata ONLY {method, route '/api/v1/admin/users/:userId/invite'}) is written in
// the transaction that rotates the token, not via @Audited. sendStaffInvite exactly once after commit
// with the new link; the old token is dead, the new works once.
// The whole file runs only when the backend's ROUTE_PERMISSIONS has the route (so it is green before
// and after the backend lands it). The generic per-route checks (401, 403 by role, 404 cross-org,
// 400, step-up, no secrets) come from be03-routes.ts (users-invite-reissue) via tc-004-rbac and
// tc-006-audit.
import request from 'supertest';
import { AuditLog, UserRole } from '../../src/generated/prisma/client';
import {
  Body,
  boot,
  createUser,
  expectReauthFailed,
  Harness,
  PASSWORD,
  stableProblem,
} from '../support/harness';
import { actor, call, flushDeferred, tokenFromUrl } from '../support/be03-helpers';
import {
  ADMIN_USERS,
  BE03_READY,
  backendHasRoute,
  loadBackendRegistry,
} from '../support/be03-routes';

const KEY = 'POST /admin/users/:userId/invite';
const ON = BE03_READY && backendHasRoute(KEY);
const suite = ON ? describe : describe.skip;
const reissuePath = (id: string): string => `${ADMIN_USERS}/${id}/invite`;
const resetWith = (h: Harness, token: string): request.Test =>
  request(h.app.getHttpServer())
    .post('/api/v1/auth/password/reset')
    .send({ token, newPassword: 'Brand-New-Passphrase-77' });

suite('TC-004 TC-006: invite re-issue route', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h?.close();
  });
  const lastId = async (): Promise<bigint> =>
    (await h.owner.auditLog.findFirst({ orderBy: { id: 'desc' } }))?.id ?? 0n;
  const inviteMails = (from: number): { to: string; url: string }[] =>
    h.mails.slice(from).filter((m) => m.method === 'sendStaffInvite');

  /** Invites a fresh user through the API; returns the id, email and the first token from the mail. */
  async function invite(token: string): Promise<{ id: string; email: string; token1: string }> {
    const email = `qa-reissue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const from = h.mails.length;
    const res = await call(h, 'POST', ADMIN_USERS, token, {
      email,
      name: 'Reissue Target',
      role: 'RECRUITER',
      currentPassword: PASSWORD,
    }).expect(201);
    await flushDeferred(h);
    const mail = inviteMails(from).find((m) => m.to === email);
    return { id: (res.body as Body).id as string, email, token1: tokenFromUrl(mail?.url ?? '') };
  }

  it('TC-004: the matrix entry is user:manage for SUPER_ADMIN only and carries no `audited` flag (the row is written in the service transaction)', () => {
    const entry = loadBackendRegistry().ROUTE_PERMISSIONS[KEY];
    expect(entry).not.toBe('public');
    if (entry === 'public' || entry === undefined) return;
    expect(entry.permission).toBe('user:manage');
    expect([...entry.roles]).toEqual(['SUPER_ADMIN']);
    expect(entry.audited).toBeUndefined();
  });

  it('TC-006 FR-107: a re-issue returns a StaffUserDto without token fields, mails the NEW link once after commit, kills the old token and writes one row with only {method, route}', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const target = await invite(admin.token);
    expect(target.token1.length).toBeGreaterThanOrEqual(20);
    const mailsBefore = h.mails.length;
    const before = await lastId();
    const res = await call(h, 'POST', reissuePath(target.id), admin.token, {
      currentPassword: PASSWORD,
    }).expect(200);
    const body = res.body as Body;
    expect(body.id).toBe(target.id);
    expect(body.status).toBe('invited');
    expect(Object.keys(body).filter((k) => /token|hash|link|url|secret/i.test(k))).toEqual([]);
    await flushDeferred(h);
    const mails = inviteMails(mailsBefore);
    expect(mails).toHaveLength(1); // exactly once, after commit
    expect(mails[0]?.to).toBe(target.email);
    expect(mails[0]?.url).toMatch(/\/admin\/set-password#token=[^&]+$/);
    const token2 = tokenFromUrl(mails[0]?.url ?? '');
    expect(token2.length).toBeGreaterThanOrEqual(20);
    expect(token2).not.toBe(target.token1);
    expect(res.text).not.toContain(token2);

    const rows: AuditLog[] = await h.owner.auditLog.findMany({
      where: { id: { gt: before } },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0] as AuditLog;
    expect([row.action, row.entityType, row.entityId, row.orgId, row.actorId]).toEqual([
      'USER_INVITE_REISSUED',
      'user',
      target.id,
      h.orgId,
      admin.id,
    ]);
    expect(row.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    expect(row.metadata).toEqual({ method: 'POST', route: `/api/v1${ADMIN_USERS}/:userId/invite` });
    expect(
      JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(new RegExp(`${token2}|${target.token1}|${PASSWORD}|@example\\.com`));
    // Only the hash of the new token is stored.
    const stored = await h.owner.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(JSON.stringify(stored)).not.toContain(token2);

    await resetWith(h, target.token1).expect(400); // old link dead
    await resetWith(h, token2).expect(204); // new link works once
    await resetWith(h, token2).expect(400);
  });

  it('TC-004 TC-006: a user who has a password, or is deactivated, gets 409; nothing changes, no mail, no audit row', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const active = await createUser(h); // has a password
    const gone = await createUser(h, { password: null });
    await h.owner.user.update({ where: { id: gone.id }, data: { isActive: false } });
    const hashOf = async (id: string): Promise<string | null> =>
      (await h.owner.user.findUniqueOrThrow({ where: { id } })).setPasswordTokenHash;
    const [a0, g0] = [await hashOf(active.id), await hashOf(gone.id)];
    const mailsBefore = h.mails.length;
    const before = await lastId();
    for (const t of [active, gone]) {
      const res = await call(h, 'POST', reissuePath(t.id), admin.token, {
        currentPassword: PASSWORD,
      });
      expect([t.id, res.status]).toEqual([t.id, 409]);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
    expect([await hashOf(active.id), await hashOf(gone.id)]).toEqual([a0, g0]);
    await flushDeferred(h);
    expect(inviteMails(mailsBefore)).toEqual([]);
    expect(await h.owner.auditLog.count({ where: { id: { gt: before } } })).toBe(0);
  });

  it('TC-004 TC-008: a cross-org or missing id is the same 404 body, only after the right password (a wrong one is 403 first); nothing is written', async () => {
    const orgB = (await h.owner.organization.create({ data: { name: 'QA Org B reissue' } })).id;
    const adminA = await actor(h, UserRole.SUPER_ADMIN);
    const foreign = await createUser(h, { orgId: orgB, password: null });
    const missing = crypto.randomUUID();
    const before = await lastId();
    const hashBefore = (await h.owner.user.findUniqueOrThrow({ where: { id: foreign.id } }))
      .setPasswordTokenHash;
    const mailsBefore = h.mails.length;
    const cross = await call(h, 'POST', reissuePath(foreign.id), adminA.token, {
      currentPassword: PASSWORD,
    });
    const none = await call(h, 'POST', reissuePath(missing), adminA.token, {
      currentPassword: PASSWORD,
    });
    expect([cross.status, none.status]).toEqual([404, 404]);
    expect(JSON.stringify(stableProblem(cross)).replace(foreign.id, 'ID')).toBe(
      JSON.stringify(stableProblem(none)).replace(missing, 'ID'),
    );
    const wrongCross = await call(h, 'POST', reissuePath(foreign.id), adminA.token, {
      currentPassword: 'Wrong-Password-1',
    });
    const wrongMissing = await call(h, 'POST', reissuePath(missing), adminA.token, {
      currentPassword: 'Wrong-Password-1',
    });
    expectReauthFailed(wrongCross);
    expectReauthFailed(wrongMissing);
    expect(stableProblem(wrongCross)).toEqual(stableProblem(wrongMissing));
    expect(
      (await h.owner.user.findUniqueOrThrow({ where: { id: foreign.id } })).setPasswordTokenHash,
    ).toBe(hashBefore);
    await flushDeferred(h);
    expect(inviteMails(mailsBefore)).toEqual([]);
    expect(
      await h.owner.auditLog.count({
        where: { id: { gt: before }, action: 'USER_INVITE_REISSUED' },
      }),
    ).toBe(0);
  });

  it('TC-006: when the audit insert fails the re-issue is 500, the rotation rolls back (the old link still works) and no mail is sent', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const target = await invite(admin.token);
    const hashBefore = (await h.owner.user.findUniqueOrThrow({ where: { id: target.id } }))
      .setPasswordTokenHash;
    const mailsBefore = h.mails.length;
    await h.owner.$executeRawUnsafe('REVOKE INSERT ON audit_logs FROM app_user');
    try {
      const res = await call(h, 'POST', reissuePath(target.id), admin.token, {
        currentPassword: PASSWORD,
      });
      expect(res.status).toBe(500);
      expect(res.text).not.toMatch(/token|currentPassword|@example\.com/i);
    } finally {
      await h.owner.$executeRawUnsafe('GRANT INSERT ON audit_logs TO app_user');
    }
    expect(
      (await h.owner.user.findUniqueOrThrow({ where: { id: target.id } })).setPasswordTokenHash,
    ).toBe(hashBefore);
    await flushDeferred(h);
    expect(inviteMails(mailsBefore)).toEqual([]);
    await resetWith(h, target.token1).expect(204); // the old link is still valid
  });

  it('TC-004: 429 shares the per-org invite limit with POST /admin/users; the refused re-issue sends no mail, rotates nothing and writes no row', async () => {
    const orgC = (await h.owner.organization.create({ data: { name: 'QA Org C reissue rate' } }))
      .id;
    const admin = await actor(h, UserRole.SUPER_ADMIN, orgC);
    const first = await invite(admin.token); // counts against the limit
    let limited = false;
    for (let i = 0; i < 300 && !limited; i++) {
      const res = await call(h, 'POST', ADMIN_USERS, admin.token, {
        email: `qa-reissue-rate-${i}-${Date.now()}@example.com`,
        name: 'Rate',
        role: 'RECRUITER',
        currentPassword: PASSWORD,
      });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
    const hashBefore = (await h.owner.user.findUniqueOrThrow({ where: { id: first.id } }))
      .setPasswordTokenHash;
    const before = await lastId();
    await flushDeferred(h);
    const mailsBefore = h.mails.length;
    const res = await call(h, 'POST', reissuePath(first.id), admin.token, {
      currentPassword: PASSWORD,
    });
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(
      (await h.owner.user.findUniqueOrThrow({ where: { id: first.id } })).setPasswordTokenHash,
    ).toBe(hashBefore);
    await flushDeferred(h);
    expect(inviteMails(mailsBefore)).toEqual([]);
    expect(await h.owner.auditLog.count({ where: { id: { gt: before } } })).toBe(0);
    await resetWith(h, first.token1).expect(204); // old link untouched
  });
});

// Last on purpose: the Redis container is stopped for good (as in tc-003's outage test).
// Since #175 the global throttle guard answers 503 "Service is temporarily unavailable." before
// any handler when Redis is down, so this suite boots with the in-memory throttle store and skips
// the JWT guard's own Redis freshness check (same wording as the handler), so the request reaches
// the re-issue handler (UsersService.takeInviteSlot) and ITS fail-closed branch is what answers.
suite('TC-004: invite re-issue with Redis down', () => {
  let h: Harness;
  let spy: jest.SpyInstance | undefined;
  beforeAll(async () => {
    h = await boot({ memoryThrottle: true });
  });
  afterAll(async () => {
    spy?.mockRestore();
    await h?.close();
  });

  it('TC-004: the re-issue answers the handler 503 (not 500), rotates nothing, sends no mail and writes no row', async () => {
    const admin = await actor(h, UserRole.SUPER_ADMIN);
    const target = await createUser(h, { password: null });
    const hashBefore = (await h.owner.user.findUniqueOrThrow({ where: { id: target.id } }))
      .setPasswordTokenHash;
    const before = (await h.owner.auditLog.findFirst({ orderBy: { id: 'desc' } }))?.id ?? 0n;
    const mailsBefore = h.mails.length;
    spy = h.skipFreshnessCheck();
    await h.infra.redis.stop();
    const res = await call(h, 'POST', reissuePath(target.id), admin.token, {
      currentPassword: PASSWORD,
    }).timeout({ response: 30000, deadline: 40000 });
    expect(spy).toHaveBeenCalled(); // the bypass took effect, so the handler is what answered
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    // The handler's own text; the throttler's 503 says "Service is temporarily unavailable."
    expect((res.body as Body).detail).toBe('Verification is temporarily unavailable.');
    expect(JSON.stringify(res.body)).not.toContain('Service is temporarily unavailable.');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(
      (await h.owner.user.findUniqueOrThrow({ where: { id: target.id } })).setPasswordTokenHash,
    ).toBe(hashBefore);
    await flushDeferred(h);
    expect(h.mails.slice(mailsBefore).filter((m) => m.method === 'sendStaffInvite')).toEqual([]);
    expect(await h.owner.auditLog.count({ where: { id: { gt: before } } })).toBe(0);
  }, 90000);
});
