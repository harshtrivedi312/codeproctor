// D-76, FR-107, FR-102, TC-003: the account holder gets one queued email when staff two-factor
// sign-in is turned on, off or reset. The action never depends on delivery: a failed enqueue or a
// failed notice audit write changes nothing in the response or the stored state.
import type { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AuthService } from './auth.service';
import type { MailPort } from '../mail/mail.port';
import type { TokenService } from '../common/auth/token.service';
import type { TokenValidityService } from '../common/auth/token-validity.service';
import { createPrismaClient } from '../database/create-prisma-client';
import type { PrismaService } from '../database/prisma.service';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import type { EmailJob } from '../mail/mail-templates';
import { renderMail } from '../mail/mail-templates';
import type { EnqueueOutcome } from '../mail/email-queue.port';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import { encryptSecret, passwordVersion } from './crypto.util';
import { ARGON2_OPTIONS } from './password.service';

const API = '/api/v1/auth';
const PASSWORD = 'Correct-Horse-9';
const ADMIN_PASSWORD = 'Admin-Horse-Staple-7';
const WRONG = 'Wrong-Password-1';
const SECRET = 'JBSWY3DPEHPK3PXP';
const SUBJECTS = {
  'two-factor-enabled': 'Two-factor sign-in was turned on for your account',
  'two-factor-disabled': 'Two-factor sign-in was turned off for your account',
  'two-factor-reset': 'Two-factor sign-in was reset on your account',
} as const;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Body {
  manualKey: string;
  recoveryCodes: string[];
}

