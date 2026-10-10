// GET /candidate/session/accommodations (FR-305, FR-403, ADR 0015 section 4). The session is the
// token's; nothing from the client picks a row. Returns the projection only.
import { Controller, Get, Header } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { PROCTOR_DETECTORS } from '@codeproctor/shared';
import { CandidateRoute } from '../common/auth/candidate-route.decorator';
import { PrismaService } from '../database/prisma.service';
import { CandidateScope } from './candidate-scope';
import { Candidate, CandidateScoped } from './candidate.decorators';
import type { CandidateContext } from './candidate.types';
import { emptyAccommodations, projectAccommodations } from './accommodations.projection';
import type { AccommodationsGate, AccommodationsProjection } from './accommodations.projection';
import { SessionRateLimiter } from './session-rate-limiter';

export class AccommodationsGateDto implements AccommodationsGate {
  @ApiProperty({ description: 'The candidate may upload an ID photo from their own device' })
  idPhotoUpload!: boolean;

  @ApiProperty({ description: 'The room scan is replaced by another check' })
  roomScanAlternative!: boolean;

  @ApiProperty({ description: 'No microphone is needed for this session' })
  microphoneNotRequired!: boolean;
}

export class AccommodationsProjectionDto implements AccommodationsProjection {
  @ApiProperty({ description: 'The ID and selfie check is waived for this session' })
  identityCheckWaived!: boolean;

  @ApiProperty({ description: 'The face detectors are off for this session' })
  faceDetectorsOff!: boolean;

  @ApiProperty({
    type: [String],
    enum: PROCTOR_DETECTORS,
    description: 'Detectors switched off for this session; sorted, unique, [] when none',
  })
  disabledDetectors!: string[];

  @ApiProperty({ type: AccommodationsGateDto })
  gate!: AccommodationsGateDto;
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
      'Booleans, detector names and the gate flags. The reason, notes, tools list, assistive input and extra time are never returned here.',
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
    if (row === null) return emptyAccommodations();
    return projectAccommodations(row.invitation.accommodations);
  }
}
