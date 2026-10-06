import { Inject, Injectable, Optional } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { VALIDATION_REPORT_SINK } from './reference-validation.types';
import type {
  ValidationCell,
  ValidationFailure,
  ValidationInput,
  ValidationReport,
  ValidationReportSink,
} from './reference-validation.types';

const MAX_FAILURE_OUTPUT_CHARS = 500;

export interface SeededValidationSummary {
  readonly passed: boolean;
  readonly questionCount: number;
  /** Distinct (question, language) pairs checked, for example 6 x 3 = 18 on the seed (R-11). */
  readonly questionLanguagePairs: number;
  readonly reports: readonly { readonly label: string; readonly report: ValidationReport }[];
}

@Injectable()
export class ReferenceValidationService {
  constructor(
    private readonly execution: ExecutionService,
    @Optional() @Inject(VALIDATION_REPORT_SINK) private readonly sink?: ValidationReportSink,
  ) {}

  /** Server time; replaceable in tests. */
  clock: () => Date = () => new Date();

  /**
   * Runs the reference solution of every allowed language against every test slot of every active
   * variant, with that variant's data (FR-203, TC-012). A missing reference or a question with no
   * variants and no tests fails. Pure: nothing is stored.
   */
  async validate(input: ValidationInput): Promise<ValidationReport> {
    const cells: ValidationCell[] = [];
    const failures: ValidationFailure[] = [];

    if (input.variants.length === 0 || input.languages.length === 0) {
      failures.push({
        variantId: null,
        language: input.languages[0] ?? 'python',
        testCaseId: null,
        position: null,
        verdict: 'MISSING_REFERENCE',
      });
    }

    // Sequential on purpose: validation must not starve candidate runs of sandbox capacity.
    for (const variant of input.variants) {
      for (const language of input.languages) {
        const source = variant.referenceSources[language];
        if (source === undefined || source.trim() === '' || variant.tests.length === 0) {
          cells.push({
            variantId: variant.variantId,
            language,
            passed: false,
            testsPassed: 0,
            testsTotal: variant.tests.length,
          });
          failures.push({
            variantId: variant.variantId,
            language,
            testCaseId: null,
            position: null,
            verdict: 'MISSING_REFERENCE',
          });
          continue;
        }
        const run = await this.execution.runCaptured({
          language,
          sourceCode: source,
          limits: input.limits,
          tests: variant.tests.map((t) => ({
            id: t.testCaseId,
            input: t.input,
            expectedOutput: t.expectedOutput,
            reveal: false,
          })),
        });
        let passedCount = 0;
        run.results.forEach((r, index) => {
          if (r.passed) {
            passedCount += 1;
            return;
          }
          const slot = variant.tests[index];
          failures.push({
            variantId: variant.variantId,
            language,
            testCaseId: r.testId,
            position: slot?.position ?? null,
            verdict: r.verdict,
            ...(r.verdict === 'FAILED' && r.rawActualOutput !== undefined
              ? { actualOutput: r.rawActualOutput.slice(0, MAX_FAILURE_OUTPUT_CHARS) }
              : {}),
            ...(r.diagnostic !== undefined
              ? { diagnostic: r.diagnostic.slice(0, MAX_FAILURE_OUTPUT_CHARS) }
              : {}),
          });
        });
        cells.push({
          variantId: variant.variantId,
          language,
          passed: passedCount === variant.tests.length,
          testsPassed: passedCount,
          testsTotal: variant.tests.length,
        });
      }
    }

    return {
      questionVersionId: input.questionVersionId,
      passed: failures.length === 0 && cells.length > 0,
      validatedAt: this.clock().toISOString(),
      cells,
      failures,
    };
  }

  /** validate() then hand the report to the BE-04 sink. Throws if no sink is wired. */
  async validateAndRecord(input: ValidationInput): Promise<ValidationReport> {
    if (!this.sink) throw new Error('ValidationReportSink is not provided (BE-04)');
    const report = await this.validate(input);
    await this.sink.save(report);
    return report;
  }

  /** Seed check (PA-05, R-11): validates many questions and summarizes. Stores nothing. */
  async validateSeeded(inputs: readonly ValidationInput[]): Promise<SeededValidationSummary> {
    const reports: { label: string; report: ValidationReport }[] = [];
    let pairs = 0;
    for (const input of inputs) {
      reports.push({
        label: input.label ?? input.questionVersionId,
        report: await this.validate(input),
      });
      pairs += input.languages.length;
    }
    return {
      passed: reports.length > 0 && reports.every((r) => r.report.passed),
      questionCount: inputs.length,
      questionLanguagePairs: pairs,
      reports,
    };
  }
}
