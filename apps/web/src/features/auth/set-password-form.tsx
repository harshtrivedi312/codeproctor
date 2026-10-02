'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { PASSWORD_RULES, setPasswordFormSchema, type SetPasswordForm } from './schemas';

/**
 * Reads the single-use token from the link once, into memory, and removes it from the address bar.
 * The emailed link should carry it in the fragment (#token=...) so it never reaches a server log;
 * a ?token= query is accepted as a fallback. It is never put in storage, a log or a request URL.
 */
function useLinkToken(): { token: string | null; ready: boolean } {
  const [state, setState] = React.useState<{ token: string | null; ready: boolean }>({
    token: null,
    ready: false,
  });
  React.useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    const token = fromHash ?? fromQuery;
    if (token) window.history.replaceState(null, '', window.location.pathname);
    // Reading the browser URL is the one thing an effect is for here. In React Strict Mode (dev)
    // this runs twice and the second pass finds the URL already stripped, so keep what we have.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((prev) => {
      if (token) return { token, ready: true };
      return prev.ready ? prev : { token: null, ready: true };
    });
  }, []);
  return state;
}

/** FR-107 reset and the staff invite (ADR 0003 section 4) share this page. It never signs in. */
export function SetPasswordForm({ purpose }: { purpose: 'reset' | 'invite' }): React.JSX.Element {
  const router = useRouter();
  const { token, ready } = useLinkToken();
  const [serverError, setServerError] = React.useState<'invalid' | 'network' | null>(null);
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<SetPasswordForm>({
    resolver: zodResolver(setPasswordFormSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });
  const typed = useWatch({ control, name: 'newPassword' });

  if (!ready)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  if (!token || serverError === 'invalid') {
    return (
      <div className="space-y-4">
        <Alert tone="error" role="alert" title="This link cannot be used">
          {serverError === 'invalid'
            ? 'It has expired or was already used. Links work once.'
            : 'The link is incomplete, or this page was reloaded after the link was opened. Open the link from your email again.'}
        </Alert>
        <p className="text-sm">
          {purpose === 'invite' ? <>Ask a Super Admin to send you a new invitation, or </> : null}
          <Link className="text-primary underline underline-offset-4" href="/admin/forgot-password">
            request a new reset link
          </Link>
          .
        </p>
      </div>
    );
  }
  const linkToken = token;

  async function onSubmit(values: SetPasswordForm): Promise<void> {
    setServerError(null);
    try {
      const { response } = await api.POST('/v1/auth/password/reset', {
        body: { token: linkToken, newPassword: values.newPassword },
      });
      if (response.ok) router.replace('/admin/login?reset=done');
      else if (response.status === 400) setServerError('invalid');
      else setServerError('network');
    } catch {
      setServerError('network');
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate className="space-y-4">
      {serverError === 'network' ? (
        <Alert tone="error" role="alert" title="We could not save the password">
          Check your connection and try again. Your link is still valid.
        </Alert>
      ) : null}
      <Field
        id="newPassword"
        label="New password"
        error={errors.newPassword?.message}
        hint={
          <ul aria-label="Password rules" className="mt-1 space-y-0.5">
            {PASSWORD_RULES.map((rule) => {
              const ok = rule.test(typed);
              return (
                <li key={rule.id} data-met={ok}>
                  <span aria-hidden>{ok ? '✓ ' : '• '}</span>
                  {rule.label}
                  <span className="sr-only">{ok ? ' (met)' : ' (not met yet)'}</span>
                </li>
              );
            })}
          </ul>
        }
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            autoComplete="new-password"
            {...register('newPassword')}
          />
        )}
      </Field>
      <Field
        id="confirmPassword"
        label="Repeat the new password"
        error={errors.confirmPassword?.message}
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            autoComplete="new-password"
            {...register('confirmPassword')}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : purpose === 'invite' ? 'Set password' : 'Save new password'}
      </Button>
    </form>
  );
}
