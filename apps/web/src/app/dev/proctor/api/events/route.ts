import { withSession } from '../_lib/handler';
import { MAX_EVENT_BATCH_BYTES, batch } from '../_lib/mock-server';

// DEV ONLY mock, provisional, ADR 0013 (Proposed, PR #39) sections 2 and 5.2: the body is the
// exact signed string, X-Signature is lowercase hex HMAC-SHA256, verified on the raw bytes.
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(
    req,
    async (st) =>
      batch(
        'events',
        st,
        new Uint8Array(await req.arrayBuffer()),
        req.headers.get('x-signature') ?? '',
        req.headers.get('content-type'),
      ),
    MAX_EVENT_BATCH_BYTES,
  );
