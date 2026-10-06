// What the identity check needs to know about a session and its invitation, behind one seam.
//
// Two facts decide whether and how the check runs: the waiver ("no identity check", ADR 0015 C-25)
// and "face detectors off" (FACE in disabledDetectors, C-34), plus session facts that stop a job
// before any image is read (ERASED, a pending erasure fence, RETENTION_FACE_DONE; ADR 0014 3.4).
//
// INTERIM (marked for the PR): the schema on this branch has no WAIVED status and no face-retention
// marker yet (ADR 0015 migrations #100, ADR 0004 section 9 migrations #91, #120). So:
//   - the waiver is read from `invitations.accommodations.identityCheckWaiver` (BE-06's input) and,
//     once the status exists, from a WAIVED row (compared as a string so this file compiles today);
//   - the erasure fence (candidate.erasure_requested_at / erased_at) is wired; RETENTION_FACE_DONE
//     reads as not done.
// When CS-4 forbids candidate scope from reading `invitations` (ADR 0013 CS-4.4), the waiver moves to
// `AccommodationsService.projection()`; only this class changes.
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface IdentityPolicy {
  /** The identity check is waived (the recruiter's accommodation): no match, no images. */
  readonly waived: boolean;
  /** FACE is in disabledDetectors: the initial match still runs, the re-check is refused (C-34). */
  readonly faceDetectorsOff: boolean;
}

export interface IdentitySessionFacts {
  readonly status: string;
  /** ERASED, a pending erasure fence or the face tier already run: no image may be read again. */
  readonly imagesGone: boolean;
}

export abstract class IdentityFacts {
  abstract policy(sessionId: string): Promise<IdentityPolicy>;
  abstract session(sessionId: string): Promise<IdentitySessionFacts | null>;
}

@Injectable()
export class PrismaIdentityFacts extends IdentityFacts {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async policy(sessionId: string): Promise<IdentityPolicy> {
    const [session, waivedRow] = await Promise.all([
      this.prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { invitation: { select: { accommodations: true } } },
      }),
      // WAIVED is not in the status enum until the ADR 0015 migration lands: compare as a string.
      this.prisma.client.identityCheck.findFirst({
        where: { sessionId },
        select: { status: true },
        orderBy: { attempt: 'asc' },
      }),
    ]);
    const acc = session?.invitation.accommodations;
    const obj = typeof acc === 'object' && acc !== null && !Array.isArray(acc) ? acc : {};
    const waiver = (obj as Record<string, unknown>).identityCheckWaiver;
    const detectors = (obj as Record<string, unknown>).disabledDetectors;
    // Set by the server at erasure and R-10 (ADR 0015 table): the waiver reason was reduced away.
    const reduced = (obj as Record<string, unknown>).identityCheckWaived === true;
    return {
      waived:
        (typeof waiver === 'object' && waiver !== null) ||
        reduced ||
        (waivedRow !== null && String(waivedRow.status) === 'WAIVED'),
      faceDetectorsOff: Array.isArray(detectors) && detectors.includes('FACE'),
    };
  }

  async session(sessionId: string): Promise<IdentitySessionFacts | null> {
    const row = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: {
        status: true,
        invitation: {
          select: {
            candidate: { select: { erasureRequestedAt: true, erasedAt: true } },
          },
        },
      },
    });
    if (row === null) return null;
    const status = String(row.status);
    const candidate = row.invitation.candidate;
    // The erasure fence is on the candidate (ADR 0004 section 9.5): a request or a completed erasure
    // stops every job before it presigns or reads an image. INTERIM: RETENTION_FACE_DONE (the face
    // tier already run) has no column on this branch yet, so it reads as not done.
    return {
      status,
      imagesGone:
        status === 'ERASED' || candidate.erasureRequestedAt !== null || candidate.erasedAt !== null,
    };
  }
}
