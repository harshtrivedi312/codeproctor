// The one thing the invitation step needs from the session state machine: the INVITED sessions row
// (ADR 0002). Only SessionStateService may write sessions.status, so this module never inserts a
// session itself; it asks this port, inside its own transaction, so a failure rolls the invitation
// back with it.
//
// Bound in invitations.module.ts to SessionStateService (useExisting); tests bind a fake that
// inserts through the transaction they are handed.
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
