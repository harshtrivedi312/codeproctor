import { withSession } from '../../_lib/handler';
import { mediaPresign } from '../../_lib/mock-server';

// DEV ONLY mock, provisional, ADR 0013 (Proposed, PR #39) section 5.5.
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(req, async (st, id) => mediaPresign(st, id, await req.json().catch(() => null)));
