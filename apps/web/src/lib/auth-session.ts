import type { Schemas } from '@/lib/api/client';
import { setAccessToken } from '@/lib/auth-token';
import { apiBaseUrl } from '@/lib/env';
import { mockingReady } from '@/lib/mock-ready';

/*
 * Silent refresh (FR-104). The refresh token is an httpOnly cookie the browser sends on its own;
 * this module only ever sees the short-lived access token, and keeps it in memory (auth-token.ts).
 * It uses plain fetch, not the api client, so the client's 401 handler cannot call back into it.
 */

export type AuthSession = Schemas['AuthSession'];

type SessionListener = (session: AuthSession | null) => void;
const listeners = new Set<SessionListener>();

export function onSessionChange(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishSession(session: AuthSession | null): void {
  setAccessToken(session ? session.accessToken : null);
  for (const listener of listeners) listener(session);
}

let inFlight: Promise<AuthSession | null> | null = null;
// Bumped on sign-out. A refresh that started before the bump must not restore the session.
let generation = 0;

// True from the moment the user chooses Sign out until the next sign-in. While set, no refresh
// starts, so a 401 on some other request during logout cannot bring the session back.
let signingOut = false;

/** Refreshes already in flight are ignored when they finish. */
export function invalidateRefreshes(): void {
  generation += 1;
  inFlight = null;
}

const SIGN_OUT_MARKER = 'cp.signOutPending';

/*
 * "Sign-out pending" marker. A boolean only, never a token. It survives a reload so that a logout
 * the server did not confirm cannot be undone by the next page load's silent refresh (FR-104).
 */
function markerSet(): boolean {
  try {
    return window.localStorage.getItem(SIGN_OUT_MARKER) === '1';
  } catch {
    return false;
  }
}
function writeMarker(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SIGN_OUT_MARKER, '1');
    else window.localStorage.removeItem(SIGN_OUT_MARKER);
  } catch {
    // Storage blocked: the in-memory flag still covers this page load.
  }
}

/** True while a sign-out has not been confirmed by the server (survives reloads). */
export function isSignOutPending(): boolean {
  return signingOut || markerSet();
}

/** Called once the server answered the logout call with success. */
export function confirmSignedOut(): void {
  signingOut = false;
  writeMarker(false);
}

/** Resolves when any refresh in flight has finished, whatever its result. Never rejects. */
export function settleRefresh(): Promise<void> {
  return inFlight ? inFlight.then(noop, noop) : Promise.resolve();
}
function noop(): void {}

/** The current session generation. Requests record it so a later user's token is never used to replay them. */
export function getGeneration(): number {
  return generation;
}

/**
 * Called when the user chooses Sign out: stops in-flight and new refreshes until the next sign-in
 * and sets the pending marker. Resolves once any refresh already running has settled (its result
 * is ignored), so the logout call is not racing a cookie rotation.
 */
export function beginSignOut(): Promise<void> {
  const settled = settleRefresh();
  signingOut = true;
  writeMarker(true);
  invalidateRefreshes();
  return settled;
}

/**
 * Called on a fresh login. Bumps the generation so a slow first-load refresh that ends in 401
 * cannot sign out the new session, and allows refreshes again.
 */
export function beginSession(): void {
  signingOut = false;
  writeMarker(false);
  invalidateRefreshes();
}

/** One refresh at a time; concurrent callers share the result. Returns null when it failed. */
export function refreshSession(): Promise<AuthSession | null> {
  if (isSignOutPending()) return Promise.resolve(null);
  if (inFlight) return inFlight;
  const mine = doRefresh().finally(() => {
    if (inFlight === mine) inFlight = null;
  });
  inFlight = mine;
  return mine;
}

async function doRefresh(): Promise<AuthSession | null> {
  const startedIn = generation;
  try {
    await mockingReady;
    const response = await fetch(`${apiBaseUrl}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (startedIn !== generation) return null;
    if (!response.ok) {
      publishSession(null);
      return null;
    }
    const session = (await response.json()) as AuthSession;
    if (startedIn !== generation) return null;
    publishSession(session);
    return session;
  } catch {
    if (startedIn === generation) publishSession(null);
    return null;
  }
}
