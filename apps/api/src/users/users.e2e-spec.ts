// Staff user management, RBAC, audit and lockout alert/unlock against a real Postgres 16 and
// Redis (Testcontainers). The API runs as app_user, the role it has in production (ADR 0006).
import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { encryptSecret, passwordVersion, sha256Hex } from '../auth/crypto.util';
import { ARGON2_OPTIONS } from '../auth/password.service';
const hash2 = (p: string): Promise<string> => hash(p, ARGON2_OPTIONS);
import type { AuthService } from '../auth/auth.service';
import type { PasswordService } from '../auth/password.service';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import type { MailPort } from '../mail/mail.port';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import type { TokenService } from '../common/auth/token.service';

const API = '/api/v1';
const PASSWORD = 'Correct-Horse-9';
const NEW_PASSWORD = 'Another-Horse-42!';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

interface Body {
  [key: string]: unknown;
  detail?: string;
  items?: Record<string, unknown>[];
  total?: number;
  session?: { accessToken: string };
}

interface Mails {
  invites: { to: string; url: string }[];
  locked: { to: string; email: string; minutes: number }[];
  failLocked: boolean;
}

/** A problem body without the per-request members, for "identical body" comparisons. */
function stable(res: request.Response): Record<string, unknown> {
  const { traceId: _t, instance: _i, ...rest } = res.body as Record<string, unknown>;
  void _t;
  void _i;
  return rest;
}

