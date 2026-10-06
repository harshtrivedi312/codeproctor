// The variant template renderer and the variant params rules (FR-203, ADR 0007 V-2). Pure: no
// database, no Nest, unit tested directly.
//
// Template syntax: the variable-tag subset of Mustache and nothing else. `{{name}}` is replaced
// by the variant's param `name`. There are no sections, partials, comments, set-delimiters,
// helpers, lambdas, dotted paths or "triple mustache" tags: any other `{{...}}` is a validation
// error, so the engine cannot run code and cannot surprise an author. Nothing is HTML-escaped:
// the output is Markdown and source code, both treated as untrusted text downstream (the web
// app sanitizes Markdown). `\{{` writes a literal `{{`. A placeholder with no param is an error
// (never silently empty). Rendering is ONE pass over the template: a param value is inserted as
// text and never rendered again, so there is no recursion to bound, and the output length is
// capped while it is built.
//
// Params are a flat object of scalars. Names are plain identifiers and are looked up with
// Object.hasOwn on the params object, never through the prototype chain; `__proto__`,
// `constructor`, `prototype` and every name starting with `__` are refused, so no params object
// can pollute or read a prototype.
import { isStorableText } from './text-rules';
import { MAX_STATEMENT_LENGTH } from './dto/questions.dto';
import { MAX_CODE_LENGTH } from './question-content';

export type ParamValue = string | number | boolean;
export type Params = Readonly<Record<string, ParamValue>>;

export const MAX_PARAM_KEYS = 50;
export const MAX_PARAM_VALUE_LENGTH = 1000;
export const MAX_PARAMS_JSON_LENGTH = 20_000;
const MAX_TAG_LENGTH = 80;
const MAX_ERRORS = 20;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const FORBIDDEN_NAMES = new Set(['constructor', 'prototype']);

export function isValidName(name: string): boolean {
  return NAME.test(name) && !name.startsWith('__') && !FORBIDDEN_NAMES.has(name);
}

/** Why a params value is not acceptable; empty when it is. */
export function paramsProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['must be an object'];
  }
  const problems: string[] = [];
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAM_KEYS) problems.push(`at most ${MAX_PARAM_KEYS} parameters`);
  let size = 0;
  for (const [key, v] of entries) {
    if (problems.length >= MAX_ERRORS) break;
    if (!isValidName(key)) {
      problems.push(
        'parameter names are 1 to 40 letters, digits or underscores, not starting with a digit or two underscores',
      );
      continue;
    }
    if (typeof v === 'string') {
      if (v.length > MAX_PARAM_VALUE_LENGTH) {
        problems.push(`${key}: at most ${MAX_PARAM_VALUE_LENGTH} characters`);
      } else if (!isStorableText(v)) {
        problems.push(`${key}: contains a NUL byte or a lone surrogate`);
      }
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

/** Reads stored params; null when they are not a valid flat scalar object. */
export function paramsFromStored(raw: unknown): Params | null {
  if (paramsProblems(raw).length > 0) return null;
  return raw as Params;
}

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
  while (i < template.length && errors.length < MAX_ERRORS) {
    if (template.startsWith('\\{{', i)) {
      text += '{{';
      i += 3;
    } else if (template.startsWith('{{', i)) {
      const close = template.indexOf('}}', i + 2);
      if (close === -1 || close - i > MAX_TAG_LENGTH) {
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

/** The placeholder names a template uses, and the syntax errors found. */
export function templateNames(template: string): { names: string[]; errors: string[] } {
  const { tokens, errors } = tokenize(template);
  const names = new Set<string>();
  for (const t of tokens) if (t.kind === 'var') names.add(t.name);
  return { names: [...names], errors };
}

export type RenderResult = { ok: true; text: string } | { ok: false; errors: string[] };

export function renderTemplate(template: string, params: Params, maxLength: number): RenderResult {
  const { tokens, errors } = tokenize(template);
  if (errors.length > 0) return { ok: false, errors };
  const out: string[] = [];
  let length = 0;
  for (const t of tokens) {
    let piece: string;
    if (t.kind === 'text') {
      piece = t.text;
    } else if (Object.hasOwn(params, t.name)) {
      piece = String(params[t.name]);
    } else {
      errors.push(`offset ${t.at}: unknown placeholder "${t.name}"`);
      if (errors.length >= MAX_ERRORS) break;
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
  starterCode: unknown;
  referenceSolution: unknown;
}

export interface RenderedContent {
  statementMd: string;
  starterCode: Record<string, string>;
  referenceSolution: Record<string, string>;
}

function codeEntries(v: unknown): [string, string][] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [];
  return Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string');
}

/** Renders statement, starter code and reference solution for one variant (ADR 0007 V-2). */
export function renderContent(
  content: TemplateContent,
  params: Params,
): { ok: true; content: RenderedContent } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const run = (label: string, template: string, max: number): string => {
    const r = renderTemplate(template, params, max);
    if (r.ok) return r.text;
    for (const e of r.errors) errors.push(`${label}: ${e}`);
    return '';
  };
  const statementMd = run('statementMd', content.statementMd, MAX_STATEMENT_LENGTH);
  const code = (field: string, v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [lang, src] of codeEntries(v))
      out[lang] = run(`${field}.${lang}`, src, MAX_CODE_LENGTH);
    return out;
  };
  const starterCode = code('starterCode', content.starterCode);
  const referenceSolution = code('referenceSolution', content.referenceSolution);
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, content: { statementMd, starterCode, referenceSolution } };
}
