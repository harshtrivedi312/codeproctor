'use client';
import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { useWatch } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Schemas } from '@/lib/api/client';
import { LANGUAGE_LABELS, newId, type VariantValues } from '../draft';
import { MarkdownPreview } from '../markdown-preview';
import { checkParams, missingPlaceholders, parseParams } from '../params';
import { usePrefill } from '../queries';
import { placeholdersOf, renderTemplate } from '../template';
import { errorAt, useDraftField, type ApiTabProps } from '../use-draft-field';

type Proposal = Schemas['PrefillResponse']['proposals'][number];

/**
 * FR-203, ADR 0007: variants with their own explicit parameter values, a rendered
 * preview, and per-variant input and expected-output overrides for each test slot. Prefilling
 * expected outputs from the reference solution only PROPOSES values; they change nothing until the
 * author accepts them.
 */
export function VariantsTab({ form, readOnly, questionId }: ApiTabProps): React.JSX.Element {
  if (questionId === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Save the question first. Variants belong to a saved draft; add them after the first save.
      </p>
    );
  }
  return <VariantsBody form={form} readOnly={readOnly} questionId={questionId} />;
}

function VariantsBody({
  form,
  readOnly,
  questionId,
}: Omit<ApiTabProps, 'questionId'> & { questionId: string }): React.JSX.Element {
  const [variants, setVariants] = useDraftField(form, 'variants');
  const statement = useWatch({ control: form.control, name: 'statementMd' });
  const starter = useWatch({ control: form.control, name: 'starterCode' });
  const reference = useWatch({ control: form.control, name: 'referenceSolution' });
  const used = placeholdersOf(
    [statement, ...Object.values(starter), ...Object.values(reference)].join('\n'),
  );

  function patchVariant(id: string, patch: Partial<VariantValues>): void {
    setVariants(variants.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }

  return (
    <div className="space-y-6">
      <Alert tone="info">
        A variant gives each candidate a different but equivalent version: it fills the{' '}
        <code>{'{{name}}'}</code> placeholders and may replace the input and expected output of a
        test slot. Every variant keeps the same slots and weights, and the reference solution must
        pass all of them before the question can be published.
      </Alert>

      <p className="text-sm text-muted-foreground" data-testid="placeholders-used">
        {used.length > 0
          ? `Placeholders used by this question: ${used.map((n) => `{{${n}}}`).join(', ')}. Give each variant a value for every one of them.`
          : 'This question uses no {{name}} placeholders yet, so a variant can only override test data.'}
      </p>
      {errorAt(form, 'variants') ? (
        <p role="alert" className="text-sm text-destructive">
          {errorAt(form, 'variants')}
        </p>
      ) : null}

      <section aria-labelledby="variants-heading" className="space-y-4">
        <h3 id="variants-heading" className="text-sm font-medium">
          Variants
        </h3>
        {variants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No variants: every candidate gets the base statement and the default test data.
          </p>
        ) : null}
        {variants.map((v, i) => (
          <VariantCard
            key={v.id}
            index={i}
            variant={v}
            form={form}
            readOnly={readOnly}
            questionId={questionId}
            used={used}
            statement={statement}
            reference={reference}
            onChange={(patch) => patchVariant(v.id, patch)}
            onRemove={() => setVariants(variants.filter((x) => x.id !== v.id))}
          />
        ))}
        {readOnly ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setVariants([
                ...variants,
                {
                  id: newId('var'),
                  label: `Variant ${variants.length + 1}`,
                  paramsText: JSON.stringify(Object.fromEntries(used.map((n) => [n, ''])), null, 2),
                  active: true,
                  overrides: [],
                },
              ])
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add variant
          </Button>
        )}
      </section>
    </div>
  );
}

interface CardProps extends Pick<ApiTabProps, 'form' | 'readOnly' | 'questionId'> {
  index: number;
  variant: VariantValues;
  used: string[];
  statement: string;
  reference: Record<string, string>;
  onChange: (patch: Partial<VariantValues>) => void;
  onRemove: () => void;
}

