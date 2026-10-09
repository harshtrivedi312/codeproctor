// GET /candidate/session/accommodations (ADR 0013 CS-4.4 table: the AccommodationsService
// projection; ADR 0015 section 3). The candidate-safe part of `invitations.accommodations`: the
// extra-time percentage, the disabled detectors, the allowed assistive tools and whether the
// identity check is waived. NEVER the reason code, the reason note or the free-text notes.
// The web also reads `faceDetectorsOff` (FACE among the disabled detectors, C-34), derived here so
// the browser does not parse the list.
// `invitations.accommodations` is an explicit-only column; until the CS-4 PR 2 grant exists the
// read goes through the org scope (P-24 interim, D-54).
import { Injectable } from '@nestjs/common';
import { PROCTOR_DETECTORS } from '@codeproctor/shared';
import { PrismaService } from '../database/prisma.service';
import { readExtraTime } from '../session/accommodations';
import { CandidateScope } from './candidate-scope';
import type { CandidateContext } from './candidate.types';

export interface AccommodationsProjection {
  readonly extraTimePct: number;
  readonly disabledDetectors: readonly string[];
  readonly allowedAssistiveTools: readonly string[];
  readonly identityCheckWaived: boolean;
  readonly faceDetectorsOff: boolean;
}

const MAX_TOOLS = 20;
const MAX_TOOL_LENGTH = 64;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Pure projection of a stored `accommodations` value; unknown or malformed parts mean "none". */
export function projectAccommodations(
  stored: unknown,
  waivedRow: boolean,
): AccommodationsProjection {
  const acc = asRecord(stored);
  const known: readonly string[] = PROCTOR_DETECTORS;
  const disabledDetectors = Array.isArray(acc.disabledDetectors)
    ? [
        ...new Set(
          acc.disabledDetectors.filter(
            (d): d is string => typeof d === 'string' && known.includes(d),
          ),
        ),
      ]
    : [];
  const allowedAssistiveTools = Array.isArray(acc.allowedAssistiveTools)
    ? acc.allowedAssistiveTools
        .filter(
          (t): t is string => typeof t === 'string' && t.length > 0 && t.length <= MAX_TOOL_LENGTH,
        )
        .slice(0, MAX_TOOLS)
    : [];
  const waiver = acc.identityCheckWaiver;
  return {
    extraTimePct: readExtraTime(stored).pct,
    disabledDetectors,
    allowedAssistiveTools,
    // The reason is never returned: only the fact. `identityCheckWaived: true` is what erasure and
    // R-10 leave behind after they delete the reason (ADR 0015 section 7).
    identityCheckWaived:
      (typeof waiver === 'object' && waiver !== null) ||
      acc.identityCheckWaived === true ||
      waivedRow,
    faceDetectorsOff: disabledDetectors.includes('FACE'),
  };
}

@Injectable()
export class AccommodationsProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
  ) {}

  async projection(ctx: CandidateContext): Promise<AccommodationsProjection> {
    return this.scope.asOrg(ctx, async () => {
      const [invitation, firstCheck] = await Promise.all([
        this.prisma.client.invitation.findUnique({
          where: { id: ctx.invitationId },
          select: { accommodations: true },
        }),
        // The WAIVED row is authoritative (ADR 0015 section 3); the jsonb signals are the fallback
        // the identity gate also uses (FU-BEB-155).
        this.prisma.client.identityCheck.findFirst({
          where: { sessionId: ctx.sessionId },
          select: { status: true },
          orderBy: { attempt: 'asc' },
        }),
      ]);
      return projectAccommodations(
        invitation?.accommodations ?? {},
        firstCheck?.status === 'WAIVED',
      );
    });
  }
}
