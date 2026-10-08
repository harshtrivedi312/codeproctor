// Two ports the identity check leans on that other tracks own (design notes section 2).
/** Enqueues the `face-match` job. Ids only; the job id is the idempotency key (CS-4.7, `_` not `:`). */
export abstract class FaceMatchQueue {
  abstract enqueue(orgId: string, sessionId: string, attempt: number): Promise<void>;
}

/**
 * `verify-session` (CONSENTED to VERIFIED when every check is done, ADR 0013 CS-4.7, ADR 0015
 * section 7: the identity gate is PASSED, MANUAL_REVIEW or WAIVED). BE-07 owns that job; the binding
 * is VerifySessionJobs.enqueueVerifySession (identity.module.ts), called inside IdentitySessionJobs only.
 */
export abstract class VerifySessionPort {
  abstract enqueue(orgId: string, sessionId: string): Promise<void>;
}
