// OQ-10 hook (decisions.md): a SUPER_ADMIN legal hold per candidate that pauses all deletion. Off
// until Legal decides (RETENTION_LEGAL_HOLD). When on, RetentionService asks this port before it
// touches a session. The default holds nothing.
import { Injectable } from '@nestjs/common';

export abstract class LegalHoldPort {
  /** True if deletion for this session's candidate is paused. Never throws a value; a failure counts as held. */
  abstract isHeld(orgId: string, sessionId: string): Promise<boolean>;
}

@Injectable()
export class NoLegalHold extends LegalHoldPort {
  isHeld(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
