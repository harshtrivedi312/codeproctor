// The only place that constructs a Prisma client (ADR 0009 section 4.2). Prisma 7 needs a driver
// adapter. Callers pass the connection string: the API passes DATABASE_URL (app_user), the seed
// passes the URL its own guard has checked. Never log the connection string.
//
// The import ends in `.js`, as the generated client's own imports do (FU-DB-10). tsc (NodeNext)
// maps it to the .ts source, Jest maps it in jest.config.js, and it keeps working if the API ever
// moves to ESM.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/** pg's own defaults are max 10 and connectionTimeoutMillis 0 (wait forever): FU-BE-194. */
export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface PoolOptions {
  /** Most connections the pool opens. */
  max?: number;
  /** Longest wait for one new connection, in ms. Never 0: pg reads 0 as "wait forever". */
  connectionTimeoutMillis?: number;
}

export function createPrismaClient(connectionString: string, pool: PoolOptions = {}): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: pool.max ?? DEFAULT_POOL_MAX,
      connectionTimeoutMillis: pool.connectionTimeoutMillis || DEFAULT_CONNECT_TIMEOUT_MS,
    }),
    // No code frame in error messages (FU-DB-70). Never add `log: ['query']` or a query event
    // listener here: they print every query with its parameters. 'minimal' still leaves values in
    // some errors, so the org-scoped client scrubs them (error-scrub.ts). Both are tested in
    // error-hygiene.spec.ts.
    errorFormat: 'minimal',
  });
}
