'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  DEFAULT_EVENT_CAP_PER_TYPE,
  DEFAULT_EVENT_SEVERITY,
  DEFAULT_EVENT_WEIGHT,
  DEFAULT_SEVERITY_POINTS,
  EVENT_TYPES,
  RISK_BAND_MIN_SCORE,
  type EventType,
  type Severity,
} from '@codeproctor/shared';
import * as React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Schemas } from '@/lib/api/client';
import { humanizeEventType } from './format';
import { useOrgSettings, useUpdateSettings } from './queries';
import { riskSettingsSchema, type RiskSettingsValues } from './schemas';
import { SettingsFrame } from './settings-frame';

interface WeightRow {
  type: EventType;
  label: string;
  severity: Severity;
}

const WEIGHT_ROWS: WeightRow[] = EVENT_TYPES.map((type) => ({
  type,
  label: humanizeEventType(type),
  severity: DEFAULT_EVENT_SEVERITY[type],
}));

const SEVERITY_TONE = { LOW: 'neutral', MEDIUM: 'warning', HIGH: 'error' } as const;

export function toFormValues(risk: Schemas['RiskSettings']): RiskSettingsValues {
  const weights = Object.fromEntries(
    EVENT_TYPES.map((t) => [t, risk.weights[t] ?? DEFAULT_EVENT_WEIGHT[t]]),
  ) as RiskSettingsValues['weights'];
  return {
    pointsLow: risk.severityPoints.LOW,
    pointsMedium: risk.severityPoints.MEDIUM,
    pointsHigh: risk.severityPoints.HIGH,
    capPerType: risk.capPerType,
    mediumFrom: risk.bandMinScore.MEDIUM,
    highFrom: risk.bandMinScore.HIGH,
    weights,
  };
}

export function defaultFormValues(): RiskSettingsValues {
  return {
    pointsLow: DEFAULT_SEVERITY_POINTS.LOW,
    pointsMedium: DEFAULT_SEVERITY_POINTS.MEDIUM,
    pointsHigh: DEFAULT_SEVERITY_POINTS.HIGH,
    capPerType: DEFAULT_EVENT_CAP_PER_TYPE,
    mediumFrom: RISK_BAND_MIN_SCORE.MEDIUM,
    highFrom: RISK_BAND_MIN_SCORE.HIGH,
    weights: { ...DEFAULT_EVENT_WEIGHT },
  };
}

function toRiskSettings(v: RiskSettingsValues): Schemas['RiskSettings'] {
  return {
    severityPoints: { LOW: v.pointsLow, MEDIUM: v.pointsMedium, HIGH: v.pointsHigh },
    capPerType: v.capPerType,
    bandMinScore: { MEDIUM: v.mediumFrom, HIGH: v.highFrom },
    weights: v.weights,
  };
}

/** FR-804: risk weights and thresholds. Org overrides of the defaults in ADR 0005 section 2. */
export function RiskSettingsPage(): React.JSX.Element {
  return (
    <SettingsFrame
      title="Risk scoring"
      description="The risk score is 0 to 100: for each event type, the first few events count (the cap), each worth the points of its severity times the type's weight. Changes apply to scores calculated from now on."
    >
      <RiskContent />
    </SettingsFrame>
  );
}

function RiskContent(): React.JSX.Element {
  const settings = useOrgSettings();
  return (
    <>
      {settings.isError ? (
        <Alert tone="error" role="alert" title="We could not load the settings">
          Check your connection and reload the page.
        </Alert>
      ) : settings.data ? (
        <RiskForm initial={toFormValues(settings.data.risk)} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading settings…
        </p>
      )}
    </>
  );
}

function numberInput(
  register: ReturnType<typeof useForm<RiskSettingsValues>>['register'],
  name: 'pointsLow' | 'pointsMedium' | 'pointsHigh' | 'capPerType' | 'mediumFrom' | 'highFrom',
) {
  return register(name, { valueAsNumber: true });
}

