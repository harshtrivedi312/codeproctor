import { Module } from '@nestjs/common';
import { SessionKeyService } from './session-key.service';
import { SessionStateService } from './session-state.service';
import { SessionWritableGuard } from './session-write-gate';
import { ColumnVerifyConditions, VerifyConditionsPort } from './verify-conditions.port';
import { VerifySessionJobs } from './verify-session.jobs';

// The session state machine, the per-session key and the session-job layer (BE-07). Exported for
// BE-06 (creates INVITED sessions), BE-10 and BE-08b (enqueueVerifySession), BE-11 (assertWritable)
// and BE-13.
// The per-session locks are SessionStateService wrappers over database/session-locks (FU-BEB-111).
@Module({
  providers: [
    SessionStateService,
    SessionKeyService,
    SessionWritableGuard,
    VerifySessionJobs,
    { provide: VerifyConditionsPort, useClass: ColumnVerifyConditions },
  ],
  exports: [
    SessionStateService,
    SessionKeyService,
    SessionWritableGuard,
    VerifySessionJobs,
    VerifyConditionsPort,
  ],
})
export class SessionModule {}
