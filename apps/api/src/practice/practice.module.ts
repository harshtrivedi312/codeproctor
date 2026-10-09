import { Module } from '@nestjs/common';
import { CandidateModule } from '../candidate/candidate.module';
import { ExecutionModule } from '../execution/execution.module';
import { PracticeController } from './practice.controller';
import { PracticeService } from './practice.service';

// FR-406 (practice question). No database access at all.
@Module({
  imports: [CandidateModule, ExecutionModule],
  controllers: [PracticeController],
  providers: [PracticeService],
})
export class PracticeModule {}
