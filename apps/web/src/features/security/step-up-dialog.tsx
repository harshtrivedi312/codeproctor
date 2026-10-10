'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { reauthBodySchema, REAUTH_FAILED_MESSAGE, type ReauthBodyValues } from './schemas';

/*
 * The shared "Confirm with your password" step for password-protected admin actions (FR-102,
 * docs/api-contract.md sections 1 and 6). The password lives only in this form's state: it is
 * cleared after every attempt (success, wrong password, any error) and is gone when the dialog
 * closes. It is handed to `onRun` and nowhere else: never logged, never in the query cache (the
 * callers send it with a plain function, not a mutation, whose variables the cache would keep),
 * never in a URL. A wrong password (403 REAUTH_FAILED) is reported inline and the dialog stays
 * open: it never signs the user out and never refreshes.
 */

export type StepUpOutcome =
  /** The action succeeded: the dialog closes. */
  | { kind: 'done' }
  /** 403 REAUTH_FAILED: wrong or locked, one answer for both. Shown on the password field. */
  | { kind: 'wrong' }
  /** Anything else: said in words with a fix-it hint, the dialog stays open. */
  | { kind: 'failed'; title: string; hint: string; tone?: 'error' | 'warning' };

export type StepUpRun = (currentPassword: string) => Promise<StepUpOutcome>;

/** The password field and buttons. Rendered inside a DialogContent by the caller. */
export function StepUpForm({
  submitLabel,
  destructive = false,
  onRun,
  onDone,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  submitLabel: string;
  destructive?: boolean;
  onRun: StepUpRun;
  onDone: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}): React.JSX.Element {
  const [failure, setFailure] = React.useState<Extract<StepUpOutcome, { kind: 'failed' }> | null>(
    null,
  );
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<ReauthBodyValues>({
    resolver: zodResolver(reauthBodySchema),
    defaultValues: { currentPassword: '' },
  });

  async function submit(values: ReauthBodyValues): Promise<void> {
    setFailure(null);
    const out = await onRun(values.currentPassword);
    // Never keep the password in the field after an attempt, whatever the answer was.
    setValue('currentPassword', '');
    if (out.kind === 'done') {
      onDone();
      return;
    }
    if (out.kind === 'wrong') setError('currentPassword', { message: REAUTH_FAILED_MESSAGE });
    else setFailure(out);
    setFocus('currentPassword');
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(submit)(e)}
      noValidate
      className="mt-4 space-y-4"
      data-testid="step-up-form"
    >
      {failure ? (
        <Alert tone={failure.tone ?? 'error'} role="alert" title={failure.title}>
          {failure.hint}
        </Alert>
      ) : null}
      <Field
        id="step-up-password"
        label="Your password"
        hint="The password you sign in with. We ask again so a stolen session cannot change accounts."
        error={errors.currentPassword?.message}
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            autoComplete="current-password"
            {...register('currentPassword')}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={isSubmitting} onClick={onCancel}>
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

/** A confirmation (title and description say what will happen) that also asks for the password. */
export function StepUpDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  destructive,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  submitLabel: string;
  destructive?: boolean;
  onRun: StepUpRun;
}): React.JSX.Element {
  // While a call is in flight the dialog cannot be dismissed: the answer must be seen.
  const [busy, setBusy] = React.useState(false);
  const run: StepUpRun = async (password) => {
    setBusy(true);
    try {
      return await onRun(password);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription asChild>
          <div>{description}</div>
        </DialogDescription>
        <StepUpForm
          submitLabel={submitLabel}
          destructive={destructive ?? false}
          onRun={run}
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
