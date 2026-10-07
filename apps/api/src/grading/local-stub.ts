// The local development stub (DL-54, DL-58; Backend A's PR #298) answers every test with the verdict
// LOCAL_STUB: nothing ran, so it is never a pass or a fail. The check is on the plain string and the
// `stub` flag, so it compiles and works before and after #298 adds the typed verdict. Once #298 is
// on main it can use `TestVerdict` directly (FU-BEB-144).
export function isLocalStub(result: {
  readonly verdict: string;
  readonly stub?: unknown;
}): boolean {
  return result.verdict === 'LOCAL_STUB' || result.stub === true;
}

/** Shown to the reviewer on a question the local stub could not grade (scoring_note). */
export const LOCAL_STUB_NOTE = 'not graded (local stub)';
