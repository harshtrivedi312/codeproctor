/*
 * Variant parameters (ADR 0007): each variant carries its own explicit values, a JSON object of
 * name to scalar. There is no declared parameter schema (DL-32); the only cross-check is that
 * every `{{name}}` placeholder the question uses has a value in each variant.
 */

export type Params = Record<string, unknown>;

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

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every value must be a string or a finite number, and every name a valid placeholder name. */
export function checkParams(value: Params): string[] {
  const errors: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (!NAME.test(key)) {
      errors.push(`"${key}" is not a valid name. Use letters, digits and underscores.`);
    }
    const scalar = typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    if (!scalar) errors.push(`"${key}" must be a string or a number.`);
  }
  return errors;
}

/** Placeholders the question uses that this variant gives no value. */
export function missingPlaceholders(value: Params, used: readonly string[]): string[] {
  return used.filter((name) => !Object.prototype.hasOwnProperty.call(value, name));
}
