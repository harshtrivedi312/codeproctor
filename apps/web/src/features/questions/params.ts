/*
 * Variant parameters (ADR 0007): each variant carries its own explicit values, a JSON object of
 * name to scalar (string, number or boolean, the API's rule since BE-04b). There is no declared
 * parameter schema; the only cross-check is that every `{{name}}` placeholder the question uses has
 * a value in each variant.
 */

export type Params = Record<string, unknown>;
export type ParamValue = string | number | boolean;

export const MAX_PARAM_KEYS = 50;
export const MAX_PARAM_VALUE_LENGTH = 1000;

/** Parses the text of a variant's parameters editor. Only a JSON object is accepted. */
export function parseParams(
  text: string,
): { ok: true; value: Params } | { ok: false; error: string } {
  if (text.trim() === '') {
    return { ok: false, error: 'Enter the parameters as a JSON object, for example {"n": 5}.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'not valid JSON';
    return { ok: false, error: `This is not valid JSON (${detail}). Check commas and quotes.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'The parameters must be a JSON object such as {"n": 5}, not a list or a single value.',
    };
  }
  return { ok: true, value: parsed as Params };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** The API's rules (variant-template.ts paramsProblems), as hints to fix. */
export function checkParams(value: Params): string[] {
  const errors: string[] = [];
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAM_KEYS) errors.push(`Use at most ${MAX_PARAM_KEYS} parameters.`);
  for (const [key, v] of entries) {
    if (!NAME.test(key) || key.startsWith('__') || key === 'constructor' || key === 'prototype') {
      errors.push(
        `"${key}" is not a valid name. Use 1 to 40 letters, digits and underscores, not starting with a digit or two underscores.`,
      );
    }
    if (typeof v === 'string') {
      if (v.length > MAX_PARAM_VALUE_LENGTH) {
        errors.push(`"${key}" is too long: at most ${MAX_PARAM_VALUE_LENGTH} characters.`);
      }
    } else if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
      errors.push(`"${key}" must be a string, a number or true or false.`);
    }
  }
  return errors;
}

/** Placeholders the question uses that this variant gives no value. */
export function missingPlaceholders(value: Params, used: readonly string[]): string[] {
  return used.filter((name) => !Object.prototype.hasOwnProperty.call(value, name));
}
