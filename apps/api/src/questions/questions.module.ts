import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { AiReferencesController } from './ai-references.controller';
import { AiReferencesService } from './ai-references.service';
import { ExecutionValidationAdapter } from './execution-validation.adapter';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';
import { REFERENCE_VALIDATION_PORT } from './reference-validation.port';
import { ValidationController } from './validation.controller';
import { ValidationService } from './validation.service';
import { VariantsController } from './variants.controller';
import { VariantsService } from './variants.service';

@Module({
  imports: [ExecutionModule],
  controllers: [
    QuestionsController,
    VariantsController,
    ValidationController,
    AiReferencesController,
  ],
  providers: [
    QuestionsService,
    VariantsService,
    ValidationService,
    AiReferencesService,
    ExecutionValidationAdapter,
    { provide: REFERENCE_VALIDATION_PORT, useExisting: ExecutionValidationAdapter },
  ],
})
export class QuestionsModule {}
