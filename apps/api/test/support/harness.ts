// Shared setup for the QA integration tests. Starts throwaway Postgres 16 and Redis with
// Testcontainers, applies prisma/migrations, and boots the real Nest app AS app_user, the
// least-privileged role the product uses (ADR 0006), so a missing grant fails a test.
// Fixtures are written with the container owner role. Nothing here reads the host environment's
// database settings.
import type { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Client } from 'pg';
import { encryptSecret, sha256Hex } from '../../src/auth/crypto.util';
import { createPrismaClient } from '../../src/database/create-prisma-client';
import { PrismaClient, UserRole } from '../../src/generated/prisma/client';
import type { MailPort } from '../../src/mail/mail.port';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../../src/test/containers';

export const API = '/api/v1';
export const PASSWORD = 'Correct-Horse-9';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

export interface SentMail {
  to: string;
  url: string;
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

    const fakeMail: Pick<MailPort, 'sendPasswordReset'> = {
      sendPasswordReset: (to, url) => {
        mails.push({ to, url });
        return Promise.resolve();
      },
    };

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
      await startedApp.close();
      await startedOwner.$disconnect();
      await infra.stop();
    },
  };
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
    Authorization: `Bearer ${(done.body as unknown as { accessToken: string }).accessToken}`,
  };
}

/** Loose view of the JSON bodies; each test reads only the fields it expects. */
export interface Body {
  status: string;
  detail: string;
  title: string;
  challengeToken: string;
  accessToken: string;
  session: { accessToken: string; user: { email: string; role: string } };
  manualKey: string;
  otpauthUri: string;
  qrDataUrl: string;
  recoveryCodes: string[];
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
