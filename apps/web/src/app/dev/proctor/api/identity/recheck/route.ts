import { withSession } from '../../_lib/handler';
import { identityRecheck } from '../../_lib/mock-server';

// DEV ONLY mock, provisional, ADR 0013 (Proposed, PR #39) section 5.6: 202 and no match result;
// the "server" decides and records a server-written FACE_MISMATCH.
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(req, async (st) => identityRecheck(st, await req.json().catch(() => null)));
