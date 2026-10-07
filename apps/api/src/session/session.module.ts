import { Module } from '@nestjs/common';
import { SessionKeyService } from './session-key.service';
import { SessionLockPort, UnwiredSessionLockPort } from './session-lock.port';
import { SessionStateService } from './session-state.service';
import { SessionWritableGuard } from './session-write-gate';
import { ColumnVerifyConditions, VerifyConditionsPort } from './verify-conditions.port';
import { VerifySessionJobs } from './verify-session.jobs';

// The session state machine, the per-session key and the session-job layer (BE-07). Exported for
// BE-06 (creates INVITED sessions), BE-10 and BE-08b (enqueueVerifySession), BE-11 (assertWritable)
// and BE-13. SessionLockPort is bound to a port that always throws until database/session-locks lands (FU-BEB-111).
@Module({
  providers: [
    SessionStateService,
    SessionKeyService,
    SessionWritableGuard,
    VerifySessionJobs,
    { provide: SessionLockPort, useClass: UnwiredSessionLockPort },
    { provide: VerifyConditionsPort, useClass: ColumnVerifyConditions },
  ],
  exports: [
    SessionStateService,
    SessionKeyService,
    SessionWritableGuard,
    VerifySessionJobs,
    SessionLockPort,
    VerifyConditionsPort,
  ],
})
export class SessionModule {}
