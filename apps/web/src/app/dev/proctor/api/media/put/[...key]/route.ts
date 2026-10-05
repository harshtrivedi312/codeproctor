import { NextResponse } from 'next/server';
import { notFound } from '../../../_lib/handler';
import { isDevBlocked, mediaPut, sessionState } from '../../../_lib/mock-server';

// DEV ONLY mock of the presigned PUT target. The body is counted and discarded, never stored.
export const dynamic = 'force-dynamic';

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ key: string[] }> },
): Promise<NextResponse> {
  if (isDevBlocked()) return notFound();
  const { key } = await ctx.params;
  const joined = key.join('/');
  const sessionId = /^(?:evidence\/)?([A-Za-z0-9-]{1,64})\//.exec(joined)?.[1];
  if (!sessionId) return NextResponse.json({ error: 'bad key' }, { status: 400 });
  const bytes = (await req.arrayBuffer()).byteLength;
  const st = sessionState(sessionId);
  if (joined.startsWith('evidence/')) {
    st.evidence.uploaded++;
    return NextResponse.json({ ok: true });
  }
  const r = mediaPut(st, joined, bytes);
  return NextResponse.json(r.body, { status: r.status });
}