describe('Two-factor change emails (D-76, FR-107, FR-102, TC-003)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let orgId: string;
  let appPrisma: PrismaService;
  let validity: TokenValidityService;
  let tokenService: TokenService;
  let authService: AuthService;
  let seq = 0;
  const jobs: EmailJob[] = [];
  let queueMode: 'accept' | 'reject' | 'throw' = 'accept';
  const logged: string[] = [];

  const captureStreams = (): void => {
    for (const stream of [process.stdout, process.stderr]) {
      jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        logged.push(String(chunk));
        return true;
      });
    }
  };

  beforeAll(async () => {
    captureStreams();
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '10000', LOG_LEVEL: 'info' });
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    orgId = (await prisma.organization.create({ data: { name: 'Notice Org' } })).id;
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { EmailQueuePort } = jest.requireActual<typeof import('../mail/email-queue.port')>(
      '../mail/email-queue.port',
    );
    const fakeQueue = {
      enqueue: (job: EmailJob): Promise<EnqueueOutcome> => {
        if (queueMode === 'throw') return Promise.reject(new Error('queue exploded'));
        if (queueMode === 'reject') return Promise.resolve('rejected');
        // The lock alert (P-03) shares this queue; only the D-76 mails are watched here.
        if (job.template.startsWith('two-factor-')) jobs.push(job);
        return Promise.resolve('accepted');
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailQueuePort)
      .useValue(fakeQueue)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    authService = app.get(
      jest.requireActual<typeof import('./auth.service')>('./auth.service').AuthService,
    );
    appPrisma = app.get(
      jest.requireActual<typeof import('../database/prisma.service')>('../database/prisma.service')
        .PrismaService,
    );
    validity = app.get(
      jest.requireActual<typeof import('../common/auth/token-validity.service')>(
        '../common/auth/token-validity.service',
      ).TokenValidityService,
    );
    tokenService = app.get(
      jest.requireActual<typeof import('../common/auth/token.service')>(
        '../common/auth/token.service',
      ).TokenService,
    );
  });

  beforeEach(() => {
    jobs.length = 0;
    logged.length = 0;
    queueMode = 'accept';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    captureStreams();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await prisma?.$disconnect();
    await infra?.stop();
  });

  async function createUser(
    opts: { role?: UserRole; totp?: boolean; password?: string; active?: boolean } = {},
  ): Promise<{ id: string; email: string }> {
    const email = `notice${++seq}@example.com`;
    const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
    const user = await prisma.user.create({
      data: {
        orgId,
        email,
        fullName: `Planted Name ${seq}`,
        role: opts.role ?? UserRole.RECRUITER,
        passwordHash: await hash(opts.password ?? PASSWORD, ARGON2_OPTIONS),
        totpSecretEnc: opts.totp ? encryptSecret(SECRET, key) : null,
        totpEnabled: opts.totp === true,
        isActive: opts.active ?? true,
      },
    });
    return { id: user.id, email };
  }
  const createAdmin = (): Promise<{ id: string; email: string }> =>
    createUser({ role: UserRole.SUPER_ADMIN, password: ADMIN_PASSWORD });
  async function accessFor(id: string): Promise<string> {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    return tokenService.sign(
      {
        sub: u.id,
        org: u.orgId,
        role: u.role,
        kind: 'access',
        pwv: passwordVersion(u.passwordHash ?? ''),
      },
      900,
    );
  }
  const post = (path: string, token: string, body: object): request.Test =>
    request(app.getHttpServer())
      .post(`${API}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const disable = (token: string, totpCode: string, currentPassword = PASSWORD): request.Test =>
    post('/2fa/disable', token, { currentPassword, totpCode });
  const reset = (token: string, targetId: string, currentPassword = ADMIN_PASSWORD): request.Test =>
    post(`/2fa/reset/${targetId}`, token, { currentPassword });
  const confirm = (token: string, code: string, currentPassword = PASSWORD): request.Test =>
    post('/2fa/setup/confirm', token, { currentPassword, code });

  async function startedEnrollment(): Promise<{
    id: string;
    email: string;
    token: string;
    key: string;
  }> {
    const u = await createUser();
    const token = await accessFor(u.id);
    const start = (await post('/2fa/setup/start', token, { currentPassword: PASSWORD }).expect(200))
      .body as Body;
    return { ...u, token, key: start.manualKey };
  }
  const noticeRows = (entityId: string) =>
    prisma.auditLog.findMany({ where: { action: 'AUTH_2FA_NOTICE', entityId } });
  const totpOn = async (id: string): Promise<boolean> =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).totpEnabled;
  const lockError = (): Error => Object.assign(new Error('lock wait'), { code: '55P03' });
  const p2028 = (): Error => {
    const { Prisma } = jest.requireActual<typeof import('../generated/prisma/client')>(
      '../generated/prisma/client',
    );
    return new Prisma.PrismaClientKnownRequestError('Transaction API error', {
      code: 'P2028',
      clientVersion: 'test',
    });
  };
  type TxFn = (tx: unknown) => Promise<unknown>;
  type TxRun = (fn: TxFn, o?: unknown) => Promise<unknown>;
  function txSpy(impl: (real: TxRun) => TxRun): void {
    const client = appPrisma.client;
    const real = client.$transaction.bind(client) as TxRun;
    jest
      .spyOn(client, '$transaction')
      .mockImplementationOnce(impl(real) as unknown as typeof client.$transaction);
  }
  /** The work runs, then the error is thrown inside the wrapper: the transaction rolls back. */
  const failAfterCallback = (): void =>
    txSpy(
      (real) => (fn, o) =>
        real(async (tx) => {
          await fn(tx);
          throw p2028();
        }, o),
    );
  /** The commit really lands, then the error is thrown: the worst case for an unknown outcome. */
  const commitThenFail = (): void =>
    txSpy((real) => async (fn, o) => {
      await real(fn, o);
      throw p2028();
    });

  /** Subject and body hold only the fixed text and the time; no planted value, link or name. */
  function expectCleanMail(job: EmailJob, forbidden: string[]): void {
    const rendered = renderMail(job);
    const all = `${rendered.subject}\n${rendered.html}\n${rendered.text}`;
    for (const v of forbidden) expect(all).not.toContain(v);
    expect(all).not.toMatch(/https?:|@|Planted Name/i);
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(Object.keys(job.params)).toEqual(['occurredAt']);
  }

  describe('the three triggers (D-76, FR-107)', () => {
    it('D-76, FR-102, TC-003: turning 2FA on queues exactly one two-factor-enabled mail to the account holder, with an ISO occurredAt and an AUTH_2FA_NOTICE audit row without the address', async () => {
      const e = await startedEnrollment();
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      const code = authenticator.generate(e.key);
      const res = await confirm(e.token, code).expect(200);
      const recovery = (res.body as Body).recoveryCodes;
      expect(jobs).toHaveLength(1);
      const job = jobs[0] as EmailJob;
      expect(job).toMatchObject({ template: 'two-factor-enabled', to: e.email });
      expect((job.params as { occurredAt: string }).occurredAt).toMatch(ISO_UTC);
      expect(renderMail(job).subject).toBe(SUBJECTS['two-factor-enabled']);
      expect(renderMail(job).text).not.toMatch(/session/i);
      expectCleanMail(job, [code, e.key, PASSWORD, ...recovery]);
      const rows = await noticeRows(e.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: e.id, entityType: 'user', entityId: e.id });
      expect(rows[0]?.metadata).toEqual({ template: 'two-factor-enabled', outcome: 'queued' });
      expect(
        JSON.stringify(rows[0], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toContain(e.email);
    });

    it('D-76, FR-102, TC-003: turning 2FA off queues exactly one two-factor-disabled mail that says every session was signed out', async () => {
      const u = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      const code = authenticator.generate(SECRET);
      await disable(await accessFor(u.id), code).expect(204);
      expect(jobs).toHaveLength(1);
      const job = jobs[0] as EmailJob;
      expect(job).toMatchObject({ template: 'two-factor-disabled', to: u.email });
      expect((job.params as { occurredAt: string }).occurredAt).toMatch(ISO_UTC);
      expect(renderMail(job).subject).toBe(SUBJECTS['two-factor-disabled']);
      expect(renderMail(job).text).toMatch(/session/i);
      expectCleanMail(job, [code, SECRET, PASSWORD]);
      const rows = await noticeRows(u.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toEqual({ template: 'two-factor-disabled', outcome: 'queued' });
    });

    it('D-76, FR-102, TC-003: an admin reset mails the TARGET, not the admin; the audit actor is the admin and the entity is the target', async () => {
      const admin = await createAdmin();
      const target = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      await reset(await accessFor(admin.id), target.id).expect(204);
      expect(jobs).toHaveLength(1);
      const job = jobs[0] as EmailJob;
      expect(job).toMatchObject({ template: 'two-factor-reset', to: target.email });
      expect(job.to).not.toBe(admin.email);
      expect((job.params as { occurredAt: string }).occurredAt).toMatch(ISO_UTC);
      expect(renderMail(job).subject).toBe(SUBJECTS['two-factor-reset']);
      expect(renderMail(job).text).toMatch(/an administrator/i);
      expect(renderMail(job).text).toMatch(/session/i);
      expectCleanMail(job, [ADMIN_PASSWORD, SECRET]);
      const rows = await noticeRows(target.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: admin.id, entityType: 'user' });
      expect(rows[0]?.metadata).toEqual({ template: 'two-factor-reset', outcome: 'queued' });
      expect(
        JSON.stringify(rows[0], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toContain(target.email);
    });

    it('D-76: resetting an account without 2FA, or a deactivated target, sends nothing', async () => {
      const admin = await createAdmin();
      const off = await createUser();
      const inactive = await createUser({ totp: true, active: false });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      const token = await accessFor(admin.id);
      await reset(token, off.id).expect(204);
      await reset(token, inactive.id).expect(204);
      expect(jobs).toHaveLength(0);
      expect(await noticeRows(off.id)).toHaveLength(0);
      expect(await noticeRows(inactive.id)).toHaveLength(0);
    });
  });

  describe('no mail when the action did not happen (D-76, FR-107)', () => {
    it('D-76, TC-003: wrong password or wrong code (403), 409 and lockout send nothing', async () => {
      const e = await startedEnrollment();
      await confirm(e.token, '000000', WRONG).expect(403);
      await confirm(e.token, '000000').expect(400);
      const on = await createUser({ totp: true });
      const token = await accessFor(on.id);
      await disable(token, authenticator.generate(SECRET), WRONG).expect(403);
      await disable(token, '000000').expect(403);
      const off = await createUser();
      await disable(await accessFor(off.id), '000000').expect(409);
      const admin = await createAdmin();
      const target = await createUser({ totp: true });
      await reset(await accessFor(admin.id), target.id, WRONG).expect(403);
      const victim = await createUser({ totp: true });
      const vt = await accessFor(victim.id);
      for (let i = 0; i < 5; i++) await disable(vt, '000000', WRONG).expect(403);
      await disable(vt, authenticator.generate(SECRET)).expect(403); // locked
      expect(jobs).toHaveLength(0);
      const ids = [e.id, on.id, off.id, target.id, victim.id];
      expect(
        await prisma.auditLog.count({
          where: { action: 'AUTH_2FA_NOTICE', entityId: { in: ids } },
        }),
      ).toBe(0);
    });

    it('D-76, TC-003: a Redis marker failure (503 rollback) on confirm, disable and reset sends nothing', async () => {
      const { ServiceUnavailableException } =
        jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
      const e = await startedEnrollment();
      jest
        .spyOn(validity, 'invalidateIssuedTokens')
        .mockRejectedValue(new ServiceUnavailableException('down'));
      await confirm(e.token, authenticator.generate(e.key)).expect(503);
      const on = await createUser({ totp: true });
      await disable(await accessFor(on.id), authenticator.generate(SECRET)).expect(503);
      const admin = await createAdmin();
      const target = await createUser({ totp: true });
      await reset(await accessFor(admin.id), target.id).expect(503);
      expect(jobs).toHaveLength(0);
      expect(await totpOn(target.id)).toBe(true);
      expect(await totpOn(on.id)).toBe(true);
    });

    it('D-76, TC-003: a pre-commit lock timeout (503 BUSY) and a rolled-back commit-time P2028 on reset send nothing', async () => {
      const admin = await createAdmin();
      const t1 = await createUser({ totp: true });
      const t2 = await createUser({ totp: true });
      const token = await accessFor(admin.id);
      jest.spyOn(validity, 'invalidateIssuedTokens').mockRejectedValueOnce(lockError());
      await reset(token, t1.id).expect(503);
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      failAfterCallback();
      await reset(token, t2.id).expect(503);
      expect(jobs).toHaveLength(0);
    });

    it("FR-107, D-76, TC-003: a reset whose commit-time P2028 DID land is still 503 BUSY and mails the TARGET exactly once (this request's audit row proves it)", async () => {
      const admin = await createAdmin();
      const target = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      const token = await accessFor(admin.id);
      commitThenFail();
      await reset(token, target.id).expect(503);
      expect(await totpOn(target.id)).toBe(false);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ template: 'two-factor-reset', to: target.email });
      expect(jobs[0]?.to).not.toBe(admin.email);
      // The admin's retry is a no-op reset and sends nothing more.
      await reset(token, target.id).expect(204);
      expect(jobs).toHaveLength(1);
    });

    it('FR-107, D-76, TC-003: a reset whose commit did NOT land (P2028 at COMMIT, rolled back) sends none', async () => {
      const admin = await createAdmin();
      const target = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      failAfterCallback();
      await reset(await accessFor(admin.id), target.id).expect(503);
      expect(await totpOn(target.id)).toBe(true);
      expect(jobs).toHaveLength(0);
    });

    it('FR-107, D-76, TC-003: a no-op reset (target 2FA off) whose commit outcome is unknown sends none', async () => {
      const admin = await createAdmin();
      const target = await createUser();
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      commitThenFail();
      await reset(await accessFor(admin.id), target.id).expect(503);
      expect(jobs).toHaveLength(0);
    });

    it('FR-107, D-76, TC-003: when the re-read cannot be made after an unknown reset, no mail and the response stays 503', async () => {
      const admin = await createAdmin();
      const target = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      jest
        .spyOn(authService as unknown as { lockedReread: () => Promise<null> }, 'lockedReread')
        .mockResolvedValue(null);
      commitThenFail();
      await reset(await accessFor(admin.id), target.id).expect(503);
      expect(jobs).toHaveLength(0);
    });

    it.each([
      ['audit lookup unreadable, 2FA off now', { totpEnabled: false, proof: null }, 1],
      ['audit lookup unreadable, 2FA still on', { totpEnabled: true, proof: null }, 0],
      ['no audit row of this request', { totpEnabled: false, proof: false }, 0],
    ])('FR-107, D-76, TC-003: reset unknown outcome fallback, %s', async (_n, read, mails) => {
      const admin = await createAdmin();
      const target = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      jest
        .spyOn(authService as unknown as { lockedReread: () => Promise<unknown> }, 'lockedReread')
        .mockResolvedValue(read);
      commitThenFail();
      await reset(await accessFor(admin.id), target.id).expect(503);
      expect(jobs).toHaveLength(mails);
    });

    it('FR-107, D-76, FU-BE-265: the disable re-read gives up after its 2 s lock_timeout when another connection holds the row: no mail, the response stays the fixed 500', async () => {
      const u = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      const holder = new Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      const client = appPrisma.client;
      const real = client.$transaction.bind(client) as TxRun;
      jest.spyOn(client, '$transaction').mockImplementationOnce((async (fn: TxFn, o?: unknown) => {
        await real(fn, o);
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]);
        throw p2028();
      }) as unknown as typeof client.$transaction);
      const started = Date.now();
      try {
        const res = await disable(await accessFor(u.id), authenticator.generate(SECRET));
        expect(res.status).toBe(500);
        expect(Date.now() - started).toBeLessThan(6000);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      expect(await totpOn(u.id)).toBe(false);
      expect(jobs).toHaveLength(0);
    });

    it('D-76, TC-003: the unknown-outcome 500 on setup/confirm sends nothing, even when the commit did land', async () => {
      const e = await startedEnrollment();
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      commitThenFail();
      await confirm(e.token, authenticator.generate(e.key)).expect(500);
      expect(await totpOn(e.id)).toBe(true);
      expect(jobs).toHaveLength(0);
      expect(await noticeRows(e.id)).toHaveLength(0);
    });

    it('D-76, TC-003: the unknown-outcome 500 on disable sends nothing when the locking re-read shows the commit did not land', async () => {
      const u = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      failAfterCallback();
      await disable(await accessFor(u.id), authenticator.generate(SECRET)).expect(500);
      expect(await totpOn(u.id)).toBe(true);
      expect(jobs).toHaveLength(0);
    });

    it('D-76, TC-003: the unknown-outcome 500 on disable mails the holder when the locking re-read shows the change landed; the response stays the fixed 500', async () => {
      const u = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      commitThenFail();
      const res = await disable(await accessFor(u.id), authenticator.generate(SECRET)).expect(500);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(await totpOn(u.id)).toBe(false);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ template: 'two-factor-disabled', to: u.email });
    });
  });

  describe('a failed notice never changes the action (D-76)', () => {
    it.each(['throw', 'reject'] as const)(
      'D-76, FR-102, TC-003: when the queue fails by "%s", confirm, disable and reset keep their status and state and the audit row says failed with no address',
      async (mode) => {
        queueMode = mode;
        jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
        const e = await startedEnrollment();
        await confirm(e.token, authenticator.generate(e.key)).expect(200);
        expect(await totpOn(e.id)).toBe(true);
        const on = await createUser({ totp: true });
        await disable(await accessFor(on.id), authenticator.generate(SECRET)).expect(204);
        expect(await totpOn(on.id)).toBe(false);
        const admin = await createAdmin();
        const target = await createUser({ totp: true });
        await reset(await accessFor(admin.id), target.id).expect(204);
        expect(await totpOn(target.id)).toBe(false);
        expect(jobs).toHaveLength(0);
        const cases: [string, string, string][] = [
          [e.id, e.email, 'two-factor-enabled'],
          [on.id, on.email, 'two-factor-disabled'],
          [target.id, target.email, 'two-factor-reset'],
        ];
        for (const [id, email, template] of cases) {
          const rows = await noticeRows(id);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.metadata).toEqual({ template, outcome: 'failed' });
          expect(
            JSON.stringify(rows[0], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
          ).not.toContain(email);
        }
        const text = logged.join('');
        expect(text).not.toContain('queue exploded');
        for (const [, email] of cases) expect(text).not.toContain(email);
      },
    );

    it('D-76, TC-003: a failed notice audit write is logged by error name and action only; the response and state are unchanged', async () => {
      const u = await createUser({ totp: true });
      jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
      const model = appPrisma.client.auditLog;
      jest.spyOn(model, 'create').mockRejectedValueOnce(new Error(`boom ${u.email}`));
      await disable(await accessFor(u.id), authenticator.generate(SECRET)).expect(204);
      expect(await totpOn(u.id)).toBe(false);
      expect(jobs).toHaveLength(1);
      const text = logged.join('');
      expect(text).toContain('AUTH_2FA_NOTICE');
      expect(text).not.toContain(u.email);
      expect(text).not.toContain('boom');
    });
  });

  it('FU-BE-267, D-76, TC-003: when MailPort.sendTwoFactorNotice itself rejects, the response is 2xx, the audit outcome is failed and the planted value is not logged', async () => {
    const u = await createUser({ totp: true });
    jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
    const mail = (authService as unknown as { mail: MailPort }).mail;
    jest
      .spyOn(mail, 'sendTwoFactorNotice')
      .mockRejectedValue(new Error(`planted-value-Zq9 ${u.email}`));
    await disable(await accessFor(u.id), authenticator.generate(SECRET)).expect(204);
    expect(await totpOn(u.id)).toBe(false);
    const rows = await noticeRows(u.id);
    expect(rows[0]?.metadata).toEqual({ template: 'two-factor-disabled', outcome: 'failed' });
    const text = logged.join('');
    expect(text).not.toContain('planted-value-Zq9');
    expect(text).not.toContain(u.email);
  });

  it('D-76, FR-107, TC-003: logs hold no address, code, key, password or recovery code for any of the three actions', async () => {
    jest.spyOn(validity, 'invalidateIssuedTokens').mockResolvedValue(undefined);
    const e = await startedEnrollment();
    const code = authenticator.generate(e.key);
    const recovery = ((await confirm(e.token, code).expect(200)).body as Body).recoveryCodes;
    const on = await createUser({ totp: true });
    await disable(await accessFor(on.id), authenticator.generate(SECRET)).expect(204);
    const admin = await createAdmin();
    const target = await createUser({ totp: true });
    await reset(await accessFor(admin.id), target.id).expect(204);
    const text = logged.join('');
    const planted = [
      e.email,
      on.email,
      target.email,
      code,
      e.key,
      SECRET,
      PASSWORD,
      ADMIN_PASSWORD,
    ];
    for (const v of [...planted, ...recovery]) expect(text).not.toContain(v);
  });
});
