/*
 * Placeholders in a question (ADR 0007 V-2), the same subset the API renders (variant-template.ts):
 * `{{name}}` only. `\{{` writes a literal `{{`; any other `{{...}}` (sections, partials, triple
 * braces, dotted paths) is an error, and a name without a value is an error, never rendered empty.
 * Nothing runs code and nothing is HTML-escaped.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const validName = (n: string): boolean =>
  NAME.test(n) && !n.startsWith('__') && n !== 'constructor' && n !== 'prototype';

type Token = { kind: 'text'; text: string } | { kind: 'var'; name: string };

function tokenize(template: string): { tokens: Token[]; errors: number } {
  const tokens: Token[] = [];
  let errors = 0;
  let text = '';
  let i = 0;
  const flush = (): void => {
    if (text) tokens.push({ kind: 'text', text });
    text = '';
  };
  while (i < template.length) {
    if (template.startsWith('\\{{', i)) {
      text += '{{';
      i += 3;
    } else if (template.startsWith('{{', i)) {
      const close = template.indexOf('}}', i + 2);
      if (close === -1 || close - i > 80) {
        errors += 1;
        break;
      }
      const name = template.slice(i + 2, close).trim();
      if (validName(name)) {
        flush();
        tokens.push({ kind: 'var', name });
      } else {
        errors += 1;
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

/** The distinct placeholder names used in the text, in order of first use. */
export function placeholdersOf(text: string): string[] {
  const names: string[] = [];
  for (const t of tokenize(text).tokens) {
    if (t.kind === 'var' && !names.includes(t.name)) names.push(t.name);
  }
  return names;
}

/** True when the text uses `{{...}}` beyond `{{name}}` (sections, partials, `{{{x}}}`, an unclosed tag). */
export function hasUnsupportedSyntax(text: string): boolean {
  return tokenize(text).errors > 0;
}

/**
 * Replaces each `{{name}}` with the variant's value (strings as they are, numbers and booleans as
 * text). Names without a value stay as written and are listed in `missing`, so the preview never
 * hides a mistake. The API's own rendering is the one that counts; this is the live preview.
 */
export function renderTemplate(
  text: string,
  params: Readonly<Record<string, unknown>>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = tokenize(text)
    .tokens.map((t) => {
      if (t.kind === 'text') return t.text;
      if (!Object.hasOwn(params, t.name)) {
        if (!missing.includes(t.name)) missing.push(t.name);
        return `{{${t.name}}}`;
      }
      const v = params[t.name];
      return typeof v === 'string'
        ? v
        : typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : JSON.stringify(v);
    })
    .join('');
  return { text: out, missing };
}
