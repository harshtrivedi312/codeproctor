// The question bank's port to code execution (FR-203, ADR 0007 V-3). The validate job talks to
// this interface only; execution-validation.adapter.ts is the one file that knows Backend B's
// ReferenceValidationService (BE-05) and Judge0. Tests supply a fake.

/** One test slot with the variant's own data already merged in (V-1, V-5). */
export interface PortTestSlot {
  readonly testCaseId: string;
  readonly position: number;
  readonly isHidden: boolean;
  readonly input: string;
  readonly expectedOutput: string;
}

export interface PortVariant {
  /** null: the base content, validated as one implicit variant when no variant is active. */
  readonly variantId: string | null;
  /** Reference solution per language with this variant's params already rendered. */
  readonly referenceSources: Readonly<Record<string, string>>;
  readonly tests: readonly PortTestSlot[];
}

export interface PortRequest {
  readonly questionVersionId: string;
  readonly limits: unknown;
  readonly languages: readonly string[];
  readonly variants: readonly PortVariant[];
}

export interface PortCell {
  readonly variantId: string | null;
  readonly language: string;
  readonly passed: boolean;
  readonly testsPassed: number;
  readonly testsTotal: number;
}

export interface PortFailure {
  readonly variantId: string | null;
  readonly language: string;
  readonly testCaseId: string | null;
  readonly position: number | null;
  readonly verdict: string;
  readonly actualOutput?: string;
  readonly diagnostic?: string;
}

export interface PortResult {
  readonly passed: boolean;
  readonly cells: readonly PortCell[];
  readonly failures: readonly PortFailure[];
}

export interface ReferenceValidationPort {
  /** Runs every language's reference on every slot of every variant. Rejects when it cannot run. */
  validate(request: PortRequest): Promise<PortResult>;
}

export const REFERENCE_VALIDATION_PORT = Symbol('REFERENCE_VALIDATION_PORT');
