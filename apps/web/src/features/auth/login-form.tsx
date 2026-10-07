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
import { settleSession } from '@/lib/auth-session';
import { useAuth } from './auth-provider';
import { safeNextPath } from './schemas';

type Banner = { kind: 'failed' } | { kind: 'network' } | { kind: 'busy' } | null;

/**
 * One neutral message for every failed sign-in (wrong password, unknown email, locked account), so
 * the screen never reveals which one it was (FR-101, TC-002).
 */
export const SIGN_IN_FAILED_MESSAGE =
  'Sign-in failed. If this keeps happening, wait 15 minutes or contact your administrator.';

/** FR-101 login form. TOTP (FR-102) and enrollment are separate screens reached from the result. */
export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const { signIn, setPending, status, signOutUnconfirmed, retrySignOut } = useAuth();
  const [banner, setBanner] = React.useState<Banner>(null);
  const [retrying, setRetrying] = React.useState(false);

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
      // A silent refresh or a logout retry from first load may still be running. Let it finish
      // first, so it cannot overwrite or revoke the refresh cookie this login is about to set (FR-101, FR-104).
      await settleSession();
      result = await api.POST('/v1/auth/login', { body: values });
    } catch {
      setBanner({ kind: 'network' });
      return;
    }
    const { data, response } = result;
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
    if (response.status === 401) {
      setBanner({ kind: 'failed' });
      setFocus('password');
    } else if (response.status === 503) {
      // Not retried by itself: every sign-in attempt counts, and a retry would count one more.
      setBanner({ kind: 'busy' });
    } else {
      setBanner({ kind: 'network' });
    }
  }

  const expired = params.get('reason') === 'expired';
  const reset = params.get('reset') === 'done';
  const twoFactorOff = params.get('reason') === 'two-factor-off';

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate className="space-y-4">
      {reset ? (
        <Alert tone="success" role="status" title="Password saved">
          Sign in with your new password. If your role uses an authenticator app, you will be asked
          for a code next.
        </Alert>
      ) : null}
      {twoFactorOff && !banner ? (
        <Alert tone="info" role="status">
          Two-factor sign-in is turned off and you were signed out on all devices. Sign in again.
        </Alert>
      ) : null}
      {signOutUnconfirmed ? (
        <Alert tone="warning" role="alert" title="We could not confirm you were signed out">
          Your sign-out may not have reached the server. Check your connection, then try again. Do
          this before leaving a shared computer.
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={isSubmitting || retrying}
            onClick={() => {
              setRetrying(true);
              void retrySignOut().finally(() => setRetrying(false));
            }}
          >
            Retry sign-out
          </Button>
        </Alert>
      ) : null}
      {expired && !banner ? (
        <Alert tone="info" role="status">
          Your session ended. Sign in again to continue.
        </Alert>
      ) : null}
      {banner?.kind === 'failed' ? (
        <Alert tone="error" role="alert">
          {SIGN_IN_FAILED_MESSAGE}
        </Alert>
      ) : null}
      {banner?.kind === 'busy' ? (
        <Alert tone="info" role="status" title="The service is busy">
          We did not try again for you, so this attempt is not counted twice. Wait a moment, then
          press Sign in again.
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
