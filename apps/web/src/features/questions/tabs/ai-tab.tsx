'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { AI_REFERENCE_LANGUAGES, type CodeLanguage } from '@codeproctor/shared';
import * as React from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/features/admin/format';
import type { Schemas } from '@/lib/api/client';
import { aiReferenceFormSchema, type AiReferenceFormValues } from '../ai-schema';
import { LANGUAGE_LABELS, variantName } from '../draft';
import { aiGate, aiRefreshDue } from '../gate';
import { MonacoField } from '../monaco-field';
import { useAddAiReference, useAiReferences } from '../queries';
import { useDraftField, type ApiTabProps } from '../use-draft-field';

type Ref = Schemas['AiReference'];

interface Props extends ApiTabProps {
  policy: Schemas['AiReferencePolicy'];
}

/**
 * D-20, ADR 0005: solutions collected from AI assistants. Rows are append-only: "supersede" adds
 * the new row and keeps the old one (marked superseded). They are used for similarity checks only,
 * never for grading, and candidates never see them.
 */
function variantLabel(variants: readonly { id: string }[], id: string): string {
  const at = variants.findIndex((v) => v.id === id);
  return at >= 0 ? variantName(at) : 'A variant';
}

export function AiTab({
  form,
  readOnly,
  questionId,
  policy: fallbackPolicy,
}: Props): React.JSX.Element {
  const [languages] = useDraftField(form, 'allowedLanguages');
  const [variants] = useDraftField(form, 'variants');
  const refs = useAiReferences(questionId ?? '');
  const [dialog, setDialog] = React.useState<{ supersede: Ref | null } | null>(null);

  if (questionId === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Save the question first. AI reference solutions belong to a saved question.
      </p>
    );
  }
  const rows = refs.data?.items ?? [];
  // The policy comes with the list (WEB-ONLY placeholder [BE-04c]); until it loads, the default.
  const policy = refs.data?.policy ?? fallbackPolicy;
  const gates = aiGate(languages, rows, policy);
  const due = aiRefreshDue(rows, policy, new Date());
  const aiLanguages = languages.filter((l) => AI_REFERENCE_LANGUAGES.includes(l));

  return (
    <div className="space-y-5">
      <Alert tone="info">
        Collect a solution for each language from at least {policy.minAssistants} different AI
        assistants (business or team plans that do not train on inputs). They are compared with
        candidates&apos; code to spot copying. They are <strong>never</strong> used for grading and
        candidates never see them.
      </Alert>

      <section aria-labelledby="ai-gate-heading" className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 id="ai-gate-heading" className="text-sm font-medium">
            Publish requirement
          </h3>
          {due ? (
            <Badge tone="warning" data-testid="refresh-due">
              Refresh due
            </Badge>
          ) : null}
        </div>
        {due ? (
          <p className="text-sm text-muted-foreground">
            The newest solution is older than {policy.refreshDays} days. Collect fresh ones and
            supersede the old rows.
          </p>
        ) : null}
        {policy.minAssistants === 0 ? (
          <p className="text-sm text-muted-foreground">
            The organisation turned this requirement off.
          </p>
        ) : null}
        <ul className="space-y-1">
          {gates.map((g) => (
            <li key={g.language} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{LANGUAGE_LABELS[g.language]}</span>
              <Badge tone={g.ok ? 'success' : 'warning'}>
                {g.ok ? 'Ready' : `Needs ${g.required - g.assistants.length} more`}
              </Badge>
              <span className="text-muted-foreground">
                {g.assistants.length}/{g.required} assistants
                {g.assistants.length > 0 ? `: ${g.assistants.join(', ')}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ai-list-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="ai-list-heading" className="text-sm font-medium">
            Collected solutions
          </h3>
          {readOnly ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={aiLanguages.length === 0}
              onClick={() => setDialog({ supersede: null })}
            >
              Add solution
            </Button>
          )}
        </div>
        {refs.isError ? (
          <Alert tone="error" role="alert" title="We could not load the solutions">
            Check your connection and reload the page.
          </Alert>
        ) : refs.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">AI reference solutions</caption>
              <thead className="border-b bg-muted/60">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Language
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Assistant
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Model
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Applies to
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Collected
                  </th>
                  <th scope="col" className="px-3 py-2">
                    By
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-3 py-2">{LANGUAGE_LABELS[r.language]}</td>
                    <td className="px-3 py-2">{r.assistant}</td>
                    <td className="px-3 py-2">{r.modelLabel}</td>
                    <td className="px-3 py-2">
                      {r.variantId ? variantLabel(variants, r.variantId) : 'Base statement'}
                    </td>
                    <td className="px-3 py-2">{formatDate(r.collectedAt)}</td>
                    <td className="px-3 py-2">{r.collectedByName}</td>
                    <td className="px-3 py-2">
                      <Badge tone={r.supersededAt ? 'neutral' : 'success'}>
                        {r.supersededAt ? 'Superseded' : 'Current'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      {!readOnly && !r.supersededAt ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Supersede the ${r.assistant} ${LANGUAGE_LABELS[r.language]} solution`}
                          onClick={() => setDialog({ supersede: r })}
                        >
                          Supersede
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog ? (
        <AiDialog
          questionId={questionId}
          supersede={dialog.supersede}
          languages={aiLanguages}
          variants={variants.map((v, i) => ({ id: v.id, label: variantName(i) }))}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function AiDialog({
  questionId,
  supersede,
  languages,
  variants,
  onClose,
}: {
  questionId: string;
  supersede: Ref | null;
  languages: CodeLanguage[];
  variants: { id: string; label: string }[];
  onClose: () => void;
}): React.JSX.Element {
  const add = useAddAiReference(questionId);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AiReferenceFormValues>({
    resolver: zodResolver(aiReferenceFormSchema),
    defaultValues: {
      assistant: supersede?.assistant ?? '',
      modelLabel: supersede?.modelLabel ?? '',
      language: supersede?.language ?? languages[0] ?? 'python',
      variantId: supersede?.variantId ?? '',
      collectedAt: today(),
      solutionCode: '',
      promptText: supersede?.promptText ?? '',
    },
  });

  const lang = useWatch({ control, name: 'language' });

  async function onSubmit(v: AiReferenceFormValues): Promise<void> {
    setServerError(null);
    try {
      await add.mutateAsync({
        ...(supersede ? { supersedes: supersede.id } : {}),
        body: {
          assistant: v.assistant.trim(),
          modelLabel: v.modelLabel.trim(),
          language: v.language as Schemas['Language'],
          solutionCode: v.solutionCode,
          collectedAt: new Date(`${v.collectedAt}T12:00:00`).toISOString(),
          ...(v.promptText.trim() ? { promptText: v.promptText } : {}),
          variantId: v.variantId === '' ? null : v.variantId,
        },
      });
      onClose();
    } catch {
      setServerError('We could not save this solution. Check your connection and try again.');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto">
        <DialogTitle>{supersede ? 'Supersede an AI solution' : 'Add an AI solution'}</DialogTitle>
        <DialogDescription>
          {supersede
            ? 'The old row stays in the history, marked superseded. Paste the new solution.'
            : 'Paste a solution an AI assistant produced for this question.'}
        </DialogDescription>
        <form
          onSubmit={(e) => {
            // The dialog renders in a portal, but React events still bubble to the editor's own
            // <form>: without this, adding a solution would also submit (save) the question.
            e.stopPropagation();
            void handleSubmit(onSubmit)(e);
          }}
          noValidate
          className="mt-4 space-y-3"
        >
          {serverError ? (
            <Alert tone="error" role="alert">
              {serverError}
            </Alert>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <Field id="ai-assistant" label="Assistant" error={errors.assistant?.message}>
              {(aria) => <Input {...aria} placeholder="ChatGPT" {...register('assistant')} />}
            </Field>
            <Field id="ai-model" label="Model label" error={errors.modelLabel?.message}>
              {(aria) => (
                <Input
                  {...aria}
                  placeholder="As the assistant shows it"
                  {...register('modelLabel')}
                />
              )}
            </Field>
            <Field id="ai-language" label="Language" error={errors.language?.message}>
              {(aria) => (
                <Select
                  {...aria}
                  className="w-full"
                  disabled={supersede !== null}
                  {...register('language')}
                >
                  {languages.map((l) => (
                    <option key={l} value={l}>
                      {LANGUAGE_LABELS[l]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="ai-variant" label="Applies to">
              {(aria) => (
                <Select
                  {...aria}
                  className="w-full"
                  disabled={supersede !== null}
                  {...register('variantId')}
                >
                  <option value="">Base statement</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="ai-date" label="Date collected" error={errors.collectedAt?.message}>
              {(aria) => <Input {...aria} type="date" {...register('collectedAt')} />}
            </Field>
          </div>
          <Controller
            control={control}
            name="solutionCode"
            render={({ field }) => {
              return (
                <div className="space-y-1">
                  <p className="text-sm font-medium" id="ai-code-label">
                    Solution
                  </p>
                  <MonacoField
                    path={`ai.${lang}`}
                    language={(lang as CodeLanguage) ?? 'python'}
                    value={field.value}
                    ariaLabel="AI solution code"
                    height="220px"
                    onChange={field.onChange}
                  />
                  {errors.solutionCode?.message ? (
                    <p role="alert" className="text-sm text-destructive">
                      {errors.solutionCode.message}
                    </p>
                  ) : null}
                </div>
              );
            }}
          />
          <Field id="ai-prompt" label="Prompt used (optional)" error={errors.promptText?.message}>
            {(aria) => <Textarea {...aria} className="min-h-20" {...register('promptText')} />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : supersede ? 'Supersede' : 'Add solution'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
