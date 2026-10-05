import { NextResponse } from 'next/server';
import {
  isDevBlocked,
  problem,
  sessionIdFromAuth,
  sessionState,
  type Reply,
  type SessionState,
} from './mock-server';

// PROVISIONAL, ADR 0013 (Proposed, PR #39). DEV ONLY.
export const notFound = (): NextResponse => new NextResponse(null, { status: 404 });

export function toResponse(r: Reply): NextResponse {
  return NextResponse.json(r.body, { status: r.status, headers: r.headers });
}

/** Common wrapper: 404 in production, 401 without the dev token, then the handler. */
export async function withSession(
  req: Request,
  fn: (st: SessionState, sessionId: string) => Promise<Reply> | Reply,
): Promise<NextResponse> {
  if (isDevBlocked()) return notFound();
  const id = sessionIdFromAuth(req.headers.get('authorization'));
  if (!id) return toResponse(problem(401, 'UNAUTHENTICATED', 'Unauthenticated'));
  return toResponse(await fn(sessionState(id), id));
}
