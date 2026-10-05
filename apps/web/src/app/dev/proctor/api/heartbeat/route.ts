import { withSession } from '../_lib/handler';
import { heartbeat } from '../_lib/mock-server';

// DEV ONLY mock, provisional, ADR 0013 (Proposed, PR #39) section 5.3: unsigned heartbeat with an
// optional recorder/queue health body.
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(req, async (st) => heartbeat(st, await req.json().catch(() => null)));
