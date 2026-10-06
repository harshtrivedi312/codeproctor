// DL-37 / api-contract section 8 carve-out (P-37): the audit row of an @Audited route is written
// after the handler committed, in its own transaction. If that write fails, the action has
// happened, so the request must NOT answer 503 + Retry-After (a retry would repeat a
// non-idempotent action). ProblemFilter maps exactly this type to a fixed 500 with no Retry-After
// and no code. The error carries no message from the database and no cause. Contention inside the
// action's own transaction is not this type and stays 503 BUSY.
export class AuditWriteAfterCommitError extends Error {
  constructor() {
    super('Audit write failed after the action committed');
    this.name = 'AuditWriteAfterCommitError';
  }
}
