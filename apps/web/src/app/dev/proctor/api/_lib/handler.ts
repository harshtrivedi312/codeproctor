import { NextResponse } from 'next/server';
import {
  isDevBlocked,
  sessionIdFromAuth,
  sessionState,
  type Reply,
  type SessionState,
} from './mock-server';

export const notFound = (): NextResponse => new NextResponse(null, { status: 404 });

/** Common wrapper: 404 in production, 401 without the dev token, then the handler. */
export async function withSession(
  req: Request,
  fn: (st: SessionState, sessionId: string) => Promise<Reply> | Reply,
): Promise<NextResponse> {
  if (isDevBlocked()) return notFound();
  const id = sessionIdFromAuth(req.headers.get('authorization'));
  if (!id) return NextResponse.json({ error: 'missing dev token' }, { status: 400 });
  const r = await fn(sessionState(id), id);
  return NextResponse.json(r.body, { status: r.status });
}
