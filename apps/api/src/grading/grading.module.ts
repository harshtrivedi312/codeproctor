import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { SessionModule } from '../session/session.module';
import { CloseSectionService } from './close-section.service';
import { GradeSessionService } from './grade-session.service';
import { GradingQueue } from './grading-queue';
import { GradingWorker } from './grading-worker';
import { ManualScoringService } from './manual-scoring.service';
import { SubmitFlowService } from './submit-flow.service';

// FR-505, FR-506, FR-205 (BE-11): section close, auto-submit, grade-session and manual scoring.
// ManualScoringService is exported for the review module (BE-13).
@Module({
  imports: [SessionModule, ExecutionModule],
  providers: [
    GradingQueue,
    CloseSectionService,
    SubmitFlowService,
    GradeSessionService,
    ManualScoringService,
    GradingWorker,
  ],
  exports: [GradingQueue, SubmitFlowService, ManualScoringService, GradeSessionService],
})
export class GradingModule {}
