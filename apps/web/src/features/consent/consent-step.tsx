'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { candidateApi } from '@/features/candidate-flow/api';
import { ErrorSummary, type SummaryItem } from '@/features/candidate-flow/error-summary';
import { StepFrame } from '@/features/candidate-flow/step-frame';
import { RetentionLink, type Terminal } from '@/features/candidate-flow/terminal-screens';
import { ConsentMarkdown } from './consent-markdown';
import { evaluateConsentDocument } from './placeholder-guard';
import { consentFormSchema, type ConsentFormValues } from './schemas';
import { useScrolledToEnd } from './use-scrolled-to-end';

/**
 * FR-401 consent step (D-17, C-09, C-30; TC-030, TC-095, TC-096).
 *
 * Nothing on this screen touches the camera, microphone or screen. The document is shown only if
 * the placeholder guard passes. Signing needs: the end of the document seen, a typed legal name and
 * the 18+ confirmation. The consent text id (its version) is sent with the signature, and the
 * server sets the time.
 */
export function ConsentStep({
  onSigned,
  onDeclined,
  onSessionEnded,
}: {
  onSigned: () => void;
  onDeclined: (terminal: Terminal) => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ['candidate', 'consent'],
    queryFn: () => candidateApi.getConsent(),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const result = query.data;

  // A document signed earlier in this session (reload after signing): no second signature.
  const alreadySigned = result?.ok === true && result.data.signed;
  React.useEffect(() => {
    if (alreadySigned) onSigned();
  }, [alreadySigned, onSigned]);

  React.useEffect(() => {
    if (result && !result.ok && result.kind === 'problem' && result.status === 401)
      onSessionEnded();
  }, [result, onSessionEnded]);

  if (query.isPending) {
    return (
      <StepFrame title="Your consent">
        <p role="status">Loading the consent document...</p>
      </StepFrame>
    );
  }
  if (!result || !result.ok) {
    return (
      <StepFrame title="We could not load the consent document">
        <Alert tone="error" role="alert">
          Check your internet connection and press &quot;Try again&quot;. Nothing has been recorded.
        </Alert>
        <Button size="lg" className="min-h-11" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </StepFrame>
    );
  }
  if (result.data.signed) {
    return (
      <StepFrame title="Your consent">
        <p role="status">You already signed. Taking you to the next step...</p>
      </StepFrame>
    );
  }
  const guard = evaluateConsentDocument(result.data);
  if (!guard.ok) {
    return <ConsentUnavailable onRetry={() => void query.refetch()} />;
  }
  return (
    <ConsentForm
      document={result.data}
      onSigned={onSigned}
      onDeclined={onDeclined}
      onSessionEnded={onSessionEnded}
    />
  );
}

/** Placeholder guard outcome: no accept control, no document text. */
export function ConsentUnavailable({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <StepFrame title="The consent document is not available yet">
      <div data-testid="consent-unavailable" className="space-y-3">
        <Alert tone="warning">
          We cannot show the consent document for signing right now. This is a problem on our side,
          not yours. Nothing has been recorded, and your camera, microphone and screen have not been
          used.
        </Alert>
        <p>What you can do:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>Wait a few minutes, then press &quot;Check again&quot;.</li>
          <li>
            If it keeps happening, contact the person who invited you and tell them the consent
            document is unavailable.
          </li>
        </ul>
        <p>
          <RetentionLink />
        </p>
      </div>
      <Button size="lg" className="min-h-11" variant="outline" onClick={onRetry}>
        Check again
      </Button>
    </StepFrame>
  );
}

function ConsentForm({
  document: doc,
  onSigned,
  onDeclined,
  onSessionEnded,
}: {
  document: { consentTextId: string; version: string; bodyMd: string };
  onSigned: () => void;
  onDeclined: (terminal: Terminal) => void;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const { containerRef, endMarkerRef, reachedEnd } = useScrolledToEnd();
  const [signed, setSigned] = React.useState(false);
  const [confirmingDecline, setConfirmingDecline] = React.useState(false);
  const [summaryFocus, setSummaryFocus] = React.useState(0);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const declineRef = React.useRef<HTMLDivElement>(null);
  const continueRef = React.useRef<HTMLButtonElement>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ConsentFormValues>({
    resolver: zodResolver(consentFormSchema),
    defaultValues: { signedName: '', confirmedAge18: false },
  });

  React.useEffect(() => {
    if (summaryFocus > 0) summaryRef.current?.focus();
  }, [summaryFocus]);
  React.useEffect(() => {
    if (confirmingDecline) declineRef.current?.focus();
  }, [confirmingDecline]);
  React.useEffect(() => {
    if (signed) continueRef.current?.focus();
  }, [signed]);

  const sign = useMutation({
    mutationFn: (values: ConsentFormValues) =>
      candidateApi.signConsent({
        consentTextId: doc.consentTextId,
        signedName: values.signedName,
        confirmedAge18: true,
      }),
    onSuccess: (result) => {
      if (result.ok) setSigned(true);
      else if (result.kind === 'problem' && result.status === 401) onSessionEnded();
    },
  });

  const decline = useMutation({
    mutationFn: () => candidateApi.declineConsent(),
    onSuccess: (result) => {
      if (result.ok) onDeclined({ reason: 'DECLINED', contact: result.data.declineContact });
      else if (result.kind === 'problem' && result.status === 401) onSessionEnded();
    },
  });

  const summaryItems: SummaryItem[] = [];
  if (errors.signedName?.message)
    summaryItems.push({ fieldId: 'signed-name', message: errors.signedName.message });
  if (errors.confirmedAge18?.message)
    summaryItems.push({ fieldId: 'age-18', message: errors.confirmedAge18.message });

  const signResult = sign.data;
  let signProblem: string | null = null;
  if (sign.isError || (signResult && !signResult.ok && signResult.kind !== 'problem')) {
    signProblem =
      'We could not save your signature. Check your internet connection and press "I agree and sign" again.';
  } else if (signResult && !signResult.ok && signResult.kind === 'problem') {
    signProblem =
      signResult.status === 409
        ? 'This document changed or was already signed. Reload this page to see the latest version.'
        : signResult.status === 400
          ? 'We could not accept the signature. Check your name and the age confirmation, then try again.'
          : signResult.status === 401
            ? null
            : 'The service had a problem saving your signature. Wait a minute and try again.';
  }
  const declineFailed =
    decline.isError ||
    (decline.data !== undefined && !decline.data.ok && decline.data.kind !== 'problem')
      ? 'We could not record your choice. Check your internet connection and try again.'
      : decline.data && !decline.data.ok
        ? 'The service had a problem. Wait a minute and try again.'
        : null;

  if (signed) {
    return (
      <StepFrame title="Thank you, your consent is recorded">
        <Alert tone="success" role="status">
          A copy has been emailed to you. Keep it for your records.
        </Alert>
        <p>
          Next we check that your browser, camera, microphone and screen sharing work. Your camera
          and microphone are still off.
        </p>
        <Button ref={continueRef} size="lg" className="min-h-11" onClick={onSigned}>
          Continue to the system check
        </Button>
      </StepFrame>
    );
  }

  return (
    <StepFrame
      title="Please read and sign the consent document"
      intro="Read the whole document. Your camera, microphone and screen are not used, and nothing is recorded, until you sign."
    >
      <p className="text-sm text-muted-foreground">
        Document version <span data-testid="consent-version">{doc.version}</span>
      </p>
      <div
        ref={containerRef}
        role="region"
        aria-label={`Consent document, version ${doc.version}. Scrollable.`}
        // A scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        data-testid="consent-scroll"
        className="max-h-[55vh] overflow-y-auto rounded-md border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ConsentMarkdown>{doc.bodyMd}</ConsentMarkdown>
        <div ref={endMarkerRef} className="mt-6 border-t pt-2 text-sm font-medium">
          End of the document
        </div>
      </div>
      <p role="status" data-testid="scroll-status" className="text-sm">
        {reachedEnd
          ? 'You have reached the end. You can now type your name and sign.'
          : 'Scroll to the end of the document to unlock signing. With a keyboard: press Tab to the document, then use the arrow keys, Page Down or End.'}
      </p>

      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) =>
          void handleSubmit(
            (values) => sign.mutate(values),
            () => setSummaryFocus((n) => n + 1),
          )(e)
        }
      >
        <ErrorSummary ref={summaryRef} items={summaryItems} />
        {signProblem ? (
          <Alert tone="error" role="alert">
            {signProblem}
          </Alert>
        ) : null}
        <Field
          id="signed-name"
          label="Your full legal name"
          hint="Type your name as it appears on your ID. This is your signature."
          error={errors.signedName?.message}
        >
          {(aria) => (
            <Input
              {...aria}
              {...register('signedName')}
              className="h-11 max-w-md"
              autoComplete="name"
              disabled={!reachedEnd}
            />
          )}
        </Field>
        <div className="space-y-1.5">
          <label htmlFor="age-18" className="flex min-h-11 items-center gap-3 text-sm font-medium">
            <input
              id="age-18"
              type="checkbox"
              className="h-6 w-6 shrink-0"
              aria-invalid={errors.confirmedAge18 ? true : undefined}
              aria-describedby={errors.confirmedAge18 ? 'age-18-error' : undefined}
              disabled={!reachedEnd}
              {...register('confirmedAge18')}
            />
            <span>I confirm that I am 18 years old or older (required)</span>
          </label>
          {errors.confirmedAge18?.message ? (
            <p id="age-18-error" className="text-sm text-destructive">
              {errors.confirmedAge18.message}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            size="lg"
            className="min-h-11"
            disabled={!reachedEnd || sign.isPending}
          >
            {sign.isPending ? 'Saving your signature...' : 'I agree and sign'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-11"
            aria-expanded={confirmingDecline}
            onClick={() => setConfirmingDecline(true)}
          >
            I decline
          </Button>
        </div>
      </form>

      {confirmingDecline ? (
        <div
          ref={declineRef}
          tabIndex={-1}
          role="group"
          aria-labelledby="decline-title"
          className="space-y-3 rounded-md border p-4"
        >
          <h2 id="decline-title" className="font-semibold">
            Decline and end this assessment?
          </h2>
          <p className="text-sm">
            Nothing will be recorded and the assessment will end. You will see your recruiter&apos;s
            contact so you can ask about an alternative or an accommodation.
          </p>
          {declineFailed ? (
            <Alert tone="error" role="alert">
              {declineFailed}
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              className="min-h-11"
              variant="destructive"
              disabled={decline.isPending}
              onClick={() => decline.mutate()}
            >
              {decline.isPending ? 'Ending...' : 'Yes, decline'}
            </Button>
            <Button
              size="lg"
              className="min-h-11"
              variant="outline"
              onClick={() => setConfirmingDecline(false)}
            >
              No, go back to the document
            </Button>
          </div>
        </div>
      ) : null}
    </StepFrame>
  );
}
