import type { Request } from 'express';

/**
 * A request refused by a middleware that runs before the throttler (the streaming body reader of
 * the public client-error route). The middleware records it and calls next(); the throttler then
 * counts the request, and a guard turns the record into the problem response. Without this, a
 * flood of oversize or malformed bodies was answered before any rate limit saw it (FU-BE-100).
 */
export interface EarlyRejection {
  status: number;
  detail: string;
}

const rejections = new WeakMap<object, EarlyRejection>();

export function markEarlyRejection(req: Request, rejection: EarlyRejection): void {
  rejections.set(req, rejection);
}

export function getEarlyRejection(req: Request): EarlyRejection | undefined {
  return rejections.get(req);
}
