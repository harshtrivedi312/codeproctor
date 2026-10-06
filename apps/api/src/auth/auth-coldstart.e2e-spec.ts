import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import { encryptSecret } from './crypto.util';
import { ARGON2_OPTIONS } from './password.service';

const API = '/api/v1/auth';
const PASSWORD = 'Correct-Horse-9';
const SECRET = 'JBSWY3DPEHPK3PXP';
const USERS = 5;

describe('2FA verify right after a cold start (FR-102, TC-003, NFR-03, NFR-04, QA-D-04)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let orgId: string;
  let key: Buffer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '10000' });
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    orgId = (await prisma.organization.create({ data: { name: 'Cold Start Org' } })).id;
    key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await infra?.stop();
  });

  async function createTotpUsers(prefix: string, count: number): Promise<string[]> {
    const emails: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const email = `${prefix}${i}@example.com`;
      emails.push(email);
      await prisma.user.create({
        data: {
          orgId,
          email,
          fullName: `${prefix} ${i}`,
          role: UserRole.REVIEWER,
          passwordHash: await hash(PASSWORD, ARGON2_OPTIONS),
          totpSecretEnc: encryptSecret(SECRET, key),
          totpEnabled: true,
        },
      });
    }
    return emails;
  }

  async function bootFreshApp(): Promise<void> {
    await app?.close();
    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const { MailPort } =
      jest.requireActual<typeof import('../mail/mail.port')>('../mail/mail.port');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailPort)
      .useValue({ sendPasswordReset: () => Promise.resolve() })
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
  }

  // Password sign-in does not touch Redis, so the first Redis use is the verify that follows.
  async function challengeFor(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { challengeToken: string }).challengeToken;
  }

  it('TC-003: parallel 2FA verifies on a freshly booted app (lazy Redis not yet connected) all succeed, never 503', async () => {
    const emails = await createTotpUsers('cold', USERS);
    await bootFreshApp();
    const challenges = await Promise.all(emails.map(challengeFor));
    const code = authenticator.generate(SECRET);
    const results = await Promise.all(
      challenges.map((challengeToken) =>
        request(app.getHttpServer()).post(`${API}/2fa/verify`).send({ challengeToken, code }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(USERS).fill(200));
    for (const r of results)
      expect((r.body as { accessToken?: string }).accessToken).toEqual(expect.any(String));
  });

  it('NFR-04: with Redis unreachable a 2FA verify fails closed with 503 within the health timeout, no session, no failed-login count', async () => {
    const [email] = await createTotpUsers('down', 1);
    // The challenge is signed with the test secrets, so get it from an app that still has Redis
    // (login is throttled in Redis since FU-BE-1), then point a fresh app at a dead Redis.
    await bootFreshApp();
    const challengeToken = await challengeFor(email ?? '');
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    await bootFreshApp();
    const started = Date.now();
    const res = await request(app.getHttpServer())
      .post(`${API}/2fa/verify`)
      .send({ challengeToken, code: authenticator.generate(SECRET) });
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1500 + 1500);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((res.body as { accessToken?: string }).accessToken).toBeUndefined();
    const row = await prisma.user.findUniqueOrThrow({ where: { email: email ?? '' } });
    expect(row.failedLogins).toBe(0);
  });
});
