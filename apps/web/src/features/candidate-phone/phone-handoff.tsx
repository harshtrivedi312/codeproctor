'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { capturePhoneToken, PHONE_PAGE_PATH, readPhoneTokenFromHash } from './phone-store';

/**
 * Entry for /t/phone/enter#<token>: moves the token into memory and replaces the route with
 * /t/phone, the same hand-off as the invitation link (see candidate-flow/token-handoff.tsx for why
 * the stepper route never loads with a token on it). Whether the address bar and history end up
 * clean is checked in a real browser (FU-FEB-23), not by the unit tests.
 */
export function PhoneHandoff(): React.JSX.Element {
  const router = useRouter();
  React.useEffect(() => {
    const token = readPhoneTokenFromHash();
    if (token) capturePhoneToken(token);
    router.replace(PHONE_PAGE_PATH);
  }, [router]);
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-8">
      <p role="status" className="py-10 text-center">
        Opening the phone camera page...
      </p>
    </main>
  );
}
