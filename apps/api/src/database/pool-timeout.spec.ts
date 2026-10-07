// No TC id in docs/test-cases.md covers DL-42; test names cite FU-BE-197, DL-42 and NFR-09.
// FU-BE-197, DL-42: what a pool-wait timeout REALLY looks like through Prisma 7.10 and
// @prisma/adapter-pg, captured with a pool of max 1 held by a long query and a short
// connectionTimeoutMillis (Postgres 16 via Testcontainers), and then through a real Nest app and
// ProblemFilter. Captured shapes, all three paths alike (plain query, $executeRaw, interactive
// $transaction start): a bare `Error` (not a Prisma error, no DriverAdapterError wrapper), message
// exactly 'timeout exceeded when trying to connect', no `code`, no `cause`, no `meta`.
import { createServer, Server, Socket } from 'node:net';
import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { lockContentionCode } from '../common/db-contention';
import { ProblemFilter } from '../common/problem.filter';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from './create-prisma-client';
import { DatabaseModule } from './database.module';
import { OrgContextService } from './org-context';
import { PrismaService } from './prisma.service';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';

const POOL_MESSAGE = 'timeout exceeded when trying to connect';
const HOLD_MS = 1_800;

/** Own fields only: the shape of the error, with no message text beyond the pool sentence. */
function describeShape(e: unknown): Record<string, unknown> {
  const o = e as Record<string, unknown>;
  return {
    isError: e instanceof Error,
    ctor: (e as object).constructor.name,
    hasCode: 'code' in o,
    hasCause: 'cause' in o,
    hasMeta: 'meta' in o,
    message: (e as Error).message,
  };
}

const EXPECTED_SHAPE = {
  isError: true,
  ctor: 'Error',
  hasCode: false,
  hasCause: false,
  hasMeta: false,
  message: POOL_MESSAGE,
};

@Controller('probe')
class ProbeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

  private raw<T>(label: string, work: (c: PrismaClient) => Promise<T>): Promise<T> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () =>
      this.orgContext.runRawSql(label, () => work(this.prisma.client as unknown as PrismaClient)),
    );
  }

  // Holds the only pool connection.
  @Get('hold')
  hold(): Promise<unknown> {
    return this.raw('test: hold the pool', (c) => c.$queryRaw`SELECT pg_sleep(1.8)::text AS s`);
  }

  @Get('query')
  query(): Promise<unknown> {
    return this.raw('test: pool wait', (c) => c.$queryRaw`SELECT 1 AS one`);
  }

  // The pool wait happens while an interactive transaction starts.
  @Get('tx')
  tx(): Promise<unknown> {
    return this.raw('test: pool wait in a transaction start', (c) =>
      c.$transaction((t) => t.$queryRaw`SELECT 1 AS one`),
    );
  }
}

