// FU-BE-194 / DL-42: the Prisma pool must never wait forever for a connection, and the start-up
// warm-up must never fail boot (NFR-09). A TCP server that accepts and never answers stands in for
// an unreachable or full Postgres: pg's defaults (connectionTimeoutMillis 0) would hang on it.
import { createServer, Server, Socket } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { createPrismaClient } from './create-prisma-client';
import { OrgContextService } from './org-context';
import { PrismaService } from './prisma.service';

const GUARD_MS = 4_000;
jest.setTimeout(20_000); // a regression to unbounded waits fails here, not after the 120 s default

describe('Prisma pool bounds (FU-BE-194, NFR-09)', () => {
  let server: Server;
  let sockets: Socket[];
  let url: string;

  beforeAll(async () => {
    sockets = [];
    server = createServer((s) => {
      sockets.push(s); // accept, then stay silent
      s.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    url = `postgresql://app_user:x@127.0.0.1:${port}/db`;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const bounded = <T>(work: Promise<T>): Promise<T | 'hung'> =>
    Promise.race([
      work.catch((e: unknown) => e as T),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), GUARD_MS)),
    ]);

  it('FU-BE-194: a query against a server that never answers fails within the connect timeout instead of hanging', async () => {
    const client = createPrismaClient(url, { connectionTimeoutMillis: 300, max: 2 });
    try {
      const started = Date.now();
      const outcome = await bounded(client.$queryRaw`SELECT 1`);
      expect(outcome).not.toBe('hung');
      expect(outcome).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(GUARD_MS);
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  });

  it('FU-BE-194: two concurrent first queries both fail within the bound, none hangs', async () => {
    const client = createPrismaClient(url, { connectionTimeoutMillis: 300, max: 2 });
    try {
      const outcomes = await Promise.all([
        bounded(client.$queryRaw`SELECT 1`),
        bounded(client.$queryRaw`SELECT 2`),
      ]);
      expect(outcomes.map((o) => o === 'hung')).toEqual([false, false]);
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  });

  it('FU-BE-194, NFR-09: start-up warm-up against a Postgres that never answers resolves within its bound and does not fail boot', async () => {
    const values: Record<string, unknown> = {
      DATABASE_URL: url,
      DB_POOL_MAX: 2,
      DB_CONNECT_TIMEOUT_MS: 10_000,
      DB_WARMUP_TIMEOUT_MS: 300,
    };
    const config = { get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
    const svc = new PrismaService(config, new OrgContextService());
    try {
      const started = Date.now();
      await expect(bounded(svc.onModuleInit())).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(GUARD_MS);
    } finally {
      await svc.onApplicationShutdown().catch(() => undefined);
    }
  });
});
