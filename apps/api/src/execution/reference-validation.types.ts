import type { ExecLanguage } from '../judge0/language-map';
import type { TestVerdict } from './execution.types';

/** One test slot with the variant's own data already resolved (ADR 0007: variant_test_cases). */
export interface ValidationTestSlot {
  readonly testCaseId: string;
  readonly position: number;
  readonly input: string;
  readonly expectedOutput: string;
}

export interface ValidationVariant {
  /** null for a question with no variants: the default data is validated as one implicit variant. */
  readonly variantId: string | null;
  /** Reference solution per language, with this variant's params already rendered (Mustache, BE-04). */
  readonly referenceSources: Readonly<Partial<Record<ExecLanguage, string>>>;
  readonly tests: readonly ValidationTestSlot[];
}

export interface ValidationInput {
  readonly questionVersionId: string;
  /** Free label for reports and the seed run (for example the slug). */
  readonly label?: string;
  readonly limits: unknown;
  /** question_versions.allowed_languages; every one needs a reference that passes. */
  readonly languages: readonly ExecLanguage[];
  /** Active variants only. */
  readonly variants: readonly ValidationVariant[];
}

export interface ValidationFailure {
  readonly variantId: string | null;
  readonly language: ExecLanguage;
  readonly testCaseId: string | null;
  readonly position: number | null;
  readonly verdict: TestVerdict | 'MISSING_REFERENCE';
  /** Capped actual output on a wrong answer, for the author; absent otherwise. */
  readonly actualOutput?: string;
}

export interface ValidationCell {
  readonly variantId: string | null;
  readonly language: ExecLanguage;
  readonly passed: boolean;
  readonly testsPassed: number;
  readonly testsTotal: number;
}

/** Stored in question_versions.validation_report (FR-203, TC-012). */
export interface ValidationReport {
  readonly questionVersionId: string;
  readonly passed: boolean;
  /** Server time of the run (the only clock). */
  readonly validatedAt: string;
  readonly cells: readonly ValidationCell[];
  readonly failures: readonly ValidationFailure[];
}

/**
 * Port for storing the report and setting validated_at. BE-04 (QuestionsModule) implements it; the
 * publish gate reads validated_at and the report. Not implemented in BE-05 (follow-up FU-BE-05-1).
 */
export interface ValidationReportSink {
  save(report: ValidationReport): Promise<void>;
}
export const VALIDATION_REPORT_SINK = Symbol('VALIDATION_REPORT_SINK');
