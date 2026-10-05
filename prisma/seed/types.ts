// Shapes for the seeded coding questions (DB-04). A question is plain data plus a TypeScript oracle
// (`solve`) that computes every expected output, so test data and the statement's worked example
// cannot drift from each other. The reference solutions are separate programs in Python, JavaScript
// and Java; a plan test runs them against the oracle's outputs (BE-05 validates them again later).

export const LANGUAGES = ['python', 'javascript', 'java'] as const;
export type Language = (typeof LANGUAGES)[number];
export type SourceByLanguage = Readonly<Record<Language, string>>;

export type ParamValue = string | number;
export type Params = Readonly<Record<string, ParamValue>>;

export type CodingDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

/** One test slot (test_cases row). The first three slots of a question are samples. */
export interface TestSlot {
  readonly input: string;
  readonly hidden: boolean;
  readonly weight: number;
}

export interface VariantSpec {
  /** Rendered into the statement, starter code and reference solution (ADR 0007 V-2). */
  readonly params: Params;
  /** Slot index (0-based) to the input this variant uses instead of the slot's default input. */
  readonly inputOverrides?: Readonly<Record<number, string>>;
}

export interface AiSolutionSet {
  /** What the first synthetic assistant "wrote", per language. */
  readonly assistantA: SourceByLanguage;
  /** What the second synthetic assistant "wrote", per language. */
  readonly assistantB: SourceByLanguage;
}

export interface CodingQuestionSpec {
  readonly slug: string;
  readonly title: string;
  readonly difficulty: CodingDifficulty;
  readonly tags: readonly string[];
  readonly statementTemplate: string;
  readonly starterTemplates: SourceByLanguage;
  readonly referenceTemplates: SourceByLanguage;
  /** 11 slots: 3 samples, then 8 hidden. Defaults are the data of variant 0. */
  readonly slots: readonly TestSlot[];
  /** Variant 0 uses the defaults and the base params. */
  readonly variants: readonly [VariantSpec, VariantSpec, VariantSpec];
  /** The expected output (no trailing newline) of a variant's params on an input. */
  readonly solve: (params: Params, input: string) => string;
  /** AI reference solutions for the base statement (variant 0's params, hard-coded). */
  readonly aiSolutions: AiSolutionSet;
}

export const SAMPLE_COUNT = 3;
export const HIDDEN_COUNT = 8;
/** Hidden slot weights (ADR 0007 section 3: score uses hidden weights only). Sum 15. */
export const HIDDEN_WEIGHTS: readonly number[] = [1, 1, 1, 2, 2, 2, 3, 3];

export function sampleSlot(input: string): TestSlot {
  return { input, hidden: false, weight: 1 };
}

/** Builds the 8 hidden slots from inputs, in order, with HIDDEN_WEIGHTS. */
export function hiddenSlots(inputs: readonly string[]): TestSlot[] {
  if (inputs.length !== HIDDEN_COUNT) {
    throw new Error(`A question needs ${HIDDEN_COUNT} hidden inputs, got ${inputs.length}.`);
  }
  return inputs.map((input, index) => ({
    input,
    hidden: true,
    weight: HIDDEN_WEIGHTS[index] as number,
  }));
}

export const SYNTHETIC_CODE_NOTE = 'SYNTHETIC SEED DATA - not produced by an AI assistant.';
