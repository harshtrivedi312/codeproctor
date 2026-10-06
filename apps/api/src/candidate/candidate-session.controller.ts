import { candidateVisibleStatus } from '../session/candidate-visible-status';
// Candidate routes behind a session token (ADR 0013 section 5.10). The session is the token's: no
// route has a :sessionId, and ids in a body are never used to pick a session (CS-1). Each route is
// limited per session in Redis, not per IP (ADR 0013 section 5.1).
import { Body, Controller, Get, Header, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CandidateRoute } from '../common/auth/candidate-route.decorator';
import { Candidate, CandidateScoped } from './candidate.decorators';
import type { CandidateContext } from './candidate.types';
import { CandidateSessionService } from './candidate-session.service';
import type { SessionStateView } from './candidate-session.service';
import { ConsentService } from './consent.service';
import {
  ConsentDeclinedDto,
  ConsentDocumentDto,
  ConsentSignedDto,
  HeartbeatDto,
  HeartbeatResultDto,
  ProctorKeyDto,
  SessionStateDto,
  SignConsentDto,
  TestStartedDto,
} from './dto/candidate.dto';
import { SessionRateLimiter } from './session-rate-limiter';
import { TestStartService } from './test-start.service';
import { HEARTBEAT_LIMIT_PER_MINUTE } from './candidate-session.service';

const NO_STORE = 'no-store';

function stateDto(view: SessionStateView): SessionStateDto {
  return {
    serverTime: view.serverTime.toISOString(),
    status: candidateVisibleStatus(view.status),
    startedAt: view.startedAt?.toISOString() ?? null,
    deadlineAt: view.deadlineAt?.toISOString() ?? null,
    sectionDeadlineAt: view.sectionDeadlineAt?.toISOString() ?? null,
    pauseReasons: [...view.pauseReasons],
  };
}

// FR-401, FR-505, FR-609; ADR 0002; ADR 0013 sections 2, 4, 5.3; TC-021, TC-030, TC-047, TC-095, TC-096.
@ApiTags('candidate')
@CandidateScoped()
@Controller('candidate/session')
export class CandidateSessionController {
  constructor(
    private readonly session: CandidateSessionService,
    private readonly consent: ConsentService,
    private readonly testStart: TestStartService,
    private readonly limiter: SessionRateLimiter,
  ) {}

  @CandidateRoute('candidate_session:read')
  @Get()
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Session state with the server clock (a reload, FR-505)' })
  @ApiOkResponse({ type: SessionStateDto })
  async state(@Candidate() ctx: CandidateContext): Promise<SessionStateDto> {
    await this.limiter.hit('session', ctx.sessionId, 60, 60);
    return stateDto(await this.session.view(ctx));
  }

