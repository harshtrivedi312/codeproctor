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

/** NUL bytes and lone surrogates cannot be stored (text-rules.ts isStorableText). */
const storable = (v: string): boolean =>
  !v.includes('\u0000') &&
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v);

export const MAX_PARAMS_JSON_LENGTH = 20_000;

/** Why a params value is not acceptable; empty when it is (paramsProblems). */
export function paramsProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['must be an object'];
  }
  const problems: string[] = [];
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAM_KEYS) problems.push(`at most ${MAX_PARAM_KEYS} parameters`);
  let size = 0;
  for (const [key, v] of entries) {
    if (!isValidName(key)) {
      problems.push(
        'parameter names are 1 to 40 letters, digits or underscores, not starting with a digit or two underscores',
      );
      continue;
    }
    if (typeof v === 'string') {
      if (v.length > MAX_PARAM_VALUE_LENGTH)
        problems.push(`${key}: at most ${MAX_PARAM_VALUE_LENGTH} characters`);
      else if (!storable(v)) problems.push(`${key}: contains a NUL byte or a lone surrogate`);
      size += v.length;
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) problems.push(`${key}: must be a finite number`);
      size += 24;
    } else if (typeof v === 'boolean') {
      size += 5;
    } else {
      problems.push(`${key}: must be a string, number or boolean`);
    }
    size += key.length;
  }
  if (size > MAX_PARAMS_JSON_LENGTH) problems.push('parameters are too large in total');
  return [...new Set(problems)];
}

export type RenderResult = { ok: true; text: string } | { ok: false; errors: string[] };

type Token = { kind: 'text'; text: string } | { kind: 'var'; name: string; at: number };

function tokenize(template: string): { tokens: Token[]; errors: string[] } {
  const tokens: Token[] = [];
  const errors: string[] = [];
  let text = '';
  let i = 0;
  const flush = (): void => {
    if (text) tokens.push({ kind: 'text', text });
    text = '';
  };
  while (i < template.length && errors.length < 20) {
    if (template.startsWith('\\{{', i)) {
      text += '{{';
      i += 3;
    } else if (template.startsWith('{{', i)) {
      const close = template.indexOf('}}', i + 2);
      if (close === -1 || close - i > 80) {
        errors.push(`offset ${i}: a "{{" tag is not closed (write \\{{ for a literal "{{")`);
        break;
      }
      const name = template.slice(i + 2, close).trim();
      if (isValidName(name)) {
        flush();
        tokens.push({ kind: 'var', name, at: i });
      } else {
        errors.push(
          `offset ${i}: only {{name}} placeholders are supported (write \\{{ for a literal "{{")`,
        );
      }
      i = close + 2;
    } else {
      text += template[i];
      i += 1;
    }
  }
  flush();
  return { tokens, errors };
}

/**
 * One pass, like the API: syntax errors alone when there are any (no placeholder is looked up
 * then), otherwise unknown placeholders, and the rendered text is capped while it is built.
 */
export function renderTemplate(
  template: string,
  params: Readonly<Record<string, ParamValue>>,
  maxLength = 100_000,
): RenderResult {
  const { tokens, errors } = tokenize(template);
  if (errors.length > 0) return { ok: false, errors };
  const out: string[] = [];
  let length = 0;
  for (const t of tokens) {
    let piece: string;
    if (t.kind === 'text') piece = t.text;
    else if (Object.hasOwn(params, t.name)) piece = String(params[t.name]);
    else {
      errors.push(`offset ${t.at}: unknown placeholder "${t.name}"`);
      if (errors.length >= 20) break;
      continue;
    }
    length += piece.length;
    if (length > maxLength) {
      return { ok: false, errors: [`the rendered text is longer than ${maxLength} characters`] };
    }
    out.push(piece);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, text: out.join('') };
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
  const run = (label: string, template: string, max: number): string => {
    const r = renderTemplate(template, params, max);
    if (r.ok) return r.text;
    for (const e of r.errors) errors.push(`${label}: ${e}`);
    return '';
  };
  const statementMd = run('statementMd', content.statementMd, 50_000);
  const code = (field: string, map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(map).map(([lang, src]) => [lang, run(`${field}.${lang}`, src, 100_000)]),
    );
  const starterCode = code('starterCode', content.starterCode);
  const referenceSolution = code('referenceSolution', content.referenceSolution);
  return errors.length > 0
    ? { ok: false, errors: errors.slice(0, 20) }
    : { ok: true, content: { statementMd, starterCode, referenceSolution } };
}
