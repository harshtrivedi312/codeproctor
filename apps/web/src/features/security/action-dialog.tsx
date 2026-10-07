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
import {
  captureSessionStamp,
  getGeneration,
  getSessionUserId,
  refreshForReplay,
} from '@/lib/auth-session';
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
      'Enter your current password to continue. We ask again so that nobody else can change your sign-in on a computer you left unlocked.',
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
  role: {
    title: 'Two-factor sign-in is required for your role',
    hint: 'Super Admins and Reviewers cannot turn it off. If you lost your phone, use a recovery code or ask a Super Admin.',
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
  outcomeUnknown: {
    title: 'We could not confirm the result',
    hint: 'Nothing was retried for you. Check the current state before trying again.',
  },
  unknown: {
    title: 'Something went wrong',
    hint: 'Try again in a moment. If it keeps happening, contact your administrator.',
  },
};

type Stage =
  | { kind: 'password'; passwordWrong: boolean }
  | { kind: 'confirm'; manualKey: string; qr: string; restarted?: boolean }
  /**
   * Set-up confirm answered the fixed 500 (outcome unknown): finding out whether 2FA is on. `on`:
   * it is, so the recovery codes in the lost answer are gone; `retry`: the check itself failed.
   */
  | { kind: 'unconfirmed'; state: 'checking' | 'on' | 'retry' }
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
      if (!out.ok && out.failure === 'outcomeUnknown') {
        // The fixed 500 (contract section 8): a landed commit revokes this session, a lost one
        // leaves the cookie valid. Either way end this session as after a 204, plus POST
        // /auth/logout so a silent refresh cannot bring it back. A 401 after this is expected and
        // starts no refresh (refreshes are blocked from here until the next sign-in).
        if (stamp.generation !== getGeneration() || stamp.userId !== getSessionUserId()) {
          onClose();
          return 'ok';
        }
        await signOutRevoked({ confirmWithLogout: true });
        return 'ok';
      }
      if (!out.ok) return fail(out.failure);
      // Another tab signed in as someone else (or this tab already signed out) while the call
      // was in flight: that session is not ours to end. Just close.
      if (stamp.generation !== getGeneration() || stamp.userId !== getSessionUserId()) {
        onClose();
        return 'ok';
      }
      // The server revoked every session of this user, this one included: no refresh, no logout.
      await signOutRevoked();
      return 'ok';
    }
    const out = await regenerateRecoveryCodes(values.currentPassword);
    if (!out.ok) return fail(out.failure);
    // totpEnabled does not change here, so there is nothing to re-read.
    setStage({ kind: 'codes', codes: out.data.recoveryCodes });
    return 'ok';
  }

  /**
   * Set-up turned 2FA on: re-read the session user (it carries `totpEnabled`) through the shared
   * silent-refresh guard. Only runs after the recovery codes were acknowledged (Done): a failing
   * refresh signs the user out and would unmount the one-time codes. Never runs for another user.
   */
  function refreshStatus(): void {
    void refreshForReplay(stamp);
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
    if (out.failure === 'outcomeUnknown') {
      // The fixed 500: 2FA may or may not be on now. Never confirm again with this code.
      void checkSetupOutcome();
      return 'failed';
    }
    setFailure(out.failure);
    return 'failed';
  }

  /**
   * Finds out whether set-up landed, with the password this dialog still holds (setup/start answers
   * 409 when 2FA is already on; until `totpEnabled` ships that is the only read). On: the codes in
   * the lost answer are gone, so offer new ones. Off: set-up starts again with a new QR code.
   */
  async function checkSetupOutcome(): Promise<void> {
    setFailure(null);
    setStage({ kind: 'unconfirmed', state: 'checking' });
    const out = await startSetup(password);
    if (out.ok) {
      if (!out.data.qrDataUrl.startsWith('data:image/png;base64,')) {
        setStage({ kind: 'unconfirmed', state: 'retry' });
        return;
      }
      setStage({
        kind: 'confirm',
        manualKey: out.data.manualKey,
        qr: out.data.qrDataUrl,
        restarted: true,
      });
      return;
    }
    if (out.failure === 'conflict') {
      setStage({ kind: 'unconfirmed', state: 'on' });
      return;
    }
    if (out.failure === 'password') {
      setPassword('');
      setStage({ kind: 'password', passwordWrong: true });
      return;
    }
    setFailure(out.failure);
    setStage({ kind: 'unconfirmed', state: 'retry' });
  }

  /** 2FA is on but the one-time codes were lost: issue a new set (the old ones stop working). */
  async function regenerateAfterUnknown(): Promise<void> {
    setFailure(null);
    const out = await regenerateRecoveryCodes(password);
    if (out.ok) {
      setPassword('');
      setStage({ kind: 'codes', codes: out.data.recoveryCodes });
      return;
    }
    if (out.failure === 'password') {
      setPassword('');
      setStage({ kind: 'password', passwordWrong: true });
      return;
    }
    setFailure(out.failure);
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
              restarted={stage.restarted === true}
              onSubmit={onCode}
              onCancel={onClose}
            />
          </>
        ) : null}
        {stage.kind === 'unconfirmed' ? (
          <>
            <DialogTitle>We could not confirm the result</DialogTitle>
            <DialogDescription>
              The server did not say whether two-factor sign-in was turned on. We did not send the
              code again.
            </DialogDescription>
            <UnconfirmedStep
              state={stage.state}
              failure={failure}
              onCheck={checkSetupOutcome}
              onRegenerate={regenerateAfterUnknown}
              onCancel={onClose}
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
                if (action === 'setup') refreshStatus();
                onDone(action === 'setup' ? 'enabled' : 'regenerated');
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
}: {
  submitLabel: string;
  destructive: boolean;
  /** Disable also asks for the 6-digit authenticator code. */
  withCode: boolean;
  initialWrong: boolean;
  failure: Failure | null;
  onSubmit: (values: PasswordFormValues) => Promise<'wrong' | 'invalid' | 'failed' | 'ok'>;
  onCancel: () => void;
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
          Cancel
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

function UnconfirmedStep({
  state,
  failure,
  onCheck,
  onRegenerate,
  onCancel,
}: {
  state: 'checking' | 'on' | 'retry';
  failure: Failure | null;
  onCheck: () => Promise<void>;
  onRegenerate: () => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="mt-4 space-y-4" data-testid="setup-unconfirmed">
      <FailureAlert failure={failure} />
      {state === 'checking' ? (
        <p role="status" className="text-sm">
          Checking whether two-factor sign-in is on…
        </p>
      ) : null}
      {state === 'on' ? (
        <Alert tone="warning" role="status" title="Two-factor sign-in is on">
          Set-up appears to have gone through, but your recovery codes did not reach you. Get a new
          set now. Your authenticator app already works, and nothing needs to be scanned again.
        </Alert>
      ) : null}
      {state === 'retry' ? (
        <Alert tone="warning" role="status" title="We could not check yet">
          Check your connection, then check again. Do not enter the same code again.
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Close
        </Button>
        {state === 'on' ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onRegenerate().finally(() => setBusy(false));
            }}
          >
            Get new recovery codes
          </Button>
        ) : null}
        {state === 'retry' ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onCheck().finally(() => setBusy(false));
            }}
          >
            Check again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ConfirmStep({
  manualKey,
  qr,
  failure,
  restarted,
  onSubmit,
  onCancel,
}: {
  manualKey: string;
  qr: string;
  failure: Failure | null;
  /** Set-up was started again after an unconfirmed answer: the old QR code and code are void. */
  restarted: boolean;
  onSubmit: (values: CodeFormValues) => Promise<'ok' | 'wrongCode' | 'failed'>;
  onCancel: () => void;
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
      {restarted ? (
        <Alert tone="info" role="status" title="Set-up is not on, so we started it again">
          Scan this new QR code (remove the old entry from your app) and enter a fresh code. The old
          code cannot be used.
        </Alert>
      ) : null}
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
          Cancel
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