describe('Staff user management, RBAC and audit (FR-101, FR-103, FR-105, TC-002, TC-004, TC-006, TC-008)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let owner: PrismaClient;
  let pg: Client;
  let appUserUrl: string;
  let orgA: string;
  let orgB: string;
  let tokens: TokenService;
  let authService: AuthService;
  let passwordVerify: jest.SpyInstance<Promise<boolean>, [string, string]>;
  let realVerify: (hash: string, password: string) => Promise<boolean>;
  let PgClient: typeof Client;
  const logged: string[] = [];
  let stdout: jest.SpyInstance;
  const mails: Mails = { invites: [], locked: [], failLocked: false };
  let seq = 0;

  const fakeMail: Pick<
    MailPort,
    'sendPasswordReset' | 'sendStaffInvite' | 'sendStaffAccountLocked'
  > = {
    sendPasswordReset: () => Promise.resolve(),
    sendStaffInvite: (to, url) => {
      mails.invites.push({ to, url });
      return Promise.resolve();
    },
    sendStaffAccountLocked: (to, locked) => {
      if (mails.failLocked) return Promise.reject(new Error(`smtp down for ${to}`));
      mails.locked.push({ to, email: locked.email, minutes: locked.minutes });
      return Promise.resolve();
    },
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
    appUserUrl = `postgresql://app_user:${appPassword}@${infra.postgres.getHost()}:${infra.postgres.getMappedPort(5432)}/${infra.postgres.getDatabase()}`;
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
    const { AuthService: Auth } =
      jest.requireActual<typeof import('../auth/auth.service')>('../auth/auth.service');
    authService = app.get(Auth);
    const { TokenService: Tokens } = jest.requireActual<
      typeof import('../common/auth/token.service')
    >('../common/auth/token.service');
    tokens = app.get(Tokens);
    const { PasswordService: Passwords } = jest.requireActual<
      typeof import('../auth/password.service')
    >('../auth/password.service');
    const passwords: PasswordService = app.get(Passwords);
    realVerify = passwords.verify.bind(passwords);
    passwordVerify = jest.spyOn(passwords, 'verify') as typeof passwordVerify;
    // The pg driver of the app (loaded after resetModules): counts statements sent by the API.
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
    mails.failLocked = false;
    passwordVerify.mockImplementation(realVerify);
  });

  // ---- fixtures -------------------------------------------------------------------------------

  interface Made {
    id: string;
    email: string;
    auth: { Authorization: string };
  }

  async function make(
    role: UserRole,
    opts: { orgId?: string; password?: string | null; totp?: string } = {},
  ): Promise<Made> {
    const n = ++seq;
    const email = `u${n}@example.com`;
    const passwordHash =
      opts.password === null ? null : await hash(opts.password ?? PASSWORD, ARGON2_OPTIONS);
    const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
    const user = await owner.user.create({
      data: {
        orgId: opts.orgId ?? orgA,
        email,
        fullName: `User ${n}`,
        role,
        passwordHash,
        setPasswordTokenHash: passwordHash === null ? sha256Hex(`invite-${n}`) : null,
        totpSecretEnc: opts.totp ? encryptSecret(opts.totp, key) : null,
        totpEnabled: opts.totp !== undefined,
      },
    });
    const token = tokens.sign(
      {
        sub: user.id,
        org: user.orgId,
        role,
        kind: 'access',
        pwv: passwordVersion(passwordHash ?? ''),
      },
      900,
    );
    return { id: user.id, email, auth: { Authorization: `Bearer ${token}` } };
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const login = (email: string, password = PASSWORD): request.Test =>
    http().post(`${API}/auth/login`).send({ email, password });

  async function lockByLogins(email: string): Promise<void> {
    for (let i = 0; i < 5; i++) await login(email, 'wrong-password-1').expect(401);
    await authService.settleDeferred();
  }

  async function auditRows(
    action: string,
    entityId?: string,
  ): Promise<
    {
      org_id: string;
      actor_id: string | null;
      entity_id: string | null;
      ip: string | null;
      metadata: unknown;
    }[]
  > {
    const r = await pg.query(
      `SELECT org_id, actor_id, entity_id, host(ip) AS ip, metadata FROM audit_logs
       WHERE action = $1 AND ($2::text IS NULL OR entity_id = $2) ORDER BY id`,
      [action, entityId ?? null],
    );
    return r.rows as never;
  }

  const liveTokens = (userId: string): Promise<number> =>
    owner.refreshToken.count({ where: { userId, revokedAt: null } });

  /** Number of statements the API sends while `run` is awaited (pg Client.query calls). */
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

  // ---- FR-103, TC-004: role guard and the route matrix -----------------------------------------

  describe('FR-103, TC-004: only a SUPER_ADMIN reaches the admin user routes', () => {
    it('TC-004: RECRUITER, AUTHOR and REVIEWER get 403 on every admin user route and nothing changes', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const victim = await make(UserRole.RECRUITER);
      for (const role of [UserRole.RECRUITER, UserRole.AUTHOR, UserRole.REVIEWER]) {
        const caller = await make(role);
        const calls: request.Test[] = [
          http().get(`${API}/admin/users`).set(caller.auth),
          http().get(`${API}/admin/users/lock-events`).set(caller.auth),
          http().post(`${API}/admin/users`).set(caller.auth).send({
            currentPassword: PASSWORD,
            email: 'x@example.com',
            name: 'X',
            role: 'RECRUITER',
          }),
          http()
            .patch(`${API}/admin/users/${victim.id}`)
            .set(caller.auth)
            .send({ currentPassword: PASSWORD, role: 'AUTHOR' }),
          http()
            .post(`${API}/admin/users/${victim.id}/unlock`)
            .set(caller.auth)
            .send({ currentPassword: PASSWORD }),
        ];
        for (const call of calls) expect((await call).status).toBe(403);
      }
      const row = await owner.user.findUniqueOrThrow({ where: { id: victim.id } });
      expect(row.role).toBe(UserRole.RECRUITER);
      expect(await owner.user.count({ where: { email: 'x@example.com' } })).toBe(0);
      await http().get(`${API}/admin/users`).set(admin.auth).expect(200);
    });

    it('TC-008, FR-103: a validly signed token that claims another org for the user is 401 (the re-check runs in the claimed org)', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const stored = await owner.user.findUniqueOrThrow({ where: { id: admin.id } });
      const wrongOrg = tokens.sign(
        {
          sub: admin.id,
          org: orgB,
          role: UserRole.SUPER_ADMIN,
          kind: 'access',
          pwv: passwordVersion(stored.passwordHash ?? ''),
        },
        900,
      );
      const res = await http()
        .get(`${API}/admin/users`)
        .set({ Authorization: `Bearer ${wrongOrg}` });
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(orgA);
    });

    it('TC-004: no token and a forged token are 401 on the admin routes', async () => {
      await http().get(`${API}/admin/users`).expect(401);
      await http()
        .get(`${API}/admin/users`)
        .set({ Authorization: 'Bearer not.a.token' })
        .expect(401);
    });

    it('FR-103: a demoted admin loses access at once, with the same still-valid access token', async () => {
      const a = await make(UserRole.SUPER_ADMIN);
      const b = await make(UserRole.SUPER_ADMIN);
      await http()
        .patch(`${API}/admin/users/${b.id}`)
        .set(a.auth)
        .send({ currentPassword: PASSWORD, role: 'RECRUITER' })
        .expect(200);
      expect((await http().get(`${API}/admin/users`).set(b.auth)).status).toBe(401);
    });

    it('TC-004: every controller route is in the matrix, with the same access as its decorators (FR-103)', () => {
      const { ModulesContainer } =
        jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core');
      const { listRoutes, matrixProblems } = jest.requireActual<
        typeof import('../common/auth/route-registry')
      >('../common/auth/route-registry');
      const { ROUTE_PERMISSIONS } = jest.requireActual<
        typeof import('../common/auth/route-permissions')
      >('../common/auth/route-permissions');
      const routes = listRoutes(app.get(ModulesContainer));
      expect(routes.length).toBeGreaterThan(15);
      expect(matrixProblems(routes)).toEqual([]);
      expect(ROUTE_PERMISSIONS['GET /health']).toBe('public');
      for (const r of routes.filter((x) => x.key.includes('/auth/'))) {
        expect(ROUTE_PERMISSIONS[r.key]).toBeDefined();
      }
    });
  });

  // ---- FR-105, TC-006: audit ------------------------------------------------------------------

  describe('FR-105, TC-006: audit rows', () => {
    it('TC-006: listing users writes an audit row with org, actor, action, IP and no body or query values', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await http().get(`${API}/admin/users?page=1&pageSize=5`).set(admin.auth).expect(200);
      const rows = (await auditRows('USER_LIST')).filter((r) => r.actor_id === admin.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.org_id).toBe(orgA);
      expect(rows[0]?.ip).toMatch(/127\.0\.0\.1/);
      expect(rows[0]?.metadata).toEqual({ method: 'GET', route: '/api/v1/admin/users' });
    });

    it('TC-006: if the audit write fails the request fails and no data is returned (fail closed)', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const { PrismaService } = jest.requireActual<typeof import('../database/prisma.service')>(
        '../database/prisma.service',
      );
      const client = app.get(PrismaService).client;
      const create = jest.spyOn(client.auditLog, 'create').mockRejectedValue(new Error('disk'));
      try {
        const res = await http().get(`${API}/admin/users`).set(admin.auth);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('items');
        expect(JSON.stringify(res.body)).not.toContain('@example.com');
      } finally {
        create.mockRestore();
      }
    });

    it('TC-006: a refused call (403) writes no audit row', async () => {
      const rec = await make(UserRole.RECRUITER);
      await http().get(`${API}/admin/users`).set(rec.auth).expect(403);
      expect((await auditRows('USER_LIST')).filter((r) => r.actor_id === rec.id)).toHaveLength(0);
    });
  });

  // ---- invite ---------------------------------------------------------------------------------

  describe('FR-103, FR-107: invite and set password (ADR 0003 section 4, FU-BE-32)', () => {
    async function invite(admin: Made, email: string, role = 'RECRUITER'): Promise<Body> {
      mails.invites.length = 0;
      const res = await http()
        .post(`${API}/admin/users`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, email, name: 'New Person', role })
        .expect(201);
      return res.body as Body;
    }
    const tokenOf = (url: string): string => url.split('#token=')[1] ?? '';

    it('TC-004: an invite stores only the SHA-256 of the token for 72 hours, mails the link once, and logs no token', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const before = Date.now();
      const body = await invite(admin, 'invitee1@example.com');
      expect(body).toMatchObject({ status: 'invited', role: 'RECRUITER', locked: false });
      expect(mails.invites).toHaveLength(1);
      const token = tokenOf(mails.invites[0]?.url ?? '');
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      const row = await owner.user.findUniqueOrThrow({ where: { email: 'invitee1@example.com' } });
      expect(row.orgId).toBe(orgA);
      expect(row.passwordHash).toBeNull();
      expect(row.setPasswordTokenHash).toBe(sha256Hex(token));
      const ttl = (row.setPasswordExpiresAt?.getTime() ?? 0) - before;
      expect(ttl).toBeGreaterThan(72 * 3600_000 - 60_000);
      expect(ttl).toBeLessThan(72 * 3600_000 + 60_000);
      expect(logged.join('')).not.toContain(token);
      const audit = await auditRows('USER_INVITED', row.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ org_id: orgA, actor_id: admin.id });
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain(token);
      // The pending user cannot sign in, and forgot-password does not replace the invite token.
      await login('invitee1@example.com', 'anything-at-all-1').expect(401);
      await http()
        .post(`${API}/auth/password/forgot`)
        .send({ email: 'invitee1@example.com' })
        .expect(202);
      await authService.settleDeferred();
      const after = await owner.user.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.setPasswordTokenHash).toBe(row.setPasswordTokenHash);
    });

    it('FR-103: a duplicate email is 409; a bad body is 400', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const other = await make(UserRole.RECRUITER, { orgId: orgB });
      await http()
        .post(`${API}/admin/users`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, email: other.email, name: 'Dup', role: 'RECRUITER' })
        .expect(409);
      await http()
        .post(`${API}/admin/users`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, email: 'not-an-email', name: '', role: 'KING' })
        .expect(400);
      await http()
        .post(`${API}/admin/users`)
        .set(admin.auth)
        .send({
          currentPassword: PASSWORD,
          email: 'x1@example.com',
          name: 'X',
          role: 'RECRUITER',
          orgId: orgB,
        })
        .expect(400);
    });

    it('FR-107: the invite link sets the password once, never signs in, revokes sessions and is audited; reuse and expiry give the same 400', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await invite(admin, 'invitee2@example.com');
      const token = tokenOf(mails.invites[0]?.url ?? '');
      const row = await owner.user.findUniqueOrThrow({ where: { email: 'invitee2@example.com' } });
      const set = (t: string, password = NEW_PASSWORD): request.Test =>
        http().post(`${API}/auth/password/reset`).send({ token: t, newPassword: password });

      const done = await set(token).expect(204);
      expect(done.headers['set-cookie']).toBeUndefined();
      expect(done.body).toEqual({});
      const after = await owner.user.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.passwordHash).not.toBeNull();
      expect(after.setPasswordTokenHash).toBeNull();
      expect(after.setPasswordExpiresAt).toBeNull();
      expect(await auditRows('AUTH_INVITE_ACCEPTED', row.id)).toHaveLength(1);
      await login('invitee2@example.com', NEW_PASSWORD).expect(200);

      const reused = await set(token).expect(400);
      // Expired.
      await invite(admin, 'invitee3@example.com');
      const t3 = tokenOf(mails.invites[0]?.url ?? '');
      await owner.user.update({
        where: { email: 'invitee3@example.com' },
        data: { setPasswordExpiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await set(t3).expect(400);
      const unknown = await set(randomBytes(32).toString('base64url')).expect(400);
      expect(stable(expired)).toEqual(stable(reused));
      expect(stable(unknown)).toEqual(stable(reused));
      expect(
        await owner.user.findUniqueOrThrow({ where: { email: 'invitee3@example.com' } }),
      ).toMatchObject({ passwordHash: null });
    });

    it('FR-107: two parallel uses of one invite link set the password exactly once', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await invite(admin, 'invitee4@example.com');
      const token = tokenOf(mails.invites[0]?.url ?? '');
      const results = await Promise.all(
        ['First-Password-1!', 'Second-Password-2!'].map((p) =>
          http().post(`${API}/auth/password/reset`).send({ token, newPassword: p }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
      const row = await owner.user.findUniqueOrThrow({ where: { email: 'invitee4@example.com' } });
      expect(await auditRows('AUTH_INVITE_ACCEPTED', row.id)).toHaveLength(1);
    });

    it('FR-107: a deactivated invitee cannot accept the invite', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const body = await invite(admin, 'invitee5@example.com');
      const token = tokenOf(mails.invites[0]?.url ?? '');
      await http()
        .patch(`${API}/admin/users/${String(body.id)}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, active: false })
        .expect(200);
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(400);
    });
  });

  // ---- role change and deactivation ------------------------------------------------------------

  describe('FR-103, FR-104: role change and deactivation', () => {
    it('TC-004: a role change revokes every refresh family, ends the old access token, and is audited with org, actor, target and IP', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      const session = (await login(user.email).expect(200)).body as Body;
      expect(await liveTokens(user.id)).toBe(1);
      const res = await http()
        .patch(`${API}/admin/users/${user.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, role: 'AUTHOR' })
        .expect(200);
      expect((res.body as Body).role).toBe('AUTHOR');
      expect(await liveTokens(user.id)).toBe(0);
      expect(
        (
          await http()
            .get(`${API}/admin/users`)
            .set({ Authorization: `Bearer ${session.session?.accessToken ?? ''}` })
        ).status,
      ).toBe(401);
      const rows = await auditRows('USER_ROLE_CHANGED', user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ org_id: orgA, actor_id: admin.id });
      expect(rows[0]?.ip).toMatch(/127\.0\.0\.1/);
      expect(rows[0]?.metadata).toEqual({ from: 'RECRUITER', to: 'AUTHOR', sessionsRevoked: 1 });
    });

    it('FR-104: deactivation ends sessions at once: access token 401, refresh 401, login 401; reactivation restores login', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      const first = await login(user.email).expect(200);
      const cookie = ((first.headers['set-cookie'] as unknown as string[]) ?? [])[0] ?? '';
      const access = { Authorization: `Bearer ${(first.body as Body).session?.accessToken ?? ''}` };
      await http()
        .patch(`${API}/admin/users/${user.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, active: false })
        .expect(200);
      expect(await liveTokens(user.id)).toBe(0);
      expect(
        (
          await http()
            .post(`${API}/auth/2fa/disable`)
            .set(access)
            .send({ currentPassword: PASSWORD })
        ).status,
      ).toBe(401);
      await http().post(`${API}/auth/refresh`).set('Cookie', cookie).expect(401);
      await login(user.email).expect(401);
      expect(await auditRows('USER_DEACTIVATED', user.id)).toHaveLength(1);
      const back = await http()
        .patch(`${API}/admin/users/${user.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, active: true })
        .expect(200);
      expect((back.body as Body).status).toBe('active');
      await login(user.email).expect(200);
    });

    it('FR-103: an admin cannot demote or deactivate themselves (409); a no-op change is a 200 without audit', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await http()
        .patch(`${API}/admin/users/${admin.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, role: 'RECRUITER' })
        .expect(409);
      await http()
        .patch(`${API}/admin/users/${admin.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, active: false })
        .expect(409);
      await http()
        .patch(`${API}/admin/users/${admin.id.toUpperCase()}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, role: 'REVIEWER' })
        .expect(409);
      await http()
        .patch(`${API}/admin/users/${admin.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD })
        .expect(400);
      await http()
        .patch(`${API}/admin/users/${admin.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, role: 'SUPER_ADMIN', active: true })
        .expect(200);
      expect(await auditRows('USER_ROLE_CHANGED', admin.id)).toHaveLength(0);
      expect((await owner.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe(
        UserRole.SUPER_ADMIN,
      );
    });

    it('FR-103: two admins demoting each other at once leave exactly one active SUPER_ADMIN of the org', async () => {
      const org = (await owner.organization.create({ data: { name: 'Race Org' } })).id;
      const a = await make(UserRole.SUPER_ADMIN, { orgId: org });
      const b = await make(UserRole.SUPER_ADMIN, { orgId: org });
      const results = await Promise.all([
        http()
          .patch(`${API}/admin/users/${b.id}`)
          .set(a.auth)
          .send({ currentPassword: PASSWORD, role: 'RECRUITER' }),
        http()
          .patch(`${API}/admin/users/${a.id}`)
          .set(b.auth)
          .send({ currentPassword: PASSWORD, role: 'RECRUITER' }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        await owner.user.count({ where: { orgId: org, role: 'SUPER_ADMIN', isActive: true } }),
      ).toBe(1);
    });

    it('TC-098: a deactivation waits on the user row lock of an uncommitted sign-in, then revokes the token that sign-in created (users row before tokens)', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      // A sign-in in flight: it has read the user FOR SHARE and inserted its refresh token, but
      // has not committed.
      const inflight = new Client({ connectionString: infra.postgres.getConnectionUri() });
      await inflight.connect();
      await inflight.query('BEGIN');
      await inflight.query(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
         SELECT u.id, gen_random_uuid(), $2, now() + interval '7 days' FROM users u
         WHERE u.id = $1 AND u.is_active FOR SHARE OF u`,
        [user.id, sha256Hex(randomBytes(8).toString('hex'))],
      );
      const deactivate = http()
        .patch(`${API}/admin/users/${user.id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, active: false })
        .then((r) => r);
      await untilLockWaiter();
      // Still blocked: the sign-in's token is not visible yet and the deactivation has not finished.
      expect(await liveTokens(user.id)).toBe(0);
      expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).isActive).toBe(true);
      await inflight.query('COMMIT');
      await inflight.end();
      expect((await deactivate).status).toBe(200);
      expect(await liveTokens(user.id)).toBe(0);
    });

    it('FR-104: a refresh that starts after a deactivation commits is refused and leaves no live token', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      const first = await login(user.email).expect(200);
      const cookie = ((first.headers['set-cookie'] as unknown as string[]) ?? [])[0] ?? '';
      const results = await Promise.all([
        http()
          .patch(`${API}/admin/users/${user.id}`)
          .set(admin.auth)
          .send({ currentPassword: PASSWORD, active: false }),
        http().post(`${API}/auth/refresh`).set('Cookie', cookie),
      ]);
      expect(results[0].status).toBe(200);
      expect([200, 401]).toContain(results[1].status);
      expect(await liveTokens(user.id)).toBe(0);
    });
  });

  // ---- B1: step-up (the admin's current password) on every state-changing admin route ----------------

  describe('FR-103, FR-102 follow-up: a stolen SUPER_ADMIN access token alone changes nothing', () => {
    const calls = (adminAuth: { Authorization: string }, targetId: string, body: object) => ({
      invite: () =>
        http()
          .post(`${API}/admin/users`)
          .set(adminAuth)
          .send({ email: 'stepup@example.com', name: 'S', role: 'SUPER_ADMIN', ...body }),
      role: () =>
        http()
          .patch(`${API}/admin/users/${targetId}`)
          .set(adminAuth)
          .send({ role: 'AUTHOR', ...body }),
      deactivate: () =>
        http()
          .patch(`${API}/admin/users/${targetId}`)
          .set(adminAuth)
          .send({ active: false, ...body }),
      unlock: () => http().post(`${API}/admin/users/${targetId}/unlock`).set(adminAuth).send(body),
      reissue: () => http().post(`${API}/admin/users/${targetId}/invite`).set(adminAuth).send(body),
    });

    it('TC-004: no password is 400; a wrong password is the same 403 REAUTH_FAILED on every route; nothing changes', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const victim = await make(UserRole.RECRUITER);
      await owner.user.update({
        where: { id: victim.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
      });
      const missing = calls(admin.auth, victim.id, {});
      for (const name of ['invite', 'role', 'deactivate', 'unlock', 'reissue'] as const) {
        expect([name, (await missing[name]()).status]).toEqual([name, 400]);
      }
      const wrong = calls(admin.auth, victim.id, { currentPassword: 'not-the-password-1' });
      const bodies: unknown[] = [];
      for (const name of ['invite', 'role', 'deactivate', 'unlock', 'reissue'] as const) {
        const res = await wrong[name]();
        expect([name, res.status]).toEqual([name, 403]);
        expect((res.body as Body).code).toBe('REAUTH_FAILED');
        bodies.push(stable(res));
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(await owner.user.count({ where: { email: 'stepup@example.com' } })).toBe(0);
      const row = await owner.user.findUniqueOrThrow({ where: { id: victim.id } });
      expect(row).toMatchObject({ role: 'RECRUITER', isActive: true, failedLogins: 5 });
      expect(row.lockedUntil).not.toBeNull();
      expect(await auditRows('USER_UNLOCKED', victim.id)).toHaveLength(0);
      expect(await auditRows('USER_INVITED')).not.toContainEqual(
        expect.objectContaining({ actor_id: admin.id }),
      );
    });

    it('FR-101, TC-002: repeated wrong admin passwords lock the admin like a login; a locked admin password is the same 403 as a wrong one', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const victim = await make(UserRole.RECRUITER);
      const unlock = (password: string): request.Test =>
        http()
          .post(`${API}/admin/users/${victim.id}/unlock`)
          .set(admin.auth)
          .send({ currentPassword: password });
      const wrong = await unlock('nope-nope-nope-1');
      for (let i = 0; i < 6; i++) await unlock('nope-nope-nope-1');
      const lockedRight = await unlock(PASSWORD);
      expect(lockedRight.status).toBe(403);
      expect(stable(lockedRight)).toEqual(stable(wrong));
      expect(await auditRows('USER_UNLOCKED', victim.id)).toHaveLength(0);
    });

    it('TC-002: a refused step-up costs the same statements for a wrong and a locked admin password and for a real and a missing target (invite, role, deactivate, unlock)', async () => {
      const wrongAdmin = await make(UserRole.SUPER_ADMIN);
      const lockedAdmin = await make(UserRole.SUPER_ADMIN);
      await owner.user.update({
        where: { id: lockedAdmin.id },
        data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
      });
      const victim = await make(UserRole.RECRUITER);
      const ghost = '00000000-0000-4000-8000-000000000043';
      const names = ['invite', 'role', 'deactivate', 'unlock', 'reissue'] as const;
      const measure = async (admin: Made, target: string): Promise<number[]> => {
        // Keep the wrong-password admin below the lock threshold: the 5th failure writes more.
        await owner.user.update({ where: { id: wrongAdmin.id }, data: { failedLogins: 0 } });
        const c = calls(admin.auth, target, { currentPassword: 'nope-nope-nope-1' });
        const counts: number[] = [];
        for (const name of names) {
          // Five routes would reach the lock threshold (the 5th failure writes more): reset each time.
          await owner.user.update({ where: { id: wrongAdmin.id }, data: { failedLogins: 0 } });
          let res: request.Response | undefined;
          counts.push(
            await statementsDuring(async () => {
              res = await c[name]();
            }),
          );
          expect([name, res?.status]).toEqual([name, 403]);
        }
        return counts;
      };
      const wrongVictim = await measure(wrongAdmin, victim.id);
      const wrongGhost = await measure(wrongAdmin, ghost);
      const lockedVictim = await measure(lockedAdmin, victim.id);
      const lockedGhost = await measure(lockedAdmin, ghost);
      expect(wrongVictim.every((n) => n > 2)).toBe(true);
      expect(wrongGhost).toEqual(wrongVictim);
      expect(lockedVictim).toEqual(wrongVictim);
      expect(lockedGhost).toEqual(wrongVictim);
    });

    it('FR-103: with the right password everything works; the password check precedes the 404', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const ghost = '00000000-0000-4000-8000-000000000044';
      const wrongToGhost = await calls(admin.auth, ghost, {
        currentPassword: 'nope-nope-nope-1',
      }).role();
      expect(wrongToGhost.status).toBe(403);
      const rightToGhost = await calls(admin.auth, ghost, { currentPassword: PASSWORD }).role();
      expect(rightToGhost.status).toBe(404);
    });

    it('TC-004: an admin whose password changed after the check is refused inside the transaction (no state change)', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const victim = await make(UserRole.RECRUITER);
      // The password changes while the admin password is being verified.
      passwordVerify.mockImplementationOnce(async (hash: string, password: string) => {
        const ok = await realVerify(hash, password);
        await owner.user.update({
          where: { id: admin.id },
          data: { passwordHash: await hash2(NEW_PASSWORD) },
        });
        return ok;
      });
      const res = await calls(admin.auth, victim.id, { currentPassword: PASSWORD }).role();
      expect(res.status).toBe(403);
      expect((res.body as Body).code).toBe('REAUTH_FAILED');
      expect((await owner.user.findUniqueOrThrow({ where: { id: victim.id } })).role).toBe(
        UserRole.RECRUITER,
      );
    });

    it('TC-004: an admin demoted while the password was being verified is refused (no state change)', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      await make(UserRole.SUPER_ADMIN);
      const victim = await make(UserRole.RECRUITER);
      passwordVerify.mockImplementationOnce(async (hash: string, password: string) => {
        const ok = await realVerify(hash, password);
        await owner.user.update({ where: { id: admin.id }, data: { role: UserRole.RECRUITER } });
        return ok;
      });
      const res = await calls(admin.auth, victim.id, { currentPassword: PASSWORD }).deactivate();
      expect(res.status).toBe(403);
      expect((await owner.user.findUniqueOrThrow({ where: { id: victim.id } })).isActive).toBe(
        true,
      );
    });
  });

  // ---- S1: tokens issued before a role change or deactivation stay dead -----------------------------

  describe('FR-104, S1: a role change or deactivation ends access tokens for good', () => {
    const patch = (admin: Made, id: string, body: object): request.Test =>
      http()
        .patch(`${API}/admin/users/${id}`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD, ...body });
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 1100));

    it('FR-104: deactivate then reactivate inside the token lifetime does not revive the old access token', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.SUPER_ADMIN);
      await http().get(`${API}/admin/users`).set(user.auth).expect(200);
      await patch(admin, user.id, { active: false }).expect(200);
      await patch(admin, user.id, { active: true }).expect(200);
      expect((await http().get(`${API}/admin/users`).set(user.auth)).status).toBe(401);
      // A fresh sign-in works.
      await pause();
      // A SUPER_ADMIN signs in with 2FA; mint the token the sign-in would, after the change.
      const stored = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
      const access = {
        Authorization: `Bearer ${tokens.sign(
          {
            sub: user.id,
            org: orgA,
            role: UserRole.SUPER_ADMIN,
            kind: 'access',
            pwv: passwordVersion(stored.passwordHash ?? ''),
          },
          900,
        )}`,
      };
      await http().get(`${API}/admin/users`).set(access).expect(200);
    });

    it('FR-104: a role changed A to B and back to A does not revive a token issued under A', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      await patch(admin, user.id, { role: 'AUTHOR' }).expect(200);
      await patch(admin, user.id, { role: 'RECRUITER' }).expect(200);
      // The old token claims RECRUITER and the user is RECRUITER again: only the marker refuses it.
      expect(
        (
          await http()
            .post(`${API}/auth/2fa/disable`)
            .set(user.auth)
            .send({ currentPassword: PASSWORD })
        ).status,
      ).toBe(401);
    });

    it('FR-104: the guard refuses with 503 when the marker cannot be read (Redis down), never lets the token through', async () => {
      const user = await make(UserRole.RECRUITER);
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      const get = jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
      try {
        const res = await http()
          .post(`${API}/auth/2fa/disable`)
          .set(user.auth)
          .send({ currentPassword: PASSWORD });
        expect(res.status).toBe(503);
      } finally {
        get.mockRestore();
      }
    });

    it('FR-102, FR-104: an admin 2FA reset ends the target access tokens at once, and rolls back with 503 if the marker cannot be written', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      await owner.user.update({
        where: { id: user.id },
        data: { totpEnabled: true, totpSecretEnc: 'x' },
      });
      const reset = (): request.Test =>
        http()
          .post(`${API}/auth/2fa/reset/${user.id}`)
          .set(admin.auth)
          .send({ currentPassword: PASSWORD });
      const set = jest.spyOn(redis, 'eval').mockRejectedValue(new Error('redis down'));
      try {
        expect((await reset()).status).toBe(503);
      } finally {
        set.mockRestore();
      }
      expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).totpEnabled).toBe(
        true,
      );
      const probe = (): request.Test =>
        http().post(`${API}/auth/2fa/disable`).set(user.auth).send({ currentPassword: PASSWORD });
      expect((await probe()).status).not.toBe(401);
      await reset().expect(204);
      expect((await probe()).status).toBe(401);
    });

    it('FR-104: the marker script only raises the value and always refreshes the TTL (real Redis)', async () => {
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const { TokenValidityService: Validity, MARKER_TTL_SECONDS } = jest.requireActual<
        typeof import('../common/auth/token-validity.service')
      >('../common/auth/token-validity.service');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      const validity = app.get(Validity);
      const id = '99999999-9999-4999-8999-999999999999';
      const key = `auth:tokens-valid-after:${id}`;
      await redis.del(key);
      const now = Math.floor(Date.now() / 1000);
      // Absent: set to now with the full TTL.
      await validity.invalidateIssuedTokens(id);
      expect(Math.abs(Number(await redis.get(key)) - now)).toBeLessThanOrEqual(2);
      expect(await redis.ttl(key)).toBeGreaterThan(MARKER_TTL_SECONDS - 5);
      // A marker ahead of now (a fast clock elsewhere) is never moved back; the TTL is refreshed.
      await redis.set(key, String(now + 60), 'EX', 30);
      await validity.invalidateIssuedTokens(id);
      expect(await redis.get(key)).toBe(String(now + 60));
      expect(await redis.ttl(key)).toBeGreaterThan(MARKER_TTL_SECONDS - 5);
      // An older marker is raised.
      await redis.set(key, String(now - 600), 'EX', 30);
      await validity.invalidateIssuedTokens(id);
      expect(Number(await redis.get(key))).toBeGreaterThanOrEqual(now);
      await redis.del(key);
    });

    it('FR-104: if the marker cannot be written the role change rolls back (503), nothing half-done', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      const { REDIS_CLIENT } = jest.requireActual<
        typeof import('../infrastructure/infrastructure.module')
      >('../infrastructure/infrastructure.module');
      const redis = app.get<import('ioredis').Redis>(REDIS_CLIENT);
      await login(user.email).expect(200);
      const set = jest.spyOn(redis, 'eval').mockRejectedValue(new Error('redis down'));
      try {
        expect((await patch(admin, user.id, { role: 'AUTHOR' })).status).toBe(503);
      } finally {
        set.mockRestore();
      }
      expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe(
        UserRole.RECRUITER,
      );
      expect(await liveTokens(user.id)).toBe(1);
      expect(await auditRows('USER_ROLE_CHANGED', user.id)).toHaveLength(0);
    });
  });

  // ---- S2: invite rate limit ---------------------------------------------------------------------------

  describe('FR-103, S2: per-organization invite limit', () => {
    it('FR-103: the 3rd invite in an hour is 429 when the limit is 2, and a refused invite creates no user', async () => {
      const org = (await owner.organization.create({ data: { name: 'Invite Limit Org' } })).id;
      const admin = await make(UserRole.SUPER_ADMIN, { orgId: org });
      const { UsersService } =
        jest.requireActual<typeof import('./users.service')>('./users.service');
      const svc = app.get(UsersService);
      const before = Reflect.get(svc, 'inviteLimit') as number;
      Reflect.set(svc, 'inviteLimit', 2);
      try {
        const send = (n: number): request.Test =>
          http()
            .post(`${API}/admin/users`)
            .set(admin.auth)
            .send({
              currentPassword: PASSWORD,
              email: `limit${n}@example.com`,
              name: 'L',
              role: 'AUTHOR',
            });
        await send(1).expect(201);
        await send(2).expect(201);
        await send(3).expect(429);
        expect(await owner.user.count({ where: { email: 'limit3@example.com' } })).toBe(0);
        // Another org has its own budget.
        const other = await make(UserRole.SUPER_ADMIN, { orgId: orgB });
        await http()
          .post(`${API}/admin/users`)
          .set(other.auth)
          .send({
            currentPassword: PASSWORD,
            email: 'limitb@example.com',
            name: 'L',
            role: 'AUTHOR',
          })
          .expect(201);
      } finally {
        Reflect.set(svc, 'inviteLimit', before);
      }
    });

    it('FR-103: the limit comes from INVITE_RATE_LIMIT_PER_ORG_HOUR, default 20', () => {
      const { validateEnv } = jest.requireActual<typeof import('../config/env')>('../config/env');
      const saved = process.env.INVITE_RATE_LIMIT_PER_ORG_HOUR;
      try {
        delete process.env.INVITE_RATE_LIMIT_PER_ORG_HOUR;
        expect(validateEnv({ ...process.env }).INVITE_RATE_LIMIT_PER_ORG_HOUR).toBe(20);
        process.env.INVITE_RATE_LIMIT_PER_ORG_HOUR = '3';
        expect(validateEnv({ ...process.env }).INVITE_RATE_LIMIT_PER_ORG_HOUR).toBe(3);
      } finally {
        if (saved === undefined) delete process.env.INVITE_RATE_LIMIT_PER_ORG_HOUR;
        else process.env.INVITE_RATE_LIMIT_PER_ORG_HOUR = saved;
      }
    });
  });

  // ---- TC-008: org isolation on the real routes --------------------------------------------------

  describe('TC-008 (NFR-04, FR-103): a SUPER_ADMIN of org A cannot see or change org B users', () => {
    it('TC-008: the users list and the lock-events list never contain another org', async () => {
      const adminA = await make(UserRole.SUPER_ADMIN);
      const userB = await make(UserRole.RECRUITER, { orgId: orgB });
      await lockByLogins(userB.email);
      const list = (
        await http().get(`${API}/admin/users?pageSize=100`).set(adminA.auth).expect(200)
      ).body as Body;
      expect(JSON.stringify(list)).not.toContain(userB.email);
      expect(list.items?.every((u) => u.id !== userB.id)).toBe(true);
      const events = (
        await http().get(`${API}/admin/users/lock-events`).set(adminA.auth).expect(200)
      ).body as Body;
      expect(JSON.stringify(events)).not.toContain(userB.id);
    });

    it('TC-008: role change, deactivate and unlock of another org user are the same 404 as a missing id, with the same statements', async () => {
      const adminA = await make(UserRole.SUPER_ADMIN);
      const userB = await make(UserRole.RECRUITER, { orgId: orgB });
      await login(userB.email).expect(200);
      expect(await liveTokens(userB.id)).toBe(1);
      const ghost = '00000000-0000-4000-8000-000000000042';
      const attempts: [string, (id: string) => request.Test][] = [
        [
          'role',
          (id) =>
            http()
              .patch(`${API}/admin/users/${id}`)
              .set(adminA.auth)
              .send({ currentPassword: PASSWORD, role: 'AUTHOR' }),
        ],
        [
          'deactivate',
          (id) =>
            http()
              .patch(`${API}/admin/users/${id}`)
              .set(adminA.auth)
              .send({ currentPassword: PASSWORD, active: false }),
        ],
        [
          'unlock',
          (id) =>
            http()
              .post(`${API}/admin/users/${id}/unlock`)
              .set(adminA.auth)
              .send({ currentPassword: PASSWORD }),
        ],
      ];
      for (const [name, call] of attempts) {
        let cross: request.Response | undefined;
        let missing: request.Response | undefined;
        const crossCount = await statementsDuring(async () => {
          cross = await call(userB.id);
        });
        const missingCount = await statementsDuring(async () => {
          missing = await call(ghost);
        });
        expect([name, cross?.status]).toEqual([name, 404]);
        expect([name, missing?.status]).toEqual([name, 404]);
        expect(stable(cross as request.Response)).toEqual(stable(missing as request.Response));
        expect(crossCount).toBeGreaterThan(2);
        expect([name, crossCount]).toEqual([name, missingCount]);
      }
      const row = await owner.user.findUniqueOrThrow({ where: { id: userB.id } });
      expect(row).toMatchObject({ role: 'RECRUITER', isActive: true });
      // The cross-org attempts revoked nothing.
      expect(await liveTokens(userB.id)).toBe(1);
    });

    it('TC-008: an invite is stamped with the caller org, never one from the body', async () => {
      const adminA = await make(UserRole.SUPER_ADMIN);
      await http()
        .post(`${API}/admin/users`)
        .set(adminA.auth)
        .send({
          currentPassword: PASSWORD,
          email: 'stamped@example.com',
          name: 'S',
          role: 'AUTHOR',
        })
        .expect(201);
      expect(
        (await owner.user.findUniqueOrThrow({ where: { email: 'stamped@example.com' } })).orgId,
      ).toBe(orgA);
    });
  });

  // ---- FR-101, TC-002: lock alert, visibility and unlock -------------------------------------------

  describe('FR-101, TC-002: lock alert, lock visibility and unlock (P-03)', () => {
    it('TC-002: a lock emails each active SUPER_ADMIN of the org once, none of another org, and appears in the lock-events list', async () => {
      const a1 = await make(UserRole.SUPER_ADMIN);
      const a2 = await make(UserRole.SUPER_ADMIN);
      const otherOrg = await make(UserRole.SUPER_ADMIN, { orgId: orgB });
      const user = await make(UserRole.RECRUITER);
      mails.locked.length = 0;
      await lockByLogins(user.email);
      // Further attempts on the locked account never re-alert.
      await login(user.email, 'wrong-password-1').expect(401);
      await login(user.email, PASSWORD).expect(401);
      await authService.settleDeferred();
      const mine = mails.locked.filter((m) => m.email === user.email);
      expect(mine.map((m) => m.to).sort()).toEqual(
        (
          await owner.user.findMany({
            where: {
              orgId: orgA,
              role: 'SUPER_ADMIN',
              isActive: true,
              passwordHash: { not: null },
            },
            select: { email: true },
          })
        )
          .map((u) => u.email)
          .sort(),
      );
      expect(mine.map((m) => m.to)).toEqual(expect.arrayContaining([a1.email, a2.email]));
      expect(mine.map((m) => m.to)).not.toContain(otherOrg.email);
      expect(mine.every((m) => m.minutes === 15)).toBe(true);
      expect(await auditRows('AUTH_ACCOUNT_LOCKED', user.id)).toHaveLength(1);

      const events = (await http().get(`${API}/admin/users/lock-events`).set(a1.auth).expect(200))
        .body as Body;
      const mineEvents = events.items?.filter((e) => e.userId === user.id) ?? [];
      expect(mineEvents).toHaveLength(1);
      expect(mineEvents[0]).toMatchObject({ email: user.email });
      expect(Object.keys(mineEvents[0] ?? {}).sort()).toEqual(
        ['email', 'id', 'lockedAt', 'name', 'userId'].sort(),
      );
      const list = (await http().get(`${API}/admin/users?pageSize=100`).set(a1.auth).expect(200))
        .body as Body;
      const row = list.items?.find((u) => u.id === user.id);
      expect(row).toMatchObject({ locked: true });
      expect(typeof row?.lockedUntil).toBe('string');
      expect(JSON.stringify(list)).not.toMatch(/hash|secret|token/i);
    });

    it('TC-002: a failing mailer never changes the locked user response, and is logged by name only', async () => {
      const user = await make(UserRole.RECRUITER);
      await make(UserRole.SUPER_ADMIN);
      mails.failLocked = true;
      logged.length = 0;
      const results: request.Response[] = [];
      for (let i = 0; i < 5; i++) results.push(await login(user.email, 'wrong-password-1'));
      await authService.settleDeferred();
      expect(results.every((r) => r.status === 401)).toBe(true);
      expect(new Set(results.map((r) => JSON.stringify(stable(r)))).size).toBe(1);
      const out = logged.join('');
      expect(out).toContain('Lock alert email failed (Error)');
      expect(out).not.toContain('smtp down');
    });

    it('FR-101, TC-002: a locked account shows no lock to anyone but a SUPER_ADMIN of the same org (login, refresh, 2FA, re-auth bodies and headers)', async () => {
      const lockedPlain = await make(UserRole.RECRUITER);
      const freshPlain = await make(UserRole.RECRUITER);
      const lockedTotp = await make(UserRole.REVIEWER, { totp: TOTP_SECRET });
      const freshTotp = await make(UserRole.REVIEWER, { totp: TOTP_SECRET });
      // Sessions and challenges obtained before the lock.
      const sess = async (
        u: Made,
      ): Promise<{ cookie: string; access: { Authorization: string } }> => {
        const r = await login(u.email).expect(200);
        return {
          cookie: ((r.headers['set-cookie'] as unknown as string[]) ?? [])[0] ?? '',
          access: { Authorization: `Bearer ${(r.body as Body).session?.accessToken ?? ''}` },
        };
      };
      const lp = await sess(lockedPlain);
      const fp = await sess(freshPlain);
      const challenge = (u: Made): Promise<string> =>
        login(u.email)
          .expect(200)
          .then((r) => String((r.body as Body).challengeToken));
      const lc = await challenge(lockedTotp);
      const fc = await challenge(freshTotp);
      for (const u of [lockedPlain, lockedTotp]) {
        await owner.user.update({
          where: { id: u.id },
          data: { failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) },
        });
      }
      const shape = (r: request.Response): unknown => ({
        status: r.status,
        body: stable(r),
        headers: Object.keys(r.headers)
          .filter(
            (h) => !['date', 'etag', 'content-length', 'x-request-id', 'set-cookie'].includes(h),
          )
          .sort(),
      });
      const text = (r: request.Response): string => JSON.stringify([r.body, r.headers]);
      const pairs: [request.Response, request.Response][] = [
        [
          await login(lockedPlain.email, 'wrong-password-1'),
          await login(freshPlain.email, 'wrong-password-1'),
        ],
        [
          await login(lockedPlain.email, PASSWORD),
          await login(lockedPlain.email, 'wrong-password-1'),
        ],
        [
          await http().post(`${API}/auth/2fa/verify`).send({ challengeToken: lc, code: '000000' }),
          await http().post(`${API}/auth/2fa/verify`).send({ challengeToken: fc, code: '000000' }),
        ],
        [
          await http()
            .post(`${API}/auth/2fa/setup/start`)
            .set(lp.access)
            .send({ currentPassword: 'nope-nope-1' }),
          await http()
            .post(`${API}/auth/2fa/setup/start`)
            .set(fp.access)
            .send({ currentPassword: 'nope-nope-1' }),
        ],
        [
          await http()
            .post(`${API}/auth/2fa/setup/start`)
            .set(lp.access)
            .send({ currentPassword: PASSWORD }),
          await http()
            .post(`${API}/auth/2fa/setup/start`)
            .set(lp.access)
            .send({ currentPassword: 'nope-nope-1' }),
        ],
      ];
      for (const [locked, unlocked] of pairs) {
        expect(text(locked)).not.toMatch(/lock/i);
        expect(text(unlocked)).not.toMatch(/lock/i);
        expect(shape(locked)).toEqual(shape(unlocked));
      }
      // Refresh keeps working for a session that already exists, and says nothing about locks.
      const refreshed = await http().post(`${API}/auth/refresh`).set('Cookie', lp.cookie);
      expect(text(refreshed)).not.toMatch(/lock/i);
      expect(refreshed.status).toBe(200);
      const logout = await http().post(`${API}/auth/logout`).set('Cookie', fp.cookie);
      expect(text(logout)).not.toMatch(/lock/i);
      const forgot = await http()
        .post(`${API}/auth/password/forgot`)
        .send({ email: lockedPlain.email });
      expect(text(forgot)).not.toMatch(/lock/i);

      // Non-admins are refused the admin routes (403), another org's admin sees nothing, and the
      // admin of the same org sees the fields.
      const otherAdmin = await make(UserRole.SUPER_ADMIN, { orgId: orgB });
      const sameAdmin = await make(UserRole.SUPER_ADMIN);
      expect((await http().get(`${API}/admin/users`).set(lp.access)).status).toBe(403);
      await http()
        .get(`${API}/admin/users`)
        .set((await make(UserRole.RECRUITER)).auth)
        .expect(403);
      const otherList = (
        await http().get(`${API}/admin/users?pageSize=100`).set(otherAdmin.auth).expect(200)
      ).body as Body;
      expect(JSON.stringify(otherList)).not.toContain(lockedPlain.email);
      expect(
        (
          await http()
            .post(`${API}/admin/users/${lockedPlain.id}/unlock`)
            .set(otherAdmin.auth)
            .send({ currentPassword: PASSWORD })
        ).status,
      ).toBe(404);
      const sameList = (
        await http().get(`${API}/admin/users?pageSize=100`).set(sameAdmin.auth).expect(200)
      ).body as Body;
      expect(sameList.items?.find((u) => u.id === lockedPlain.id)).toMatchObject({ locked: true });
      expect(sameList.items?.find((u) => u.id === freshPlain.id)).toMatchObject({
        locked: false,
        lockedUntil: null,
      });
    });

    it('FR-101: unlock clears the lock, signs nobody in, keeps the password and sessions, and is audited with org, actor, target and IP', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      const session = await login(user.email).expect(200);
      const before = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
      await lockByLogins(user.email);
      await login(user.email).expect(401);
      const liveBefore = await liveTokens(user.id);
      await http()
        .post(`${API}/admin/users/${user.id.toUpperCase()}/unlock`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD })
        .expect(204);
      const after = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after).toMatchObject({ failedLogins: 0, lockedUntil: null });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(await liveTokens(user.id)).toBe(liveBefore);
      expect(session.status).toBe(200);
      await login(user.email).expect(200);
      const rows = await auditRows('USER_UNLOCKED', user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ org_id: orgA, actor_id: admin.id });
      expect(rows[0]?.ip).toMatch(/127\.0\.0\.1/);
      expect(rows[0]?.metadata).toEqual({ wasLocked: true });
      await http()
        .post(`${API}/admin/users/not-a-uuid/unlock`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD })
        .expect(400);
      // A SUPER_ADMIN may unlock themselves.
      await http()
        .post(`${API}/admin/users/${admin.id}/unlock`)
        .set(admin.auth)
        .send({ currentPassword: PASSWORD })
        .expect(204);
    });

    it('TC-002: unlocking while wrong guesses are in flight allows at most 5 verified guesses in the new window', async () => {
      const admin = await make(UserRole.SUPER_ADMIN);
      const user = await make(UserRole.RECRUITER);
      await lockByLogins(user.email);
      const stored = (await owner.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash;
      passwordVerify.mockClear();
      const results = await Promise.all([
        http()
          .post(`${API}/admin/users/${user.id}/unlock`)
          .set(admin.auth)
          .send({ currentPassword: PASSWORD }),
        ...Array.from({ length: 12 }, () => login(user.email, 'wrong-password-1')),
      ]);
      expect(results[0]?.status).toBe(204);
      expect(results.slice(1).every((r) => r.status === 401)).toBe(true);
      // Verifies against this user's hash (the dummy-hash burns of refused attempts do not count).
      const verified = passwordVerify.mock.calls.filter((c) => c[0] === stored).length;
      expect(verified).toBeLessThanOrEqual(5);
      const row = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.failedLogins).toBeLessThanOrEqual(5);
      // After the last guess of the window the account is locked again, or the window is not full.
      if (verified === 5) {
        await authService.settleDeferred();
        expect(row.lockedUntil).not.toBeNull();
      }
    });
  });
});
