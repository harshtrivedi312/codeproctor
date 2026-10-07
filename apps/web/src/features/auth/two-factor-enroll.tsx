'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { otpCodeSchema } from '@codeproctor/shared';
import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import type { AuthSession } from '@/lib/auth-session';
import { useAuth } from './auth-provider';
import { RecoveryCodesPanel } from './recovery-codes-panel';
import { safeNextPath } from './schemas';

const formSchema = z.object({ code: otpCodeSchema });
type FormValues = z.infer<typeof formSchema>;

/** Groups the key in fours so it is easy to read and type. */
function groupKey(key: string): string {
  return key.match(/.{1,4}/g)?.join(' ') ?? key;
}

/**
 * FR-102 / TC-003: forced TOTP enrollment. The access token is only issued after the first code is
 * confirmed, so no staff page can load before this is done. Step 1 scan or type the key, step 2
 * confirm a code, step 3 save the recovery codes.
 */
/** enroll/start answered something other than the secret: only the status matters here. */
class StartFailure extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

export function TwoFactorEnroll(): React.JSX.Element | null {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get('next'));
  const { pending, signIn, setPending, announceSession } = useAuth();
  const [result, setResult] = React.useState<{ session: AuthSession; codes: string[] } | null>(
    null,
  );
  const [serverError, setServerError] = React.useState<'wrong' | 'network' | null>(null);

  const challengeToken = pending?.kind === 'enroll' ? pending.challengeToken : null;
  // Set once this page has sent the user back to sign-in with a reason: clearing `pending` would
  // otherwise make the "no challenge" effect replace `?reason=expired` with plain /admin/login.
  const leavingRef = React.useRef(false);
  React.useEffect(() => {
    if (!challengeToken && !result && !leavingRef.current) router.replace('/admin/login');
  }, [challengeToken, result, router]);

  const start = useQuery({
    queryKey: ['2fa-enroll-start', challengeToken],
    enabled: Boolean(challengeToken) && !result,
    // The secret must not change while the page is open, so never refetch it.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const { data, response } = await api.POST('/v1/auth/2fa/enroll/start', {
        body: { challengeToken: challengeToken ?? '' },
      });
      // A stale or unknown challenge is a 401: the sign-in step is over, so go back to sign-in.
      if (!data) throw new StartFailure(response.status);
      return { ...data, qr: await QRCode.toDataURL(data.otpauthUri, { margin: 1, width: 192 }) };
    },
  });

  const startExpired = start.error instanceof StartFailure && start.error.status === 401;
  React.useEffect(() => {
    if (!startExpired || leavingRef.current) return;
    leavingRef.current = true;
    router.replace('/admin/login?reason=expired');
    setPending(null);
  }, [startExpired, router, setPending]);

  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { code: '' } });

  if (result) {
    return (
      <RecoveryCodesStep
        email={result.session.user.email}
        codes={result.codes}
        onContinue={() => {
          signIn(result.session);
          router.replace(next);
        }}
      />
    );
  }
  if (!challengeToken) return null;

  async function onSubmit(values: FormValues): Promise<void> {
    setServerError(null);
    try {
      const { data, response } = await api.POST('/v1/auth/2fa/enroll/confirm', {
        body: { challengeToken: challengeToken ?? '', code: values.code },
      });
      if (data) {
        // The server just set this user's refresh cookie. The codes screen stays up until Continue,
        // but other tabs must not retry a logout with that cookie in the meantime (TC-005).
        announceSession(data.session.user.id);
        setResult({ session: data.session, codes: data.recoveryCodes });
        setPending(null);
      } else if (response.status === 401) {
        leavingRef.current = true;
        setPending(null);
        router.replace('/admin/login?reason=expired');
      } else if (response.status === 500) {
        // Outcome unknown (contract section 8): the first code may have been accepted. Nothing to
        // read without a session, and never re-confirm with this code: go to sign-in. It asks for
        // the authenticator code if set-up landed (then get new recovery codes), or starts enrolment again.
        leavingRef.current = true;
        setPending(null);
        router.replace('/admin/login?reason=enroll-unconfirmed');
      } else {
        setServerError('wrong');
        setValue('code', '');
        setFocus('code');
      }
    } catch {
      setServerError('network');
    }
  }

  if (startExpired) return null; // on its way to the sign-in page, which says the step expired
  if (start.isError) {
    return (
      <Alert tone="error" role="alert" title="We could not start set-up">
        Your sign-in step may have timed out. Go back to the sign-in page and try again.
      </Alert>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate className="space-y-5">
      <Alert tone="info">
        Your role requires two-factor sign-in. You cannot open any staff page until this is set up.
      </Alert>
      <section aria-labelledby="enroll-step-1" className="space-y-3">
        <h2 id="enroll-step-1" className="font-medium">
          1. Add CodeProctor to your authenticator app
        </h2>
        <p className="text-sm text-muted-foreground">
          Open an authenticator app (for example Aegis, 2FAS, Google Authenticator or Microsoft
          Authenticator) and scan this code.
        </p>
        {start.data ? (
          <>
            <img
              src={start.data.qr}
              width={192}
              height={192}
              alt="QR code to add your CodeProctor account to an authenticator app"
              className="rounded border bg-white p-1"
            />
            <div>
              <p className="text-sm">Cannot scan? Enter this key by hand (time-based, 6 digits):</p>
              <p
                data-testid="manual-key"
                className="mt-1 break-all rounded bg-muted px-3 py-2 font-mono text-sm tracking-wider"
              >
                {groupKey(start.data.manualKey)}
              </p>
            </div>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Preparing your set-up code…
          </p>
        )}
      </section>
      <section aria-labelledby="enroll-step-2" className="space-y-3">
        <h2 id="enroll-step-2" className="font-medium">
          2. Confirm with the first code
        </h2>
        {serverError === 'wrong' ? (
          <Alert tone="error" role="alert" title="That code did not match">
            Wait for a fresh code in your app and enter it again. If it keeps failing, check that
            your phone&apos;s clock is set automatically.
          </Alert>
        ) : null}
        {serverError === 'network' ? (
          <Alert tone="error" role="alert" title="We could not check the code">
            Check your connection and try again.
          </Alert>
        ) : null}
        <Field
          id="code"
          label="6-digit code"
          hint="After this you will get recovery codes to keep."
          error={errors.code?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              inputMode="numeric"
              autoComplete="one-time-code"
              {...register('code')}
            />
          )}
        </Field>
        <Button type="submit" className="w-full" disabled={isSubmitting || !start.data}>
          {isSubmitting ? 'Checking…' : 'Confirm and continue'}
        </Button>
      </section>
    </form>
  );
}

function RecoveryCodesStep({
  email,
  codes,
  onContinue,
}: {
  email: string;
  codes: string[];
  onContinue: () => void;
}): React.JSX.Element {
  const [saved, setSaved] = React.useState(false);
  return (
    <div className="space-y-4">
      <Alert tone="success" role="status" title="Two-factor sign-in is on">
        Last step: keep your recovery codes. They are shown only once.
      </Alert>
      <h2 className="font-medium">3. Save your recovery codes</h2>
      <p className="text-sm text-muted-foreground">
        If you lose your phone you can sign in with one of these instead of the 6-digit code. Each
        works once.
      </p>
      <RecoveryCodesPanel email={email} codes={codes} />
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        <span>I have saved these recovery codes somewhere safe.</span>
      </label>
      <Button type="button" className="w-full" disabled={!saved} onClick={onContinue}>
        Continue to CodeProctor
      </Button>
    </div>
  );
}
