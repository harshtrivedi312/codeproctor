'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Download, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/features/auth/auth-provider';
import { useTests } from '@/features/tests/queries';
import {
  EXAMPLE_CSV,
  FATAL_MESSAGE,
  MAX_CSV_BYTES,
  errorReportCsv,
  unsentRowsCsv,
  looksLikeFormula,
  parseInviteCsv,
  type CsvParse,
} from './csv';
import { getGeneration } from '@/lib/auth-session';
import {
  InviteFailure,
  invalidateAfterInvite,
  inviteInChunks,
  useInvite,
  type BulkOutcome,
} from './queries';
import {
  ACCOMMODATION_DETECTORS,
  BIOMETRIC_REFUSAL_OFFERED,
  DETECTOR_LABEL,
  MAX_EXTRA_TIME_PCT,
  MAX_NOTES,
  WAIVER_REASONS,
  WAIVER_REASON_LABEL,
  inviteSchema,
  toAccommodations,
  toIso,
  type InviteFormValues,
} from './schemas';

/** A `datetime-local` value (the browser's local time) for a date. */
const local = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function defaults(testId: string): InviteFormValues {
  const start = new Date();
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return {
    testId,
    mode: 'one',
    name: '',
    email: '',
    windowStart: local(start),
    windowEnd: local(end),
    extraTime: '',
    disabledDetectors: [],
    toolsText: '',
    notes: '',
    waiver: false,
    waiverReason: '',
    waiverNote: '',
  };
}

export interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The test is fixed (opened from a test page); without it the dialog asks which test. */
  testId?: string;
  /** Offer the "refuses biometric processing" reason (ADR 0015 section 7; off until the consent variant ships). */
  refusalReasonOffered?: boolean;
}

/**
 * Invite one candidate, or many from a CSV (FR-303, FR-304, FR-305, TC-023, TC-024). WEB-ONLY and
 * provisional [BE-06b]. Candidate data lives in this component's state only: it is dropped when the
 * dialog closes and when another person signs in (the body is keyed by the user id and role).
 */
