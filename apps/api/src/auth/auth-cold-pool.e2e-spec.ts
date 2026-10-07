// FU-BE-194 / DL-42 (C-43: the first candidate after an instance boot hits a cold pool). Written
// from the repro in the review of PR #216 (lock-held login on a cold app), without its lock: the
// logic is copied, not imported, because #216 is not merged. No TC id covers this in
// docs/test-cases.md; names cite FU-BE-194, NFR-09 and FR-101.
import { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createPrismaClient } from '../database/create-prisma-client';
import { UserRole } from '../generated/prisma/client';
import { applyEnv, applyMigrations, startInfra, TestInfra } from '../test/containers';
import { ARGON2_OPTIONS } from './password.service';

const LOGIN = '/api/v1/auth/login';
// Generous against CI noise (a cold login measured ~100 ms); a stall is 10 s or never.
const BOUND_MS = 5_000;

describe('Login on a cold app (FU-BE-194, FR-101, NFR-09)', () => {
  let infra: TestInfra;
  let app: INestApplication<App>;
  let monitor: Client;

  beforeAll(async () => {
    infra = await startInfra();
    await applyMigrations(infra);
    applyEnv(infra, { THROTTLE_AUTH_LIMIT: '10000' });
    const prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    const orgId = (await prisma.organization.create({ data: { name: 'Cold Pool Org' } })).id;
    await prisma.user.create({
      data: {
        orgId,
        email: 'existing@example.com',
        fullName: 'Existing',
        role: UserRole.RECRUITER,
        passwordHash: await hash('Correct-Horse-9', ARGON2_OPTIONS),
      },
    });
    await prisma.$disconnect();
    monitor = new Client({ connectionString: process.env.DATABASE_URL });
    await monitor.connect();

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
    await monitor?.end();
    await app?.close();
    await infra?.stop();
  });

  it('FU-BE-194, NFR-09: when the app finishes starting, it already holds a database connection (warm-up ran before traffic)', async () => {
    // Before the fix this list was empty here: the first connection opened on the first request.
    const { rows } = await monitor.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IS NOT NULL`,
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('FU-BE-194, FR-101: two concurrent first logins on a cold app (no warm-up login) both answer 401 within the bound', async () => {
    const login = async (email: string): Promise<{ status: number; ms: number }> => {
      const started = Date.now();
      const res = await request(app.getHttpServer())
        .post(LOGIN)
        .send({ email, password: 'not-the-password-at-all-1' });
      return { status: res.status, ms: Date.now() - started };
    };
    const results = await Promise.all([login('existing@example.com'), login('nobody@example.com')]);
    expect(results.map((r) => r.status)).toEqual([401, 401]);
    for (const r of results) expect(r.ms).toBeLessThan(BOUND_MS);
  });

  it('FU-BE-194, NFR-09: /health answers ok once the app is up, after probing the database through the request path', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });
});