  @Get('consent')
  @CandidateRoute('candidate_consent:read')
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: "The org's current consent document for this session (FR-401, D-17)",
    description:
      'Refused with 409 CONSENT_NOT_APPROVED when REQUIRE_LEGAL_APPROVED_CONSENT is true and the text has no Legal approval.',
  })
  @ApiOkResponse({ type: ConsentDocumentDto })
  @ApiConflictResponse({ description: 'CONSENT_NOT_APPROVED' })
  @ApiServiceUnavailableResponse({
    description: 'CONSENT_NOT_CONFIGURED: the org has no current consent text',
  })
  async getConsent(@Candidate() ctx: CandidateContext): Promise<ConsentDocumentDto> {
    await this.limiter.hit('consent-get', ctx.sessionId, 30, 60);
    const view = await this.consent.get(ctx);
    return { ...view, signedAt: view.signedAt?.toISOString() ?? null };
  }

  @Post('consent/sign')
  @CandidateRoute('candidate_consent:sign')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Sign the consent document with the typed full legal name (FR-401, C-07, C-30)',
    description:
      'Server time, IP and user agent are recorded. OPENED to CONSENTED. A job then renders the signed PDF and emails a copy.',
  })
  @ApiOkResponse({ type: ConsentSignedDto })
  @ApiConflictResponse({
    description: 'ALREADY_SIGNED, CONSENT_TEXT_CHANGED, CONSENT_NOT_APPROVED',
  })
  async sign(
    @Candidate() ctx: CandidateContext,
    @Body() dto: SignConsentDto,
    @Req() req: Request,
  ): Promise<ConsentSignedDto> {
    const result = await this.limiter.guarded('consent-sign', ctx.sessionId, 10, 60, () =>
      this.consent.sign(ctx, dto, { ip: req.ip, userAgent: req.headers['user-agent'] }),
    );
    return { status: result.status, signedAt: result.signedAt.toISOString() };
  }

  @Post('consent/decline')
  @CandidateRoute('candidate_consent:decline')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Decline the consent document: OPENED to DECLINED, no device access, no recording',
  })
  @ApiOkResponse({ type: ConsentDeclinedDto })
  @ApiConflictResponse({ description: 'ALREADY_SIGNED: the session already answered the document' })
  async decline(
    @Candidate() ctx: CandidateContext,
    @Req() req: Request,
  ): Promise<ConsentDeclinedDto> {
    return this.limiter.guarded('consent-decline', ctx.sessionId, 10, 60, () =>
      this.consent.decline(ctx, { ip: req.ip, userAgent: req.headers['user-agent'] }),
    );
  }

  @CandidateRoute('candidate_session:start')
  @Post('test/start')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Start the timed test: VERIFIED to IN_PROGRESS (ADR 0002 L-1, S-2, S-3)',
    description:
      'Server sets started_at and deadline_at (accommodations applied), assigns questions and variants, opens section 1, sets invitations.used_at and creates the proctor key. Idempotent. The key is fetched with POST proctor-key.',
  })
  @ApiOkResponse({ type: TestStartedDto })
  @ApiConflictResponse({
    description:
      'SYSTEM_CHECK_BLOCKED, LINK_EXPIRED, SESSION_STATE_CONFLICT, RANDOM_RULE_UNSATISFIABLE',
  })
  async startTest(@Candidate() ctx: CandidateContext): Promise<TestStartedDto> {
    const view = await this.limiter.guarded('test-start', ctx.sessionId, 6, 60, () =>
      this.testStart.start(ctx),
    );
    return {
      status: view.status,
      serverTime: view.serverTime.toISOString(),
      startedAt: view.startedAt.toISOString(),
      deadlineAt: view.deadlineAt.toISOString(),
      sections: view.sections.map((s) => ({
        ...s,
        startedAt: s.startedAt?.toISOString() ?? null,
        deadlineAt: s.deadlineAt?.toISOString() ?? null,
        questions: [...s.questions],
      })),
    };
  }

  @CandidateRoute('candidate_session:heartbeat')
  @Post('heartbeat')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'Heartbeat every 10 s (FR-609); renews the token when half its life is gone',
    description:
      'Updates last_heartbeat. More than 60 s of silence logs a DISCONNECTED event (an event, not a status). Never logged: this response may carry a token.',
  })
  @ApiOkResponse({ type: HeartbeatResultDto })
  @ApiConflictResponse({ description: 'SESSION_NOT_ACTIVE with the current status' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED: 12 per minute per session' })
  async heartbeat(
    @Candidate() ctx: CandidateContext,
    @Body() dto: HeartbeatDto,
  ): Promise<HeartbeatResultDto> {
    // No slot is given back on a busy error: the next beat is the retry (DL-37).
    await this.limiter.hit('heartbeat', ctx.sessionId, HEARTBEAT_LIMIT_PER_MINUTE, 60);
    const view = await this.session.heartbeat(ctx, dto);
    return {
      ...stateDto(view),
      ...(view.sessionToken !== undefined
        ? {
            sessionToken: view.sessionToken,
            sessionTokenExpiresAt: view.sessionTokenExpiresAt?.toISOString(),
          }
        : {}),
    };
  }

  @CandidateRoute('candidate_session:key')
  @Post('proctor-key')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({
    summary: 'The batch-signing key for the token epoch, once (ADR 0013 section 4)',
    description:
      'K_e = HMAC-SHA256(master key, session id and epoch). 409 KEY_ALREADY_ISSUED when this epoch already received it: sign in again with the OTP. 5 per minute per session. The key is never logged.',
  })
  @ApiOkResponse({ type: ProctorKeyDto })
  @ApiConflictResponse({ description: 'KEY_ALREADY_ISSUED, SESSION_NOT_ACTIVE, KEY_UNAVAILABLE' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async proctorKey(@Candidate() ctx: CandidateContext): Promise<ProctorKeyDto> {
    await this.limiter.hit('proctor-key', ctx.sessionId, 5, 60);
    return this.session.proctorKey(ctx);
  }
}
