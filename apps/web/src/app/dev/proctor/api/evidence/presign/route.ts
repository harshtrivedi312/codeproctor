import { withSession } from '../../_lib/handler';
import { evidencePresign } from '../../_lib/mock-server';

// DEV ONLY mock (assumption pending ARC-03).
export const dynamic = 'force-dynamic';
export const POST = (req: Request) => withSession(req, (st, id) => evidencePresign(st, id));
