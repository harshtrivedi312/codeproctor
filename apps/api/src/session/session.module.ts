import { Module } from '@nestjs/common';
import { SessionKeyService } from './session-key.service';
import { SessionStateService } from './session-state.service';
import { SessionWritableGuard } from './session-write-gate';

// The session state machine and the per-session key (BE-07). Exported for BE-06 (creates INVITED
// sessions), BE-10, BE-11 (assertWritable) and BE-13.
@Module({
  providers: [SessionStateService, SessionKeyService, SessionWritableGuard],
  exports: [SessionStateService, SessionKeyService, SessionWritableGuard],
})
export class SessionModule {}
