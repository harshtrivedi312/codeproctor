'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, type Schemas } from '@/lib/api/client';
import { busyStore } from '@/lib/api/busy';
import { disposeModels, MODEL_ROOT } from '@/features/questions/monaco-registry';
import {
  beginSession,
  beginSignOut,
  confirmSignedOut,
  getGeneration,
  getSessionUserId,
  REQUEST_TIMEOUT_MS,
  handleSignInElsewhere,
  invalidateRefreshes,
  isSignOutMarkerSet,
  isSignOutPending,
  SESSION_EPOCH_KEY,
  SIGN_OUT_MARKER_KEY,
  signedOutElsewhere,
  trackLogout,
  onSessionChange,
  publishSession,
  refreshSession,
  type AuthSession,
} from '@/lib/auth-session';

export type AuthUser = Schemas['AuthUser'];
export type StaffRole = Schemas['StaffRole'];

/** Second login step waiting for a code. Held in memory only; a page reload starts again at login. */
export interface PendingChallenge {
  kind: 'verify' | 'enroll';
  challengeToken: string;
}

export const LOGIN_PATH = '/admin/login';
/** Shown once on the login page after turning 2FA off. A fixed word, nothing about the user. */
export const TWO_FACTOR_OFF_LOGIN_PATH = '/admin/login?reason=two-factor-off';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  role: StaffRole | null;
  pending: PendingChallenge | null;
  /** True after the user chose Sign out, so the redirect to login does not say "session ended". */
  signedOutByUser: boolean;
  /** True when the server has not confirmed the last sign-out; the login screen offers a retry. */
  signOutUnconfirmed: boolean;
  retrySignOut: () => Promise<void>;
  /** Where staff pages send a signed-out user: /admin/login, or with a notice after a server-side revoke. */
  loginPath: string;
  /**
   * The server already ended every session of this user (turning 2FA off revokes all refresh
   * tokens and clears the cookie): forget the session here without a refresh or a logout call, and
   * go to login with a one-time notice. Nothing is left pending afterwards, so no "could not
   * confirm sign-out" warning and no logout retry. The sign-out marker is set briefly as a
   * cross-tab broadcast (other tabs sign out) and cleared last.
   */
  signOutRevoked: () => Promise<void>;
  /** The silent refresh got 503 BUSY and gave up: nobody was signed out; offer a manual retry. */
  refreshBusy: boolean;
  retryRefresh: () => void;
  /**
   * The server just set this user's refresh cookie but the session is not published yet (forced
   * enrollment: the recovery codes are still on screen). Clears the sign-out marker and tells
   * other tabs now, so no tab retries a logout with the new cookie. Does not sign in.
   */
  announceSession: (userId: string) => void;
  setPending: (pending: PendingChallenge | null) => void;
  /** Called after a successful login, 2FA verify or enrollment. */
  signIn: (session: AuthSession) => void;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const booted = React.useRef(false);
  const refreshBusy = React.useSyncExternalStore(
    busyStore.subscribe,
    () => busyStore.get().refreshBusy,
    () => false,
  );
  const retryRefresh = React.useCallback(() => void refreshSession(), []);
  const [status, setStatus] = React.useState<AuthStatus>('loading');
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [pending, setPending] = React.useState<PendingChallenge | null>(null);
  const [signedOutByUser, setSignedOutByUser] = React.useState(false);
  const [signOutUnconfirmed, setSignOutUnconfirmed] = React.useState(false);
  const [loginPath, setLoginPath] = React.useState(LOGIN_PATH);
  // This tab's own logout attempts: a call in flight, and the generation of a failed answer.
  // Used instead of the shared marker, which another tab clears before announcing its sign-in.
  const logoutOutstanding = React.useRef(0);
  const unconfirmedGen = React.useRef<number | null>(null);

  /**
   * Asks the server to end the session. Success, or 401 (there is no valid session left, so
   * nothing can be restored), clears the pending marker; anything else leaves it set.
   */
  const confirmLogout = React.useCallback(async () => {
    const startedIn = getGeneration();
    logoutOutstanding.current += 1;
    const call = (async (): Promise<boolean> => {
      try {
        const { response } = await api.POST('/v1/auth/logout', {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return response.ok || response.status === 401;
      } catch {
        return false;
      }
    })();
    trackLogout(call);
    const ok = await call;
    logoutOutstanding.current -= 1;
    // A new sign-in happened meanwhile: this answer is about the old session; ignore it.
    if (startedIn !== getGeneration()) return;
    if (ok) confirmSignedOut();
    // Remember which generation the failed answer belongs to, so Retry can tell it went stale.
    unconfirmedGen.current = ok ? null : startedIn;
    setSignOutUnconfirmed(!ok);
  }, []);

  /**
   * Retry after a failed logout. Only sends when nothing changed since the failure: if another
   * sign-in was announced (generation bumped) or the marker is gone, the shared cookie may belong
   * to someone else now, so just hide the button.
   */
  const retrySignOut = React.useCallback(async () => {
    if (unconfirmedGen.current !== getGeneration() || !isSignOutMarkerSet()) {
      unconfirmedGen.current = null;
      setSignOutUnconfirmed(false);
      return;
    }
    await confirmLogout();
  }, [confirmLogout]);

  React.useEffect(() => {
    let lastIdentity: string | null = null;
    const off = onSessionChange((session) => {
      // Cached API data belongs to one user AND one role. When either changes (sign-out, a
      // different person signing in, a lost session, or a role change that arrives with a refresh)
      // drop everything, so the next user, or the same person with less access (an Author demoted
      // to Recruiter), never sees what the old access allowed (FR-103, rule 3). Mounted screens
      // refetch and decide again from what the API now answers.
      const identity = session ? `${session.user.id}|${session.user.role}` : null;
      if (identity !== lastIdentity) {
        void queryClient.cancelQueries();
        queryClient.clear();
        // Question code (starter, reference and AI solutions) must not outlive the access in
        // Monaco's model store either.
        disposeModels(MODEL_ROOT);
        lastIdentity = identity;
      }
      setUser(session ? session.user : null);
      setStatus(session ? 'authenticated' : 'unauthenticated');
    });
    // Runs after the effect body (the marker lives in localStorage, so it cannot be read during
    // render without a hydration mismatch).
    const start = async (): Promise<void> => {
      await Promise.resolve();
      if (isSignOutPending()) {
        // The last sign-out was never confirmed. Do not restore a session; try the logout again.
        setSignedOutByUser(true);
        publishSession(null);
        await confirmLogout();
      } else {
        // Silent refresh on first load: the httpOnly cookie restores the session without a login.
        await refreshSession();
      }
    };
    // Effects run twice under React StrictMode in development; boot (and the logout retry) once.
    if (!booted.current) {
      booted.current = true;
      void start();
    }
    // Another tab signed out: this one must not keep looking signed in.
    const onStorage = (event: StorageEvent): void => {
      if (event.key === SIGN_OUT_MARKER_KEY && event.newValue === '1') {
        setSignedOutByUser(true);
        signedOutElsewhere();
      } else if (event.key === SIGN_OUT_MARKER_KEY && event.newValue === null) {
        // Another tab confirmed the sign-out (or signed in): nothing left to retry here.
        unconfirmedGen.current = null;
        setSignOutUnconfirmed(false);
      } else if (event.key === SESSION_EPOCH_KEY && getSessionUserId()) {
        // Another tab signed in. Compare user ids locally: no network call, so a burst of
        // refreshes from every tab cannot look like token reuse (TC-005).
        handleSignInElsewhere(event.newValue);
      } else if (
        event.key === SESSION_EPOCH_KEY &&
        (logoutOutstanding.current > 0 || unconfirmedGen.current !== null || isSignOutPending())
      ) {
        // Another tab has signed in (the shared cookie is now theirs) while this tab still has a
        // sign-out outstanding: its logout call in flight, a failed answer awaiting Retry, or a
        // pending marker. Supersede it: a late answer must not show "could not confirm" and
        // Retry must not revoke the new session (TC-005).
        // (The in-memory signing-out flag stays true after this on purpose: no refresh here.)
        invalidateRefreshes();
        unconfirmedGen.current = null;
        setSignOutUnconfirmed(false);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      off();
    };
  }, [confirmLogout, queryClient]);

  const signIn = React.useCallback(
    (session: AuthSession) => {
      setPending(null);
      setSignedOutByUser(false);
      setSignOutUnconfirmed(false);
      setLoginPath(LOGIN_PATH);
      beginSession(session.user.id);
      // The listener below clears on a user change; this clears when the same user id signs in
      // again (for example after a sign-out that kept the page mounted), so nothing is reused.
      void queryClient.cancelQueries();
      queryClient.clear();
      publishSession(session);
    },
    [queryClient],
  );

  const signOut = React.useCallback(async () => {
    setSignedOutByUser(true);
    setLoginPath(LOGIN_PATH);
    // Blocks new refreshes at once and forgets the session at once: a refresh already running
    // may take seconds, and until it settles the old token must not be used. Logout works from
    // the httpOnly cookie alone, so a slow logout sends no staff request with the old token and a
    // late 401 cannot start a refresh.
    const settled = beginSignOut();
    publishSession(null);
    await settled;
    try {
      // The session listener also cancels and clears on the user change; this is explicit so the
      // cache is empty even if the user id did not change.
      await queryClient.cancelQueries();
      queryClient.clear();
      setPending(null);
    } catch {
      // Nothing to do: the logout call below must still run.
    }
    try {
      await confirmLogout();
    } finally {
      // Whatever the server said, this browser has forgotten the session. If the server did not
      // confirm, the pending marker stays set so a reload does not restore it (FR-104).
      router.replace('/admin/login');
    }
  }, [router, confirmLogout, queryClient]);

  const announceSession = React.useCallback((userId: string) => {
    unconfirmedGen.current = null;
    setSignOutUnconfirmed(false);
    beginSession(userId);
  }, []);

  const signOutRevoked = React.useCallback(async () => {
    setSignedOutByUser(true);
    setLoginPath(TWO_FACTOR_OFF_LOGIN_PATH);
    // Synchronously blocks every new refresh (and tells other tabs through the marker, which is
    // set briefly on purpose as a cross-tab broadcast: do not optimise it away), then forget the
    // session at once. A request that gets a 401 from here on cannot start a refresh against a
    // family the server just revoked (that would look like token reuse, TC-005).
    const settled = beginSignOut();
    publishSession(null);
    await settled;
    await queryClient.cancelQueries();
    queryClient.clear();
    setPending(null);
    setSignOutUnconfirmed(false);
    // The server already revoked the session: nothing to confirm, no logout to retry. Cleared last.
    confirmSignedOut();
    router.replace(TWO_FACTOR_OFF_LOGIN_PATH);
  }, [router, queryClient]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      role: user?.role ?? null,
      pending,
      signedOutByUser,
      signOutUnconfirmed,
      retrySignOut,
      loginPath,
      signOutRevoked,
      refreshBusy,
      retryRefresh,
      announceSession,
      setPending,
      signIn,
      signOut,
    }),
    [
      status,
      user,
      pending,
      signedOutByUser,
      signOutUnconfirmed,
      retrySignOut,
      loginPath,
      signOutRevoked,
      refreshBusy,
      retryRefresh,
      announceSession,
      signIn,
      signOut,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Current staff user and role. Must be used inside the /admin layout's AuthProvider. */
export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
