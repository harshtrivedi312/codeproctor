// Candidate identity routes (FR-403, ADR 0004 section 1, ADR 0013 5.6). The session is the token's:
// no route has a :sessionId and a body that names one is refused (CS-1). Limited per session in
// Redis, not per IP (ADR 0013 section 5.1). Presigned URLs are never logged. The status route
// returns the status only: never a score, a threshold, a model id or a reason (NFR-05).
import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Candidate, CandidateScoped } from '../candidate/candidate.decorators';
import type { CandidateContext } from '../candidate/candidate.types';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import {
  IdentityPresignedDto,
  IdentityStatusDto,
  PresignIdentityDto,
  SubmitIdentityDto,
} from './dto/identity.dto';
import { IdentityService } from './identity.service';

const NO_STORE = 'no-store';

@ApiTags('candidate')
@Controller('candidate/session/identity')
export class IdentityCandidateController {
  constructor(
    private readonly identity: IdentityService,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @Post('presign')
  @CandidateScoped('candidate_identity:upload')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary:
      'A single-use upload name and a 60 s presigned PUT for the ID image or the selfie (FR-403)',
    description:
      'JPEG only, at most 5 MiB; send the bare content type from the response headers. The name, not a key, goes back to POST /candidate/session/identity. Refused with 409 IDENTITY_CHECK_WAIVED when the recruiter waived the check. Never logged: the response holds a URL.',
  })
  @ApiOkResponse({ type: IdentityPresignedDto })
  @ApiBadRequestResponse({ description: 'Validation: purpose, contentType, bytes' })
  @ApiConflictResponse({
    description:
      'IDENTITY_CHECK_WAIVED, IDENTITY_CHECK_PENDING, IDENTITY_ATTEMPTS_EXHAUSTED, SESSION_NOT_ACTIVE',
  })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_UNCONFIGURED, STORAGE_UNAVAILABLE' })
  presign(
    @Candidate() ctx: CandidateContext,
    @Body() dto: PresignIdentityDto,
  ): Promise<IdentityPresignedDto> {
    return this.identity.presign(ctx, { purpose: dto.purpose, bytes: dto.bytes });
  }

  @Post()
  @CandidateScoped('candidate_identity:upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Submit the ID image and the selfie for the face match (FR-403, TC-033)',
    description:
      'Takes the two names issued by /presign, never object keys. The match runs in the background: poll GET /candidate/session/identity. A repeat of the same two names returns the same row. The result is never a rejection: a low-confidence attempt may be retried once, then a person reviews it.',
  })
  @ApiAcceptedResponse({ type: IdentityStatusDto })
  @ApiBadRequestResponse({ description: 'IDENTITY_NAME_INVALID, IDENTITY_IMAGE_REJECTED' })
  @ApiConflictResponse({
    description:
      'IDENTITY_CHECK_WAIVED, IDENTITY_CHECK_PENDING, IDENTITY_ATTEMPTS_EXHAUSTED, UPLOAD_NOT_FOUND, SESSION_NOT_ACTIVE',
  })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_UNCONFIGURED, STORAGE_UNAVAILABLE' })
  async submit(
    @Candidate() ctx: CandidateContext,
    @Body() dto: SubmitIdentityDto,
  ): Promise<IdentityStatusDto> {
    await this.limiter.hit('identity-submit', ctx.sessionId, 10, 60);
    return this.identity.submit(ctx, dto);
  }

  @Get()
  @CandidateScoped('candidate_identity:upload')
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'The identity check status of this session (status only, NFR-05)' })
  @ApiOkResponse({ type: IdentityStatusDto })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async status(@Candidate() ctx: CandidateContext): Promise<IdentityStatusDto> {
    await this.limiter.hit('identity-status', ctx.sessionId, 60, 60);
    return this.identity.status(ctx);
  }
}
