import { AuthCard } from '@/features/auth/auth-card';
import { SetPasswordForm } from '@/features/auth/set-password-form';

// Staff invite link (ADR 0003 section 4). Same form and token rules as the reset page.
export const metadata = { title: 'Set your password', referrer: 'no-referrer' };

export default function SetPasswordPage() {
  return (
    <AuthCard
      title="Welcome to CodeProctor"
      description="Choose a password to activate your account. Then sign in."
    >
      <SetPasswordForm purpose="invite" />
    </AuthCard>
  );
}
