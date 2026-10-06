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

/**
 * Replaces the address-bar URL (and so the history entry) with a neutral path, and drops any
 * history state that still holds the token. Next.js keeps the route tree, including dynamic
 * segment values, in history.state, and browsers persist it, so a state that mentions the token is
 * replaced by null instead of being carried over. The stepper is served from the static path
 * /t/link (the /t/[token] page hands the token over and navigates there), so on the normal path the
 * state is already clean; this is the safety net.
 */
export function scrubTokenFromUrl(
  token: string | null = null,
  win: Pick<Window, 'history'> = window,
): void {
  const state = win.history.state as unknown;
  const dirty = token !== null && (JSON.stringify(state) ?? '').includes(token);
  win.history.replaceState(dirty ? null : state, '', SCRUBBED_PATH);
}

/**
 * Reads an invitation token from the URL fragment ("#<token>" or "#token=<token>"). A fragment is
 * never sent to the server, so it stays out of access logs and proxies, unlike a path segment.
 * Returns null when there is none or it does not look like a token. The fragment is removed by
 * scrubTokenFromUrl together with the path.
 */
export function readTokenFromHash(win: Pick<Window, 'location'> = window): string | null {
  const raw = win.location.hash.replace(/^#/, '').replace(/^token=/, '');
  return INVITATION_TOKEN_PATTERN.test(raw) ? raw : null;
}
