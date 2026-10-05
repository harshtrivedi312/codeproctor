import { NextResponse } from 'next/server';
import { notFound, toResponse, tooLarge } from '../../../_lib/handler';
import {
  MAX_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  evidencePut,
  existingSession,
  isDevBlocked,
  mediaPut,
  problem,
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
  // An unauthenticated URL must not create session state: only sessions that already exist.
  const st = existingSession(sessionId);
  if (!st) return toResponse(problem(403, 'FORBIDDEN', 'Not presigned'));
  const isEvidence = path.includes('/evidence/');
  // Refuse on the declared length before reading the body.
  if (tooLarge(req, isEvidence ? MAX_IMAGE_BYTES : MAX_CHUNK_BYTES)) {
    return toResponse(problem(413, 'PAYLOAD_TOO_LARGE', 'Payload too large', st));
  }
  const bytes = (await req.arrayBuffer()).byteLength;
  if (isEvidence) {
    const name = path.slice(path.indexOf('evidence/'));
    if (!st.evidenceIssued.has(name))
      return toResponse(problem(403, 'FORBIDDEN', 'Not presigned', st));
    return toResponse(evidencePut(st));
  }
  return toResponse(mediaPut(st, sessionId, path, bytes, req.headers.get('content-type')));
}
