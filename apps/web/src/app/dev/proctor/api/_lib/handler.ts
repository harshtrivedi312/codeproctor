import { NextResponse } from 'next/server';
import {
  MAX_JSON_BODY_BYTES,
  isDevBlocked,
  problem,
  sessionIdFromAuth,
  sessionState,
  type Reply,
  type SessionState,
} from './mock-server';

// PROVISIONAL, ADR 0013 (Proposed, PR #39). DEV ONLY.
export const notFound = (): NextResponse => new NextResponse(null, { status: 404 });

/** True when Content-Length is present and above the limit. */
export function tooLarge(req: Request, maxBytes: number): boolean {
  const n = Number(req.headers.get('content-length'));
  return Number.isFinite(n) && n > maxBytes;
}

export function toResponse(r: Reply): NextResponse {
  return NextResponse.json(r.body, { status: r.status, headers: r.headers });
}

/** Common wrapper: 404 in production, 401 without the dev token, then the handler. */
export async function withSession(
  req: Request,
  fn: (st: SessionState, sessionId: string) => Promise<Reply> | Reply,
  maxBodyBytes: number = MAX_JSON_BODY_BYTES,
): Promise<NextResponse> {
  if (isDevBlocked()) return notFound();
  // Refuse on the declared length before reading the body.
  if (tooLarge(req, maxBodyBytes))
    return toResponse(problem(413, 'PAYLOAD_TOO_LARGE', 'Payload too large'));
  const id = sessionIdFromAuth(req.headers.get('authorization'));
  if (!id) return toResponse(problem(401, 'UNAUTHENTICATED', 'Unauthenticated'));
  return toResponse(await fn(sessionState(id), id));
}
