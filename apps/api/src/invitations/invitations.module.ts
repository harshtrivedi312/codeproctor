import { Module } from '@nestjs/common';
import { TestsModule } from '../tests/tests.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { FailClosedInvitedSessionPort, INVITED_SESSION_PORT } from './invited-session.port';

// The INVITED session port fails closed until SessionStateService (PR #98) is on main; see
// invited-session.port.ts for the one-line binding that replaces the default provider.
@Module({
  imports: [TestsModule],
  controllers: [InvitationsController],
  providers: [
    InvitationsService,
    { provide: INVITED_SESSION_PORT, useClass: FailClosedInvitedSessionPort },
  ],
})
export class InvitationsModule {}
