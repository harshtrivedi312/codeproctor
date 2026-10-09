import { Module } from '@nestjs/common';
import { CandidateModule } from '../candidate/candidate.module';
import { SessionModule } from '../session/session.module';
import { ProctorEventsController } from './proctor-events.controller';
import { ProctorEventsService } from './proctor-events.service';

// BE-10: signed event and keystroke batches. Uses the candidate guard, scope and rate limiter of
// the candidate module and the key service and state machine of the session module.
@Module({
  imports: [CandidateModule, SessionModule],
  controllers: [ProctorEventsController],
  providers: [ProctorEventsService],
})
export class ProctorEventsModule {}
