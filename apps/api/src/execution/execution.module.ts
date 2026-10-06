import { Module } from '@nestjs/common';
import { Judge0Module } from '../judge0/judge0.module';
import { ExecutionService } from './execution.service';
import { ReferenceValidationService } from './reference-validation.service';

@Module({
  imports: [Judge0Module],
  providers: [ExecutionService, ReferenceValidationService],
  exports: [ExecutionService, ReferenceValidationService],
})
export class ExecutionModule {}
