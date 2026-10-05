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

// Who this tab is signed in as. Requests record it, and a refresh that returns someone else (the
// refresh cookie is shared by all tabs) must not silently turn this tab into that person.
let currentUserId: string | null = null;

export function getSessionUserId(): string | null {
  return currentUserId;
}

export function publishSession(session: AuthSession | null): void {
  const nextUserId = session ? session.user.id : null;
  if (nextUserId !== currentUserId) {
    // The identity changed (including to "nobody"): everything started under the old identity,
    // such as a request waiting for a 401 or a save in flight, must be dropped (FR-103, FR-104).
    generation += 1;
    inFlight = null;
  }
  currentUserId = nextUserId;
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

/** Longest a refresh or logout request may take, and the longest a sign-in waits for them. */
export const REQUEST_TIMEOUT_MS = 10_000;

const SIGN_OUT_MARKER = 'cp.signOutPending';
/** Changes on every sign-in so other tabs re-check their session. A random nonce, never a token. */
export const SESSION_EPOCH_KEY = 'cp.sessionEpoch';

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

export const SIGN_OUT_MARKER_KEY = SIGN_OUT_MARKER;

let logoutInFlight: Promise<unknown> | null = null;

/** Records the logout call in flight so a sign-in can wait for it (it must not revoke the new login). */
export function trackLogout(call: Promise<unknown>): void {
  const mine = call.finally(() => {
    if (logoutInFlight === mine) logoutInFlight = null;
  });
  logoutInFlight = mine;
}

/** Resolves when any refresh and any logout call in flight have finished, whatever their result. */
export async function settleSession(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REQUEST_TIMEOUT_MS);
  });
  const settled = (async () => {
    await settleRefresh();
    if (logoutInFlight) await logoutInFlight.then(noop, noop);
  })();
  // Never hang a sign-in on a stuck request.
  await Promise.race([settled, limit]);
  clearTimeout(timer);
}

/** Another tab signed out: forget the session here at once and ignore refreshes still running. */
export function signedOutElsewhere(): void {
  invalidateRefreshes();
  publishSession(null);
}

/** Test-only: simulates a page reload by forgetting the in-memory flag but not the stored marker. */
export function resetInMemorySignOutFlagForTests(): void {
  signingOut = false;
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
export function beginSession(userId?: string): void {
  signingOut = false;
  writeMarker(false);
  if (userId) announceSignIn(userId);
  invalidateRefreshes();
}

function makeNonce(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // crypto.randomUUID needs a secure context; this only has to differ from the last value.
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Tells other tabs who just signed in: "nonce|userId", a user id and no token. They compare it
 * with their own user locally and sign out on a mismatch, with no network call (a burst of
 * refreshes from every tab with the same new cookie would look like token reuse, TC-005).
 */
function announceSignIn(userId: string): void {
  try {
    window.localStorage.setItem(SESSION_EPOCH_KEY, `${makeNonce()}|${userId}`);
  } catch {
    // Storage blocked: other tabs find out when one of their requests gets a 401 and the refresh
    // returns a different user.
  }
}

/** Another tab signed in as `userId` (the value of the epoch key). Signs this tab out if it is someone else. */
export function handleSignInElsewhere(epochValue: string | null): void {
  const announced = epochValue?.split('|')[1];
  const mine = currentUserId;
  if (!announced || !mine || announced === mine) return;
  // publishSession bumps the generation, dropping work started as the old user.
  publishSession(null);
}

/** One refresh at a time; concurrent callers share the result. Returns null when it failed. */
export function refreshSession(): Promise<AuthSession | null> {
  if (isSignOutPending()) {
    // Not signed in here (for example another tab signed out): show that, never restore.
    publishSession(null);
    return Promise.resolve(null);
  }
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (startedIn !== generation) return null;
    if (!response.ok) {
      publishSession(null);
      return null;
    }
    const session = (await response.json()) as AuthSession;
    if (startedIn !== generation) return null;
    if (currentUserId && currentUserId !== session.user.id) {
      // Another tab signed in as someone else through the shared cookie. Do not switch users
      // silently: this tab signs out and goes to login (FR-103, FR-104).
      publishSession(null);
      return null;
    }
    publishSession(session);
    return session;
  } catch {
    if (startedIn === generation) publishSession(null);
    return null;
  }
}

/** Who and which session generation a request was sent under. */
export interface SessionStamp {
  generation: number;
  userId: string | null;
}

export function captureSessionStamp(): SessionStamp {
  return { generation, userId: currentUserId };
}

/**
 * The one guard for "a request got 401, refresh and send it again". Returns the refreshed session
 * only when replaying is safe: the request was sent by a signed-in user, nothing changed identity
 * since (no sign-out, no other tab signing in), and the refresh returned that same user. Anything
 * else returns null and the caller must not send again. The refresh cookie is shared by all tabs,
 * so without this a request made as X could be replayed as Y (FR-103, TC-005).
 */
export async function refreshForReplay(stamp: SessionStamp): Promise<AuthSession | null> {
  if (stamp.userId === null || stamp.generation !== generation) return null;
  const session = await refreshSession();
  if (!session || stamp.generation !== generation || session.user.id !== stamp.userId) return null;
  return session;
}
