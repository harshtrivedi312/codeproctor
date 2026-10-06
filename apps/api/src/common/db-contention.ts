// Database lock contention (DL-37, FU-BE-42): a lock wait that timed out, a deadlock, or a Prisma
// transaction that timed out or lost a write conflict. All of them fail closed and are worth a
// retry, so ProblemFilter answers them with 503 and Retry-After on every route, never 409 or 500.
//
// The error reaches us in two shapes (both exist in this repo): Prisma's own known request error
// (`code` P2028 / P2034, or any code with the driver error in `meta.driverAdapterError`), and the
// pg driver-adapter shape, where the SQLSTATE sits in `originalCode` or `code` of the error or of
// something in its `cause` chain. The walk is bounded and cycle-safe, and reads codes only: it
// never reads or returns a message, because those can carry SQL and argument values.
import { Prisma } from '../generated/prisma/client.js';

/** Seconds a client should wait before retrying a request refused for lock contention. */
export const LOCK_CONTENTION_RETRY_AFTER_SECONDS = 2;

/** The fixed detail of the 503 body. */
export const LOCK_CONTENTION_DETAIL = 'The service is busy; retry shortly.';

const SQLSTATES = new Set(['55P03', '40P01']);
const PRISMA_CODES = new Set(['P2028', 'P2034']);
const MAX_DEPTH = 8;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The fixed code token (a Postgres SQLSTATE or a Prisma code) when the error is lock contention,
 * otherwise undefined. The result is one of four constants, so it is safe to log.
 */
export function lockContentionCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): string | undefined => {
    if (!isObject(node) || depth > MAX_DEPTH || seen.has(node)) return undefined;
    seen.add(node);
    if (node instanceof Prisma.PrismaClientKnownRequestError && PRISMA_CODES.has(node.code)) {
      return node.code === 'P2028' ? 'P2028' : 'P2034';
    }
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
