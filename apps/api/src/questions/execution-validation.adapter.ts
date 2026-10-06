// Adapts Backend B's ReferenceValidationService (BE-05) to the question bank's port. The only file
// of the question bank that imports from execution/ and judge0/.
import { Injectable } from '@nestjs/common';
import { ReferenceValidationService } from '../execution/reference-validation.service';
import { isExecLanguage } from '../judge0/language-map';
import type { ExecLanguage } from '../judge0/language-map';
import type { PortRequest, PortResult, ReferenceValidationPort } from './reference-validation.port';

@Injectable()
export class ExecutionValidationAdapter implements ReferenceValidationPort {
  constructor(private readonly validation: ReferenceValidationService) {}

  async validate(request: PortRequest): Promise<PortResult> {
    const languages: ExecLanguage[] = [];
    for (const l of request.languages) {
      // Fail closed: a language the executor cannot run can never validate.
      if (!isExecLanguage(l)) throw new Error('A language of the question cannot be executed.');
      languages.push(l);
    }
    const report = await this.validation.validate({
      questionVersionId: request.questionVersionId,
      limits: request.limits,
      languages,
      variants: request.variants.map((v) => {
        const sources: Partial<Record<ExecLanguage, string>> = {};
        for (const l of languages) {
          const s = v.referenceSources[l];
          if (s !== undefined) sources[l] = s;
        }
        return {
          variantId: v.variantId,
          referenceSources: sources,
          tests: v.tests.map((t) => ({
            testCaseId: t.testCaseId,
            position: t.position,
            input: t.input,
            expectedOutput: t.expectedOutput,
          })),
        };
      }),
    });
    return { passed: report.passed, cells: report.cells, failures: report.failures };
  }
}
