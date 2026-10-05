// The only template feature the seed needs: `{{name}}` (and `{{{name}}}`) variable substitution, as in
// Mustache, which is what BE-04 will render with. Mustache HTML-escapes `{{name}}`; the seed's
// params use only letters, digits, spaces, `_` and `-`, which escaping leaves alone, and a plan
// test enforces that. An unknown name throws, so a typo in a template fails the seed.
import type { Params } from './types';

const TAG = /\{\{\{?\s*([A-Za-z][A-Za-z0-9_]*)\s*\}?\}\}/g;

export const SAFE_PARAM_VALUE = /^[A-Za-z0-9_ -]+$/;

export function renderTemplate(template: string, params: Params): string {
  return template.replace(TAG, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Template uses {{${name}}}, which the params lack.`);
    return String(value);
  });
}

/** The names a template uses. */
export function templateNames(template: string): string[] {
  return [...template.matchAll(TAG)].map((match) => match[1] as string);
}
