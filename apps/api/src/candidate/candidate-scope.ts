// The ONE place a candidate request enters a database scope (ADR 0013 CS-4, DL-31). The guard calls
// `authenticate`; services call `asCandidate` and `asOrg`. Nothing else in the candidate module
// calls runAsCandidate, runInOrg or setCandidateFacts. Org, session and facts come from the
// verified token claims and from rows read by id, never from the request.
//
// Rules this class keeps (database/README.md, "Candidate and session-job scopes"):
//   - A scope is entered only from NO scope and never nested: runAsCandidate is refused inside any
//     scope, and a runInOrg inside a candidate scope IS the candidate scope. So a handler runs with
//     no scope at all (there is no interceptor) and each service step picks `asCandidate` (reads and
//     writes the CS-4.4 allowlist covers) or `asOrg` (everything it does not: status transitions,
//     the HMAC key, device_info, consent texts, test content, audit rows, row creates), one after
//     the other. A route that forgot to pick one fails closed: queries throw without a scope.
//   - The facts (candidate, invitation, test) are set by the FIRST statement inside every candidate
//     scope, before any query.
//   - Every call in a candidate scope names an explicit `select` of readable columns, writes only the
//     allowlist, and uses no field reference in a `where`.
import { Injectable } from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import type { Scoped } from '../database/org-context';
import { setCandidateFacts } from '../database/candidate-facts';
import { PrismaService } from '../database/prisma.service';
import type { PauseReason, SessionStatus } from '../generated/prisma/enums.js';

export interface CandidateFactsOf {
  readonly candidateId: string;
  readonly invitationId: string;
  readonly testId: string;
}

export interface ScopeIds {
  readonly orgId: string;
  readonly sessionId: string;
  readonly candidateId: string;
  readonly invitationId: string;
  readonly testId: string;
}

export interface AuthenticatedSession {
  readonly status: SessionStatus;
  readonly authEpoch: number;
  readonly pauseReasons: readonly PauseReason[];
  readonly candidateId: string;
  readonly invitationId: string;
  readonly testId: string;
}

@Injectable()
export class CandidateScope {
  constructor(
    private readonly orgContext: OrgContextService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The guard's two steps. Returns null when the session is not found in the token's org.
   *  1. In a plain org scope, column-only reads: the session's invitation id, then that invitation's
   *     candidate and test (never `accommodations`). A session of another org is not found.
   *  2. Leave that scope, enter the candidate scope, set the facts first, then load the session
   *     (readable columns only).
   */
  async authenticate(orgId: string, sessionId: string): Promise<AuthenticatedSession | null> {
    const facts = await this.orgContext.runInOrg(orgId, async () => {
      const session = await this.prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { invitationId: true },
      });
      if (session === null) return null;
      const invitation = await this.prisma.client.invitation.findUnique({
        where: { id: session.invitationId },
        select: { id: true, candidateId: true, testId: true },
      });
      if (invitation === null) return null;
      return {
        candidateId: invitation.candidateId,
        invitationId: invitation.id,
        testId: invitation.testId,
      } satisfies CandidateFactsOf;
    });
    if (facts === null) return null;
    const row = await this.enterCandidate(orgId, sessionId, facts, () =>
      this.prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, authEpoch: true, pauseReasons: true },
      }),
    );
    if (row === null) return null;
    return {
      ...facts,
      status: row.status,
      authEpoch: row.authEpoch,
      pauseReasons: row.pauseReasons,
    };
  }

  private enterCandidate<T>(
    orgId: string,
    sessionId: string,
    facts: CandidateFactsOf,
    fn: () => T,
  ): Scoped<T> {
    return this.orgContext.runAsCandidate(orgId, sessionId, () => {
      // First statement of every candidate scope: nothing is queried before the facts are set.
      setCandidateFacts(this.orgContext, facts);
      return fn();
    });
  }

  /** Candidate scope for a service step. Call it from no scope; never nest it inside `asOrg`. */
  asCandidate<T>(ids: ScopeIds, fn: () => T): Scoped<T> {
    return this.enterCandidate(ids.orgId, ids.sessionId, ids, fn);
  }

  /** Plain org scope for what the candidate scope may not do. Call it from no scope. */
  asOrg<T>(ids: Pick<ScopeIds, 'orgId'>, fn: () => T): Scoped<T> {
    return this.orgContext.runInOrg(ids.orgId, fn);
  }
}
