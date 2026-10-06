// Shared setup for the QA integration tests. Starts throwaway Postgres 16 and Redis with
// Testcontainers, applies prisma/migrations, and boots the real Nest app AS app_user, the
// least-privileged role the product uses (ADR 0006), so a missing grant fails a test.
// Fixtures are written with the container owner role. Nothing here reads the host environment's
// database settings.
import type { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { encryptSecret, sha256Hex } from '../../src/auth/crypto.util';
import { createPrismaClient } from '../../src/database/create-prisma-client';
import { PrismaClient, UserRole } from '../../src/generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../../src/test/containers';

export const API = '/api/v1';
export const PASSWORD = 'Correct-Horse-9';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

export interface SentMail {
  /** MailPort method that was called, e.g. 'sendStaffInvite' (template staff-invite). */
  method: string;
  /** First argument when it is a string (the recipient); '' otherwise. */
  to: string;
  /** First argument that is an http(s) URL string, wherever it sits; '' when the mail has none. */
  url: string;
  /** Every argument as passed, for tests that read other fields (for example the lock mail). */
  args: unknown[];
}

export interface Harness {
  infra: TestInfra;
  app: INestApplication<App>;
  /** Owner-role client: for fixtures and for reading what the API wrote. Not the API's own role. */
  owner: PrismaClient;
  appUserUrl: string;
  orgId: string;
  mails: SentMail[];
  /** Everything the app wrote to stdout (request logs), when logs are on. */
  logged: string[];
  /** Waits for work the API defers until after the response (forgot-password mail, FU-BE-31). */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export interface BootOptions {
  env?: Record<string, string>;
  /** Capture stdout so a test can prove that no secret reaches the logs. */
  captureLogs?: boolean;
}

/** Docker Desktop sometimes misses the 10 s port-binding window; retry the start, never skip it. */
async function startInfraWithRetry(attempts = 3): Promise<TestInfra> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await startInfra();
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error('Testcontainers did not start');
}

export async function boot(opts: BootOptions = {}): Promise<Harness> {
  const logged: string[] = [];
  const stdout = opts.captureLogs
    ? jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        logged.push(String(chunk));
        return true;
      })
    : undefined;

  const infra = await startInfraWithRetry();
  let app: INestApplication<App> | undefined;
  let owner: PrismaClient | undefined;
  let appUserUrl: string;
  let orgId: string;
  const mails: SentMail[] = [];
  let settle: () => Promise<void> = () => Promise.resolve();
  try {
    await applyMigrations(infra);

    // app_user is created by the audit_append_only migration without a password (ADR 0006 7.4).
    const appPassword = randomBytes(18).toString('hex');
    const admin = new Client({ connectionString: infra.postgres.getConnectionUri() });
    await admin.connect();
    await admin.query(`ALTER ROLE app_user PASSWORD '${appPassword}'`);
    await admin.end();
    appUserUrl = `postgresql://app_user:${appPassword}@${infra.postgres.getHost()}:${infra.postgres.getMappedPort(5432)}/${infra.postgres.getDatabase()}`;

    applyEnv(infra, {
      DATABASE_URL: appUserUrl,
      THROTTLE_AUTH_LIMIT: '100000',
      LOG_LEVEL: opts.captureLogs ? 'info' : 'silent',
      ...opts.env,
    });
    owner = createPrismaClient(infra.postgres.getConnectionUri());
    orgId = (await owner.organization.create({ data: { name: 'QA Org A' } })).id;

    // Every MailPort send method (send*): records the method name and ALL arguments, so one fake
    // serves password reset, staff invite and staff-account-locked. It does not assume a call shape
    // such as (to, url): the URL is the first http(s) string among the arguments.
    const fakeMail = new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === 'string' && prop.startsWith('send')
            ? (...args: unknown[]) => {
                const url = args.find(
                  (a): a is string => typeof a === 'string' && /^https?:\/\//.test(a),
                );
                mails.push({
                  method: prop,
                  to: typeof args[0] === 'string' ? args[0] : '',
                  url: url ?? '',
                  args,
                });
                return Promise.resolve();
              }
            : undefined,
      },
    );

    jest.resetModules();
    const { AppModule } =
      jest.requireActual<typeof import('../../src/app.module')>('../../src/app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } =
      jest.requireActual<typeof import('../../src/bootstrap')>('../../src/bootstrap');
    const { AuthService } = jest.requireActual<typeof import('../../src/auth/auth.service')>(
      '../../src/auth/auth.service',
    );
    const { MailPort: MailToken } = jest.requireActual<typeof import('../../src/mail/mail.port')>(
      '../../src/mail/mail.port',
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailToken)
      .useValue(fakeMail)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    // Listen once on a free port so supertest reuses it instead of listen(0)/close per request.
    await app.listen(0, '127.0.0.1');
    const authService = app.get(AuthService);
    settle = () => authService.settleDeferred();
  } catch (error) {
    stdout?.mockRestore();
    await app?.close().catch(() => undefined);
    await owner?.$disconnect().catch(() => undefined);
    await infra.stop();
    throw error;
  }

  const startedApp = app;
  const startedOwner = owner;
  if (!startedApp || !startedOwner) throw new Error('harness did not start');
  return {
    infra,
    app: startedApp,
    owner: startedOwner,
    appUserUrl,
    orgId,
    mails,
    logged,
    settle: () => settle(),
    close: async () => {
      stdout?.mockRestore();
      await waitForValidation(startedApp); // a running validation job must not write to a closed Prisma
      await startedApp.close();
      await startedOwner.$disconnect();
      await infra.stop();
    },
  };
}

