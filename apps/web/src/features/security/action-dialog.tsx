'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-provider';
import { captureSessionStamp, getGeneration, getSessionUserId } from '@/lib/auth-session';
import { RecoveryCodesPanel } from '@/features/auth/recovery-codes-panel';
import {
  confirmSetup,
  disableTwoFactor,
  regenerateRecoveryCodes,
  startSetup,
  type Failure,
} from './api';
import {
  codeFormSchema,
  passwordStepSchema,
  TOTP_CODE_MESSAGE,
  REAUTH_FAILED_DISABLE_MESSAGE,
  REAUTH_FAILED_MESSAGE,
  type CodeFormValues,
  type PasswordFormValues,
} from './schemas';

export type SecurityAction = 'setup' | 'disable' | 'regenerate';
export type SecurityResult = 'enabled' | 'regenerated';

const COPY: Record<SecurityAction, { title: string; description: string; submit: string }> = {
  setup: {
    title: 'Set up two-factor sign-in',
    description:
      'This is optional, and we recommend it. Enter your current password to continue. We ask again so that nobody else can change your sign-in on a computer you left unlocked.',
    submit: 'Continue',
  },
  disable: {
    title: 'Turn off two-factor sign-in',
    description:
      'After this, your password alone signs you in, and you are signed out on all devices. Enter your current password and the 6-digit code from your authenticator app. A recovery code does not work here.',
    submit: 'Turn off 2FA',
  },
  regenerate: {
    title: 'Get new recovery codes',
    description:
      'Your old recovery codes stop working as soon as you continue. Enter your current password to confirm.',
    submit: 'Get new codes',
  },
};

const FAILURE_HINT: Record<
  Exclude<Failure, 'password' | 'code'>,
  { title: string; hint: string }
> = {
  busy: {
    title: 'Verification is temporarily unavailable',
    hint: 'The service is busy. Nothing was changed. Wait a few seconds, then submit again.',
  },
  conflict: {
    title: 'This changed in the meantime',
    hint: 'Two-factor sign-in was already turned on or off somewhere else. Close this window and reload the page to see the current state.',
  },
  forbidden: {
    title: 'Your role cannot do this',
    hint: 'Ask a Super Admin if you think this is a mistake.',
  },
  session: {
    title: 'Your session has expired',
    hint: 'Sign in again, then try once more.',
  },
  network: {
    title: 'We could not reach the server',
    hint: 'Check your connection and try again.',
  },
  unknown: {
    title: 'Something went wrong',
    hint: 'Try again in a moment. If it keeps happening, contact your administrator.',
  },
};

type Stage =
  | { kind: 'password'; passwordWrong: boolean }
  | { kind: 'confirm'; manualKey: string; qr: string }
  | { kind: 'codes'; codes: string[] };

/**
 * The one shared dialog behind all three Security actions. It always asks for the current
 * password first. The password lives in this component's state only while the dialog is mounted
 * (set-up needs it again for the confirm call) and is gone when the dialog closes (FR-102).
 */
