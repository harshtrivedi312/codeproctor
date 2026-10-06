// The ONE place a candidate request enters a database scope (guard and interceptor both call it).
// Today it is runInOrg(orgId) plus the explicit session filters in every query; when the database
// layer ships runAsCandidate(oid, sid, fn) (ADR 0013 CS-4) only this class changes. The org and the
// session come from the verified token claims, never from the request.
import { Injectable } from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import type { Scoped } from '../database/org-context';

@Injectable()
export class CandidateScope {
  constructor(private readonly orgContext: OrgContextService) {}

  enter<T>(claims: { readonly orgId: string; readonly sessionId: string }, fn: () => T): Scoped<T> {
    return this.orgContext.runInOrg(claims.orgId, fn);
  }
}
