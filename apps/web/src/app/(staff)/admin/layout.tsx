import { AuthProvider } from '@/features/auth/auth-provider';

// One AuthProvider for every /admin page so the in-memory session and pending 2FA step survive
// client-side navigation between login, 2FA and the staff shell.
export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
