import { NextResponse } from 'next/server';
import { notFound } from '../_lib/handler';
import { isDevBlocked, sessionState, store, summarize } from '../_lib/mock-server';

// DEV ONLY: what the mock server has received, for the page's live panel.
export const dynamic = 'force-dynamic';

const idOf = (req: Request): string | null => {
  const id = new URL(req.url).searchParams.get('session') ?? '';
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
};

export function GET(req: Request): NextResponse {
  if (isDevBlocked()) return notFound();
  const id = idOf(req);
  if (!id) return NextResponse.json({ error: 'bad session' }, { status: 400 });
  return NextResponse.json(summarize(sessionState(id)));
}

export function DELETE(req: Request): NextResponse {
  if (isDevBlocked()) return notFound();
  const id = idOf(req);
  if (!id) return NextResponse.json({ error: 'bad session' }, { status: 400 });
  store().delete(id);
  return NextResponse.json({ ok: true });
}
