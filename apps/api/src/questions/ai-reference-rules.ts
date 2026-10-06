// AI reference solution rules (ADR 0005 AI-5): the publish gate. Pure.
import { AI_REFERENCE_LANGUAGES } from '@codeproctor/shared';

/** Default of `aiReferences.minAssistants` (ADR 0005 D-20). */
export const DEFAULT_MIN_ASSISTANTS = 2;
const MAX_MIN_ASSISTANTS = 10;

/** The configured value, or undefined when the key is missing or not an integer from 0 to 10. */
function configuredMinAssistants(settings: unknown): number | undefined {
  const refs =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>)['aiReferences']
      : undefined;
  const raw =
    typeof refs === 'object' && refs !== null
      ? (refs as Record<string, unknown>)['minAssistants']
      : undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_MIN_ASSISTANTS
    ? raw
    : undefined;
}

/**
 * organizations.settings.aiReferences.minAssistants. A missing key is the default (2); a value that
 * is not an integer from 0 to 10 is also the default (fail closed); 0 turns the gate off.
 */
export function minAssistantsFromSettings(settings: unknown): number {
  return configuredMinAssistants(settings) ?? DEFAULT_MIN_ASSISTANTS;
}

/** Same value plus whether it is the fallback (no valid setting stored). */
export function aiPolicyFromSettings(settings: unknown): {
  minAssistants: number;
  isDefault: boolean;
} {
  const v = configuredMinAssistants(settings);
  return { minAssistants: v ?? DEFAULT_MIN_ASSISTANTS, isDefault: v === undefined };
}

export function normalizeAssistant(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * For each allowed language in the D-20 list, the current (not superseded) rows of the version must
 * come from at least `min` distinct assistants. Rows of a variant count like base rows.
 */
export function aiReferenceProblems(
  allowedLanguages: readonly string[],
  rows: readonly { language: string; assistant: string }[],
  min: number,
): string[] {
  if (min <= 0) return [];
  const problems: string[] = [];
  for (const language of AI_REFERENCE_LANGUAGES) {
    if (!allowedLanguages.includes(language)) continue;
    const have = new Set(
      rows.filter((r) => r.language === language).map((r) => normalizeAssistant(r.assistant)),
    );
    if (have.size < min) {
      problems.push(
        `aiReferences.${language}: needs current rows from at least ${min} distinct assistants (has ${have.size})`,
      );
    }
  }
  return problems;
}
