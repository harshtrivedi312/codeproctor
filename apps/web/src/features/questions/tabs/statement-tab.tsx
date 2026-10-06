'use client';
import * as React from 'react';
import { useWatch } from 'react-hook-form';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { MAX_STATEMENT, MAX_TITLE, variantName } from '../draft';
import { DIFFICULTY_LABEL } from '../labels';
import { MarkdownPreview } from '../markdown-preview';
import { parseParams } from '../params';
import { renderTemplate } from '../template';
import { errorAt, type TabProps } from '../use-draft-field';

/** FR-201: title, difficulty, tags and the markdown statement with a live preview (no raw HTML). */
export function StatementTab({ form, readOnly }: TabProps): React.JSX.Element {
  const { register } = form;
  const statement = useWatch({ control: form.control, name: 'statementMd' });
  const variants = useWatch({ control: form.control, name: 'variants' });
  const type = useWatch({ control: form.control, name: 'type' });
  const [variantId, setVariantId] = React.useState('');

  const variant = variants.find((v) => v.id === variantId);
  const parsed = variant ? parseParams(variant.paramsText) : null;
  const rendered = parsed?.ok ? renderTemplate(statement, parsed.value) : null;
  const shown = rendered ? rendered.text : statement;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr]">
        <Field id="q-title" label="Title" error={errorAt(form, 'title')}>
          {(aria) => (
            <Input {...aria} maxLength={MAX_TITLE} disabled={readOnly} {...register('title')} />
          )}
        </Field>
        <Field id="q-difficulty" label="Difficulty" error={errorAt(form, 'difficulty')}>
          {(aria) => (
            <Select {...aria} className="w-full" disabled={readOnly} {...register('difficulty')}>
              {Object.entries(DIFFICULTY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="q-tags"
          label="Tags"
          hint="Separate with commas, for example arrays, sorting."
          error={errorAt(form, 'tagsText')}
        >
          {(aria) => <Input {...aria} disabled={readOnly} {...register('tagsText')} />}
        </Field>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Field
          id="q-statement"
          label="Statement (Markdown)"
          hint={
            type === 'CODING' ? (
              <>
                Raw HTML is not rendered. Use <code>{'{{name}}'}</code> placeholders for variant
                parameters; declare them on the Variants tab.
              </>
            ) : (
              'Raw HTML is not rendered.'
            )
          }
          error={errorAt(form, 'statementMd')}
        >
          {(aria) => (
            <Textarea
              {...aria}
              className="min-h-80 font-mono"
              maxLength={MAX_STATEMENT}
              disabled={readOnly}
              {...register('statementMd')}
            />
          )}
        </Field>
        <section aria-labelledby="q-preview-heading" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="q-preview-heading" className="text-sm font-medium">
              Live preview
            </h3>
            {type === 'CODING' && variants.length > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <span>Show as</span>
                <Select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
                  <option value="">Template (placeholders as written)</option>
                  {variants.map((v, i) => (
                    <option key={v.id} value={v.id}>
                      {variantName(i)}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </div>
          {variant && parsed && !parsed.ok ? (
            <Alert tone="warning" role="status">
              This variant&apos;s parameters are not valid JSON yet, so the placeholders are shown
              as written.
            </Alert>
          ) : null}
          {rendered && rendered.missing.length > 0 ? (
            <Alert tone="warning" role="status">
              No value for {rendered.missing.map((m) => `"${m}"`).join(', ')} in this variant.
            </Alert>
          ) : null}
          <div className="min-h-80 rounded-md border bg-card p-4" data-testid="statement-preview">
            {shown.trim() === '' ? (
              <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
            ) : (
              <MarkdownPreview>{shown}</MarkdownPreview>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
