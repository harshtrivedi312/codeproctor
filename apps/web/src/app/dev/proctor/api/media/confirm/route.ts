import { withSession } from '../../_lib/handler';
import { mediaConfirm } from '../../_lib/mock-server';

// DEV ONLY mock, provisional, ADR 0013 (Proposed, PR #39) section 5.5.
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(req, async (st) => mediaConfirm(st, await req.json().catch(() => null)));
