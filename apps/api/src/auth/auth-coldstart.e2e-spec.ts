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

describe('2FA verify right after a cold start (FR-102, TC-003, NFR-09, QA-D-04)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '10000' });
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await infra?.stop();
  });

  it('TC-003: parallel 2FA verifies on a freshly booted app (lazy Redis not yet connected) never answer 503', async () => {
    const orgId = (await prisma.organization.create({ data: { name: 'Cold Start Org' } })).id;
    const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
    const emails: string[] = [];
    for (let i = 0; i < USERS; i += 1) {
      const email = `cold${i}@example.com`;
      emails.push(email);
      await prisma.user.create({
        data: {
          orgId,
          email,
          fullName: `Cold ${i}`,
          role: UserRole.REVIEWER,
          passwordHash: await hash(PASSWORD, ARGON2_OPTIONS),
          totpSecretEnc: encryptSecret(SECRET, key),
          totpEnabled: true,
        },
      });
    }

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

    // Password sign-in does not touch Redis, so the first Redis use is the parallel verify burst.
    const challenges = await Promise.all(
      emails.map(async (email) => {
        const res = await request(app.getHttpServer())
          .post(`${API}/login`)
          .send({ email, password: PASSWORD })
          .expect(200);
        return (res.body as { challengeToken: string }).challengeToken;
      }),
    );
    const code = authenticator.generate(SECRET);
    const results = await Promise.all(
      challenges.map((challengeToken) =>
        request(app.getHttpServer()).post(`${API}/2fa/verify`).send({ challengeToken, code }),
      ),
    );
    expect(results.map((r) => r.status)).not.toContain(503);
  });
});
