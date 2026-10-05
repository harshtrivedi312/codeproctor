'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Schemas } from '@/lib/api/client';
import { ConfirmDialog } from './confirm-dialog';
import { formatDate } from './format';
import {
  ApiFailure,
  useConsentTexts,
  useCreateConsentText,
  useOrgSettings,
  useSetCurrentConsent,
  useUpdateSettings,
} from './queries';
import {
  consentVersionSchema,
  declineContactSchema,
  type ConsentVersionValues,
  type DeclineContactValues,
} from './schemas';
import { SettingsFrame } from './settings-frame';

type ConsentText = Schemas['ConsentText'];

/**
 * D-17: consent documents. A text Legal has not approved is a placeholder: it is labelled as one
 * everywhere, and where the environment requires approval (pilot, production) it cannot be made
 * the current text. Approval itself is recorded outside this screen (Q-43).
 */
export function ConsentPage(): React.JSX.Element {
  return (
    <SettingsFrame
      title="Consent"
      description="The document every candidate signs before each test session. Versions cannot be edited once added; add a new version instead. Sessions already signed keep the version they signed."
    >
      <ConsentContent />
    </SettingsFrame>
  );
}

function ConsentContent(): React.JSX.Element {
  const texts = useConsentTexts();
  const setCurrent = useSetCurrentConsent();
  const [addOpen, setAddOpen] = React.useState(false);
  const [viewing, setViewing] = React.useState<ConsentText | null>(null);
  const [choosing, setChoosing] = React.useState<ConsentText | null>(null);
  const required = texts.data?.legalApprovalRequired ?? false;

  const columns: Column<ConsentText>[] = [
    {
      id: 'version',
      header: 'Version',
      sortValue: (t) => t.version,
      cell: (t) => <span className="font-medium">{t.version}</span>,
    },
    {
      id: 'status',
      header: 'Legal approval',
      sortValue: (t) => (t.legalApprovedAt ? 'Approved' : 'Placeholder'),
      searchValue: (t) => (t.legalApprovedAt ? 'Approved' : 'Placeholder not approved'),
      facet: {
        label: 'Approval',
        value: (t) => (t.legalApprovedAt ? 'approved' : 'placeholder'),
        options: [
          { value: 'approved', label: 'Approved' },
          { value: 'placeholder', label: 'Placeholder' },
        ],
      },
      cell: (t) =>
        t.legalApprovedAt ? (
          <Badge tone="success">Approved {formatDate(t.legalApprovedAt)}</Badge>
        ) : (
          <Badge tone="warning">Placeholder, not approved by Legal</Badge>
        ),
    },
    {
      id: 'current',
      header: 'In use',
      sortValue: (t) => (t.isCurrent ? 0 : 1),
      searchValue: (t) => (t.isCurrent ? 'current' : ''),
      cell: (t) =>
        t.isCurrent ? (
          <Badge tone="success">Current</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'created',
      header: 'Added',
      sortValue: (t) => t.createdAt,
      searchValue: () => '',
      cell: (t) => formatDate(t.createdAt),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (t) => {
        const blocked = required && !t.legalApprovedAt;
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setViewing(t)}>
              View<span className="sr-only"> {t.version}</span>
            </Button>
            {t.isCurrent ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={blocked}
                aria-describedby={blocked ? `blocked-${t.id}` : undefined}
                onClick={() => setChoosing(t)}
              >
                Use as current<span className="sr-only"> {t.version}</span>
              </Button>
            )}
            {blocked ? (
              <span id={`blocked-${t.id}`} className="text-xs text-muted-foreground">
                Needs Legal approval first
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="space-y-8">
        <section aria-label="Consent documents" className="space-y-3">
          {texts.data ? (
            required ? (
              <Alert tone="info" title="This environment only accepts Legal-approved texts">
                A placeholder cannot be made current here. Ask Legal to approve the text, then use
                it.
              </Alert>
            ) : (
              <Alert tone="warning" title="Placeholder texts are allowed in this environment">
                Pilot and production refuse any text Legal has not approved. Do not use a
                placeholder with real candidates.
              </Alert>
            )
          ) : null}
          <DataTable
            caption="Consent document versions"
            searchLabel="Search consent versions"
            columns={columns}
            rows={texts.data?.items}
            isLoading={texts.isLoading}
            error={
              texts.isError
                ? {
                    title: 'We could not load the consent documents',
                    hint: 'Check your connection, then try again.',
                    onRetry: () => void texts.refetch(),
                  }
                : null
            }
            getRowId={(t) => t.id}
            defaultSort={{ columnId: 'created', direction: 'desc' }}
            empty={{
              title: 'No consent document yet',
              hint: 'Candidates cannot start a test until one is current.',
              action: <Button onClick={() => setAddOpen(true)}>Add a version</Button>,
            }}
            toolbar={<Button onClick={() => setAddOpen(true)}>Add a version</Button>}
          />
        </section>
        <DeclineContactSection />
      </div>

      <AddVersionDialog open={addOpen} onOpenChange={setAddOpen} />

      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogTitle>Consent text {viewing?.version}</DialogTitle>
          <DialogDescription>
            Read only. Candidates see this text before they sign.
          </DialogDescription>
          {viewing && !viewing.legalApprovedAt ? (
            <Alert tone="warning" className="mt-3" title="Placeholder">
              Not approved by Legal. It must not be shown to real candidates.
            </Alert>
          ) : null}
          <pre
            className="mt-3 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 text-sm"
            // A scrollable region must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label="Consent text"
          >
            {viewing?.bodyMd}
          </pre>
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={choosing !== null}
        onOpenChange={(open) => {
          if (!open) setChoosing(null);
        }}
        title={`Use ${choosing?.version ?? ''} as the current text?`}
        description={
          <>
            <p>
              Candidates who start a session from now on sign this version. Sessions already signed
              keep the version they signed.
            </p>
            {choosing && !choosing.legalApprovedAt ? (
              <p className="mt-2 font-medium">
                This is a placeholder that Legal has not approved. Use it for testing only.
              </p>
            ) : null}
          </>
        }
        confirmLabel="Use this version"
        pending={setCurrent.isPending}
        onConfirm={() => {
          const target = choosing;
          if (!target) return;
          setCurrent.mutate(target.id, {
            onSuccess: () => {
              toast.success(`${target.version} is now the current consent text.`);
              setChoosing(null);
            },
            onError: (e) => {
              toast.error(
                e instanceof ApiFailure && e.status === 409
                  ? 'Legal has not approved this text, and this environment requires approval. Ask Legal to approve it first.'
                  : 'Could not change the current text. Try again in a moment.',
              );
              setChoosing(null);
            },
          });
        }}
      />
    </>
  );
}

function AddVersionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const create = useCreateConsentText();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ConsentVersionValues>({
    resolver: zodResolver(consentVersionSchema),
    defaultValues: { version: '', bodyMd: '' },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setServerError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>Add a consent version</DialogTitle>
        <DialogDescription>
          The new version starts as a placeholder until Legal approves it. It does not become
          current until you choose it.
        </DialogDescription>
        <form
          noValidate
          className="mt-4 space-y-4"
          onSubmit={(e) =>
            void handleSubmit((values) => {
              setServerError(null);
              create.mutate(values, {
                onSuccess: (t) => {
                  toast.success(`Version ${t.version} added as a placeholder.`);
                  reset();
                  onOpenChange(false);
                },
                onError: (err) =>
                  setServerError(
                    err instanceof ApiFailure && err.status === 409
                      ? 'This version name is already used. Choose a new one, for example the next number.'
                      : 'The version was not added. Check your connection and try again.',
                  ),
              });
            })(e)
          }
        >
          {serverError ? (
            <Alert tone="error" role="alert" title="Not added">
              {serverError}
            </Alert>
          ) : null}
          <Field id="consent-version" label="Version name" error={errors.version?.message}>
            {(aria) => <Input {...aria} autoComplete="off" {...register('version')} />}
          </Field>
          <Field
            id="consent-body"
            label="Consent text (Markdown)"
            hint="Cover what is recorded, how it is used, retention and deletion, who can access it, appeals, accommodations and how to withdraw."
            error={errors.bodyMd?.message}
          >
            {(aria) => (
              <Textarea {...aria} className="min-h-48 font-mono" {...register('bodyMd')} />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Adding…' : 'Add version'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** D-17: the contact shown to a candidate who declines consent (TC-096). */
function DeclineContactSection(): React.JSX.Element {
  const settings = useOrgSettings();
  return (
    <section aria-labelledby="decline-heading" className="max-w-xl space-y-3">
      <h2 id="decline-heading" className="text-base font-semibold">
        Contact for candidates who decline
      </h2>
      <p className="text-sm text-muted-foreground">
        A candidate who declines to sign ends their session with no recording. They see this contact
        for alternatives or accommodations.
      </p>
      {settings.data ? (
        <DeclineContactForm initial={settings.data.consentDeclineContact} />
      ) : settings.isError ? (
        <Alert tone="error" role="alert" title="We could not load this setting">
          Reload the page to try again.
        </Alert>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      )}
    </section>
  );
}

function DeclineContactForm({ initial }: { initial: string }): React.JSX.Element {
  const update = useUpdateSettings();
  const [saved, setSaved] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<DeclineContactValues>({
    resolver: zodResolver(declineContactSchema),
    defaultValues: { consentDeclineContact: initial },
  });
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) =>
        void handleSubmit((values) => {
          setSaved(false);
          setServerError(null);
          update.mutate(values, {
            onSuccess: () => setSaved(true),
            onError: () => setServerError('Not saved. Check your connection and try again.'),
          });
        })(e)
      }
    >
      {serverError ? (
        <Alert tone="error" role="alert" title="Not saved">
          {serverError}
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="success" role="status" title="Saved">
          Candidates who decline will see this contact.
        </Alert>
      ) : null}
      <Field
        id="decline-contact"
        label="Contact shown after declining"
        error={errors.consentDeclineContact?.message}
      >
        {(aria) => (
          <Textarea {...aria} className="min-h-20" {...register('consentDeclineContact')} />
        )}
      </Field>
      <Button type="submit" disabled={update.isPending}>
        {update.isPending ? 'Saving…' : 'Save contact'}
      </Button>
    </form>
  );
}
