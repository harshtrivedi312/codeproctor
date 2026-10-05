import { AuthCard } from '@/features/auth/auth-card';
import { SetPasswordForm } from '@/features/auth/set-password-form';

// The link carries a single-use token. Never send it on as a Referer (also set in next.config.ts).
export const metadata = { title: 'Choose a new password', referrer: 'no-referrer' };

export default function ResetPasswordPage() {
  return (
    <AuthCard
      title="Choose a new password"
      description="After saving, sign in again. If your role uses an authenticator app, you will still be asked for a code."
    >
      <SetPasswordForm purpose="reset" />
    </AuthCard>
  );
}
