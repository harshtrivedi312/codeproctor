// What must be true before a session moves CONSENTED to VERIFIED (ADR 0002 section 2, ADR 0015,
// ADR 0013 section 3). The verify-session job asks this port inside its locked transaction, after
// the callers (system check, identity, room scan routes) enqueued it, so the job never trusts the
// enqueue alone (CS-4.7: the job re-checks every condition).
//
// `ColumnVerifyConditions` evaluates what the existing columns can answer. Anything it cannot
// evaluate yet counts as NOT met (fails closed) and names the condition, so nothing is verified on
// a guess; BE-08b and BE-10 replace or extend it when they supply their evidence. It only reads.
//   SYSTEM_CHECK  device_info.systemCheck passed with no blocking finding (ADR 0013 section 3). No
//                 freshness window here: the start of the test re-checks the 15 minutes.
//   IDENTITY      an identity attempt finished: PASSED, MANUAL_REVIEW or REVIEWED (ADR 0002
//                 section 6). TODO(ADR 0015, Proposed): a WAIVED identity_checks row also meets it,
//                 once that enum value exists. Until then there is NO valid waiver, so a waived
//                 session stays unmet. `accommodations.identityCheckWaived` is NOT the waiver: ADR
//                 0015 section 7 makes it the server-only leftover that erasure writes after it has
//                 deleted the rows, so it is never read here. The inconsistency "key present, no
//                 WAIVED row" must be refused and alerted when the WAIVED row lands (FU-BEB-114).
//   ROOM_SCAN     at least one uploaded, undeleted ROOM_SCAN media chunk (FR-404)
//   SIDE_CAMERA   STRICT tests only. There is no stored evidence of a connected side camera yet
//                 (BE-10), so a STRICT session is never verified by this default.
import { Injectable } from '@nestjs/common';
import type { SessionTx } from './session-lock.port';
import { isSystemCheckPassed } from './system-check';

export const VERIFY_CONDITIONS = ['SYSTEM_CHECK', 'IDENTITY', 'ROOM_SCAN', 'SIDE_CAMERA'] as const;
export type VerifyCondition = (typeof VERIFY_CONDITIONS)[number];

export interface VerifyEvidence {
  readonly met: boolean;
  /** Names from VERIFY_CONDITIONS only: safe to log. */
  readonly unmet: readonly VerifyCondition[];
}

export abstract class VerifyConditionsPort {
  abstract evaluate(tx: SessionTx, sessionId: string): Promise<VerifyEvidence>;
}

const FINISHED_IDENTITY = ['PASSED', 'MANUAL_REVIEW', 'REVIEWED'];

@Injectable()
export class ColumnVerifyConditions extends VerifyConditionsPort {
  async evaluate(tx: SessionTx, sessionId: string): Promise<VerifyEvidence> {
    const unmet: VerifyCondition[] = [];
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { deviceInfo: true, invitationId: true },
    });
    if (session === null) return { met: false, unmet: [...VERIFY_CONDITIONS] };
    const invitation = await tx.invitation.findUnique({
      where: { id: session.invitationId },
      select: { testId: true },
    });
    if (!isSystemCheckPassed(session.deviceInfo)) unmet.push('SYSTEM_CHECK');

    // The identity_checks rows are the evidence (never the accommodations).
    const attempts = await tx.identityCheck.findMany({
      where: { sessionId },
      select: { status: true },
    });
    if (!attempts.some((a) => FINISHED_IDENTITY.includes(a.status))) unmet.push('IDENTITY');

    const scans = await tx.mediaChunk.count({
      where: { sessionId, stream: 'ROOM_SCAN', uploadedAt: { not: null }, deletedAt: null },
    });
    if (scans < 1) unmet.push('ROOM_SCAN');

    const test =
      invitation === null
        ? null
        : await tx.test.findUnique({ where: { id: invitation.testId }, select: { profile: true } });
    if (test === null || test.profile === 'STRICT') unmet.push('SIDE_CAMERA');
    return { met: unmet.length === 0, unmet };
  }
}