export function InviteDialog(props: InviteDialogProps): React.JSX.Element {
  const { user, role } = useAuth();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto">
        {props.open ? (
          <InviteBody key={`${user?.id ?? 'none'}:${role ?? 'none'}`} {...props} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InviteBody({
  onOpenChange,
  testId,
  refusalReasonOffered = BIOMETRIC_REFUSAL_OFFERED,
}: InviteDialogProps): React.JSX.Element {
  const qc = useQueryClient();
  const tests = useTests();
  const invite = useInvite();
  const schema = React.useMemo(
    () => inviteSchema(() => new Date(), testId !== undefined),
    [testId],
  );
  const form = useForm<InviteFormValues>({
    defaultValues: defaults(testId ?? ''),
    resolver: zodResolver(schema),
    mode: 'onSubmit',
  });
  const { errors, isSubmitting } = form.formState;
  const mode = useWatch({ control: form.control, name: 'mode' });
  const waiver = useWatch({ control: form.control, name: 'waiver' });
  const reason = useWatch({ control: form.control, name: 'waiverReason' });
  const detectors = useWatch({ control: form.control, name: 'disabledDetectors' });
  const faceLocked = waiver && reason === 'REFUSED_BIOMETRIC_PROCESSING';

  const [csv, setCsv] = React.useState<{ fileName: string; parse: CsvParse } | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [outcome, setOutcome] = React.useState<BulkOutcome | null>(null);
  const stop = React.useRef({ aborted: false });
  React.useEffect(() => {
    const flag = stop.current;
    // React strict mode runs setup, cleanup, setup again: the flag must be reset on every setup.
    flag.aborted = false;
    return () => {
      flag.aborted = true;
    };
  }, []);

  const describe = (e: unknown): string => {
    if (e instanceof InviteFailure) {
      if (e.status === 400)
        return (
          [e.message, ...e.errors].filter(Boolean).join(' ') ||
          'The server did not accept this invitation. Check the fields.'
        );
      if (e.status === 404)
        return 'This test no longer exists. Close this window and pick another test.';
      if (e.status === 409)
        return 'This candidate already has an open invitation to this test. Wait until it is used or expires, or invite them to another test.';
      if (e.status === 422 && e.code === 'REASON_NOT_ENABLED') {
        return 'This reason is not available yet in this build. Choose another reason.';
      }
      if (e.status === 422) return 'The window has already closed. Choose a later end.';
      if (e.status === 429) {
        const mins = e.retryAfterSeconds ? Math.ceil(e.retryAfterSeconds / 60) : null;
        return `You have sent a lot of invitations this hour. Nothing was sent. Try again ${mins ? `in about ${mins} minute${mins === 1 ? '' : 's'}` : 'later'}.`;
      }
      if (e.status === 403)
        return 'Your role cannot send invitations. Ask a Super Admin if you think this is a mistake.';
      if (e.status === 401)
        return 'Your session ended before this could be sent. Sign in again; nothing was sent.';
    }
    return 'We could not reach the server, so nothing was sent. Check your connection and try again.';
  };

  async function onFile(file: File | undefined): Promise<void> {
    setCsv(null);
    setFileError(null);
    setOutcome(null);
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      setFileError(FATAL_MESSAGE['too-large']);
      return;
    }
    const parse = parseInviteCsv(await file.text());
    if (parse.fatal) setFileError(FATAL_MESSAGE[parse.fatal]);
    else setCsv({ fileName: file.name, parse });
  }

  async function onValid(v: InviteFormValues): Promise<void> {
    setProblem(null);
    const test = v.testId || testId || '';
    const window = { windowStart: toIso(v.windowStart), windowEnd: toIso(v.windowEnd) };
    if (v.mode === 'one') {
      try {
        const accommodations = toAccommodations(v);
        await invite.mutateAsync({
          testId: test,
          body: {
            candidate: { email: v.email.trim(), name: v.name.trim() },
            ...window,
            ...(accommodations ? { accommodations } : {}),
          },
        });
        toast.success('Invitation created. The candidate gets an email with a personal link.');
        onOpenChange(false);
      } catch (e) {
        setProblem(describe(e));
      }
      return;
    }
    if (!csv || csv.parse.valid.length === 0) {
      setFileError(
        csv
          ? 'There is no valid row to invite. Fix the file and choose it again.'
          : 'Choose a CSV file first.',
      );
      return;
    }
    setProgress(0);
    const startedIn = getGeneration();
    const result = await inviteInChunks(test, csv.parse.valid, window, setProgress, stop.current);
    setProgress(null);
    setOutcome(result);
    // Whatever was created, the candidate list and the test (now in use) are stale.
    if (result.created > 0 || result.uncertain > 0) invalidateAfterInvite(qc, test, startedIn);
  }

  const problems = csv?.parse.problems ?? [];
  const hasValidRows = (csv?.parse.valid.length ?? 0) > 0;

  function downloadProblems(): void {
    const rows = [
      ...problems,
      ...(outcome?.errors ?? []).map((e) => ({
        row: e.row,
        message: e.message,
        email: '',
        name: '',
      })),
    ];
    const blob = new Blob([errorReportCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rows-not-invited.csv';
    a.click();
    // Revoke later: some browsers start the download after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function downloadUnsent(): void {
    const blob = new Blob([unsentRowsCsv(outcome?.unsentRows ?? [])], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rows-not-sent.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <>
      <DialogTitle>Invite candidates</DialogTitle>
      <DialogDescription>
        Each candidate gets an email with a personal link. It opens the test until they start it,
        inside the window you choose.
      </DialogDescription>
      <form
        onSubmit={(e) => {
          e.stopPropagation();
          void form.handleSubmit(onValid)(e);
        }}
        noValidate
        className="mt-4 space-y-4"
      >
        {problem ? (
          <Alert tone="error" role="alert" title="That did not work">
            {problem}
          </Alert>
        ) : null}

        {testId === undefined ? (
          <Field id="invite-test" label="Test" error={errors.testId?.message}>
            {(aria) => (
              <Select {...aria} className="w-full" {...form.register('testId')}>
                <option value="">Choose a test</option>
                {(tests.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Who</legend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" value="one" className="size-4" {...form.register('mode')} />
              One candidate
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" value="many" className="size-4" {...form.register('mode')} />
              Several, from a CSV file
            </label>
          </div>
        </fieldset>

        {mode === 'one' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field id="invite-name" label="Candidate name" error={errors.name?.message}>
              {(aria) => <Input {...aria} autoComplete="off" {...form.register('name')} />}
            </Field>
            <Field id="invite-email" label="Candidate email" error={errors.email?.message}>
              {(aria) => (
                <Input {...aria} type="email" autoComplete="off" {...form.register('email')} />
              )}
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <Field
              id="invite-csv"
              label="CSV file"
              hint={
                <>
                  The first line names the columns: <code>email</code> and <code>name</code> (and
                  optionally <code>external_ref</code>). Up to 10,000 rows and 1 MB. The file is
                  read in your browser; only valid rows are sent.{' '}
                  <a
                    className="text-primary underline underline-offset-4"
                    href={`data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE_CSV)}`}
                    download="candidates-example.csv"
                  >
                    Download an example
                  </a>
                </>
              }
              error={fileError ?? undefined}
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
              )}
            </Field>
            <Alert tone="info">
              Accommodations are set per candidate. To give one candidate extra time or another
              accommodation, invite them on their own.
            </Alert>
            {csv ? (
              <section aria-labelledby="csv-preview" className="space-y-2">
                <h3 id="csv-preview" className="text-sm font-medium">
                  Preview of {csv.fileName}
                </h3>
                <p className="text-sm" data-testid="csv-summary">
                  {csv.parse.total} row{csv.parse.total === 1 ? '' : 's'}: {csv.parse.valid.length}{' '}
                  can be invited
                  {problems.length > 0 ? `, ${problems.length} cannot` : ''}. Rows with a problem
                  are skipped.
                </p>
                {csv.parse.formulaLike.length > 0 ? (
                  <Alert tone="warning" role="status">
                    Row{csv.parse.formulaLike.length === 1 ? '' : 's'}{' '}
                    {csv.parse.formulaLike.slice(0, 10).join(', ')}
                    {csv.parse.formulaLike.length > 10 ? ' and more' : ''} start
                    {csv.parse.formulaLike.length === 1 ? 's' : ''} with =, +, - or @. They are kept
                    as plain text and never run as spreadsheet formulas.
                  </Alert>
                ) : null}
                <div className="max-h-56 overflow-auto rounded-md border">
                  <table className="w-full border-collapse text-left text-sm">
                    <caption className="sr-only">Rows of the CSV file</caption>
                    <thead className="sticky top-0 border-b bg-muted/60">
                      <tr>
                        <th scope="col" className="px-3 py-1.5">
                          Row
                        </th>
                        <th scope="col" className="px-3 py-1.5">
                          Name
                        </th>
                        <th scope="col" className="px-3 py-1.5">
                          Email
                        </th>
                        <th scope="col" className="px-3 py-1.5">
                          Result
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ...csv.parse.valid
                          .slice(0, 50)
                          .map((r) => ({ row: r.row, name: r.name, email: r.email, message: '' })),
                        ...problems.slice(0, 50),
                      ]
                        .sort((a, b) => a.row - b.row)
                        .map((r) => (
                          <tr key={r.row} className="border-b last:border-0">
                            <td className="px-3 py-1.5">{r.row}</td>
                            <td className="px-3 py-1.5">
                              <Cell value={r.name} />
                            </td>
                            <td className="px-3 py-1.5">
                              <Cell value={r.email} />
                            </td>
                            <td className="px-3 py-1.5">
                              {r.message === '' ? 'Will be invited' : r.message}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {csv.parse.valid.length > 50 || problems.length > 50 ? (
                  <p className="text-sm text-muted-foreground">
                    Showing the first 50 valid rows and the first 50 problems.
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <Field id="invite-start" label="Window opens" error={errors.windowStart?.message}>
            {(aria) => <Input {...aria} type="datetime-local" {...form.register('windowStart')} />}
          </Field>
          <Field
            id="invite-end"
            label="Window closes"
            hint="The link must be used to start the test before this time. A test that has started is not cut off by it."
            error={errors.windowEnd?.message}
          >
            {(aria) => <Input {...aria} type="datetime-local" {...form.register('windowEnd')} />}
          </Field>
        </div>

        {mode === 'one' ? (
          <section aria-labelledby="acc-heading" className="space-y-3 rounded-md border p-4">
            <div>
              <h3 id="acc-heading" className="font-medium">
                Accommodations (optional)
              </h3>
              <p className="text-sm text-muted-foreground">
                For this candidate only. Every change is recorded. Do not enter health details
                anywhere on this form.
              </p>
            </div>
            <Field
              id="acc-time"
              label="Extra time (%)"
              hint={`Scales the total time and every section limit by the same percentage. For example 50 turns 60 minutes into 90. From 0 to ${MAX_EXTRA_TIME_PCT}.`}
              error={errors.extraTime?.message}
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  min={0}
                  max={MAX_EXTRA_TIME_PCT}
                  className="max-w-32"
                  {...form.register('extraTime')}
                />
              )}
            </Field>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Detectors to switch off</legend>
              <p className="text-sm text-muted-foreground">
                A switched-off detector does not run for this candidate, so it records nothing.
              </p>
              {ACCOMMODATION_DETECTORS.map((d) => {
                const locked = faceLocked && (d === 'FACE' || d === 'GAZE');
                return (
                  <label key={d} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      checked={detectors.includes(d) || locked}
                      disabled={locked}
                      onChange={(e) =>
                        form.setValue(
                          'disabledDetectors',
                          e.target.checked ? [...detectors, d] : detectors.filter((x) => x !== d),
                          { shouldDirty: true },
                        )
                      }
                    />
                    <span>{DETECTOR_LABEL[d]}</span>
                  </label>
                );
              })}
            </fieldset>
            <Field
              id="acc-tools"
              label="Allowed assistive tools"
              hint="Comma separated, for example screen reader, magnifier. They are not flagged as software on the candidate's computer."
              error={errors.toolsText?.message}
            >
              {(aria) => <Input {...aria} {...form.register('toolsText')} />}
            </Field>
            <Field
              id="acc-notes"
              label="Notes"
              hint={`Up to ${MAX_NOTES} characters. Visible to staff who handle this invitation.`}
              error={errors.notes?.message}
            >
              {(aria) => <Textarea {...aria} className="min-h-16" {...form.register('notes')} />}
            </Field>

            <div className="space-y-2 rounded-md bg-muted/50 p-3">
              <label className="flex items-start gap-2 text-sm font-medium">
                <input type="checkbox" className="mt-1 size-4" {...form.register('waiver')} />
                <span>No face match / no identity check</span>
              </label>
              {waiver ? (
                <div className="space-y-3">
                  <Alert tone="warning" title="Before you do this">
                    The candidate will not be asked for an ID photo or a selfie, and no face is
                    matched. Reviewers will see “identity check waived” and the reason is recorded
                    with your name. Check the candidate’s ID on a video call before any hiring
                    decision; you can record that you did later.
                  </Alert>
                  <Field
                    id="waiver-reason"
                    label="Why is the identity check waived? (required)"
                    error={errors.waiverReason?.message}
                  >
                    {(aria) => (
                      <Select {...aria} className="w-full" {...form.register('waiverReason')}>
                        <option value="">Choose a reason</option>
                        {WAIVER_REASONS.map((r) => {
                          const unavailable =
                            r === 'REFUSED_BIOMETRIC_PROCESSING' && !refusalReasonOffered;
                          return (
                            <option key={r} value={r} disabled={unavailable}>
                              {WAIVER_REASON_LABEL[r]}
                              {unavailable ? ' (not available yet in this build)' : ''}
                            </option>
                          );
                        })}
                      </Select>
                    )}
                  </Field>
                  {reason === 'REFUSED_BIOMETRIC_PROCESSING' ? (
                    <p className="text-sm text-muted-foreground" data-testid="waiver-face-note">
                      Because the candidate refuses biometric processing, the face and gaze
                      detectors are switched off for this invitation as well.
                    </p>
                  ) : null}
                  {reason === 'OTHER' ? (
                    <Field
                      id="waiver-note"
                      label="Describe the reason (required)"
                      hint="A few words. Do not enter health details."
                      error={errors.waiverNote?.message}
                    >
                      {(aria) => (
                        <Textarea
                          {...aria}
                          className="min-h-16"
                          maxLength={500}
                          {...form.register('waiverNote')}
                        />
                      )}
                    </Field>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {progress !== null ? (
          <p role="status" className="text-sm">
            Sending… {progress} of {csv?.parse.valid.length ?? 0} rows.
          </p>
        ) : null}

        {outcome ? (
          <Alert
            tone={
              outcome.failed || outcome.notSent > 0 || outcome.errors.length > 0
                ? 'warning'
                : 'success'
            }
            role="status"
            title="Upload finished"
          >
            <span data-testid="bulk-result">{uploadSummary(outcome, problems.length)}</span>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {mode === 'many' && (outcome?.unsentRows.length ?? 0) > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={downloadUnsent}>
                <Download className="size-4" aria-hidden="true" />
                Download the rows not sent
              </Button>
            ) : null}
            {mode === 'many' && (problems.length > 0 || (outcome?.errors.length ?? 0) > 0) ? (
              <Button type="button" variant="outline" size="sm" onClick={downloadProblems}>
                <Download className="size-4" aria-hidden="true" />
                Download the rows with a problem
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {outcome ? 'Close' : 'Cancel'}
            </Button>
            <Button
              type="submit"
              disabled={
                isSubmitting ||
                progress !== null ||
                // After an upload, choose a file again (it clears the result) before sending more.
                (mode === 'many' && outcome !== null)
              }
            >
              {mode === 'many' ? <Upload className="size-4" aria-hidden="true" /> : null}
              {progress !== null || isSubmitting
                ? 'Sending…'
                : mode === 'one'
                  ? 'Send invitation'
                  : hasValidRows
                    ? `Invite ${csv?.parse.valid.length ?? 0} candidate${(csv?.parse.valid.length ?? 0) === 1 ? '' : 's'}`
                    : 'Invite'}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}

/** A cell of the preview: always text. A formula-looking value gets a visible marker, never a link or a formula. */
function Cell({ value }: { value: string }): React.JSX.Element {
  return (
    <span className="break-all">
      {value}
      {looksLikeFormula(value) ? (
        <span className="sr-only">
          {' '}
          (starts with a spreadsheet formula character, kept as text)
        </span>
      ) : null}
    </span>
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Why an upload stopped, in words that do not claim nothing was sent. */
function stopCause(e: InviteFailure): string {
  if (e.status === 401) return 'Your session ended.';
  if (e.status === 403) return 'Your role cannot send invitations.';
  if (e.status === 404) return 'The test no longer exists.';
  if (e.status === 422) return 'The window has already closed.';
  if (e.status === 400)
    return [e.message, ...e.errors].filter(Boolean).join(' ') || 'The server did not accept a row.';
  if (e.status >= 500 || e.status === 0) return 'The connection or the server failed.';
  return 'The server refused the request.';
}

/** The plain-words result of a CSV upload: what was created, what was not, and what to do next. */
export function uploadSummary(o: BulkOutcome, fileProblems: number): string {
  const skipped = o.errors.length + fileProblems;
  const made = `${plural(o.created, 'invitation', 'invitations')} created`;
  const rest = skipped > 0 ? `, ${plural(skipped, 'row', 'rows')} not invited` : '';
  if (o.failed) {
    const may =
      o.uncertain > 0 ? `; ${plural(o.uncertain, 'row', 'rows')} of those may have been sent` : '';
    return `The upload stopped after ${plural(o.created, 'invitation', 'invitations')}${rest}. ${stopCause(o.failed)} ${plural(o.notSent, 'row was', 'rows were')} not confirmed${may}. Check the candidates list before trying again; people already invited are reported as already invited.`;
  }
  if (o.notSent > 0) {
    const wait = o.retryAfterSeconds
      ? `in about ${Math.ceil(o.retryAfterSeconds / 60)} minutes`
      : 'later';
    return `${made}${rest}. You reached the hourly limit: ${plural(o.notSent, 'row was', 'rows were')} not sent. Download the rows not sent, then choose that file again ${wait}. The invitations already sent stay valid.`;
  }
  return `${made}${rest}.`;
}
