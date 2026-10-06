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
 * Replaces the address-bar URL (and so the history entry) with a neutral path, as soon as the token
 * has been read. The token never stays in the address bar, the history list, or the Referer that a
 * later navigation would send. Uses the history state Next.js already set, so its router keeps
 * working.
 */
export function scrubTokenFromUrl(win: Pick<Window, 'history'> = window): void {
  win.history.replaceState(win.history.state as unknown, '', SCRUBBED_PATH);
}
