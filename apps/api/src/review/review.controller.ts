import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Audited } from '../audit/audited.decorator';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { ctxOf } from '../common/request-context';
import { UserRole } from '../generated/prisma/client';
import {
  PlaybackDto,
  PlaybackParamsDto,
  QueueDto,
  QueueQueryDto,
  ReviewBundleDto,
} from './dto/review.dto';
import {
  ReviewVerdictDto,
  ScoreAnswerDto,
  ScoredAnswerDto,
  ScoreParamsDto,
  SetVerdictDto,
} from './dto/decisions.dto';
import { ReviewDecisionsService } from './review-decisions.service';
import { ReviewService } from './review.service';

const NO_STORE = 'no-store';

// FR-901, FR-703, FR-105. Permissions review_queue:read and review_session:read; reviewers and super
// admins only (ADR 0010). Every read of candidate data is audited. See route-permissions.ts.
@ApiTags('review')
@ApiBearerAuth()
@Roles(UserRole.SUPER_ADMIN, UserRole.REVIEWER)
@Controller('review')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold the permission for this route' })
export class ReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly decisions: ReviewDecisionsService,
  ) {}

  @Get('queue')
  @Header('Cache-Control', NO_STORE)
  @Audited('REVIEW_QUEUE_VIEWED', 'session')
  @ApiOperation({ summary: 'Sessions awaiting or under review, oldest first (FR-805, FR-901)' })
  @ApiOkResponse({ type: QueueDto })
  @ApiBadRequestResponse({ description: 'Invalid status, cursor or page size' })
  queue(@Query() query: QueueQueryDto): Promise<QueueDto> {
    return this.review.queue(query);
  }

  @Get('sessions/:id')
  @Header('Cache-Control', NO_STORE)
  @Audited('REVIEW_SESSION_VIEWED', 'session', { idParam: 'id' })
  @ApiOperation({ summary: 'The review bundle of one session (FR-901)' })
  @ApiOkResponse({ type: ReviewBundleDto })
  @ApiBadRequestResponse({ description: 'Not a UUID' })
  @ApiNotFoundResponse({ description: 'No such session in your organization' })
  bundle(@Param('id', new ParseUUIDPipe()) id: string): Promise<ReviewBundleDto> {
    return this.review.bundle(id);
  }

  @Get('sessions/:id/recordings/:recordingId/playback')
  @Header('Cache-Control', NO_STORE)
  @Audited('REVIEW_PLAYBACK_ISSUED', 'session', { idParam: 'id' })
  @ApiOperation({ summary: 'A presigned GET for one recording, valid for 15 minutes (FR-703)' })
  @ApiOkResponse({ type: PlaybackDto })
  @ApiBadRequestResponse({ description: 'Not a UUID, or a malformed recording id' })
  @ApiNotFoundResponse({ description: 'No such session or recording in your organization' })
  @ApiServiceUnavailableResponse({ description: 'Object storage is not configured' })
  playback(@Param() params: PlaybackParamsDto): Promise<PlaybackDto> {
    return this.review.playback(params.id, params.recordingId);
  }

  // Writes: permission review_verdict:set (REVIEWER, SUPER_ADMIN). The audit row is written in the
  // decision's own transaction (review-decisions.service.ts), not by @Audited.
  @Patch('sessions/:sessionId/answers/:sessionQuestionId')
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Manual scoring of a short answer (FR-205, D-23, TC-099)' })
  @ApiOkResponse({ type: ScoredAnswerDto })
  @ApiBadRequestResponse({ description: 'Not a UUID, or an invalid body' })
  @ApiNotFoundResponse({ description: 'No such session or answer in your organization' })
  @ApiConflictResponse({
    description: 'code ANSWER_NOT_MANUAL, SESSION_NOT_UNDER_REVIEW or VERDICT_ALREADY_SET',
  })
  @ApiServiceUnavailableResponse({ description: 'Lock contention (BUSY)' })
  scoreAnswer(
    @Param() params: ScoreParamsDto,
    @Body() dto: ScoreAnswerDto,
    @Req() req: AuthedRequest,
  ): Promise<ScoredAnswerDto> {
    if (!req.user) throw new Error('Guard did not attach a user');
    return this.decisions.scoreAnswer(
      { id: req.user.id, orgId: req.user.orgId },
      ctxOf(req).ip,
      params.sessionId,
      params.sessionQuestionId,
      dto,
    );
  }

  @Post('sessions/:id/verdict')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Final verdict; moves the session to COMPLETED (FR-902)' })
  @ApiOkResponse({ type: ReviewVerdictDto })
  @ApiBadRequestResponse({ description: 'Not a UUID, or an invalid body' })
  @ApiNotFoundResponse({ description: 'No such session in your organization' })
  @ApiConflictResponse({
    description:
      'code MANUAL_PENDING (short answers wait for a decision), SESSION_NOT_UNDER_REVIEW or VERDICT_ALREADY_SET',
  })
  @ApiServiceUnavailableResponse({ description: 'Lock contention (BUSY)' })
  verdict(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetVerdictDto,
    @Req() req: AuthedRequest,
  ): Promise<ReviewVerdictDto> {
    if (!req.user) throw new Error('Guard did not attach a user');
    return this.decisions.setVerdict(
      { id: req.user.id, orgId: req.user.orgId },
      ctxOf(req).ip,
      id,
      dto,
    );
  }
}
