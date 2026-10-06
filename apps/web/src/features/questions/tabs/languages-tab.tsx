'use client';
import { CODE_LANGUAGES, type CodeLanguage } from '@codeproctor/shared';
import * as React from 'react';
import { LANGUAGE_LABELS } from '../draft';
import { MonacoField } from '../monaco-field';
import { errorAt, useDraftField, type TabProps } from '../use-draft-field';

/** FR-201: which languages the candidate may use, and the starter code for each (Mustache allowed). */
export function LanguagesTab({ form, readOnly }: TabProps): React.JSX.Element {
  const [languages, setLanguages] = useDraftField(form, 'allowedLanguages');
  const [starter, setStarter] = useDraftField(form, 'starterCode');
  const error = errorAt(form, 'allowedLanguages');

  function toggle(language: CodeLanguage, on: boolean): void {
    setLanguages(on ? [...languages, language] : languages.filter((l) => l !== language));
  }

  return (
    <div className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Allowed languages</legend>
        <p className="text-sm text-muted-foreground">
          Candidates pick one of these. Add a reference solution and AI reference solutions for
          each.
        </p>
        <div className="flex flex-wrap gap-4">
          {CODE_LANGUAGES.map((language) => (
            <label key={language} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={languages.includes(language)}
                disabled={readOnly}
                onChange={(e) => toggle(language, e.target.checked)}
              />
              {LANGUAGE_LABELS[language]}
            </label>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </fieldset>

      {CODE_LANGUAGES.filter((l) => languages.includes(l)).map((language) => (
        <section key={language} aria-labelledby={`starter-${language}`} className="space-y-2">
          <h3 id={`starter-${language}`} className="text-sm font-medium">
            Starter code: {LANGUAGE_LABELS[language]}
          </h3>
          <p className="text-sm text-muted-foreground">
            What the candidate sees in the editor. <code>{'{{name}}'}</code> placeholders are filled
            in per variant.
          </p>
          <MonacoField
            path={`starter.${language}`}
            language={language}
            value={starter[language] ?? ''}
            readOnly={readOnly}
            ariaLabel={`Starter code in ${LANGUAGE_LABELS[language]}`}
            onChange={(code) => setStarter({ ...starter, [language]: code })}
          />
        </section>
      ))}
    </div>
  );
}
