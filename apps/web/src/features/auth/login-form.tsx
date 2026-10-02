'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginRequestSchema, type LoginRequest } from '@codeproctor/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { useAuth } from './auth-provider';
import { safeNextPath } from './schemas';

type Banner =
  { kind: 'wrong' } | { kind: 'locked'; lockedUntil: string } | { kind: 'network' } | null;

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** FR-101 login form. TOTP (FR-102) and enrollment are separate screens reached from the result. */
export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const { signIn, setPending, status } = useAuth();
  const [banner, setBanner] = React.useState<Banner>(null);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  React.useEffect(() => setFocus('email'), [setFocus]);

  // Already signed in (the silent refresh found a session): skip the form.
  React.useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  async function onSubmit(values: LoginRequest): Promise<void> {
    setBanner(null);
    let result;
    try {
      result = await api.POST('/v1/auth/login', { body: values });
    } catch {
      setBanner({ kind: 'network' });
      return;
    }
    const { data, error, response } = result;
    if (data) {
      if (data.status === 'authenticated' && data.session) {
        signIn(data.session);
        router.replace(next);
      } else if (data.challengeToken) {
        const kind = data.status === 'two_factor_enrollment_required' ? 'enroll' : 'verify';
        setPending({ kind, challengeToken: data.challengeToken });
        router.push(
          `${kind === 'enroll' ? '/admin/2fa/enroll' : '/admin/2fa'}?next=${encodeURIComponent(next)}`,
        );
      } else {
        setBanner({ kind: 'network' });
      }
      return;
    }
    if (response.status === 423 && error && 'lockedUntil' in error) {
      setBanner({ kind: 'locked', lockedUntil: error.lockedUntil });
    } else if (response.status === 401) {
      setBanner({ kind: 'wrong' });
      setFocus('password');
    } else {
      setBanner({ kind: 'network' });
    }
  }

  const expired = params.get('reason') === 'expired';
  const reset = params.get('reset') === 'done';

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate className="space-y-4">
      {reset ? (
        <Alert tone="success" role="status" title="Password saved">
          Sign in with your new password. If your role uses an authenticator app, you will be asked
          for a code next.
        </Alert>
      ) : null}
      {expired && !banner ? (
        <Alert tone="info" role="status">
          Your session ended. Sign in again to continue.
        </Alert>
      ) : null}
      {banner?.kind === 'wrong' ? (
        <Alert tone="error" role="alert" title="Email or password is incorrect">
          Check for typing mistakes and that Caps Lock is off. If you forgot your password, use
          &ldquo;Forgot password&rdquo; below.
        </Alert>
      ) : null}
      {banner?.kind === 'locked' ? (
        <Alert tone="warning" role="alert" title="This account is temporarily locked">
          There were too many incorrect sign-in attempts. You can try again after{' '}
          <strong>{formatTime(banner.lockedUntil)}</strong> (about 15 minutes). To sign in sooner,
          reset your password with &ldquo;Forgot password&rdquo; below.
        </Alert>
      ) : null}
      {banner?.kind === 'network' ? (
        <Alert tone="error" role="alert" title="We could not sign you in">
          The server did not answer as expected. Check your connection and try again in a moment.
        </Alert>
      ) : null}

      <Field id="email" label="Work email" error={errors.email?.message}>
        {(aria) => <Input {...aria} type="email" autoComplete="username" {...register('email')} />}
      </Field>
      <Field id="password" label="Password" error={errors.password?.message}>
        {(aria) => (
          <Input
            {...aria}
            type="password"
            autoComplete="current-password"
            {...register('password')}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-center text-sm">
        <Link className="text-primary underline underline-offset-4" href="/admin/forgot-password">
          Forgot password
        </Link>
      </p>
    </form>
  );
}
