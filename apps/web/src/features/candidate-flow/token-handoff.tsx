'use client';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { captureInvitationToken, readTokenFromHash, SCRUBBED_PATH } from './session-store';

/**
 * Thin entry routes that move an invitation token into memory and navigate to the static
 * /t/link, where the stepper lives. They are separate routes on purpose: /t/link must never be
 * the route the browser first loaded with a token on it, because Next caches that entry together
 * with its URL (fragment included) and would write it back. Arriving at /t/link through
 * router.replace from one of these routes makes Next ask the server for it, with a clean URL.
 * Credentials are not cleared here: the stepper that mounts next picks the token up from memory.
 *
 * - /t/<token>: the token is read on the client with useParams (not from a server prop, which would
 *   sit in the RSC payload).
 * - /t/start#<token>: the fragment never reaches the server.
 * Whether the token is really gone from the address bar and history is verified in a real browser
 * (FU-FEB-23); jsdom cannot show it.
 */
function HandoffView(): React.JSX.Element {
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <p role="status" className="py-10 text-center">
        Opening your invitation...
      </p>
      <noscript>
        <p>
          This page needs JavaScript. Turn it on, or use Chrome or Edge, then open the link again.
        </p>
      </noscript>
    </main>
  );
}

export function TokenHandoff(): React.JSX.Element {
  const params = useParams<{ token?: string | string[] }>();
  const router = useRouter();
  const raw = params.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  React.useEffect(() => {
    if (token) captureInvitationToken(token);
    router.replace(SCRUBBED_PATH);
  }, [token, router]);
  return <HandoffView />;
}

export function FragmentHandoff(): React.JSX.Element {
  const router = useRouter();
  React.useEffect(() => {
    const token = readTokenFromHash();
    if (token) captureInvitationToken(token);
    router.replace(SCRUBBED_PATH);
  }, [router]);
  return <HandoffView />;
}
