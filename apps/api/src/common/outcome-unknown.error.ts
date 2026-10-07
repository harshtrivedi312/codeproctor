// DL-37 / FU-BE-208 / api-contract section 8 "Outcome unknown on a write": an action's own
// transaction failed AFTER its callback returned (P2028 or P1017 at COMMIT, a driver connection
// error), so the commit may or may not have landed. Answering 503 would invite an automatic retry
// that repeats the action; 409 or 401 would say nothing true. ProblemFilter maps exactly this type
// to the generic fixed 500: no code, no Retry-After, no database detail. The error carries only a
// fixed route label (a constant such as 'users.invite', never an entity id, actor or organisation
// id), no cause and no database message: the filter logs the error name and the route, which is
// the alert signal. Rollbacks (40001, 40P01, P2034) are NOT this type and stay 503 BUSY, and so is
// contention before the callback returned; other errors before that point are not this type
// either and keep their ordinary handling (the generic 500 for an unknown error).
export class OutcomeUnknownError extends Error {
  constructor(readonly route: string) {
    super('Write outcome unknown');
    this.name = 'OutcomeUnknownError';
  }
}
