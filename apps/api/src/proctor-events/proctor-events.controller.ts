// POST /candidate/session/events and /keystrokes (BE-10; FR-608, FR-801; ADR 0013 section 5.2).
// The body is the exact signed string, so the handler reads the raw bytes itself (batch-body.ts)
// after the candidate guard, the rate limit and the state check. The session comes from the token
// only (CS-1). Limits are per session in Redis, not per IP (ADR 0013 section 5.1).
import { Controller, Header, Headers, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProperty,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { MAX_EVENT_BATCH_BODY_BYTES, MAX_KEYSTROKE_BATCH_BODY_BYTES } from '@codeproctor/shared';
import type { Request } from 'express';
import { CandidateRoute } from '../common/auth/candidate-route.decorator';
import { Candidate, CandidateScoped } from '../candidate/candidate.decorators';
import type { CandidateContext } from '../candidate/candidate.types';
import { SessionRateLimiter } from '../candidate/session-rate-limiter';
import { readBatchBody } from './batch-body';
import { ProctorEventsService } from './proctor-events.service';

export const EVENTS_LIMIT_PER_MINUTE = 120;
export const KEYSTROKES_LIMIT_PER_MINUTE = 240;

export class BatchAckDto {
  @ApiProperty({ type: 'integer' }) seq!: number;
  @ApiProperty({ description: 'True when the same batch was already stored (a retry).' })
  duplicate!: boolean;
}

@ApiTags('candidate')
@CandidateScoped()
@Controller('candidate/session')
export class ProctorEventsController {
  constructor(
    private readonly service: ProctorEventsService,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @Post('events')
  @CandidateRoute('candidate_events:write')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Signed proctor event batch (FR-801, ADR 0013 section 5.2)',
    description:
      'Body: the exact signed JSON string (application/json, at most 256 KiB, no Content-Encoding). Header X-Signature: lowercase hex HMAC-SHA256 of the body bytes with the session batch key. Same seq and signature again is a retry (200, duplicate true); same seq with another signature is 409 SEQ_CONFLICT.',
  })
  @ApiOkResponse({ type: BatchAckDto })
  @ApiForbiddenResponse({ description: 'SIGNATURE_INVALID' })
  @ApiConflictResponse({ description: 'SESSION_NOT_ACTIVE, KEY_EPOCH_STALE, SEQ_CONFLICT' })
  @ApiPayloadTooLargeResponse({ description: 'PAYLOAD_TOO_LARGE' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED (120 per minute per session)' })
  async events(
    @Candidate() ctx: CandidateContext,
    @Req() req: Request,
    @Headers('x-signature') signature: string | undefined,
  ): Promise<BatchAckDto> {
    await this.limiter.hit('events', ctx.sessionId, EVENTS_LIMIT_PER_MINUTE, 60);
    const session = await this.service.open(ctx);
    const raw = await readBatchBody(req, MAX_EVENT_BATCH_BODY_BYTES);
    return this.service.ingestEvents(ctx, session, raw, signature);
  }

  @Post('keystrokes')
  @CandidateRoute('candidate_keystrokes:write')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Signed keystroke batch (FR-608, ADR 0010, ADR 0013 section 5.2)',
    description:
      'Same scheme as events: exact signed body (at most 2 MiB), X-Signature, idempotent per seq. The editor text is stored for replay and never logged.',
  })
  @ApiOkResponse({ type: BatchAckDto })
  @ApiForbiddenResponse({ description: 'SIGNATURE_INVALID' })
  @ApiConflictResponse({ description: 'SESSION_NOT_ACTIVE, KEY_EPOCH_STALE, SEQ_CONFLICT' })
  @ApiPayloadTooLargeResponse({ description: 'PAYLOAD_TOO_LARGE' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED (240 per minute per session)' })
  async keystrokes(
    @Candidate() ctx: CandidateContext,
    @Req() req: Request,
    @Headers('x-signature') signature: string | undefined,
  ): Promise<BatchAckDto> {
    await this.limiter.hit('keystrokes', ctx.sessionId, KEYSTROKES_LIMIT_PER_MINUTE, 60);
    const session = await this.service.open(ctx);
    const raw = await readBatchBody(req, MAX_KEYSTROKE_BATCH_BODY_BYTES);
    return this.service.ingestKeystrokes(ctx, session, raw, signature);
  }
}
