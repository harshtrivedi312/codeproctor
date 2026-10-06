// Candidate media routes (FR-701, FR-702; ADR 0013 section 5.5). The session is the token's: no
// route has a :sessionId and a body that names one is refused (CS-1). Limited to 60 per minute per
// stream per session in Redis, not per IP (ADR 0013 section 5.1). Bodies and responses of these
// routes carry presigned URLs and are never logged.
import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Candidate, CandidateScoped } from '../candidate/candidate.decorators';
import type { CandidateContext } from '../candidate/candidate.types';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import { CandidateRoute } from '../common/auth/candidate-route.decorator';
import {
  AlreadyUploadedDto,
  MediaConfirmDto,
  MediaConfirmedDto,
  MediaPresignDto,
  PresignedPutDto,
} from './dto/media.dto';
import { MEDIA_LIMIT_PER_MINUTE } from './media.constants';
import { MediaService } from './media.service';

const NO_STORE = 'no-store';

@ApiTags('candidate')
@CandidateScoped()
@Controller('candidate/session/media')
export class MediaCandidateController {
  constructor(
    private readonly media: MediaService,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @Post('presign')
  @CandidateRoute('candidate_media:presign')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Presigned PUT URL for one recording chunk, valid 60 s (FR-701)',
    description:
      'Records the chunk as pending (upsert on retry). Content-Type and Content-Length are signed: send the bare content type from the response headers, never blob.type. A confirmed chunk answers { alreadyUploaded: true } with no url. A recorder restart starts a new segment. 60 per minute per stream. Never logged: the response holds a URL.',
  })
  @ApiExtraModels(PresignedPutDto, AlreadyUploadedDto)
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(PresignedPutDto) },
        { $ref: getSchemaPath(AlreadyUploadedDto) },
      ],
    },
  })
  @ApiBadRequestResponse({ description: 'Validation: stream, segment, seq, bytes, contentType' })
  @ApiConflictResponse({ description: 'SEQ_CONFLICT, SESSION_NOT_ACTIVE' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED, PRESIGN_QUOTA_EXCEEDED' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_UNCONFIGURED, STORAGE_UNAVAILABLE' })
  async presign(
    @Candidate() ctx: CandidateContext,
    @Body() dto: MediaPresignDto,
  ): Promise<PresignedPutDto | AlreadyUploadedDto> {
    await this.limiter.hit(
      `media-presign-${dto.stream}`,
      ctx.sessionId,
      MEDIA_LIMIT_PER_MINUTE,
      60,
    );
    const out = await this.media.presign(ctx, {
      stream: dto.stream,
      segment: dto.segment,
      seq: dto.seq,
      bytes: dto.bytes,
      contentType: dto.contentType,
      startedAt: new Date(dto.startedAt),
      durationMs: dto.durationMs,
    });
    if (out.alreadyUploaded) return { alreadyUploaded: true };
    return {
      url: out.url,
      method: out.method,
      headers: { ...out.headers },
      expiresAt: out.expiresAt.toISOString(),
    };
  }

  @Post('confirm')
  @CandidateRoute('candidate_media:presign')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Confirm an uploaded chunk: HEAD check, then pending to uploaded (FR-701)',
    description:
      'Idempotent. A missing object answers 409 UPLOAD_NOT_FOUND; a wrong size or type deletes the object and answers 422 UPLOAD_MISMATCH (presign and upload again).',
  })
  @ApiOkResponse({ type: MediaConfirmedDto })
  @ApiConflictResponse({ description: 'UPLOAD_NOT_FOUND, SESSION_NOT_ACTIVE' })
  @ApiUnprocessableEntityResponse({ description: 'UPLOAD_MISMATCH' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_UNCONFIGURED, STORAGE_UNAVAILABLE' })
  async confirm(
    @Candidate() ctx: CandidateContext,
    @Body() dto: MediaConfirmDto,
  ): Promise<MediaConfirmedDto> {
    await this.limiter.hit(
      `media-confirm-${dto.stream}`,
      ctx.sessionId,
      MEDIA_LIMIT_PER_MINUTE,
      60,
    );
    return this.media.confirm(ctx, { stream: dto.stream, segment: dto.segment, seq: dto.seq });
  }
}
