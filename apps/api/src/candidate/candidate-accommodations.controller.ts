// GET /candidate/session/accommodations (FR-305, FR-403, ADR 0015 section 4). The session is the
// token's; nothing from the client picks a row. Returns two booleans only.
import { Controller, Get, Header } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { CandidateRoute } from '../common/auth/candidate-route.decorator';
import { PrismaService } from '../database/prisma.service';
import { CandidateScope } from './candidate-scope';
import { Candidate, CandidateScoped } from './candidate.decorators';
import type { CandidateContext } from './candidate.types';
import { NO_ACCOMMODATIONS, projectAccommodations } from './accommodations.projection';
import type { AccommodationsProjection } from './accommodations.projection';
import { SessionRateLimiter } from './session-rate-limiter';

export class AccommodationsProjectionDto implements AccommodationsProjection {
  @ApiProperty({ description: 'The ID and selfie check is waived for this session' })
  identityCheckWaived!: boolean;

  @ApiProperty({ description: 'The face detectors are off for this session' })
  faceDetectorsOff!: boolean;
}

@ApiTags('candidate')
@CandidateScoped()
@Controller('candidate/session')
export class CandidateAccommodationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CandidateScope,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @CandidateRoute('candidate_session:read')
  @Get('accommodations')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'What the candidate may know about their accommodations (ADR 0015 section 4)',
    description:
      'Two booleans. The reason, notes, tools list and extra time are never returned here.',
  })
  @ApiOkResponse({ type: AccommodationsProjectionDto })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED: 30 per minute per session' })
  async get(@Candidate() ctx: CandidateContext): Promise<AccommodationsProjectionDto> {
    await this.limiter.hit('accommodations', ctx.sessionId, 30, 60);
    // Same org-scope read as test start: candidate scope cannot read `invitations` (CS-4.4).
    const row = await this.scope.asOrg(ctx, () =>
      this.prisma.client.session.findUnique({
        where: { id: ctx.sessionId },
        select: { invitation: { select: { accommodations: true } } },
      }),
    );
    if (row === null) return { ...NO_ACCOMMODATIONS };
    return { ...projectAccommodations(row.invitation.accommodations) };
  }
}
