import { Suspense } from 'react';
import { AuthCard } from '@/features/auth/auth-card';
import { TwoFactorVerifyForm } from '@/features/auth/two-factor-verify-form';

export const metadata = { title: 'Two-factor sign-in' };

export default function TwoFactorPage() {
  return (
    <AuthCard
      title="Two-factor sign-in"
      description="Enter the code from your authenticator app to finish signing in."
    >
      <Suspense>
        <TwoFactorVerifyForm />
      </Suspense>
    </AuthCard>
  );
}
