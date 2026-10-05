'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, type Schemas } from '@/lib/api/client';
import {
  beginSession,
  beginSignOut,
  confirmSignedOut,
  isSignOutPending,
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
  setPending: (pending: PendingChallenge | null) => void;
  /** Called after a successful login, 2FA verify or enrollment. */
  signIn: (session: AuthSession) => void;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  const [status, setStatus] = React.useState<AuthStatus>('loading');
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [pending, setPending] = React.useState<PendingChallenge | null>(null);
  const [signedOutByUser, setSignedOutByUser] = React.useState(false);
  const [signOutUnconfirmed, setSignOutUnconfirmed] = React.useState(false);

  /** Asks the server to end the session. Only a success clears the pending marker. */
  const confirmLogout = React.useCallback(async () => {
    let ok: boolean;
    try {
      ok = (await api.POST('/v1/auth/logout')).response.ok;
    } catch {
      ok = false;
    }
    if (ok) confirmSignedOut();
    setSignOutUnconfirmed(!ok);
  }, []);

  React.useEffect(() => {
    const off = onSessionChange((session) => {
      setUser(session ? session.user : null);
      setStatus(session ? 'authenticated' : 'unauthenticated');
    });
    if (isSignOutPending()) {
      // The last sign-out was never confirmed. Do not restore a session; try the logout again.
      setSignedOutByUser(true);
      publishSession(null);
      void confirmLogout();
    } else {
      // Silent refresh on first load: the httpOnly cookie restores the session without a login.
      void refreshSession();
    }
    return off;
  }, [confirmLogout]);

  const signIn = React.useCallback((session: AuthSession) => {
    setPending(null);
    setSignedOutByUser(false);
    setSignOutUnconfirmed(false);
    beginSession();
    publishSession(session);
  }, []);

  const signOut = React.useCallback(async () => {
    setSignedOutByUser(true);
    // Waits for a refresh already running, then blocks new ones until the next sign-in.
    await beginSignOut();
    try {
      await confirmLogout();
    } finally {
      // Whatever the server said, this browser forgets the session. If the server did not confirm,
      // the pending marker stays set so a reload does not restore it (FR-104).
      publishSession(null);
      setPending(null);
      router.replace('/admin/login');
    }
  }, [router, confirmLogout]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      role: user?.role ?? null,
      pending,
      signedOutByUser,
      signOutUnconfirmed,
      retrySignOut: confirmLogout,
      setPending,
      signIn,
      signOut,
    }),
    [status, user, pending, signedOutByUser, signOutUnconfirmed, confirmLogout, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Current staff user and role. Must be used inside the /admin layout's AuthProvider. */
export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
