/*
 * MOCK of the API's variant template renderer (apps/api/src/questions/variant-template.ts): the
 * `{{name}}` variable-tag subset of Mustache and nothing else. `\{{` writes a literal `{{`; any
 * other `{{...}}` is an error; a placeholder with no param is an error (never rendered empty);
 * nothing is HTML-escaped; one pass, so a param value is never rendered again. Same error shape in
 * spirit (offset-prefixed messages), not byte-identical. Pure.
 */

export type ParamValue = string | number | boolean;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
export const MAX_PARAM_KEYS = 50;
export const MAX_PARAM_VALUE_LENGTH = 1000;

export const isValidName = (name: string): boolean =>
  NAME.test(name) && !name.startsWith('__') && name !== 'constructor' && name !== 'prototype';

/** Why a params value is not acceptable; empty when it is (paramsProblems). */
export function paramsProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['must be an object'];
  }
  const problems: string[] = [];
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAM_KEYS) problems.push(`at most ${MAX_PARAM_KEYS} parameters`);
  for (const [key, v] of entries) {
    if (!isValidName(key)) {
      problems.push(
        'parameter names are 1 to 40 letters, digits or underscores, not starting with a digit or two underscores',
      );
    } else if (typeof v === 'string') {
      if (v.length > MAX_PARAM_VALUE_LENGTH)
        problems.push(`${key}: at most ${MAX_PARAM_VALUE_LENGTH} characters`);
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) problems.push(`${key}: must be a finite number`);
    } else if (typeof v !== 'boolean') {
      problems.push(`${key}: must be a string, number or boolean`);
    }
  }
  return [...new Set(problems)];
}

export type RenderResult = { ok: true; text: string } | { ok: false; errors: string[] };

export function renderTemplate(
  template: string,
  params: Readonly<Record<string, ParamValue>>,
): RenderResult {
  const errors: string[] = [];
  let out = '';
  let i = 0;
  while (i < template.length && errors.length < 20) {
    if (template.startsWith('\\{{', i)) {
      out += '{{';
      i += 3;
    } else if (template.startsWith('{{', i)) {
      const close = template.indexOf('}}', i + 2);
      if (close === -1 || close - i > 80) {
        errors.push(`offset ${i}: a "{{" tag is not closed (write \\{{ for a literal "{{")`);
        break;
      }
      const name = template.slice(i + 2, close).trim();
      if (!isValidName(name)) {
        errors.push(
          `offset ${i}: only {{name}} placeholders are supported (write \\{{ for a literal "{{")`,
        );
      } else if (Object.hasOwn(params, name)) {
        out += String(params[name]);
      } else {
        errors.push(`offset ${i}: unknown placeholder "${name}"`);
      }
      i = close + 2;
    } else {
      out += template[i];
      i += 1;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, text: out };
}

export interface TemplateContent {
  statementMd: string;
  starterCode: Record<string, string>;
  referenceSolution: Record<string, string>;
}

export interface RenderedContent {
  statementMd: string;
  starterCode: Record<string, string>;
  referenceSolution: Record<string, string>;
}

/** Statement, starter code and reference solution for one variant (renderContent). */
export function renderContent(
  content: TemplateContent,
  params: Readonly<Record<string, ParamValue>>,
): { ok: true; content: RenderedContent } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const run = (label: string, template: string): string => {
    const r = renderTemplate(template, params);
    if (r.ok) return r.text;
    for (const e of r.errors) errors.push(`${label}: ${e}`);
    return '';
  };
  const statementMd = run('statementMd', content.statementMd);
  const code = (field: string, map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(map).map(([lang, src]) => [lang, run(`${field}.${lang}`, src)]),
    );
  const starterCode = code('starterCode', content.starterCode);
  const referenceSolution = code('referenceSolution', content.referenceSolution);
  return errors.length > 0
    ? { ok: false, errors: errors.slice(0, 20) }
    : { ok: true, content: { statementMd, starterCode, referenceSolution } };
}
