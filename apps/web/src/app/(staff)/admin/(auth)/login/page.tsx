import { Suspense } from 'react';
import { AuthCard } from '@/features/auth/auth-card';
import { LoginForm } from '@/features/auth/login-form';

export const metadata = { title: 'Staff sign in' };

export default function LoginPage() {
  return (
    <AuthCard
      title="Sign in"
      description="Staff sign-in for recruiters, authors, reviewers and admins."
    >
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
