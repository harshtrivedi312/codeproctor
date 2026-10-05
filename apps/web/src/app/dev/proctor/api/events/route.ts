import { withSession } from '../_lib/handler';
import { eventBatch } from '../_lib/mock-server';

// DEV ONLY mock (assumption pending ARC-03): body is the exact signed string, X-Signature is hex.
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(req, async (st) =>
    eventBatch(st, await req.text(), req.headers.get('x-signature') ?? ''),
  );
