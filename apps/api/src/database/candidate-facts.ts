// The candidate-facts setter (ADR 0013 section 5.10, CS-4.4 "Candidate facts"; ADR 0006 section 8.5).
//
// CandidateSessionGuard ONLY. Nothing else may import this file. It is deliberately NOT exported
// from index.ts, so it cannot be reached by importing the database layer; FU-DB-67 pins its one
// importer (the guard) in the call-site test (FU-DB-189 lists the paths that test must close).
//
// What it does. The row filters CS-4.3 injects for `candidates`, `invitations` and `tests` need three
// values the token does not carry: the candidate, the invitation and the test of the scope's
// session. The guard reads them (DL-31, FU-DB-185: in a plain `runInOrg(oid)`, before it enters the
// candidate scope), enters `orgContext.runAsCandidate(oid, sid, ...)` and calls this once, before any
// other query in the scope. It throws:
//   - outside a CANDIDATE scope (no scope, a staff or plain org scope, a SERVICE scope, system);
//   - on a second call in the same scope. The facts are immutable afterwards. A nested runInOrg of
//     the same org is the same scope, so it cannot set them again either.
//   - when an id is not a uuid.
// Until it is called, a read of `candidates`, `invitations` or `tests` in the scope throws. A wrong
// fact can only narrow what the scope reads: each of those filters is ANDed with a filter derived
// from the scope's own session (session-scope-map.ts), so another candidate's facts read nothing.
//
// How it is held. The setter is a closure that org-context.ts hands out once per process (a second
// claim throws), and this module holds it. It is not a method of OrgContextService, so reflection on
// the service finds nothing to call.
import { claimCandidateFactsSetter, OrgContextService } from './org-context';
import type { CandidateFacts } from './org-context';
import { OrgScopeViolationError } from './errors';

const setFacts = claimCandidateFactsSetter();

/**
 * CandidateSessionGuard only. Sets `candidateId`, `invitationId` and `testId` of the current
 * CANDIDATE scope, once; they are immutable afterwards. Throws outside a CANDIDATE scope, on a second
 * call, and on an id that is not a uuid. `orgContext` must be an OrgContextService; the storage is
 * process-wide (FU-DB-83), so any instance sees the same scope.
 */
export function setCandidateFacts(orgContext: OrgContextService, facts: CandidateFacts): void {
  if (!(orgContext instanceof OrgContextService)) {
    throw new OrgScopeViolationError('setCandidateFacts needs the OrgContextService.');
  }
  setFacts(facts);
}
