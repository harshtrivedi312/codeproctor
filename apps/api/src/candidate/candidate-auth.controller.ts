import { candidateVisibleStatus } from '../session/candidate-visible-status';
// The routes that run before a session token exists: link, otp, start (ADR 0013 section 5.10 names
// them as the only pre-JWT candidate routes; they are the only ones outside CandidateSessionGuard).
// Public to the staff guard, throttled per IP by the stricter /candidate limit (THROTTLE_CANDIDATE_LIMIT),
// limited per invitation by OtpService, never cached.
import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/auth/decorators';
import { CandidateAuthService } from './candidate-auth.service';
import type { LinkView } from './candidate-auth.service';
import { OTP_TTL_SECONDS } from './otp.service';
import {
  LinkDto,
  LinkViewDto,
  OtpSentDto,
  SessionTokenDto,
  StartSessionDto,
} from './dto/candidate.dto';

const NO_STORE = 'no-store';

function linkDto(view: LinkView): LinkViewDto {
  return {
    state: view.state,
    orgName: view.orgName,
    declineContact: view.declineContact,
    retryAfterSeconds: view.retryAfterSeconds,
    windowStart: view.windowStart.toISOString(),
    windowEnd: view.windowEnd.toISOString(),
  };
}

// FR-106, FR-303, FR-401; ADR 0002 L-1..L-5; TC-007, TC-021, TC-022, TC-097.
@ApiTags('candidate')
@Controller('candidate/session')
export class CandidateAuthController {
  constructor(private readonly auth: CandidateAuthService) {}

  @Public()
  @Post('link')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary:
      'What an invitation link shows: open, already used, expired, declined, blocked (L-3, L-4)',
    description: 'Sends nothing. A used link never sends an OTP (TC-021).',
  })
  @ApiOkResponse({ type: LinkViewDto })
  @ApiNotFoundResponse({
    description: 'Unknown token (code INVALID_LINK is not set: one generic 404)',
  })
  async link(@Body() dto: LinkDto): Promise<LinkViewDto> {
    return linkDto(await this.auth.resolveLink(dto.invitationToken));
  }

  @Public()
  @Post('otp')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Email a 6-digit code for an open link (FR-106)' })
  @ApiOkResponse({ type: OtpSentDto })
  @ApiTooManyRequestsResponse({ description: 'OTP_COOLDOWN: a code was sent less than 30 s ago' })
  async sendOtp(@Body() dto: LinkDto): Promise<OtpSentDto> {
    const { view, sent, maskedEmail } = await this.auth.sendOtp(dto.invitationToken);
    return {
      state: sent ? 'OTP_SENT' : view.state,
      maskedEmail,
      expiresInSeconds: OTP_TTL_SECONDS,
      retryAfterSeconds: view.retryAfterSeconds,
      declineContact: view.declineContact,
    };
  }

  @Public()
  @Post('start')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Exchange the invitation token and the email OTP for a candidate session token',
    description:
      'Every success raises auth_epoch, so a token on another device stops working (ADR 0002 L-2). ' +
      'Before the test starts, 5 wrong codes block the link for 30 minutes (TC-007). During a test ' +
      'there is no block: a wrong code logs RESUME_OTP_FAILED, alerts the proctor and allows a retry ' +
      'after 30 s (TC-097).',
  })
  @ApiOkResponse({ type: SessionTokenDto })
  @ApiBadRequestResponse({ description: 'OTP_INVALID or OTP_NOT_REQUESTED' })
  @ApiConflictResponse({
    description: 'LINK_ALREADY_USED, LINK_EXPIRED, LINK_DECLINED, WINDOW_NOT_OPEN',
  })
  @ApiTooManyRequestsResponse({ description: 'LINK_BLOCKED or OTP_COOLDOWN, with Retry-After' })
  async start(@Body() dto: StartSessionDto, @Req() req: Request): Promise<SessionTokenDto> {
    const now = new Date();
    const result = await this.auth.start(dto.invitationToken, dto.otp, { ip: req.ip }, now);
    return {
      sessionToken: result.token,
      sessionTokenExpiresAt: result.expiresAt.toISOString(),
      status: candidateVisibleStatus(result.status),
      serverTime: now.toISOString(),
    };
  }
}
