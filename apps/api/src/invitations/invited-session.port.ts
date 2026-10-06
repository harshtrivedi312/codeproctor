// The one thing the invitation step needs from the session state machine: the INVITED sessions row
// (ADR 0002). Only SessionStateService may write sessions.status, so this module never inserts a
// session itself; it asks this port, inside its own transaction, so a failure rolls the invitation
// back with it.
//
// Binding. Backend B's PR #98 adds SessionStateService.createInvited(ids, db = prisma.client). Once
// it is on main the real adapter is ONE provider line in invitations.module.ts, replacing the
// default below:
//   { provide: INVITED_SESSION_PORT, useExisting: SessionStateService }
// (and the module imports whatever module exports SessionStateService). Until then the default
// provider FAILS CLOSED: it answers 503 with a fixed detail, the transaction rolls back and no
// invitation, candidate, audit row or mail is left behind. Tests bind a fake that inserts through
// the transaction they are handed.
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';

/** Injection token of the port. */
export const INVITED_SESSION_PORT = Symbol('INVITED_SESSION_PORT');

/** The transaction client the port writes with: the caller's transaction, never a new one. */
export type InvitedSessionDb = Pick<OrgScopedPrismaClient, 'session'>;

export interface InvitedSessionPort {
  /** Creates the sessions row of an invitation in status INVITED. */
  createInvited(
    ids: { orgId: string; invitationId: string },
    tx: InvitedSessionDb,
  ): Promise<{ id: string }>;
}

@Injectable()
export class FailClosedInvitedSessionPort implements InvitedSessionPort {
  createInvited(): Promise<{ id: string }> {
    return Promise.reject(
      new ServiceUnavailableException('Invitations are not available yet. Try again later.'),
    );
  }
}
