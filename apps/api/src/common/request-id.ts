import { randomUUID } from 'node:crypto';

/** A request id we are willing to echo and log: 8 to 64 safe characters (NFR-09). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** The public client-error route never trusts an inbound id (FU-BE-95). */
const NO_INBOUND_ID_PATH = /^\/[^?]*\/client-errors(?:[/?]|$)/i;

export function isTrustedRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/**
 * The id a request runs under: a well-formed inbound `x-request-id`, else a fresh UUID. On the
 * public POST /client-errors route the inbound id is ignored, so an unauthenticated caller cannot
 * attach its report to another request's trace (FU-BE-95).
 */
export function resolveRequestId(inbound: unknown, url: string | undefined): string {
  if (url !== undefined && NO_INBOUND_ID_PATH.test(url)) return randomUUID();
  return isTrustedRequestId(inbound) ? inbound : randomUUID();
}