function RiskForm({ initial }: { initial: RiskSettingsValues }): React.JSX.Element {
  const update = useUpdateSettings();
  const [saved, setSaved] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<RiskSettingsValues>({
    resolver: zodResolver(riskSettingsSchema),
    defaultValues: initial,
  });
  const values = useWatch({ control });

  function onSubmit(v: RiskSettingsValues): void {
    setSaved(false);
    setServerError(null);
    update.mutate(
      { risk: toRiskSettings(v) },
      {
        onSuccess: () => setSaved(true),
        onError: (e) =>
          setServerError(
            e.message ||
              'The settings were not saved. Check the thresholds and your connection, then try again.',
          ),
      },
    );
  }

  const columns: Column<WeightRow>[] = [
    { id: 'event', header: 'Event type', cell: (r) => r.label, sortValue: (r) => r.label },
    {
      id: 'severity',
      header: 'Severity',
      sortValue: (r) => r.severity,
      searchValue: (r) => r.severity,
      facet: {
        label: 'Severity',
        value: (r) => r.severity,
        options: [
          { value: 'HIGH', label: 'High' },
          { value: 'MEDIUM', label: 'Medium' },
          { value: 'LOW', label: 'Low' },
        ],
      },
      cell: (r) => <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>,
    },
    {
      id: 'weight',
      header: 'Weight (0 to 5)',
      cell: (r) => {
        const message = errors.weights?.[r.type]?.message;
        return (
          <div>
            <Input
              type="number"
              step="0.1"
              className="h-8 w-24"
              aria-label={`Weight for ${r.label}`}
              aria-invalid={Boolean(message)}
              {...register(`weights.${r.type}`, { valueAsNumber: true })}
            />
            {message ? <p className="text-xs text-destructive">{message}</p> : null}
          </div>
        );
      },
    },
  ];

  // TC-075 example: 2 HIGH events and 3 MEDIUM events, each of a type with weight 1.
  const cap = Number(values.capPerType ?? 0);
  const exampleScore = Math.min(
    100,
    Math.min(2, cap) * Number(values.pointsHigh ?? 0) +
      Math.min(3, cap) * Number(values.pointsMedium ?? 0),
  );
  const exampleBand =
    exampleScore >= Number(values.highFrom ?? 100)
      ? 'HIGH'
      : exampleScore >= Number(values.mediumFrom ?? 100)
        ? 'MEDIUM'
        : 'LOW';

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} noValidate className="space-y-6">
      {serverError ? (
        <Alert tone="error" role="alert" title="Not saved">
          {serverError}
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="success" role="status" title="Saved">
          Risk scoring now uses these values.
        </Alert>
      ) : null}

      <fieldset className="grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-medium">Points per event</legend>
        <Field id="points-low" label="LOW" error={errors.pointsLow?.message}>
          {(aria) => <Input {...aria} type="number" {...numberInput(register, 'pointsLow')} />}
        </Field>
        <Field id="points-medium" label="MEDIUM" error={errors.pointsMedium?.message}>
          {(aria) => <Input {...aria} type="number" {...numberInput(register, 'pointsMedium')} />}
        </Field>
        <Field id="points-high" label="HIGH" error={errors.pointsHigh?.message}>
          {(aria) => <Input {...aria} type="number" {...numberInput(register, 'pointsHigh')} />}
        </Field>
      </fieldset>

      <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
        <Field
          id="cap-per-type"
          label="Events counted per type"
          hint="One noisy detector cannot reach 100 on its own."
          error={errors.capPerType?.message}
        >
          {(aria) => <Input {...aria} type="number" {...numberInput(register, 'capPerType')} />}
        </Field>
        <Field
          id="medium-from"
          label="MEDIUM from score"
          hint="Below this is LOW."
          error={errors.mediumFrom?.message}
        >
          {(aria) => <Input {...aria} type="number" {...numberInput(register, 'mediumFrom')} />}
        </Field>
        <Field
          id="high-from"
          label="HIGH from score"
          hint="Up to 100."
          error={errors.highFrom?.message}
        >
          {(aria) => <Input {...aria} type="number" {...numberInput(register, 'highFrom')} />}
        </Field>
      </div>

      <p className="text-sm" data-testid="risk-example" aria-live="polite">
        Example: 2 HIGH events and 3 MEDIUM events score <strong>{exampleScore}</strong>, band{' '}
        <strong>{exampleBand}</strong>.
      </p>

      <DataTable
        caption="Weight per event type"
        searchLabel="Search event types"
        columns={columns}
        rows={WEIGHT_ROWS}
        getRowId={(r) => r.type}
        pageSizes={[10, 25, 50]}
        defaultPageSize={10}
        empty={{ title: 'No event types' }}
      />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save risk settings'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            reset(defaultFormValues());
            setSaved(false);
          }}
        >
          Reset to defaults
        </Button>
      </div>
    </form>
  );
}
