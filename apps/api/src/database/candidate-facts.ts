// The candidate-facts setter (ADR 0013 section 5.10, CS-4.4 "Candidate facts"; ADR 0006 section 8.5).
//
// CandidateSessionGuard ONLY. Nothing else may import this file. It is deliberately NOT exported
// from index.ts, so it cannot be reached by importing the database layer; FU-DB-67 pins its one
// importer (the guard) in the call-site test.
//
// What it does. The row filters CS-4.3 injects for `candidates`, `invitations` and `tests` need three
// values the token does not carry: the candidate, the invitation and the test of the scope's
// session. The guard reads them and calls this once, inside the CANDIDATE scope it entered with
// `orgContext.runAsCandidate(oid, sid, ...)`. It throws:
//   - outside a CANDIDATE scope (no scope, a staff or plain org scope, a SERVICE scope, system);
//   - on a second call in the same scope. The facts are immutable afterwards. A nested runInOrg of
//     the same org is the same scope, so it cannot set them again either.
//   - when an id is not a uuid.
// Until it is called, a read of `candidates`, `invitations` or `tests` in the scope throws.
//
// The ids come from rows the guard loaded INSIDE the scope, never from the request.
import { SET_CANDIDATE_FACTS } from './org-context';
import type { CandidateFacts, OrgContextService } from './org-context';

/**
 * CandidateSessionGuard only. Sets `candidateId`, `invitationId` and `testId` of the current
 * CANDIDATE scope, once; they are immutable afterwards. Throws outside a CANDIDATE scope, on a second
 * call, and on an id that is not a uuid.
 */
export function setCandidateFacts(orgContext: OrgContextService, facts: CandidateFacts): void {
  orgContext[SET_CANDIDATE_FACTS](facts);
}