async function waitForValidation(app: INestApplication<App>): Promise<void> {
  const { ValidationService } = jest.requireActual<
    typeof import('../../src/questions/validation.service')
  >('../../src/questions/validation.service');
  await app.get(ValidationService, { strict: false }).whenIdle();
}

/**
 * Waits until the async question validation job (POST /questions/:id/validate, BE-04c) has finished
 * and written its QUESTION_VALIDATION_FINISHED row. Call it after every successful validate call.
 */
export function settleValidation(h: Harness): Promise<void> {
  return waitForValidation(h.app);
}

let seq = 0;

export interface UserOptions {
  role?: UserRole;
  /** null creates a pending invite (no password yet). */
  password?: string | null;
  totp?: string;
  orgId?: string;
}

export async function createUser(
  h: Harness,
  opts: UserOptions = {},
): Promise<{ id: string; email: string }> {
  const n = ++seq;
  const email = `qa-user${n}@example.com`;
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
  const user = await h.owner.user.create({
    data: {
      orgId: opts.orgId ?? h.orgId,
      email,
      fullName: `QA User ${n}`,
      role: opts.role ?? UserRole.RECRUITER,
      passwordHash:
        opts.password === null ? null : await hash(opts.password ?? PASSWORD, { algorithm: 2 }),
      setPasswordTokenHash: opts.password === null ? sha256Hex(`invite-${n}`) : null,
      totpSecretEnc: opts.totp ? encryptSecret(opts.totp, key) : null,
      totpEnabled: opts.totp !== undefined,
    },
  });
  return { id: user.id, email };
}

export const login = (h: Harness, email: string, password = PASSWORD): request.Test =>
  request(h.app.getHttpServer()).post(`${API}/auth/login`).send({ email, password });

export function refreshCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const raw = (header ?? []).find((c) => c.startsWith('cp_refresh='));
  if (!raw) throw new Error('no refresh cookie in the response');
  return raw.split(';')[0] ?? '';
}

export const refresh = (h: Harness, cookie: string): request.Test =>
  request(h.app.getHttpServer()).post(`${API}/auth/refresh`).set('Cookie', cookie);

/** Signs in a user with no 2FA and returns the Authorization header for protected routes. */
export async function signIn(
  h: Harness,
  email: string,
  password = PASSWORD,
): Promise<{ Authorization: string }> {
  const res = await login(h, email, password).expect(200);
  return { Authorization: `Bearer ${(res.body as Body).session.accessToken}` };
}

