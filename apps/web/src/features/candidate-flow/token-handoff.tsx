'use client';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { captureInvitationToken, SCRUBBED_PATH } from './session-store';

/**
 * Reads the invitation token from the route on the client (not from a server component prop, which
 * would sit in the RSC payload), keeps it in memory, and replaces the route with the static
 * /t/link so Next's route tree and history state hold no token. Credentials are not cleared here:
 * the stepper that mounts next picks the token up from memory.
 */
export function TokenHandoff(): React.JSX.Element {
  const params = useParams<{ token?: string | string[] }>();
  const router = useRouter();
  const raw = params.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  React.useEffect(() => {
    if (token) captureInvitationToken(token);
    router.replace(SCRUBBED_PATH);
  }, [token, router]);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <p role="status" className="py-10 text-center">
        Opening your invitation...
      </p>
    </main>
  );
}