function VariantCard({
  index,
  variant,
  form,
  readOnly,
  questionId,
  used,
  statement,
  reference,
  onChange,
  onRemove,
}: CardProps): React.JSX.Element {
  const [tests] = useDraftField(form, 'testCases');
  const [languages] = useDraftField(form, 'allowedLanguages');
  const parsed = parseParams(variant.paramsText);
  const missing = parsed.ok ? missingPlaceholders(parsed.value, used) : [];
  const problems = parsed.ok
    ? [
        ...checkParams(parsed.value),
        ...(missing.length > 0
          ? [`Needs a value for ${missing.map((m) => `"${m}"`).join(', ')}.`]
          : []),
      ]
    : [parsed.error];
  const formError = errorAt(form, `variants.${index}.paramsText`);
  const rendered = parsed.ok ? renderTemplate(statement, parsed.value) : null;
  const headingId = `variant-${variant.id}`;

  const [language, setLanguage] = React.useState('');
  const withReference = languages.filter((l) => (reference[l] ?? '').trim() !== '');
  const chosen = language || withReference[0] || '';
  // Proposals remember what they were computed from; if any of it changes they are stale.
  const [proposed, setProposed] = React.useState<{ key: string; items: Proposal[] } | null>(null);
  const requestId = React.useRef(0);
  const prefill = usePrefill(questionId ?? '');

  const overrideOf = (testCaseId: string) =>
    variant.overrides.find((o) => o.testCaseId === testCaseId);

  const snapshotKey = JSON.stringify([
    chosen,
    variant.paramsText,
    reference[chosen] ?? '',
    tests.map((t) => [t.id, overrideOf(t.id)?.input ?? t.input]),
  ]);
  const stale = proposed !== null && proposed.key !== snapshotKey;
  const proposals = proposed && !stale ? proposed.items : null;
  const setProposals = (update: (all: Proposal[] | null) => Proposal[] | null): void =>
    setProposed((p) => {
      if (!p) return p;
      const items = update(p.items);
      return items === null ? null : { ...p, items };
    });

  function setOverride(
    testCaseId: string,
    patch: { input?: string; expectedOutput?: string } | null,
  ): void {
    const slot = tests.find((t) => t.id === testCaseId);
    if (!slot) return;
    const rest = variant.overrides.filter((o) => o.testCaseId !== testCaseId);
    if (patch === null) return onChange({ overrides: rest });
    const current = overrideOf(testCaseId) ?? {
      testCaseId,
      input: slot.input,
      expectedOutput: slot.expectedOutput,
    };
    const next = { ...current, ...patch };
    onChange({
      overrides: [...variant.overrides.filter((o) => o.testCaseId !== testCaseId), next].sort(
        (a, b) =>
          tests.findIndex((t) => t.id === a.testCaseId) -
          tests.findIndex((t) => t.id === b.testCaseId),
      ),
    });
  }

  async function runPrefill(): Promise<void> {
    if (!parsed.ok || !questionId || chosen === '') return;
    const id = (requestId.current += 1);
    const key = snapshotKey;
    try {
      const items = await prefill.mutateAsync({
        language: chosen as Schemas['Language'],
        params: parsed.value,
        referenceSolution: reference[chosen] ?? '',
        slots: tests.map((t) => ({ testCaseId: t.id, input: overrideOf(t.id)?.input ?? t.input })),
      });
      // A newer request (or a dismiss) replaced this one: ignore the old answer.
      if (id === requestId.current) setProposed({ key, items });
    } catch {
      // prefill.isError shows the message; nothing was changed.
    }
  }

  function accept(p: Proposal): void {
    if (p.expectedOutput === undefined) return;
    const slot = tests.find((t) => t.id === p.testCaseId);
    if (!slot) return;
    setOverride(p.testCaseId, {
      input: overrideOf(p.testCaseId)?.input ?? slot.input,
      expectedOutput: p.expectedOutput,
    });
    setProposals((all) => all?.filter((x) => x.testCaseId !== p.testCaseId) ?? null);
  }

  function acceptAll(): void {
    if (!proposals) return;
    const next = [...variant.overrides];
    for (const p of proposals) {
      if (p.expectedOutput === undefined) continue;
      const slot = tests.find((t) => t.id === p.testCaseId);
      if (!slot) continue;
      const at = next.findIndex((o) => o.testCaseId === p.testCaseId);
      const base =
        at >= 0
          ? next[at]!
          : { testCaseId: p.testCaseId, input: slot.input, expectedOutput: slot.expectedOutput };
      const merged = { ...base, expectedOutput: p.expectedOutput };
      if (at >= 0) next[at] = merged;
      else next.push(merged);
    }
    onChange({ overrides: next });
    setProposals((all) => all?.filter((p) => p.expectedOutput === undefined) ?? null);
  }

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Field
          id={`${headingId}-label`}
          label="Variant name"
          error={errorAt(form, `variants.${index}.label`)}
        >
          {(aria) => (
            <Input
              {...aria}
              className="w-64"
              value={variant.label}
              disabled={readOnly}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          )}
        </Field>
        <label className="mt-7 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={variant.active}
            disabled={readOnly}
            onChange={(e) => onChange({ active: e.target.checked })}
          />
          Active (candidates can get it; validation runs it)
        </label>
        {readOnly ? null : (
          <Button type="button" variant="ghost" size="sm" className="mt-7" onClick={onRemove}>
            <Trash2 className="size-4" aria-hidden="true" />
            Remove variant
          </Button>
        )}
      </div>
      <h4 id={headingId} className="sr-only">
        {variant.label || `Variant ${index + 1}`}
      </h4>

      <div className="grid gap-4 lg:grid-cols-2">
        <Field
          id={`${headingId}-params`}
          label="Parameters (JSON)"
          hint='An object with one value per placeholder the question uses, for example {"count": 4}.'
          error={problems.length > 0 ? problems.join(' ') : formError}
        >
          {(aria) => (
            <Textarea
              {...aria}
              className="min-h-32 font-mono"
              value={variant.paramsText}
              disabled={readOnly}
              onChange={(e) => onChange({ paramsText: e.target.value })}
            />
          )}
        </Field>
        <div className="space-y-1">
          <h5 className="text-sm font-medium">Rendered statement</h5>
          <div className="min-h-32 rounded-md border p-3" data-testid={`variant-preview-${index}`}>
            {rendered ? (
              <>
                {rendered.missing.length > 0 ? (
                  <p className="mb-2 text-sm text-destructive">
                    No value for {rendered.missing.map((m) => `"${m}"`).join(', ')}.
                  </p>
                ) : null}
                <MarkdownPreview>{rendered.text}</MarkdownPreview>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Fix the parameters to see the rendered statement.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h5 className="text-sm font-medium">Test data of this variant</h5>
        {tests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add test cases first; each one is a slot a variant can override.
          </p>
        ) : (
          <ul className="space-y-3">
            {tests.map((t, ti) => {
              const o = overrideOf(t.id);
              return (
                <li key={t.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-medium">Slot {ti + 1}</span>
                    <Badge tone={t.isHidden ? 'neutral' : 'success'}>
                      {t.isHidden ? 'Hidden' : 'Visible'}
                    </Badge>
                    <span className="text-sm text-muted-foreground">weight {t.weight}</span>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={o !== undefined}
                        disabled={readOnly}
                        onChange={(e) => setOverride(t.id, e.target.checked ? {} : null)}
                      />
                      <span>
                        Override slot {ti + 1} for {variant.label || `variant ${index + 1}`}
                      </span>
                    </label>
                  </div>
                  {o ? (
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      <Field id={`${headingId}-${t.id}-in`} label={`Input, slot ${ti + 1}`}>
                        {(aria) => (
                          <Textarea
                            {...aria}
                            className="min-h-20 font-mono"
                            value={o.input}
                            disabled={readOnly}
                            onChange={(e) => setOverride(t.id, { input: e.target.value })}
                          />
                        )}
                      </Field>
                      <Field
                        id={`${headingId}-${t.id}-out`}
                        label={`Expected output, slot ${ti + 1}`}
                      >
                        {(aria) => (
                          <Textarea
                            {...aria}
                            className="min-h-20 font-mono"
                            value={o.expectedOutput}
                            disabled={readOnly}
                            onChange={(e) => setOverride(t.id, { expectedOutput: e.target.value })}
                          />
                        )}
                      </Field>
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Uses the default input and expected output.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {readOnly || tests.length === 0 ? null : (
        <div className="space-y-2 rounded-md bg-muted/50 p-3">
          <h5 className="text-sm font-medium">Prefill from the reference solution</h5>
          <p className="text-sm text-muted-foreground">
            Runs the reference solution on this variant&apos;s inputs and proposes expected outputs.
            Nothing changes until you accept a proposal.
          </p>
          {questionId === null ? (
            <p className="text-sm text-muted-foreground">Save the question first.</p>
          ) : withReference.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add a reference solution first.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <span>Language</span>
                <Select value={chosen} onChange={(e) => setLanguage(e.target.value)}>
                  {withReference.map((l) => (
                    <option key={l} value={l}>
                      {LANGUAGE_LABELS[l]}
                    </option>
                  ))}
                </Select>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!parsed.ok || prefill.isPending}
                onClick={() => void runPrefill()}
              >
                {prefill.isPending ? 'Running…' : 'Prefill from reference solution'}
              </Button>
            </div>
          )}
          {prefill.isError ? (
            <Alert tone="error" role="alert" title="We could not run the reference solution">
              Check the reference solution and try again. Your test data was not changed.
            </Alert>
          ) : null}
          {stale ? (
            <Alert tone="warning" role="status">
              The parameters, the inputs or the reference solution changed since these outputs were
              proposed, so they were set aside. Run the prefill again.
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-2"
                onClick={() => {
                  requestId.current += 1;
                  setProposed(null);
                }}
              >
                Dismiss
              </Button>
            </Alert>
          ) : null}
          {proposals ? (
            <div
              role="region"
              aria-label={`Proposed outputs for ${variant.label}`}
              className="space-y-2"
            >
              {proposals.length === 0 ? <p className="text-sm">All proposals handled.</p> : null}
              <ul className="space-y-2">
                {proposals.map((p) => {
                  const pos = tests.findIndex((t) => t.id === p.testCaseId) + 1;
                  const slot = tests.find((t) => t.id === p.testCaseId);
                  const current =
                    overrideOf(p.testCaseId)?.expectedOutput ?? slot?.expectedOutput ?? '';
                  return (
                    <li key={p.testCaseId} className="rounded-md border bg-card p-2 text-sm">
                      <p className="font-medium">Slot {pos}</p>
                      {p.expectedOutput !== undefined ? (
                        <>
                          <p>
                            Current:{' '}
                            <code className="whitespace-pre-wrap">{current || '(empty)'}</code>
                          </p>
                          <p>
                            Proposed:{' '}
                            <code className="whitespace-pre-wrap">{p.expectedOutput}</code>
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            className="mt-1"
                            onClick={() => accept(p)}
                          >
                            Accept slot {pos}
                          </Button>
                        </>
                      ) : (
                        <p role="status" className="text-destructive">
                          {p.error ?? 'No output.'}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!proposals.some((p) => p.expectedOutput !== undefined)}
                  onClick={acceptAll}
                >
                  Accept all proposals
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    requestId.current += 1;
                    setProposed(null);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
