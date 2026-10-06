// A real 40P01 is not provoked end to end: which transaction a deadlock aborts is not deterministic.
// No TC id in docs/test-cases.md covers DL-37; test names cite FU-BE-42 and the decision id.
// DL-37, FU-BE-42: a REAL lock wait that times out, through a real Nest app on the real scoped
// client against Postgres 16 (Testcontainers), answers 503 + Retry-After with a fixed body.
// No existing route can be driven into a lock wait, so a probe controller (test only) runs a
// transaction with a short lock_timeout against a row that another connection holds locked.
import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ProblemFilter } from '../common/problem.filter';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { DatabaseModule } from './database.module';
import { OrgContextService } from './org-context';
import { PrismaService } from './prisma.service';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';
import { createTenant } from './testing/tenant-fixtures';
import type { TenantFixture } from './testing/tenant-fixtures';

let probeUserId = '';

@Controller('probe')
class ProbeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  // A transaction that outlives its own timeout: Prisma P2028.
  @Get('slow')
  slow(): Promise<unknown> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () =>
      this.orgContext.runRawSql('test: provoke a transaction timeout', () =>
        (this.prisma.client as unknown as PrismaClient).$transaction(
          (tx) => tx.$queryRaw`SELECT pg_sleep(1.5)::text AS s`,
          { timeout: 200 },
        ),
      ),
    );
  }

  @Get('lock')
  lock(): Promise<unknown> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () =>
      this.orgContext.runRawSql('test: provoke a lock timeout', () =>
        (this.prisma.client as unknown as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '50ms'`);
          return tx.$queryRaw`SELECT id FROM users WHERE id = ${probeUserId}::uuid FOR UPDATE`;
        }),
      ),
    );
  }
}

describe('lock contention through the app (DL-37, FU-BE-42)', () => {
  let db: MigratedDatabase;
  let owner: PrismaClient;
  let app: INestApplication<App>;
  let tenant: TenantFixture;

  beforeAll(async () => {
    db = await startMigratedDatabase();
    owner = createPrismaClient(db.ownerUrl);
    tenant = await createTenant(owner, 'lock');
    probeUserId = tenant.userId;
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: db.appUserUrl })],
        }),
        DatabaseModule,
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    await db?.stop();
  });

  it('FU-BE-42: a lock wait that times out (55P03) is 503 + Retry-After, fixed body, no SQL in the log', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      // Hold the row lock on a separate connection for the whole request.
      await owner.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM users WHERE id = ${probeUserId}::uuid FOR UPDATE`,
          );
          const res = await request(app.getHttpServer()).get('/probe/lock');
          expect(res.status).toBe(503);
          expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
          expect(res.headers['content-type']).toContain('application/problem+json');
          const body = res.body as Record<string, unknown>;
          expect(body.detail).toBe('The service is busy; retry shortly.');
          expect(body.code).toBe('BUSY');
          expect(JSON.stringify(body)).not.toMatch(/users|FOR UPDATE|55P03|lock_timeout/);
        },
        { timeout: 20000 },
      );
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      expect(logged).not.toMatch(/FOR UPDATE|SELECT|users/);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('FU-BE-42: a real interactive-transaction timeout (P2028) is 503 + Retry-After, logged at error level without SQL', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(app.getHttpServer()).get('/probe/slow');
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toMatch(/pg_sleep|SELECT/);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
