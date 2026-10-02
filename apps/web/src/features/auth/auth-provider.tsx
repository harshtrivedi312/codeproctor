'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, type Schemas } from '@/lib/api/client';
import {
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

  React.useEffect(() => {
    const off = onSessionChange((session) => {
      setUser(session ? session.user : null);
      setStatus(session ? 'authenticated' : 'unauthenticated');
    });
    // Silent refresh on first load: the httpOnly cookie restores the session without a login.
    void refreshSession();
    return off;
  }, []);

  const signIn = React.useCallback((session: AuthSession) => {
    setPending(null);
    setSignedOutByUser(false);
    publishSession(session);
  }, []);

  const signOut = React.useCallback(async () => {
    setSignedOutByUser(true);
    try {
      await api.POST('/v1/auth/logout');
    } finally {
      // Whatever the server said, this browser forgets the session.
      publishSession(null);
      setPending(null);
      router.replace('/admin/login');
    }
  }, [router]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      role: user?.role ?? null,
      pending,
      signedOutByUser,
      setPending,
      signIn,
      signOut,
    }),
    [status, user, pending, signedOutByUser, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Current staff user and role. Must be used inside the /admin layout's AuthProvider. */
export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
