// DL-37, api-contract section 8 (auth routes): contention on a login must not tell an existing
// account from an unknown one. No TC id covers this in docs/test-cases.md; names cite DL-37,
// FR-101 and FU-BE-177.
import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import type { OrgContextService } from '../database/org-context';
import type { PrismaService } from '../database/prisma.service';
import { PrismaClient, UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import { ARGON2_OPTIONS } from './password.service';

const LOGIN = '/api/v1/auth/login';
const PASSWORD = 'Correct-Horse-9';

describe('Login under row-lock contention (DL-37, FR-101, FU-BE-177)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let holder: Client;
  let email: string;

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '10000' });
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    const orgId = (await prisma.organization.create({ data: { name: 'Contention Org' } })).id;
    email = 'existing@example.com';
    await prisma.user.create({
      data: {
        orgId,
        email,
        fullName: 'Existing',
        role: UserRole.RECRUITER,
        passwordHash: await hash(PASSWORD, ARGON2_OPTIONS),
      },
    });
    holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();

    jest.resetModules();
    const { AppModule } = jest.requireActual<typeof import('../app.module')>('../app.module');
    const { Test } = jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { configureApp } = jest.requireActual<typeof import('../bootstrap')>('../bootstrap');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await holder?.end();
    await app?.close();
    await prisma?.$disconnect();
    await infra?.stop();
  });

  const shape = (res: request.Response): object => ({
    ...(res.body as object),
    instance: undefined,
    traceId: undefined,
  });

  it('DL-37, FR-101: a wrong-password login for an existing account whose row is locked, and one for an unknown account, answer the same 401 and neither is 503', async () => {
    const login = (e: string): Promise<request.Response> =>
      request(app.getHttpServer())
        .post(LOGIN)
        .send({ email: e, password: 'not-the-password-at-all-1' });
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM users WHERE email = $1 FOR UPDATE', [email]);
    try {
      const pending = Promise.all([login(email), login('nobody@example.com')]);
      // Hold the lock while both requests are in flight, then release it.
      await new Promise((r) => setTimeout(r, 500));
      await holder.query('COMMIT');
      const [existing, unknown] = await pending;
      expect(existing.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(shape(existing)).toEqual(shape(unknown));
      expect(existing.headers['retry-after']).toBeUndefined();
      expect(unknown.headers['retry-after']).toBeUndefined();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('FU-BE-177 guard: the client that serves login sets no lock_timeout or statement_timeout; a setting here must force the equalisation decision', async () => {
    const { PrismaService: Prisma } = jest.requireActual<
      typeof import('../database/prisma.service')
    >('../database/prisma.service');
    const { OrgContextService: Ctx } =
      jest.requireActual<typeof import('../database/org-context')>('../database/org-context');
    const svc: PrismaService = app.get(Prisma);
    const ctx: OrgContextService = app.get(Ctx);
    const rows = await ctx.runSystem('AUTH_BOOTSTRAP', () =>
      ctx.runRawSql(
        'test guard: read the session timeouts of the login pool',
        () =>
          (svc.client as unknown as PrismaClient).$queryRaw<
            { lock: string; statement: string }[]
          >`SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`,
      ),
    );
    expect(rows).toEqual([{ lock: '0', statement: '0' }]);
  });
});
