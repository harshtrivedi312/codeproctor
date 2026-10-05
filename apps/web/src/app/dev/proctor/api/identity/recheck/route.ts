import { withSession } from '../../_lib/handler';
import { identityRecheck } from '../../_lib/mock-server';

// DEV ONLY mock (assumption pending ARC-03): canned result, the frame is read and discarded.
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(req, async (st) => {
    await req.arrayBuffer();
    return identityRecheck(st);
  });
