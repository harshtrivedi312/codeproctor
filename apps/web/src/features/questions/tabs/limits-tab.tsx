'use client';
import * as React from 'react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorAt, type TabProps } from '../use-draft-field';

const FIELDS = [
  { name: 'cpuMs', label: 'CPU time limit (ms)', hint: 'Per test. Default 2000.' },
  {
    name: 'wallMs',
    label: 'Wall time limit (ms)',
    hint: 'Per test, including waiting. Default 5000.',
  },
  { name: 'memoryKb', label: 'Memory limit (KB)', hint: 'Default 262144 (256 MB).' },
] as const;

/** FR-201: time and memory limits applied to every run of this question. */
export function LimitsTab({ form, readOnly }: TabProps): React.JSX.Element {
  return (
    <div className="grid max-w-3xl gap-4 md:grid-cols-3">
      {FIELDS.map((f) => (
        <Field
          key={f.name}
          id={`limit-${f.name}`}
          label={f.label}
          hint={f.hint}
          error={errorAt(form, `limits.${f.name}`)}
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              inputMode="numeric"
              disabled={readOnly}
              {...form.register(`limits.${f.name}`, { valueAsNumber: true })}
            />
          )}
        </Field>
      ))}
    </div>
  );
}
