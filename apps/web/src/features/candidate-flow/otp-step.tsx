'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { candidateApi } from './api';
import { terminalForConflict } from './problems';
import { getInvitationToken } from './session-store';
import { StepFrame, useCountdown } from './step-frame';
import type { Terminal } from './terminal-screens';
import { otpFormSchema, type OtpFormInput, type OtpFormValues } from './schemas';
import { OTP_RESEND_SECONDS, type CodeSentInfo } from './welcome-step';
import type { SessionTokenResponse } from './wire';

/** Plain-language messages. Each one says what to do next (FR-106, TC-007, TC-097). */
export const OTP_MESSAGES = {
  invalid:
    'That code is not right. Check the newest email we sent, type all 6 digits, and try again. Several wrong tries in a row pause this link for 30 minutes.',
  expired:
    'That code has expired, or no code was requested. Codes last 10 minutes. Press "Send a new code" and use the newest email.',
  network: 'We could not reach the service. Check your internet connection and try again.',
  server: 'The service had a problem. Wait a minute and try again.',
  resent: 'A new code is on its way. Use the newest email: older codes stop working.',
} as const;

/** FR-106 email OTP. The code is never stored, logged or put in a URL (ADR 0003). */
export function OtpStep({
  sent,
  windowStart,
  onVerified,
  onTerminal,
}: {
  sent: CodeSentInfo;
  windowStart: string;
  onVerified: (session: SessionTokenResponse) => void;
  onTerminal: (terminal: Terminal) => void;
}): React.JSX.Element {
  const [maskedEmail, setMaskedEmail] = React.useState(sent.maskedEmail);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [verifyError, setVerifyError] = React.useState<keyof typeof OTP_MESSAGES | null>(null);
  // The wait is announced once, with its full length; only the visible countdown ticks (aria-hidden).
  const [waitTotal, setWaitTotal] = React.useState(0);
  const resend = useCountdown();
  const wait = useCountdown();
  const startResend = resend.start;
  React.useEffect(() => startResend(sent.cooldownSeconds), [startResend, sent.cooldownSeconds]);

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors },
  } = useForm<OtpFormInput, unknown, OtpFormValues>({
    resolver: zodResolver(otpFormSchema),
    defaultValues: { otp: '' },
  });

  const verify = useMutation({
    mutationFn: async (values: OtpFormValues) => {
      const token = getInvitationToken();
      if (token === null) return { ok: false, kind: 'network' } as const;
      return candidateApi.startSession(token, values.otp);
    },
    onSuccess: (result) => {
      if (result.ok) {
        reset({ otp: '' });
        onVerified(result.data);
        return;
      }
      reset({ otp: '' });
      setNotice(null);
      setVerifyError(
        result.kind !== 'problem'
          ? 'network'
          : result.code === 'OTP_NOT_REQUESTED'
            ? 'expired'
            : result.status === 400
              ? 'invalid'
              : result.status >= 500
                ? 'server'
                : null,
      );
      if (result.kind === 'problem') {
        if (result.status === 429 && result.code === 'LINK_BLOCKED') {
          onTerminal({ reason: 'BLOCKED', retryAfterSeconds: result.retryAfterSeconds });
          return;
        }
        if (result.status === 429) {
          const seconds = result.retryAfterSeconds ?? OTP_RESEND_SECONDS;
          setWaitTotal(seconds);
          wait.start(seconds);
        }
        if (result.status === 409) onTerminal(terminalForConflict(result.code, windowStart));
        if (result.status === 404) onTerminal({ reason: 'INVALID' });
      }
      window.setTimeout(() => setFocus('otp'), 0);
    },
  });

  const sendAgain = useMutation({
    mutationFn: async () => {
      const token = getInvitationToken();
      if (token === null) return { ok: false, kind: 'network' } as const;
      return candidateApi.sendOtp(token);
    },
    onSuccess: (result) => {
      if (result.ok) {
        if (result.data.state === 'OTP_SENT') {
          setMaskedEmail(result.data.maskedEmail);
          setNotice(OTP_MESSAGES.resent);
          resend.start(OTP_RESEND_SECONDS);
        } else if (result.data.state !== 'OTP_REQUIRED') {
          onTerminal({
            reason: result.data.state,
            contact: result.data.declineContact,
            retryAfterSeconds: result.data.retryAfterSeconds,
            windowStart,
          });
        }
      } else if (result.kind === 'problem' && result.status === 429) {
        if (result.code === 'LINK_BLOCKED') {
          onTerminal({ reason: 'BLOCKED', retryAfterSeconds: result.retryAfterSeconds });
        } else {
          resend.start(result.retryAfterSeconds ?? OTP_RESEND_SECONDS);
        }
      }
    },
  });

  const errorMessage = verifyError ? OTP_MESSAGES[verifyError] : null;
  const waiting = wait.secondsLeft > 0;

  return (
    <StepFrame
      title="Enter your one-time code"
      intro={
        maskedEmail
          ? `We emailed a 6-digit code to ${maskedEmail}. It can take a minute to arrive. Check your spam folder too.`
          : 'We emailed you a 6-digit code. It can take a minute to arrive. Check your spam folder too.'
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          setVerifyError(null);
          // The mutation keeps its variables (the code) until reset, so reset as soon as it settles.
          void handleSubmit((values) => verify.mutate(values, { onSettled: () => verify.reset() }))(
            e,
          );
        }}
        className="space-y-4"
      >
        <div aria-live="polite" role="status" className="space-y-3 empty:hidden">
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          {errorMessage ? <Alert tone="error">{errorMessage}</Alert> : null}
          {waitTotal > 0 ? (
            <Alert tone="warning">
              {waiting
                ? `Please wait ${waitTotal} seconds before trying again. You can still use the same code if it has not expired.`
                : 'You can try again now.'}
              {waiting ? (
                <span aria-hidden="true" className="ml-2 font-medium">
                  ({wait.secondsLeft} s left)
                </span>
              ) : null}
            </Alert>
          ) : null}
        </div>
        <Field
          id="otp"
          label="6-digit code"
          hint="Type the digits only, for example 123456."
          error={errors.otp?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              {...register('otp')}
              className="h-12 max-w-48 text-center text-xl tracking-widest"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              spellCheck={false}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            size="lg"
            className="min-h-11"
            disabled={verify.isPending || waiting}
          >
            {verify.isPending ? 'Checking...' : 'Check code'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-11"
            disabled={sendAgain.isPending || resend.secondsLeft > 0}
            onClick={() => sendAgain.mutate()}
          >
            {resend.secondsLeft > 0
              ? `Send a new code (wait ${resend.secondsLeft} s)`
              : 'Send a new code'}
          </Button>
        </div>
      </form>
    </StepFrame>
  );
}
