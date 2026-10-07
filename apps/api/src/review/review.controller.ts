import { Controller, Get, Header, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Audited } from '../audit/audited.decorator';
import { Roles } from '../common/auth/decorators';
import { UserRole } from '../generated/prisma/client';
import { PlaybackDto, QueueDto, QueueQueryDto, ReviewBundleDto } from './dto/review.dto';
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
  constructor(private readonly review: ReviewService) {}

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
  @ApiBadRequestResponse({ description: 'Not a UUID' })
  @ApiNotFoundResponse({ description: 'No such session or recording in your organization' })
  @ApiServiceUnavailableResponse({ description: 'Object storage is not configured' })
  playback(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('recordingId') recordingId: string,
  ): Promise<PlaybackDto> {
    return this.review.playback(id, recordingId);
  }
}
