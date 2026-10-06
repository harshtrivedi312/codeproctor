// Re-issue of a pending staff invite (DL-23, FR-103, FR-105) against a real Postgres 16 and Redis
// (Testcontainers). The API runs as app_user, the role it has in production (ADR 0006).
import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { passwordVersion, sha256Hex } from '../auth/crypto.util';
import { ARGON2_OPTIONS } from '../auth/password.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import type { MailPort } from '../mail/mail.port';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import type { TokenService } from '../common/auth/token.service';

const API = '/api/v1';
const PASSWORD = 'Correct-Horse-9';
const NEW_PASSWORD = 'Another-Horse-42!';
const GHOST = '00000000-0000-4000-8000-000000000103';

function stable(res: request.Response): Record<string, unknown> {
  const { traceId: _t, instance: _i, ...rest } = res.body as Record<string, unknown>;
  void _t;
  void _i;
  return rest;
}

describe('Re-issue a pending invite (DL-23, FR-103, FR-105, TC-004, TC-008)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let PgClient: typeof Client;
  const logged: string[] = [];
  let stdout: jest.SpyInstance;
  const invites: { to: string; url: string }[] = [];
  let failMail = false;
  let seq = 0;

  const fakeMail: Pick<
    MailPort,
    'sendPasswordReset' | 'sendStaffInvite' | 'sendStaffAccountLocked'
  > = {
    sendPasswordReset: () => Promise.resolve(),
    sendStaffInvite: (to, url) => {
      if (failMail) return Promise.reject(new Error(`smtp down for ${to} ${url}`));
      invites.push({ to, url });
      return Promise.resolve();
    },
    sendStaffAccountLocked: () => Promise.resolve(),
  };

  beforeAll(async () => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    infra = await startInfra();
    await applyMigrations(infra);
    const appPassword = randomBytes(18).toString('hex');
    pg = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await pg.connect();
    await pg.query(`ALTER ROLE app_user PASSWORD '${appPassword}'`);
    const appUserUrl = `postgresql://app_user:${appPassword}@${infra.postgres.getHost()}:${infra.postgres.getMappedPort(5432)}/${infra.postgres.getDatabase()}`;
    applyEnv(infra, { DATABASE_URL: appUserUrl, THROTTLE_AUTH_LIMIT: '100000', LOG_LEVEL: 'info' });
    owner = createPrismaClient(infra.postgres.getConnectionUri());
    orgA = (await owner.organization.create({ data: { name: 'Org A' } })).id;
    orgB = (await owner.organization.create({ data: { name: 'Org B' } })).id;

    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { MailPort: MailToken } =
      jest.requireActual<typeof import('../mail/mail.port')>('../mail/mail.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailToken)
      .useValue(fakeMail)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    const { TokenService: Tokens } = jest.requireActual<
      typeof import('../common/auth/token.service')
    >('../common/auth/token.service');
    tokens = app.get(Tokens);
    PgClient = jest.requireActual<typeof import('pg')>('pg').Client;
  });

  afterAll(async () => {
    stdout.mockRestore();
    await app?.close();
    await owner?.$disconnect();
    await pg?.end();
    await infra?.stop();
  });

  afterEach(() => {
    failMail = false;
    invites.length = 0;
  });

  interface Made {
    id: string;
    email: string;
    auth: { Authorization: string };
  }

  async function make(
    role: UserRole,
    opts: { orgId?: string; pending?: boolean; active?: boolean } = {},
  ): Promise<Made & { token: string }> {
    const n = ++seq;
    const email = `r${n}@example.com`;
    const token = `invite-token-${n}-${randomBytes(8).toString('hex')}`;
    const passwordHash = opts.pending ? null : await hash(PASSWORD, ARGON2_OPTIONS);
    const user = await owner.user.create({
      data: {
        orgId: opts.orgId ?? orgA,
        email,
        fullName: `User ${n}`,
        role,
        isActive: opts.active ?? true,
        passwordHash,
        setPasswordTokenHash: passwordHash === null ? sha256Hex(token) : null,
        setPasswordExpiresAt: passwordHash === null ? new Date(Date.now() + 3_600_000) : null,
      },
    });
    const access = tokens.sign(
      {
        sub: user.id,
        org: user.orgId,
        role,
        kind: 'access',
        pwv: passwordVersion(passwordHash ?? ''),
      },
      900,
    );
    return { id: user.id, email, token, auth: { Authorization: `Bearer ${access}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const reissue = (admin: Made, target: string, body: object = { currentPassword: PASSWORD }) =>
    http().post(`${API}/admin/users/${target}/invite`).set(admin.auth).send(body);
  const accept = (token: string, newPassword = NEW_PASSWORD): request.Test =>
    http().post(`${API}/auth/password/reset`).send({ token, newPassword });
  const auditCount = async (entityId?: string): Promise<number> => {
    const r = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'USER_INVITE_REISSUED' AND ($1::text IS NULL OR entity_id = $1)`,
      [entityId ?? null],
    );
    return r.rows[0]?.n ?? 0;
  };
  const tokenHashOf = async (id: string): Promise<string | null> =>
    (await owner.user.findUniqueOrThrow({ where: { id } })).setPasswordTokenHash;

  async function statementsDuring(run: () => Promise<unknown>): Promise<number> {
    const spy = jest.spyOn(PgClient.prototype, 'query');
    try {
      await run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  async function untilLockWaiter(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const r = await pg.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if ((r.rows[0] as { n: number }).n > 0) return;
      if (Date.now() > deadline) throw new Error('no statement is waiting on a lock');
      await new Promise((r2) => setTimeout(r2, 20));
    }
  }

  it('TC-004, FR-103: only a SUPER_ADMIN may re-issue; other roles get 403 and nothing changes', async () => {
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const before = await tokenHashOf(pending.id);
    for (const role of [UserRole.RECRUITER, UserRole.AUTHOR, UserRole.REVIEWER]) {
      const caller = await make(role);
      await reissue(caller, pending.id).expect(403);
    }
    await http().post(`${API}/admin/users/${pending.id}/invite`).send({}).expect(401);
    expect(await tokenHashOf(pending.id)).toBe(before);
    expect(await auditCount(pending.id)).toBe(0);
    expect(invites).toHaveLength(0);
  });

  it('TC-004: no password is 400, a wrong or locked admin password is the same 403 REAUTH_FAILED; no audit row, no change, no mail', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const before = await tokenHashOf(pending.id);
    await reissue(admin, pending.id, {}).expect(400);
    await reissue(admin, 'not-a-uuid').expect(400);
    const wrong = await reissue(admin, pending.id, { currentPassword: 'nope-nope-nope-1' });
    expect(wrong.status).toBe(403);
    expect((wrong.body as { code?: string }).code).toBe('REAUTH_FAILED');
    for (let i = 0; i < 6; i++)
      await reissue(admin, pending.id, { currentPassword: 'nope-nope-1x' });
    const locked = await reissue(admin, pending.id);
    expect(locked.status).toBe(403);
    expect(stable(locked)).toEqual(stable(wrong));
    expect(await tokenHashOf(pending.id)).toBe(before);
    expect(await auditCount(pending.id)).toBe(0);
    expect(invites).toHaveLength(0);
  });

  it('TC-008: another org user is the same 404 as a missing id, with the same statements, only after the password check; no audit row', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const foreign = await make(UserRole.AUTHOR, { orgId: orgB, pending: true });
    const before = await tokenHashOf(foreign.id);
    const wrongToForeign = await reissue(admin, foreign.id, {
      currentPassword: 'nope-nope-nope-1',
    });
    expect(wrongToForeign.status).toBe(403);
    let cross: request.Response | undefined;
    let missing: request.Response | undefined;
    const crossCount = await statementsDuring(async () => {
      cross = await reissue(admin, foreign.id);
    });
    const missingCount = await statementsDuring(async () => {
      missing = await reissue(admin, GHOST);
    });
    expect([cross?.status, missing?.status]).toEqual([404, 404]);
    if (!cross || !missing) throw new Error('unreachable');
    expect(stable(cross)).toEqual(stable(missing));
    expect(crossCount).toBeGreaterThan(2);
    expect(crossCount).toBe(missingCount);
    expect(await tokenHashOf(foreign.id)).toBe(before);
    expect(await auditCount()).toBe(0);
    expect(invites).toHaveLength(0);
  });

  it('FR-103: a user with a password, or a deactivated pending user, is 409 and stays untouched; no audit row, no mail', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const active = await make(UserRole.RECRUITER);
    const off = await make(UserRole.RECRUITER, { pending: true, active: false });
    const beforeOff = await tokenHashOf(off.id);
    const activeBefore = await owner.user.findUniqueOrThrow({ where: { id: active.id } });
    await reissue(admin, active.id).expect(409);
    await reissue(admin, off.id).expect(409);
    const after = await owner.user.findUniqueOrThrow({ where: { id: active.id } });
    expect(after.passwordHash).toBe(activeBefore.passwordHash);
    expect(after.setPasswordTokenHash).toBeNull();
    expect(await tokenHashOf(off.id)).toBe(beforeOff);
    expect(await auditCount()).toBe(0);
    expect(invites).toHaveLength(0);
  });

  it('FR-103, FR-105: re-issue mails the new link once, revokes the old link, the new link sets the password; audited with method and route only; nothing secret logged', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const oldHash = await tokenHashOf(pending.id);
    const res = await reissue(admin, pending.id).expect(200);
    expect(res.body).toMatchObject({ id: pending.id, status: 'invited' });
    expect(JSON.stringify(res.body)).not.toMatch(/token|hash/i);
    expect(invites).toHaveLength(1);
    expect(invites[0]?.to).toBe(pending.email);
    const url = invites[0]?.url ?? '';
    expect(url).toMatch(/\/admin\/set-password#token=[A-Za-z0-9_-]+$/);
    const newToken = url.split('#token=')[1] ?? '';
    const row = await owner.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.setPasswordTokenHash).toBe(sha256Hex(newToken));
    expect(row.setPasswordTokenHash).not.toBe(oldHash);
    const ttl = (row.setPasswordExpiresAt?.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(71.9 * 3_600_000);
    expect(ttl).toBeLessThanOrEqual(72 * 3_600_000);
    // Old link is dead, new one works once.
    await accept(pending.token).expect(400);
    await accept(newToken).expect(204);
    await accept(newToken).expect(400);
    const done = await owner.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(done.passwordHash).not.toBeNull();
    const rows = await pg.query(
      `SELECT org_id, actor_id, entity_type, host(ip) AS ip, metadata FROM audit_logs WHERE action = 'USER_INVITE_REISSUED' AND entity_id = $1`,
      [pending.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      org_id: orgA,
      actor_id: admin.id,
      entity_type: 'user',
      metadata: { method: 'POST', route: '/api/v1/admin/users/:userId/invite' },
    });
    const all = logged.join('');
    expect(all).not.toContain(newToken);
    expect(all).not.toContain(sha256Hex(newToken));
  });

  it('FR-103: a failing mail does not change the response, the new link is stored, and the log has the error name only', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const oldHash = await tokenHashOf(pending.id);
    failMail = true;
    logged.length = 0;
    await reissue(admin, pending.id).expect(200);
    expect(await tokenHashOf(pending.id)).not.toBe(oldHash);
    expect(await auditCount(pending.id)).toBe(1);
    const all = logged.join('');
    expect(all).toContain('Staff invite email failed (Error)');
    expect(all).not.toContain(pending.email);
    expect(all).not.toContain('set-password#token');
  });

  it('FR-103: re-issues count against the per-org invite limit (429) and a refused one changes nothing', async () => {
    const org = (await owner.organization.create({ data: { name: 'Reissue Limit Org' } })).id;
    const admin = await make(UserRole.SUPER_ADMIN, { orgId: org });
    const pending = await make(UserRole.AUTHOR, { orgId: org, pending: true });
    const { UsersService } =
      jest.requireActual<typeof import('./users.service')>('./users.service');
    const svc = app.get(UsersService);
    const before = Reflect.get(svc, 'inviteLimit') as number;
    Reflect.set(svc, 'inviteLimit', 2);
    try {
      await reissue(admin, pending.id).expect(200);
      await reissue(admin, pending.id).expect(200);
      const hash2 = await tokenHashOf(pending.id);
      await reissue(admin, pending.id).expect(429);
      expect(await tokenHashOf(pending.id)).toBe(hash2);
      expect(await auditCount(pending.id)).toBe(2);
      expect(invites).toHaveLength(2);
    } finally {
      Reflect.set(svc, 'inviteLimit', before);
    }
  });

  it('FR-103: a re-issue racing the invitee accepting waits on the row lock, then is a 409 and does not overwrite the new password or revive a link', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const held = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await held.connect();
    const newHash = await hash(NEW_PASSWORD, ARGON2_OPTIONS);
    let racing: Promise<request.Response> | undefined;
    try {
      await held.query('BEGIN');
      // The invitee's acceptance in flight: row locked, password set, not yet committed.
      await held.query(
        `UPDATE users SET password_hash = $2, set_password_token_hash = NULL, set_password_expires_at = NULL WHERE id = $1`,
        [pending.id, newHash],
      );
      racing = reissue(admin, pending.id).then((r) => r);
      await untilLockWaiter();
      await held.query('COMMIT');
    } finally {
      await held.query('ROLLBACK').catch(() => undefined);
      await held.end().catch(() => undefined);
    }
    if (racing === undefined) throw new Error('unreachable');
    expect((await racing).status).toBe(409);
    const row = await owner.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.passwordHash).toBe(newHash);
    expect(row.setPasswordTokenHash).toBeNull();
    expect(await auditCount(pending.id)).toBe(0);
    expect(invites).toHaveLength(0);
  });

  it('FR-105: a failing audit insert rolls the token rotation back: 500, old link still works, no mail, no audit row', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const oldHash = await tokenHashOf(pending.id);
    try {
      await pg.query(
        `CREATE OR REPLACE FUNCTION fail_reissue_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$ LANGUAGE plpgsql`,
      );
      await pg.query(
        `CREATE TRIGGER fail_reissue BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action = 'USER_INVITE_REISSUED') EXECUTE FUNCTION fail_reissue_audit()`,
      );
      await reissue(admin, pending.id).expect(500);
    } finally {
      await pg.query('DROP TRIGGER IF EXISTS fail_reissue ON audit_logs');
      await pg.query('DROP FUNCTION IF EXISTS fail_reissue_audit()');
    }
    expect(await tokenHashOf(pending.id)).toBe(oldHash);
    expect(await auditCount(pending.id)).toBe(0);
    expect(invites).toHaveLength(0);
    await accept(pending.token).expect(204);
  });

  it('FR-103: Redis down on the invite slot is 503; hash unchanged, no audit row, no mail', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const before = await tokenHashOf(pending.id);
    const { REDIS_CLIENT } = jest.requireActual<
      typeof import('../infrastructure/infrastructure.module')
    >('../infrastructure/infrastructure.module');
    const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
    const set = jest.spyOn(redis, 'set').mockRejectedValue(new Error('redis down'));
    try {
      await reissue(admin, pending.id).expect(503);
    } finally {
      set.mockRestore();
    }
    expect(await tokenHashOf(pending.id)).toBe(before);
    expect(await auditCount(pending.id)).toBe(0);
    expect(invites).toHaveLength(0);
  });

  it('FR-103: the mirror race: acceptance arriving while a re-issue holds the row lock is refused after the commit (old link dead)', async () => {
    const admin = await make(UserRole.SUPER_ADMIN);
    const pending = await make(UserRole.AUTHOR, { pending: true });
    const held = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await held.connect();
    const newToken = `rotated-${randomBytes(8).toString('hex')}`;
    let racing: Promise<request.Response> | undefined;
    try {
      await held.query('BEGIN');
      await held.query(
        `UPDATE users SET set_password_token_hash = $2, set_password_expires_at = now() + interval '72 hours' WHERE id = $1`,
        [pending.id, sha256Hex(newToken)],
      );
      racing = accept(pending.token).then((r) => r);
      await untilLockWaiter();
      await held.query('COMMIT');
    } finally {
      await held.query('ROLLBACK').catch(() => undefined);
      await held.end().catch(() => undefined);
    }
    if (racing === undefined) throw new Error('unreachable');
    expect((await racing).status).toBe(400);
    const row = await owner.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.setPasswordTokenHash).toBe(sha256Hex(newToken));
    void admin;
  });
});