/** Signs in (with TOTP when a secret is given) and also returns the refresh cookie. */
export async function signInKeepingCookie(
  h: Harness,
  email: string,
  secret?: string,
): Promise<{ auth: { Authorization: string }; cookie: string }> {
  const first = await login(h, email).expect(200);
  if (!secret) {
    return {
      auth: { Authorization: `Bearer ${(first.body as Body).session.accessToken}` },
      cookie: refreshCookie(first),
    };
  }
  const done = await request(h.app.getHttpServer())
    .post(`${API}/auth/2fa/verify`)
    .send({
      challengeToken: (first.body as Body).challengeToken,
      code: authenticator.generate(secret),
    })
    .expect(200);
  return {
    auth: { Authorization: `Bearer ${(done.body as Body).accessToken}` },
    cookie: refreshCookie(done),
  };
}

/** Completes a 2FA login with a TOTP code and returns the Authorization header. */
export async function signInWithTotp(
  h: Harness,
  email: string,
  secret = TOTP_SECRET,
  password = PASSWORD,
): Promise<{ Authorization: string }> {
  const { challengeToken } = (await login(h, email, password).expect(200)).body as Body;
  const done = await request(h.app.getHttpServer())
    .post(`${API}/auth/2fa/verify`)
    .send({ challengeToken, code: authenticator.generate(secret) })
    .expect(200);
  // /2fa/verify answers with the session itself.
  return {
    Authorization: `Bearer ${(done.body as Body).accessToken}`,
  };
}

/**
 * The session user of a successful auth response. The contract puts it under `session` for login
 * and enroll/confirm ('nested') and at the top level for 2fa/verify and refresh ('flat').
 */
export function sessionUser(body: unknown, shape: 'nested' | 'flat'): Record<string, unknown> {
  const b = body as { session?: { user?: unknown }; user?: unknown };
  const user = shape === 'nested' ? b.session?.user : b.user;
  if (shape === 'nested' && b.user !== undefined)
    throw new Error('nested body has a top-level user');
  if (typeof user !== 'object' || user === null) {
    throw new Error(`no ${shape} session user in the body`);
  }
  if (shape === 'flat' && b.session !== undefined) throw new Error('flat body also has a session');
  return user as Record<string, unknown>;
}

/** FR-102: the caller's own 2FA state is on session users only, never on challenge or error bodies. */
export function expectNoTotpEnabled(res: request.Response): void {
  expect(res.text).not.toMatch(/totp_?enabled|twoFactorEnabled/i);
  expect(JSON.stringify(res.body)).not.toMatch(/totp_?enabled|twoFactorEnabled/i);
}

/** Loose view of the JSON bodies; each test reads only the fields it expects. */
export interface Body {
  status: string;
  detail: string;
  title: string;
  challengeToken: string;
  accessToken?: string;
  session: { accessToken: string; user: { email: string; role: string } };
  manualKey: string;
  otpauthUri: string;
  qrDataUrl: string;
  recoveryCodes: string[];
  user?: { email: string; role: string; totpEnabled: boolean };
  [key: string]: unknown;
}

export function claimsOf(jwt: string): { exp: number; iat: number; role: string; org: string } {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as {
    exp: number;
    iat: number;
    role: string;
    org: string;
  };
}

export const REAUTH_DETAIL = 'The current password is incorrect.';

/** Asserts the final FR-102 re-auth contract: 403 problem+json, code REAUTH_FAILED, fixed detail. */
export function expectReauthFailed(res: request.Response): void {
  expect(res.status).toBe(403);
  expect(res.headers['content-type']).toContain('application/problem+json');
  const body = res.body as Body;
  expect(body.code).toBe('REAUTH_FAILED');
  expect(body.detail).toBe(REAUTH_DETAIL);
}

/** A problem body without the per-request fields, for "identical body" comparisons. */
export function stableProblem(res: request.Response): Record<string, unknown> {
  const { traceId: _t, instance: _i, ...rest } = res.body as Record<string, unknown>;
  void _t;
  void _i;
  return rest;
}
