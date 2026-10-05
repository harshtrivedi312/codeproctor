import { Suspense } from 'react';
import { AuthCard } from '@/features/auth/auth-card';
import { TwoFactorEnroll } from '@/features/auth/two-factor-enroll';

export const metadata = { title: 'Set up two-factor sign-in' };

export default function TwoFactorEnrollPage() {
  return (
    <AuthCard title="Set up two-factor sign-in" wide>
      <Suspense>
        <TwoFactorEnroll />
      </Suspense>
    </AuthCard>
  );
}
