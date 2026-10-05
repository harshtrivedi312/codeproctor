import { withSession } from '../../_lib/handler';
import { mediaConfirm } from '../../_lib/mock-server';

// DEV ONLY mock (assumption pending ARC-03).
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(req, async (st, id) => mediaConfirm(st, id, await req.json().catch(() => null)));