export function ActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: SecurityAction;
  onClose: () => void;
  onDone: (result: SecurityResult) => void;
}): React.JSX.Element {
  const { user, signOutRevoked } = useAuth();
  // Who this dialog was opened by: sign-out and the re-read below only run for that same session.
  const [stamp] = React.useState(captureSessionStamp);
  const [stage, setStage] = React.useState<Stage>({ kind: 'password', passwordWrong: false });
  // The password sits in this component state between set-up start and set-up confirm because
  // the confirm call needs it again. It is cleared once confirm succeeds or fails on the password,
  // and is gone when the dialog closes (the component unmounts).
  const [password, setPassword] = React.useState('');
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const copy = COPY[action];

  async function onPassword(
    values: PasswordFormValues,
  ): Promise<'wrong' | 'invalid' | 'failed' | 'ok'> {
    setFailure(null);
    if (action === 'setup') {
      const out = await startSetup(values.currentPassword);
      if (!out.ok) return fail(out.failure);
      // Only a PNG data URL may become the image source.
      if (!out.data.qrDataUrl.startsWith('data:image/png;base64,')) return fail('unknown');
      setPassword(values.currentPassword);
      setStage({ kind: 'confirm', manualKey: out.data.manualKey, qr: out.data.qrDataUrl });
      return 'ok';
    }
    if (action === 'disable') {
      const out = await disableTwoFactor(values.currentPassword, values.totpCode ?? '');
      if (!out.ok) return fail(out.failure);
      // Another tab signed in as someone else (or this tab already signed out) while the call
      // was in flight: that session is not ours to end. Just close.
      if (stamp.generation !== getGeneration() || stamp.userId !== getSessionUserId()) {
        onClose();
        return 'ok';
      }
      // The server revoked every session of this user, this one included: sign out normally (the
      // logout call normally answers 401, which counts as confirmed), no refresh.
      await signOutRevoked('off');
      return 'ok';
    }
    const out = await regenerateRecoveryCodes(values.currentPassword);
    if (!out.ok) return fail(out.failure);
    // totpEnabled does not change here, so there is nothing to re-read.
    setStage({ kind: 'codes', codes: out.data.recoveryCodes });
    return 'ok';
  }

  /**
   * Set-up turned 2FA on, and the server revoked every refresh family of this user, this one
   * included. After the recovery codes were acknowledged (Done), forget the session here and go to
   * sign-in through the normal sign-out (one logout call, normally 401 = confirmed), no refresh. Never for another user's session.
   */
  async function finishSetup(): Promise<void> {
    // Only another person's session is not ours to end; the same user in a newer generation is.
    if (stamp.userId !== getSessionUserId()) {
      onDone('enabled');
      return;
    }
    await signOutRevoked('on');
  }

  function fail(f: Failure): 'wrong' | 'invalid' | 'failed' {
    if (f === 'password') return 'wrong';
    // 400 here means the password field was missing or invalid.
    if (f === 'code') return 'invalid';
    setFailure(f);
    return 'failed';
  }

  async function onCode(values: CodeFormValues): Promise<'ok' | 'wrongCode' | 'failed'> {
    setFailure(null);
    const out = await confirmSetup(password, values.code);
    if (out.ok) {
      setPassword('');
      setStage({ kind: 'codes', codes: out.data.recoveryCodes });
      return 'ok';
    }
    if (out.failure === 'password') {
      // The password stopped matching (for example it was changed in another tab): ask again.
      setPassword('');
      setStage({ kind: 'password', passwordWrong: true });
      return 'failed';
    }
    if (out.failure === 'code') return 'wrongCode';
    if (out.failure === 'network' || out.failure === 'unknown') {
      // The outcome is unknown: 2FA may be on and every session revoked, or nothing happened and
      // the cookie is still valid. Sign out for real (logout call, pending marker if it fails).
      setPassword('');
      if (stamp.userId === getSessionUserId()) {
        await signOutRevoked('unconfirmed');
        return 'failed';
      }
      // Another person's session now: do not end it. Hint to reload and check the current state.
      setFailure('conflict');
      return 'failed';
    }
    setFailure(out.failure);
    return 'failed';
  }

  const locked = stage.kind === 'codes';
  // The codes are shown once: warn before a reload or tab close loses them.
  React.useEffect(() => {
    if (!locked) return undefined;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [locked]);
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto"
        // The recovery codes are shown once: only the Done button closes the window then.
        onEscapeKeyDown={(e) => (locked ? e.preventDefault() : undefined)}
        onInteractOutside={(e) => (locked ? e.preventDefault() : undefined)}
      >
        {stage.kind === 'password' ? (
          <>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
            <PasswordStep
              submitLabel={copy.submit}
              destructive={action === 'disable'}
              withCode={action === 'disable'}
              initialWrong={stage.passwordWrong}
              failure={failure}
              onSubmit={onPassword}
              onCancel={onClose}
              cancelLabel={action === 'setup' ? 'Skip for now' : 'Cancel'}
            />
          </>
        ) : null}
        {stage.kind === 'confirm' ? (
          <>
            <DialogTitle>Set up two-factor sign-in</DialogTitle>
            <DialogDescription>
              Add CodeProctor to an authenticator app (for example Aegis, 2FAS, Google Authenticator
              or Microsoft Authenticator), then enter the code it shows.
            </DialogDescription>
            <ConfirmStep
              manualKey={stage.manualKey}
              qr={stage.qr}
              failure={failure}
              onSubmit={onCode}
              onCancel={onClose}
              cancelLabel={action === 'setup' ? 'Skip for now' : 'Cancel'}
            />
          </>
        ) : null}
        {stage.kind === 'codes' ? (
          <>
            <DialogTitle>Save your recovery codes</DialogTitle>
            <DialogDescription>
              {action === 'regenerate'
                ? 'Your old recovery codes no longer work. '
                : 'Two-factor sign-in is on. '}
              These new codes are shown only once. Each works one time, in place of the 6-digit
              code.
            </DialogDescription>
            <CodesStep
              email={user?.email ?? ''}
              codes={stage.codes}
              onDone={() => {
                if (action === 'setup') void finishSetup();
                else onDone('regenerated');
              }}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FailureAlert({ failure }: { failure: Failure | null }): React.JSX.Element | null {
  if (!failure || failure === 'code' || failure === 'password') return null;
  const { title, hint } = FAILURE_HINT[failure];
  return (
    <Alert tone="error" role="alert" title={title}>
      {hint}
    </Alert>
  );
}

function PasswordStep({
  submitLabel,
  destructive,
  withCode,
  initialWrong,
  failure,
  onSubmit,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  submitLabel: string;
  destructive: boolean;
  /** Disable also asks for the 6-digit authenticator code. */
  withCode: boolean;
  initialWrong: boolean;
  failure: Failure | null;
  onSubmit: (values: PasswordFormValues) => Promise<'wrong' | 'invalid' | 'failed' | 'ok'>;
  onCancel: () => void;
  cancelLabel?: string;
}): React.JSX.Element {
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordStepSchema(withCode)),
    defaultValues: { currentPassword: '', ...(withCode ? { totpCode: '' } : {}) },
  });
  React.useEffect(() => {
    if (initialWrong) setError('currentPassword', { message: REAUTH_FAILED_MESSAGE });
  }, [initialWrong, setError]);

  async function submit(values: PasswordFormValues): Promise<void> {
    const outcome = await onSubmit(values);
    if (outcome === 'ok') return;
    // Never keep a password that did not work (or any password after a failure) in the field.
    setValue('currentPassword', '');
    if (withCode) setValue('totpCode', '');
    if (outcome === 'wrong') {
      setError('currentPassword', {
        message: withCode ? REAUTH_FAILED_DISABLE_MESSAGE : REAUTH_FAILED_MESSAGE,
      });
    }
    if (outcome === 'invalid') {
      if (withCode) setError('totpCode', { message: TOTP_CODE_MESSAGE });
      else setError('currentPassword', { message: 'Enter your current password.' });
    }
    setFocus('currentPassword');
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(submit)(e)}
      noValidate
      className="mt-4 space-y-4"
      data-testid="reauth-form"
    >
      <FailureAlert failure={failure} />
      <Field id="current-password" label="Current password" error={errors.currentPassword?.message}>
        {(aria) => (
          <Input
            {...aria}
            type="password"
            autoComplete="current-password"
            {...register('currentPassword')}
          />
        )}
      </Field>
      {withCode ? (
        <Field
          id="disable-code"
          label="6-digit code"
          hint="From your authenticator app."
          error={errors.totpCode?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              inputMode="numeric"
              autoComplete="one-time-code"
              {...register('totpCode')}
            />
          )}
        </Field>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          type="submit"
          variant={destructive ? 'destructive' : 'default'}
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Checking…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function groupKey(key: string): string {
  return key.match(/.{1,4}/g)?.join(' ') ?? key;
}

function ConfirmStep({
  manualKey,
  qr,
  failure,
  onSubmit,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  manualKey: string;
  qr: string;
  failure: Failure | null;
  onSubmit: (values: CodeFormValues) => Promise<'ok' | 'wrongCode' | 'failed'>;
  onCancel: () => void;
  cancelLabel?: string;
}): React.JSX.Element {
  const [wrongCode, setWrongCode] = React.useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<CodeFormValues>({
    resolver: zodResolver(codeFormSchema),
    defaultValues: { code: '' },
  });
  async function submit(values: CodeFormValues): Promise<void> {
    setWrongCode(false);
    const outcome = await onSubmit(values);
    if (outcome === 'ok') return;
    setWrongCode(outcome === 'wrongCode');
    setValue('code', '');
    setFocus('code');
  }
  return (
    <form onSubmit={(e) => void handleSubmit(submit)(e)} noValidate className="mt-4 space-y-4">
      <img
        src={qr}
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
          {groupKey(manualKey)}
        </p>
      </div>
      {wrongCode ? (
        <Alert tone="error" role="alert" title="That code did not match">
          Wait for a fresh code in your app and enter it again. If it keeps failing, check that your
          phone&apos;s clock is set automatically.
        </Alert>
      ) : null}
      <FailureAlert failure={failure} />
      <Field id="setup-code" label="6-digit code" error={errors.code?.message}>
        {(aria) => (
          <Input {...aria} inputMode="numeric" autoComplete="one-time-code" {...register('code')} />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Checking…' : 'Confirm and turn on'}
        </Button>
      </div>
    </form>
  );
}

function CodesStep({
  email,
  codes,
  onDone,
}: {
  email: string;
  codes: string[];
  onDone: () => void;
}): React.JSX.Element {
  const [saved, setSaved] = React.useState(false);
  return (
    <div className="mt-4 space-y-4">
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
      <div className="flex justify-end">
        <Button type="button" disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
