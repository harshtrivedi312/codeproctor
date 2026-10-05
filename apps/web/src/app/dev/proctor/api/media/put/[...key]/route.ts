import { NextResponse } from 'next/server';
import { notFound, toResponse } from '../../../_lib/handler';
import {
  evidencePut,
  isDevBlocked,
  mediaPut,
  problem,
  sessionState,
} from '../../../_lib/mock-server';

// DEV ONLY mock of the presigned PUT target, provisional, ADR 0013 (Proposed, PR #39) section 5.7.
// The body is counted and discarded, never stored. The path must be one a presign call issued.
export const dynamic = 'force-dynamic';

const KEY =
  /^orgs\/demo\/sessions\/([A-Za-z0-9-]{1,64})\/(?:media\/[A-Z_]+\/\d{6}\/\d{8}\.webm|evidence\/[0-9A-HJKMNP-TV-Z]{26}\.jpg)$/;

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ key: string[] }> },
): Promise<NextResponse> {
  if (isDevBlocked()) return notFound();
  const { key } = await ctx.params;
  const path = key.join('/');
  const m = KEY.exec(path);
  if (!m?.[1]) return toResponse(problem(400, 'VALIDATION_FAILED', 'Validation failed'));
  const sessionId = m[1];
  const st = sessionState(sessionId);
  const bytes = (await req.arrayBuffer()).byteLength;
  if (path.includes('/evidence/')) {
    const name = path.slice(path.indexOf('evidence/'));
    if (!st.evidenceIssued.has(name))
      return toResponse(problem(403, 'FORBIDDEN', 'Not presigned', st));
    return toResponse(evidencePut(st));
  }
  return toResponse(mediaPut(st, sessionId, path, bytes, req.headers.get('content-type')));
}
