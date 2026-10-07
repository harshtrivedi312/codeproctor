import { Module } from '@nestjs/common';
import { CandidateModule } from '../candidate/candidate.module';
import { CandidateScope } from '../candidate/candidate-scope';
import { ExecutionModule } from '../execution/execution.module';
import { GradingModule } from '../grading/grading.module';
import { SessionModule } from '../session/session.module';
import { AnswersController } from './answers.controller';
import { AnswersService } from './answers.service';
import { QuestionGateService } from './question-gate.service';
import { SubmitLimiter } from './submit-limiter';

// FR-502, FR-504, FR-505, FR-506 (BE-11): run, draft, submit and finish. CandidateScope is stateless
// and provided here so the guard and the services can use it; CandidateModule supplies the token
// service and the per-session rate limiter.
@Module({
  imports: [CandidateModule, SessionModule, ExecutionModule, GradingModule],
  controllers: [AnswersController],
  providers: [AnswersService, QuestionGateService, SubmitLimiter, CandidateScope],
})
export class SubmissionsModule {}
