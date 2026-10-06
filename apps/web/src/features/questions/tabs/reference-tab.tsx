'use client';
import { CODE_LANGUAGES } from '@codeproctor/shared';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { LANGUAGE_LABELS } from '../draft';
import { MonacoField } from '../monaco-field';
import { useDraftField, type TabProps } from '../use-draft-field';

/** FR-201, FR-203: the author's reference solution; validation runs it on every variant (ADR 0007 V-3). */
export function ReferenceTab({ form, readOnly }: TabProps): React.JSX.Element {
  const [languages] = useDraftField(form, 'allowedLanguages');
  const [reference, setReference] = useDraftField(form, 'referenceSolution');
  const active = CODE_LANGUAGES.filter((l) => languages.includes(l));

  return (
    <div className="space-y-4">
      <Alert tone="info">
        The reference solution is private: candidates never receive it. Validation runs it on every
        test of the base statement and of every active variant, so it can use{' '}
        <code>{'{{name}}'}</code> placeholders for the variant parameters.
      </Alert>
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Pick at least one language on the Languages and starter code tab first.
        </p>
      ) : null}
      {active.map((language) => (
        <section key={language} aria-labelledby={`ref-${language}`} className="space-y-2">
          <h3 id={`ref-${language}`} className="text-sm font-medium">
            Reference solution: {LANGUAGE_LABELS[language]}
          </h3>
          <MonacoField
            path={`reference.${language}`}
            language={language}
            value={reference[language] ?? ''}
            readOnly={readOnly}
            ariaLabel={`Reference solution in ${LANGUAGE_LABELS[language]}`}
            onChange={(code) => setReference({ ...reference, [language]: code })}
          />
        </section>
      ))}
    </div>
  );
}
