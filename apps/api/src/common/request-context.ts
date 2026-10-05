import type { Request } from 'express';

/** What a service needs to know about the HTTP request, for audit rows. */
export interface RequestContext {
  ip?: string;
}

export function ctxOf(req: Request): RequestContext {
  return { ip: req.ip };
}

/** The class name of a thrown value only: the message may carry an address, token or value. */
export function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown';
}
