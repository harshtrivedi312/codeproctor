import { AI_REFERENCE_LANGUAGES, type CodeLanguage } from '@codeproctor/shared';
import type { Schemas } from '@/lib/api/client';

export type AiReference = Schemas['AiReference'];

/**
 * What the AI gate assumes. The API does NOT expose the organisation's policy to Authors (org
 * settings are SUPER_ADMIN only): `minAssistants` is the API's own default (2, D-20) and is only a
 * hint, because the API's 422 on publish is the truth; `refreshDays` exists only in the web (the
 * "refresh due" badge is advisory). Both are defaults, not settings.
 */
export interface AiPolicy {
  refreshDays: number;
  minAssistants: number;
}
export const DEFAULT_AI_POLICY: AiPolicy = { refreshDays: 90, minAssistants: 2 };

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LanguageGate {
  language: CodeLanguage;
  /** Distinct assistants with a current (not superseded) row, as the author typed them. */
  assistants: string[];
  required: number;
  ok: boolean;
}

function key(assistant: string): string {
  return assistant.trim().toLowerCase();
}

/**
 * ADR 0005 AI-5: for each allowed language that has AI references (python, javascript, java),
 * publishing needs current rows from at least `minAssistants` distinct assistants. 0 turns it off.
 */
export function aiGate(
  allowedLanguages: readonly CodeLanguage[],
  refs: readonly AiReference[],
  policy: AiPolicy,
): LanguageGate[] {
  return allowedLanguages
    .filter((language) => AI_REFERENCE_LANGUAGES.includes(language))
    .map((language) => {
      const seen = new Map<string, string>();
      for (const r of refs) {
        if (r.language === language && r.supersededAt === null && !seen.has(key(r.assistant))) {
          seen.set(key(r.assistant), r.assistant.trim());
        }
      }
      const assistants = [...seen.values()];
      return {
        language,
        assistants,
        required: policy.minAssistants,
        ok: assistants.length >= policy.minAssistants,
      };
    });
}

export function aiGatePassed(gates: readonly LanguageGate[]): boolean {
  return gates.every((g) => g.ok);
}

/** ADR 0005 AI-4: "refresh due" when the newest row is older than `refreshDays`. No rows, no badge. */
export function aiRefreshDue(refs: readonly AiReference[], policy: AiPolicy, now: Date): boolean {
  if (refs.length === 0) return false;
  const newest = Math.max(...refs.map((r) => new Date(r.collectedAt).getTime()));
  return now.getTime() - newest > policy.refreshDays * DAY_MS;
}

export interface PublishInput {
  type: Schemas['QuestionType'];
  isPublished: boolean;
  dirty: boolean;
  validationPassed: boolean;
  aiGates: readonly LanguageGate[];
}

export interface PublishCheck {
  id: 'saved' | 'validated' | 'ai';
  label: string;
  ok: boolean;
  hint: string;
}

/** The publish checklist. Publish is enabled only when every item is ok (TC-012, AI-5). */
export function publishChecks(input: PublishInput): PublishCheck[] {
  const checks: PublishCheck[] = [
    {
      id: 'saved',
      label: 'All changes saved',
      ok: !input.dirty,
      hint: 'Save your changes first. Publishing uses the saved version.',
    },
  ];
  // Only coding questions are validated (TC-012); the API publishes a complete multiple-choice or
  // short-answer question without a validation run.
  if (input.type === 'CODING') {
    checks.push(
      {
        id: 'validated',
        label: 'Validation passed on every variant and test',
        ok: input.validationPassed,
        hint: 'Press Validate. Any edit after a validation clears it.',
      },
      {
        id: 'ai',
        label: 'AI reference solutions collected',
        ok: aiGatePassed(input.aiGates),
        hint: 'Add solutions from enough different AI assistants for each language on the AI reference solutions tab.',
      },
    );
  }
  return checks;
}

export function canPublish(input: PublishInput): boolean {
  return !input.isPublished && publishChecks(input).every((c) => c.ok);
}
