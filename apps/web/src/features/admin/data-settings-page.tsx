'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useOrgSettings, useUpdateSettings } from './queries';
import {
  dataSettingsSchema,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type DataSettingsValues,
} from './schemas';
import { SettingsFrame } from './settings-frame';

/** FR-704 retention days and D-19 erasure hold. */
export function DataSettingsPage(): React.JSX.Element {
  return (
    <SettingsFrame
      title="Data and privacy"
      description="How long recordings and ID images are kept, and what happens when a candidate asks for erasure."
    >
      <DataSettingsContent />
    </SettingsFrame>
  );
}

function DataSettingsContent(): React.JSX.Element {
  const settings = useOrgSettings();
  return (
    <>
      {settings.isError ? (
        <Alert tone="error" role="alert" title="We could not load the settings">
          Check your connection and reload the page.
        </Alert>
      ) : settings.data ? (
        <DataSettingsForm
          initial={{
            retentionDays: settings.data.retentionDays,
            holdWhileReviewOrAppealOpen: settings.data.erasure.holdWhileReviewOrAppealOpen,
          }}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading settings…
        </p>
      )}
    </>
  );
}

function DataSettingsForm({ initial }: { initial: DataSettingsValues }): React.JSX.Element {
  const update = useUpdateSettings();
  const [saved, setSaved] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<DataSettingsValues>({
    resolver: zodResolver(dataSettingsSchema),
    defaultValues: initial,
  });
  const hold = useWatch({ control, name: 'holdWhileReviewOrAppealOpen' });

  function onSubmit(values: DataSettingsValues): void {
    setSaved(false);
    setServerError(null);
    update.mutate(
      {
        retentionDays: values.retentionDays,
        erasure: { holdWhileReviewOrAppealOpen: values.holdWhileReviewOrAppealOpen },
      },
      {
        onSuccess: () => setSaved(true),
        onError: () =>
          setServerError('The settings were not saved. Check your connection and try again.'),
      },
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      noValidate
      className="max-w-xl space-y-6"
    >
      {serverError ? (
        <Alert tone="error" role="alert" title="Not saved">
          {serverError}
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="success" role="status" title="Saved">
          The new settings apply from now on.
        </Alert>
      ) : null}
      <Field
        id="retention-days"
        label="Keep recordings and ID images for (days)"
        hint={`From the session's final outcome. Between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} days; the default is 90. Nothing is deleted while a review or appeal is open.`}
        error={errors.retentionDays?.message}
      >
        {(aria) => (
          <Input
            {...aria}
            type="number"
            inputMode="numeric"
            className="w-32"
            {...register('retentionDays', { valueAsNumber: true })}
          />
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Erasure requests</legend>
        <div className="flex items-start gap-2">
          <input
            id="erasure-hold"
            type="checkbox"
            className="mt-1 size-4"
            aria-describedby="erasure-hold-hint"
            {...register('holdWhileReviewOrAppealOpen')}
          />
          <label htmlFor="erasure-hold" className="text-sm">
            Wait while a review or appeal is open
          </label>
        </div>
        <p id="erasure-hold-hint" className="text-sm text-muted-foreground">
          On (recommended): when a candidate asks for erasure while a review or appeal is open,
          erasure waits and runs as soon as it closes; the candidate is told. This can take longer
          than 30 days. Legal has not yet confirmed this rule (D-19).
        </p>
        {!hold ? (
          <Alert tone="warning" title="Erasure will not wait">
            With this off, a candidate&apos;s recordings and answers are erased even while their
            review or appeal is open, so the reviewer may lose the evidence.
          </Alert>
        ) : null}
      </fieldset>

      <Button type="submit" disabled={update.isPending}>
        {update.isPending ? 'Saving…' : 'Save settings'}
      </Button>
    </form>
  );
}
