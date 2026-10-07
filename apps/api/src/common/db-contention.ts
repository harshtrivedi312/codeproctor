// Database lock contention (DL-37, FU-BE-42) and pool exhaustion (DL-42, FU-BE-197): a lock wait
// that timed out, a deadlock, a serialization failure, a Prisma transaction that timed out or lost a
// write conflict, or a wait for a free pool connection that timed out. All of them fail closed and are worth a
// retry, so ProblemFilter answers them with 503 and Retry-After on every route, never 409 or 500.
//
// The error reaches us in two shapes (both exist in this repo): Prisma's own known request error
// (`code` P2028 / P2034, or any code with the driver error in `meta.driverAdapterError`), and the
// pg driver-adapter shape, where the SQLSTATE sits in `originalCode` or `code` of the error or of
// something in its `cause` chain. The walk is bounded and cycle-safe and reads codes. The one message
// it reads is compared with the fixed pool-timeout sentence (FU-BE-197, DL-42) and never returned
// or logged, because messages can carry SQL and argument values.
import { HttpException } from '@nestjs/common';
import { OrgScopeError } from '../database/errors';
import { Prisma } from '../generated/prisma/client';

/** Seconds a client should wait before retrying a request refused for lock contention. */
export const LOCK_CONTENTION_RETRY_AFTER_SECONDS = 2;

/** The fixed problem `code` of the 503 body (api-contract section 8). */
export const LOCK_CONTENTION_CODE = 'BUSY' as const;

/** The fixed detail of the 503 body. */
export const LOCK_CONTENTION_DETAIL = 'The service is busy; retry shortly.';

const SQLSTATES = new Set(['55P03', '40P01', '40001']);
const PRISMA_CODES = new Set(['P2028', 'P2034']);

/**
 * The token for a pool-wait timeout (FU-BE-197, DL-42): a request waited longer than
 * DB_CONNECT_TIMEOUT_MS for a free pooled connection. No SQLSTATE exists for it, because no
 * statement reached Postgres.
 */
export const POOL_TIMEOUT_TOKEN = 'POOL_TIMEOUT' as const;

/**
 * What pg-pool throws when the wait for a free slot runs out. Observed on Prisma 7.10 with
 * @prisma/adapter-pg (database/pool-timeout.spec.ts): a bare `Error` with this exact message and no
 * `code`, `cause` or `meta`, for a plain query, an interactive transaction start and an execute
 * alike. Prisma's own P2024 means the same and is matched by code. The message is compared, never
 * returned or logged.
 */
const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const MAX_DEPTH = 8;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The fixed code token (a Postgres SQLSTATE or a Prisma code) when the error is lock contention,
 * otherwise undefined. The result is one of six constants (the five contention codes or
 * POOL_TIMEOUT), so it is safe to log.
 */
export function lockContentionCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): string | undefined => {
    if (!isObject(node) || depth > MAX_DEPTH || seen.has(node)) return undefined;
    seen.add(node);
    // Our own errors are never database contention, and their causes are not followed.
    if (node instanceof HttpException || node instanceof OrgScopeError) return undefined;
    if (node instanceof Prisma.PrismaClientKnownRequestError && PRISMA_CODES.has(node.code)) {
      return node.code === 'P2028' ? 'P2028' : 'P2034';
    }
    if (node instanceof Prisma.PrismaClientKnownRequestError && node.code === 'P2024') {
      return POOL_TIMEOUT_TOKEN;
    }
    if (node instanceof Error && node.message === POOL_TIMEOUT_MESSAGE) return POOL_TIMEOUT_TOKEN;
    for (const key of ['originalCode', 'code'] as const) {
      const value = node[key];
      if (typeof value === 'string' && SQLSTATES.has(value)) return value;
    }
    const meta = node.meta;
    const adapter = isObject(meta) ? meta.driverAdapterError : undefined;
    return visit(adapter, depth + 1) ?? visit(node.cause, depth + 1);
  };
  try {
    return visit(error, 0);
  } catch {
    return undefined; // a hostile getter must not turn into a different failure
  }
}
