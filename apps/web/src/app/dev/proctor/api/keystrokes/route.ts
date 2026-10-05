import { withSession } from '../_lib/handler';
import { MAX_KEYSTROKE_BATCH_BYTES, batch } from '../_lib/mock-server';

// DEV ONLY mock, provisional, ADR 0013 (Proposed, PR #39) sections 2 and 5.2: keystroke batches
// use the same signing and verification as event batches (the SDK does not send them yet).
export const dynamic = 'force-dynamic';
export const POST = (req: Request) =>
  withSession(
    req,
    async (st) =>
      batch(
        'keystrokes',
        st,
        new Uint8Array(await req.arrayBuffer()),
        req.headers.get('x-signature') ?? '',
        req.headers.get('content-type'),
      ),
    MAX_KEYSTROKE_BATCH_BYTES,
  );
