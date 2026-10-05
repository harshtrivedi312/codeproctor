'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, type Schemas } from '@/lib/api/client';
import {
  beginSession,
  beginSignOut,
  confirmSignedOut,
  getGeneration,
  getSessionUserId,
  REQUEST_TIMEOUT_MS,
  handleSignInElsewhere,
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
   * go to login with a one-time notice. Nothing is left pending, so no "could not confirm sign-out"
   * warning and no logout retry.
   */
  signOutRevoked: () => Promise<void>;
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
  const [status, setStatus] = React.useState<AuthStatus>('loading');
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [pending, setPending] = React.useState<PendingChallenge | null>(null);
  const [signedOutByUser, setSignedOutByUser] = React.useState(false);
  const [signOutUnconfirmed, setSignOutUnconfirmed] = React.useState(false);
  const [loginPath, setLoginPath] = React.useState(LOGIN_PATH);

  /**
   * Asks the server to end the session. Success, or 401 (there is no valid session left, so
   * nothing can be restored), clears the pending marker; anything else leaves it set.
   */
  const confirmLogout = React.useCallback(async () => {
    const startedIn = getGeneration();
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
    // A new sign-in happened meanwhile: this answer is about the old session; ignore it.
    if (startedIn !== getGeneration()) return;
    if (ok) confirmSignedOut();
    setSignOutUnconfirmed(!ok);
  }, []);

  React.useEffect(() => {
    let lastUserId: string | null = null;
    const off = onSessionChange((session) => {
      // Cached API data belongs to one user. When the user changes (sign-out, a different person
      // signing in, a lost session) drop everything, so the next user never sees it (FR-103).
      const id = session ? session.user.id : null;
      if (id !== lastUserId) {
        void queryClient.cancelQueries();
        queryClient.clear();
        lastUserId = id;
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
        setSignOutUnconfirmed(false);
      } else if (event.key === SESSION_EPOCH_KEY && getSessionUserId()) {
        // Another tab signed in. Compare user ids locally: no network call, so a burst of
        // refreshes from every tab cannot look like token reuse (TC-005).
        handleSignInElsewhere(event.newValue);
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
    // Waits for a refresh already running, then blocks new ones until the next sign-in.
    await beginSignOut();
    try {
      await confirmLogout();
    } finally {
      // Whatever the server said, this browser forgets the session. If the server did not confirm,
      // the pending marker stays set so a reload does not restore it (FR-104).
      await queryClient.cancelQueries();
      queryClient.clear();
      publishSession(null);
      setPending(null);
      router.replace('/admin/login');
    }
  }, [router, confirmLogout, queryClient]);

  const signOutRevoked = React.useCallback(async () => {
    setSignedOutByUser(true);
    setLoginPath(TWO_FACTOR_OFF_LOGIN_PATH);
    // Stops and ignores any refresh in flight, so nothing can bring the session back.
    await beginSignOut();
    // The server has already revoked the session: nothing to confirm, no logout to retry.
    confirmSignedOut();
    setSignOutUnconfirmed(false);
    await queryClient.cancelQueries();
    queryClient.clear();
    publishSession(null);
    setPending(null);
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
      retrySignOut: confirmLogout,
      loginPath,
      signOutRevoked,
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
      confirmLogout,
      loginPath,
      signOutRevoked,
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
