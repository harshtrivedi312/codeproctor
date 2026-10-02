'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { forgotPasswordFormSchema } from './schemas';

type FormValues = { email: string };

/** Shown for every email, known or not (FR-107, TC-098). Do not add any account-specific wording. */
export const FORGOT_CONFIRMATION =
  'If an account exists for that email, we have sent a link to reset the password. The link works once and expires in 30 minutes.';

export function ForgotPasswordForm(): React.JSX.Element {
  const [sent, setSent] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(forgotPasswordFormSchema),
    defaultValues: { email: '' },
  });

  React.useEffect(() => setFocus('email'), [setFocus]);

  async function onSubmit(values: FormValues): Promise<void> {
    setFailed(false);
    try {
      const { response } = await api.POST('/v1/auth/password/forgot', { body: values });
      // 202 is the only success. Anything else (for example rate limiting) is a generic retry.
      if (response.status === 202) setSent(true);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <Alert tone="success" role="status" title="Check your email">
          {FORGOT_CONFIRMATION}
        </Alert>
        <p className="text-sm text-muted-foreground">
          Nothing arrived after a few minutes? Check your spam folder, or request another link.
          Asking again makes the earlier link stop working.
        </p>
        <Link className="text-sm text-primary underline underline-offset-4" href="/admin/login">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate className="space-y-4">
      {failed ? (
        <Alert tone="error" role="alert" title="We could not send the request">
          Wait a minute, check your connection and try again.
        </Alert>
      ) : null}
      <Field id="email" label="Work email" error={errors.email?.message}>
        {(aria) => <Input {...aria} type="email" autoComplete="email" {...register('email')} />}
      </Field>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send reset link'}
      </Button>
      <p className="text-center text-sm">
        <Link className="text-primary underline underline-offset-4" href="/admin/login">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
