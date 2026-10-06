/*
 * Mustache placeholders in a question (ADR 0007 V-2). Only plain `{{name}}` variables are
 * supported: Mustache is logic-less, so nothing here runs code. Sections, partials and
 * triple-braces are flagged instead of being half-supported.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const UNSUPPORTED = /\{\{\{|\{\{\s*[#^/!>&]/;

/** The distinct placeholder names used in the text, in order of first use. */
export function placeholdersOf(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** True when the text uses Mustache syntax beyond `{{name}}` (sections, partials, `{{{x}}}`). */
export function hasUnsupportedSyntax(text: string): boolean {
  return UNSUPPORTED.test(text);
}

function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Replaces each `{{name}}` with the variant's value. Strings are inserted as they are, arrays as
 * JSON (valid in Python and JavaScript). Names without a value stay as written and are listed in
 * `missing`, so the preview never hides a mistake.
 */
export function renderTemplate(
  text: string,
  params: Readonly<Record<string, unknown>>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return show(params[name]);
  });
  return { text: out, missing };
}
