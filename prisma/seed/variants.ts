// Resolves what a candidate sees and what the grader uses for one variant of a coding question
// (ADR 0007): rendered texts, and for every test slot the input and expected output after the
// variant's overrides. Pure functions of the question definition.
import { renderTemplate } from './mustache';
import type { CodingQuestionSpec, Language, SourceByLanguage, TestSlot } from './types';
import { LANGUAGES } from './types';

export interface ResolvedSlot {
  readonly index: number;
  readonly input: string;
  readonly expectedOutput: string;
  readonly hidden: boolean;
  readonly weight: number;
}

export function resolveSlots(spec: CodingQuestionSpec, variantIndex: number): ResolvedSlot[] {
  const variant = spec.variants[variantIndex];
  if (variant === undefined) throw new Error(`${spec.slug} has no variant ${variantIndex}.`);
  return spec.slots.map((slot: TestSlot, index: number) => {
    const input = variant.inputOverrides?.[index] ?? slot.input;
    return {
      index,
      input,
      expectedOutput: spec.solve(variant.params, input),
      hidden: slot.hidden,
      weight: slot.weight,
    };
  });
}

/** The slot data of the base (variant 0). These are the test_cases defaults. */
export function defaultSlots(spec: CodingQuestionSpec): ResolvedSlot[] {
  return resolveSlots(spec, 0);
}

export function renderSources(
  templates: SourceByLanguage,
  params: CodingQuestionSpec['variants'][number]['params'],
): Record<Language, string> {
  const rendered = {} as Record<Language, string>;
  for (const language of LANGUAGES)
    rendered[language] = renderTemplate(templates[language], params);
  return rendered;
}
