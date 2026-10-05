'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { useAuth } from './auth-provider';
import { safeNextPath, twoFactorCodeSchema } from './schemas';

const formSchema = z.object({ code: twoFactorCodeSchema });
type FormValues = z.infer<typeof formSchema>;

/** FR-102: second step. Accepts a 6-digit authenticator code or one 16-character recovery code. */
export function TwoFactorVerifyForm(): React.JSX.Element | null {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get('next'));
  const { pending, signIn, setPending } = useAuth();
  const [serverError, setServerError] = React.useState<'wrong' | 'network' | null>(null);
  const [useRecovery, setUseRecovery] = React.useState(false);
  // Set once this form has finished the step itself (signed in, or sent back to login with a
  // reason). signIn clears `pending`, and without this the "no challenge" effect below would
  // replace the destination with /admin/login and drop `next` and `?reason=expired`.
  const finishedRef = React.useRef(false);

  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { code: '' } });

  React.useEffect(() => setFocus('code'), [setFocus]);

  // No pending challenge (page reload or direct visit): start again at login.
  const hasChallenge = pending?.kind === 'verify';
  React.useEffect(() => {
    if (!hasChallenge && !finishedRef.current) router.replace('/admin/login');
  }, [hasChallenge, router]);
  if (!pending || pending.kind !== 'verify') return null;
  const challengeToken = pending.challengeToken;

  async function onSubmit(values: FormValues): Promise<void> {
    setServerError(null);
    try {
      const { data, response } = await api.POST('/v1/auth/2fa/verify', {
        body: { challengeToken, code: values.code.trim() },
      });
      if (data) {
        finishedRef.current = true;
        signIn(data);
        router.replace(next);
      } else if (response.status === 401) {
        finishedRef.current = true;
        setPending(null);
        router.replace('/admin/login?reason=expired');
      } else {
        setServerError('wrong');
        setValue('code', '');
        setFocus('code');
      }
    } catch {
      setServerError('network');
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate className="space-y-4">
      {serverError === 'wrong' ? (
        <Alert tone="error" role="alert" title="That code did not work">
          {useRecovery
            ? 'Check the recovery code, including every character, and try again. Each recovery code works only once.'
            : 'Codes change every 30 seconds. Wait for a new code in your authenticator app and try again, or use a recovery code.'}
        </Alert>
      ) : null}
      {serverError === 'network' ? (
        <Alert tone="error" role="alert" title="We could not check the code">
          Check your connection and try again.
        </Alert>
      ) : null}
      <Field
        id="code"
        label={useRecovery ? 'Recovery code' : 'Authenticator code'}
        hint={
          useRecovery
            ? 'One of the 16-character codes you saved when you set up two-factor sign-in.'
            : 'The 6-digit code shown in your authenticator app.'
        }
        error={errors.code?.message}
      >
        {(aria) => (
          <Input
            {...aria}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            spellCheck={false}
            {...register('code')}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Checking…' : 'Verify and sign in'}
      </Button>
      <div className="flex flex-col items-center gap-2 text-sm">
        <button
          type="button"
          className="text-primary underline underline-offset-4"
          onClick={() => {
            setUseRecovery((v) => !v);
            setServerError(null);
            setValue('code', '');
            setFocus('code');
          }}
        >
          {useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
        </button>
        <Link className="text-primary underline underline-offset-4" href="/admin/login">
          Back to sign in
        </Link>
      </div>
    </form>
  );
}
