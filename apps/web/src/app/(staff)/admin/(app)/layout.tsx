import { ThemeToggle } from '@/components/theme-toggle';
import { RequireRole } from '@/features/auth/require-role';
import { SignOutButton } from '@/features/auth/sign-out-button';
import { UserBadge } from '@/features/auth/user-badge';

// Staff shell placeholder behind sign-in. Sidebar and role-based navigation arrive in FE-03.
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b bg-card px-4 py-2">
        <span className="font-semibold">CodeProctor staff</span>
        <div className="flex items-center gap-2">
          <UserBadge />
          <SignOutButton />
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="p-4">
        <RequireRole>{children}</RequireRole>
      </main>
    </div>
  );
}
