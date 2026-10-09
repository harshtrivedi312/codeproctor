'use client';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { captureInvitationToken, readTokenFromHash, SCRUBBED_PATH } from './session-store';

/** Where the email link /t#<token> is forwarded to, as a full document load. */
export const FRAGMENT_ENTRY_PATH = '/t/start';

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

/**
 * Entry for the invitation email link `/t#<token>` (FR-407, TC-107). It forwards to
 * `/t/start#<token>` with window.location.replace, a FULL document load that replaces this history
 * entry, for two reasons:
 * - the Permissions-Policy that allows the microphone (DL-28) applies to the document as first
 *   loaded and matches /t/<anything>, not /t itself, so the stepper must not be reached from a
 *   document loaded at /t by a soft navigation (the mic check would be blocked);
 * - the fragment is not left in this entry's history.
 * Only a well-formed token is carried over (never a query string or other text); a missing or odd
 * fragment goes to /t/start without one, which ends at the stepper's "link not valid" state. The
 * fragment never reaches the server, so it is not in any log or Referer.
 */
export function EmailLinkEntry({
  replaceLocation = (url: string) => window.location.replace(url),
}: {
  replaceLocation?: (url: string) => void;
}): React.JSX.Element {
  React.useEffect(() => {
    const token = readTokenFromHash();
    replaceLocation(token ? `${FRAGMENT_ENTRY_PATH}#${token}` : FRAGMENT_ENTRY_PATH);
  }, [replaceLocation]);
  return <HandoffView />;
}
