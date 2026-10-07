import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { SessionStateService } from '../session/session-state.service';
import { TestsModule } from '../tests/tests.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { INVITED_SESSION_PORT } from './invited-session.port';

// The INVITED session row is created by SessionStateService.createInvited, the only writer of
// sessions.status (ADR 0002). Its signature is the port's, so no adapter class is needed.
@Module({
  imports: [TestsModule, SessionModule],
  controllers: [InvitationsController],
  providers: [
    InvitationsService,
    { provide: INVITED_SESSION_PORT, useExisting: SessionStateService },
  ],
})
export class InvitationsModule {}
