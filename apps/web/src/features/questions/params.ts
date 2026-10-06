import type { Schemas } from '@/lib/api/client';

export type ParamDef = Schemas['ParamDef'];
export type Params = Record<string, unknown>;

export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses the text of a variant's parameters editor. Only a JSON object is accepted. */
export function parseParams(
  text: string,
): { ok: true; value: Params } | { ok: false; error: string } {
  if (text.trim() === '')
    return { ok: false, error: 'Enter the parameters as a JSON object, for example {"n": 5}.' };
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

function typeOf(value: unknown): ParamDef['type'] | 'other' {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  return 'other';
}

/** Checks one variant's parameters against the question's declared parameters. Empty list means valid. */
export function checkParams(value: Params, defs: readonly ParamDef[]): string[] {
  const errors: string[] = [];
  for (const def of defs) {
    if (!Object.prototype.hasOwnProperty.call(value, def.name)) {
      errors.push(`"${def.name}" is missing. Add it as a ${def.type}.`);
      continue;
    }
    if (typeOf(value[def.name]) !== def.type) {
      errors.push(`"${def.name}" must be a ${def.type}.`);
    }
  }
  const known = new Set(defs.map((d) => d.name));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      errors.push(`"${key}" is not a declared parameter. Declare it above or remove it.`);
    }
  }
  return errors;
}

/** Placeholders that no declared parameter covers (they would render literally). */
export function undeclaredPlaceholders(
  used: readonly string[],
  defs: readonly ParamDef[],
): string[] {
  const known = new Set(defs.map((d) => d.name));
  return used.filter((name) => !known.has(name));
}
