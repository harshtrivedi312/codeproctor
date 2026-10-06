/**
 * In-memory credentials for the candidate pre-test flow (ADR 0003, ADR 0013 section 5.10).
 *
 * Nothing here is ever written to localStorage, sessionStorage, cookies, logs, analytics or error
 * reports. A reload loses both values on purpose: the candidate opens the link from the email again
 * and enters a new one-time code (ADR 0002, resume rules).
 */

/** Matches the backend's accepted invitation token shape (BE-07 `TOKEN_PATTERN`). */
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/** Neutral path shown in the address bar once the token has been read. It carries no secret. */
export const SCRUBBED_PATH = '/t/link';

let invitationToken: string | null = null;
let sessionToken: string | null = null;

/** Keeps the token from the URL in memory. A second call with another value is ignored. */
export function captureInvitationToken(token: string): void {
  if (invitationToken === null && INVITATION_TOKEN_PATTERN.test(token)) invitationToken = token;
}

export function getInvitationToken(): string | null {
  return invitationToken;
}

export function clearInvitationToken(): void {
  invitationToken = null;
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export function clearCandidateCredentials(): void {
  invitationToken = null;
  sessionToken = null;
}

/** True when the address bar carries a fragment. The stepper never expects one (see below). */
export function hasUrlFragment(win: Pick<Window, 'location'> = window): boolean {
  return win.location.hash !== '';
}

/**
 * Reads an invitation token from the URL fragment ("#<token>" or "#token=<token>"). A fragment is
 * never sent to the server, so it stays out of access logs and proxies, unlike a path segment.
 * Returns null when there is none or it does not look like a token.
 *
 * Only the thin entry route /t/start (FragmentHandoff) reads it, then navigates to /t/link with
 * router.replace. Nothing here changes the URL: Next keeps its own copy of the URL and route tree,
 * so the only thing that is known to work is arriving at /t/link through the router from a route
 * Next has not cached. Whether the token is really gone from the address bar and history is checked
 * in a real browser (FU-FEB-23), not by the unit tests.
 */
export function readTokenFromHash(win: Pick<Window, 'location'> = window): string | null {
  const raw = win.location.hash.replace(/^#/, '').replace(/^token=/, '');
  return INVITATION_TOKEN_PATTERN.test(raw) ? raw : null;
}