describe('pool-wait timeout (FU-BE-197, DL-42, NFR-09)', () => {
  let db: MigratedDatabase;

  beforeAll(async () => {
    db = await startMigratedDatabase();
  });
  afterAll(async () => {
    await db?.stop();
  });

  it('FU-BE-197, DL-42: with a pool of 1 held by a long query, a plain query, $executeRaw and an interactive transaction start all fail with the same bare Error', async () => {
    const client = createPrismaClient(db.appUserUrl, { max: 1, connectionTimeoutMillis: 300 });
    try {
      const hold = Promise.resolve(client.$queryRaw`SELECT pg_sleep(1.8)::text`);
      await new Promise((r) => setTimeout(r, 250));
      const caught: unknown[] = [];
      for (const attempt of [
        () => client.$queryRaw`SELECT 1`,
        () => client.$executeRaw`SELECT 1`,
        () => client.$transaction((tx) => tx.$queryRaw`SELECT 1`),
      ]) {
        await Promise.resolve(attempt()).catch((e: unknown) => caught.push(e));
      }
      await hold;
      expect(caught).toHaveLength(3);
      for (const e of caught) {
        expect(describeShape(e)).toEqual(EXPECTED_SHAPE);
        expect(lockContentionCode(e)).toBe('POOL_TIMEOUT');
      }
    } finally {
      await client.$disconnect();
    }
  });

  it('FU-BE-197, DL-42: a pool that frees up in time does not fail (the wait is bounded, not a failure)', async () => {
    const client = createPrismaClient(db.appUserUrl, { max: 1, connectionTimeoutMillis: 3_000 });
    try {
      const hold = Promise.resolve(client.$queryRaw`SELECT pg_sleep(0.4)::text`);
      await new Promise((r) => setTimeout(r, 100));
      await expect(Promise.resolve(client.$queryRaw`SELECT 1 AS one`)).resolves.toBeDefined();
      await hold;
    } finally {
      await client.$disconnect();
    }
  });

  describe('through the app', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                DATABASE_URL: db.appUserUrl,
                DB_POOL_MAX: 1,
                DB_CONNECT_TIMEOUT_MS: 300,
              }),
            ],
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
    });

    it.each(['query', 'tx'])(
      'FU-BE-197, DL-42, NFR-09: a request that waits past DB_CONNECT_TIMEOUT_MS for a pool slot (%s) is 503 BUSY with Retry-After 2, fixed body, error-level log by name and token only',
      async (path) => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        try {
          const hold = request(app.getHttpServer())
            .get('/probe/hold')
            .then((r) => r);
          await new Promise((r) => setTimeout(r, 250));
          const res = await request(app.getHttpServer()).get(`/probe/${path}`);
          expect(res.status).toBe(503);
          expect(res.headers['retry-after']).toBe('2');
          const body = res.body as Record<string, unknown>;
          expect(body.code).toBe('BUSY');
          expect(body.detail).toBe('The service is busy; retry shortly.');
          expect(JSON.stringify(body)).not.toMatch(/timeout exceeded|pool|SELECT/);
          expect(error).toHaveBeenCalledTimes(1);
          const [fields, line] = error.mock.calls[0] as [Record<string, unknown>, string];
          expect({ ...fields, traceId: 'x' }).toEqual({
            traceId: 'x',
            errorName: 'Error',
            lockCode: 'POOL_TIMEOUT',
          });
          expect(line).toBe('Database pool wait timed out');
          expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toMatch(
            /timeout exceeded|SELECT/,
          );
          expect((await hold).status).toBe(200); // the holder itself is unaffected
        } finally {
          jest.restoreAllMocks();
        }
      },
      HOLD_MS * 3,
    );
  });

  describe('an unreachable database', () => {
    let server: Server;
    const sockets: Socket[] = [];
    let url: string;

    beforeAll(async () => {
      server = createServer((s) => {
        sockets.push(s); // accept, then stay silent
        s.on('error', () => undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `postgresql://app_user:x@127.0.0.1:${(server.address() as { port: number }).port}/db`;
    });
    afterAll(async () => {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // Observed, not assumed: a connect that stalls is NOT the pool-wait message. pg reports
    // 'Connection terminated due to connection timeout' with a cause. That is an unreachable
    // database, outside FU-BE-197 (pool exhaustion), so it is deliberately not matched and stays a
    // 500; FU-BE-202 records the question.
    it('FU-BE-197, DL-42: a connect that stalls past the timeout is a different shape and is not matched as a pool wait', async () => {
      const client = createPrismaClient(url, { max: 1, connectionTimeoutMillis: 300 });
      try {
        const e = await Promise.resolve(client.$queryRaw`SELECT 1`).catch((x: unknown) => x);
        expect(describeShape(e)).toMatchObject({
          isError: true,
          hasCode: false,
          message: 'Connection terminated due to connection timeout',
        });
        expect(lockContentionCode(e)).toBeUndefined();
      } finally {
        await client.$disconnect().catch(() => undefined);
      }
    });
  });
});
