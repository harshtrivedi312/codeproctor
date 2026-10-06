'use client';
import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { useWatch } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { newId, normalizeShortAnswer } from '../draft';
import { errorAt, useDraftField, type TabProps } from '../use-draft-field';

/** FR-205: the answer key. MCQ: options and the correct ones. Short answer: canonical answer and accepted variants (D-23). */
export function AnswerTab({ form, readOnly }: TabProps): React.JSX.Element {
  const type = useWatch({ control: form.control, name: 'type' });
  return type === 'MCQ' ? (
    <McqAnswer form={form} readOnly={readOnly} />
  ) : (
    <ShortAnswer form={form} readOnly={readOnly} />
  );
}

function McqAnswer({ form, readOnly }: TabProps): React.JSX.Element {
  const [mcq, setMcq] = useDraftField(form, 'mcq');
  const keyError = errorAt(form, 'mcq.correctOptionIds');
  const listError = errorAt(form, 'mcq.options');

  function toggleCorrect(id: string, on: boolean): void {
    if (!mcq.multiple) return setMcq({ ...mcq, correctOptionIds: on ? [id] : [] });
    setMcq({
      ...mcq,
      correctOptionIds: on
        ? [...mcq.correctOptionIds, id]
        : mcq.correctOptionIds.filter((x) => x !== id),
    });
  }

  return (
    <div className="space-y-4">
      <Alert tone="info">
        The key is private: candidates see the options but never which are correct. Answers are
        scored automatically.
      </Alert>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={mcq.multiple}
          disabled={readOnly}
          onChange={(e) =>
            setMcq({
              ...mcq,
              multiple: e.target.checked,
              // Switching to single choice keeps only the first marked option.
              correctOptionIds: e.target.checked
                ? mcq.correctOptionIds
                : mcq.correctOptionIds.slice(0, 1),
            })
          }
        />
        Several options can be correct (the candidate must pick exactly the correct set)
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Options and key</legend>
        {listError ? (
          <p role="alert" className="text-sm text-destructive">
            {listError}
          </p>
        ) : null}
        <ul className="space-y-2">
          {mcq.options.map((o, i) => (
            <li key={o.id} className="flex flex-wrap items-start gap-2">
              <label className="mt-8 flex items-center gap-2 text-sm">
                <input
                  type={mcq.multiple ? 'checkbox' : 'radio'}
                  name="mcq-correct"
                  className="size-4"
                  checked={mcq.correctOptionIds.includes(o.id)}
                  disabled={readOnly}
                  onChange={(e) => toggleCorrect(o.id, e.target.checked)}
                />
                <span>{`Option ${i + 1} is correct`}</span>
              </label>
              <Field
                id={`mcq-opt-${o.id}`}
                label={`Option ${i + 1} text`}
                error={errorAt(form, `mcq.options.${i}.text`)}
              >
                {(aria) => (
                  <Input
                    {...aria}
                    className="w-96"
                    value={o.text}
                    disabled={readOnly}
                    onChange={(e) =>
                      setMcq({
                        ...mcq,
                        options: mcq.options.map((x) =>
                          x.id === o.id ? { ...x, text: e.target.value } : x,
                        ),
                      })
                    }
                  />
                )}
              </Field>
              {readOnly ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-7"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() =>
                    setMcq({
                      ...mcq,
                      options: mcq.options.filter((x) => x.id !== o.id),
                      correctOptionIds: mcq.correctOptionIds.filter((x) => x !== o.id),
                    })
                  }
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {keyError ? (
          <p role="alert" className="text-sm text-destructive">
            {keyError}
          </p>
        ) : null}
        {readOnly ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setMcq({ ...mcq, options: [...mcq.options, { id: newId('opt'), text: '' }] })
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add option
          </Button>
        )}
      </fieldset>
    </div>
  );
}

function ShortAnswer({ form, readOnly }: TabProps): React.JSX.Element {
  const [short, setShort] = useDraftField(form, 'short');
  return (
    <div className="space-y-4">
      <Alert tone="info">
        A candidate&apos;s answer is scored automatically when, after normalisation (Unicode NFKC,
        trimmed, spaces collapsed, lower case), it equals the canonical answer or one of the
        accepted variants. An answer that does not match is <strong>never</strong> marked wrong
        automatically: it goes to a reviewer for manual scoring.
      </Alert>
      <Field id="short-canonical" label="Canonical answer" error={errorAt(form, 'short.canonical')}>
        {(aria) => (
          <Input
            {...aria}
            className="max-w-xl"
            value={short.canonical}
            disabled={readOnly}
            onChange={(e) => setShort({ ...short, canonical: e.target.value })}
          />
        )}
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Accepted variants</legend>
        <p className="text-sm text-muted-foreground">
          Other wordings that also count as correct. Case and extra spaces do not matter.
        </p>
        <ul className="space-y-2">
          {short.acceptedVariants.map((a, i) => (
            <li key={a.key} className="flex flex-wrap items-start gap-2">
              <Field
                id={`short-var-${i}`}
                label={`Accepted variant ${i + 1}`}
                hint={
                  a.value.trim() ? (
                    <>
                      Matches as: <code>{normalizeShortAnswer(a.value)}</code>
                    </>
                  ) : undefined
                }
                error={errorAt(form, `short.acceptedVariants.${i}.value`)}
              >
                {(aria) => (
                  <Input
                    {...aria}
                    className="w-96"
                    value={a.value}
                    disabled={readOnly}
                    onChange={(e) =>
                      setShort({
                        ...short,
                        acceptedVariants: short.acceptedVariants.map((x, j) =>
                          j === i ? { ...x, value: e.target.value } : x,
                        ),
                      })
                    }
                  />
                )}
              </Field>
              {readOnly ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-7"
                  aria-label={`Remove accepted variant ${i + 1}`}
                  onClick={() =>
                    setShort({
                      ...short,
                      acceptedVariants: short.acceptedVariants.filter((_, j) => j !== i),
                    })
                  }
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {readOnly ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setShort({
                ...short,
                acceptedVariants: [...short.acceptedVariants, { key: newId('sv'), value: '' }],
              })
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add accepted variant
          </Button>
        )}
      </fieldset>
    </div>
  );
}
