import { Module } from '@nestjs/common';
import { CandidateModule } from '../candidate/candidate.module';
import { ExecutionModule } from '../execution/execution.module';
import { GradingModule } from '../grading/grading.module';
import { SessionModule } from '../session/session.module';
import { AnswersController } from './answers.controller';
import { AnswersService } from './answers.service';
import { QuestionsController } from './questions.controller';
import { QuestionViewService } from './question-view.service';
import { QuestionGateService } from './question-gate.service';
import { SubmitLimiter } from './submit-limiter';

// FR-502, FR-504, FR-505, FR-506 (BE-11): run, draft, submit and finish. CandidateModule supplies the
// one CandidateScope, the token service and the per-session rate limiter.
@Module({
  imports: [CandidateModule, SessionModule, ExecutionModule, GradingModule],
  controllers: [AnswersController, QuestionsController],
  providers: [AnswersService, QuestionGateService, QuestionViewService, SubmitLimiter],
})
export class SubmissionsModule {}
