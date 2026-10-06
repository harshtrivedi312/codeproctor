// Two ports the identity check leans on that other tracks own (design notes section 2).
import { Injectable, Logger } from '@nestjs/common';

/** Enqueues the `face-match` job. Ids only; the job id is the idempotency key (CS-4.7, `_` not `:`). */
export abstract class FaceMatchQueue {
  abstract enqueue(orgId: string, sessionId: string, attempt: number): Promise<void>;
}

/**
 * `verify-session` (CONSENTED to VERIFIED when every check is done, ADR 0013 CS-4.7, ADR 0015
 * section 7: the identity gate is PASSED, MANUAL_REVIEW or WAIVED). BE-07 owns that job and it is
 * not on this branch, so the default only logs a fixed code. Replace the binding when it lands.
 */
export abstract class VerifySessionPort {
  abstract enqueue(orgId: string, sessionId: string): Promise<void>;
}

@Injectable()
export class UnboundVerifySessionPort extends VerifySessionPort {
  private readonly logger = new Logger(UnboundVerifySessionPort.name);

  enqueue(): Promise<void> {
    this.logger.warn('verify-session is not bound yet (BE-07)');
    return Promise.resolve();
  }
}
