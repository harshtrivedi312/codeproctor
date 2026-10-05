import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Public, Roles } from '../common/auth/decorators';
import { UserRole } from '../generated/prisma/client';
import { AuthService, REFRESH_TTL_MS } from './auth.service';
import type { RequestContext, SessionOutcome } from './auth.service';
import {
  AcceptedDto,
  AuthSessionDto,
  ChallengeCodeDto,
  ChallengeDto,
  EnrollmentConfirmedDto,
  ForgotPasswordDto,
  LoginDto,
  LoginResultDto,
  ResetPasswordDto,
  TotpCodeDto,
  TotpEnrollmentDto,
} from './dto/auth.dto';

export const REFRESH_COOKIE = 'cp_refresh';
const ALL_STAFF = [UserRole.SUPER_ADMIN, UserRole.RECRUITER, UserRole.AUTHOR, UserRole.REVIEWER];

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  signed: true,
  path: '/api/v1/auth',
};

function ctxOf(req: Request): RequestContext {
  return { ip: req.ip };
}

function setRefreshCookie(res: Response, outcome: SessionOutcome): void {
  if (outcome.refreshToken) {
    res.cookie(REFRESH_COOKIE, outcome.refreshToken, { ...cookieOptions, maxAge: REFRESH_TTL_MS });
  }
}

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.signedCookies?.[REFRESH_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

// FR-101, FR-102, FR-104, FR-107. /auth is throttled at the stricter auth limit (NFR-04).
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Staff password login; may return a 2FA challenge (FR-101, FR-102)' })
  @ApiOkResponse({ type: LoginResultDto })
  @ApiUnauthorizedResponse({ description: 'Wrong email or password (one message for all causes)' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    const outcome = await this.auth.login(dto.email, dto.password, ctxOf(req));
    setRefreshCookie(res, outcome);
    return outcome.body;
  }

  @Public()
  @Post('2fa/enroll/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Begin forced TOTP enrollment with the login challenge (FR-102)' })
  @ApiOkResponse({ type: TotpEnrollmentDto })
  @ApiUnauthorizedResponse({ description: 'Challenge expired' })
  async enrollStart(@Body() dto: ChallengeDto): Promise<TotpEnrollmentDto> {
    const challenge = await this.auth.resolveChallenge(dto.challengeToken);
    return this.auth.startEnrollment(challenge.userId);
  }

  @Public()
  @Post('2fa/enroll/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm forced enrollment; returns session and recovery codes once' })
  @ApiOkResponse({ type: EnrollmentConfirmedDto })
  @ApiBadRequestResponse({ description: 'Wrong code' })
  @ApiConflictResponse({ description: 'Already enrolled' })
  async enrollConfirm(
    @Body() dto: ChallengeCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EnrollmentConfirmedDto> {
    const challenge = await this.auth.resolveChallenge(dto.challengeToken);
    const result = await this.auth.confirmEnrollmentWithChallenge(
      challenge.userId,
      dto.code,
      ctxOf(req),
      challenge.jti,
    );
    setRefreshCookie(res, result.session);
    return { session: result.session.body.session, recoveryCodes: result.recoveryCodes };
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete login with a TOTP code or a recovery code (FR-102)' })
  @ApiOkResponse({ type: AuthSessionDto })
  @ApiBadRequestResponse({ description: 'Wrong code' })
  @ApiUnauthorizedResponse({ description: 'Challenge expired' })
  async verify(
    @Body() dto: ChallengeCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionDto | undefined> {
    const challenge = await this.auth.resolveChallenge(dto.challengeToken);
    const outcome = await this.auth.completeLogin(
      challenge.userId,
      dto.code,
      ctxOf(req),
      challenge.jti,
    );
    setRefreshCookie(res, outcome);
    return outcome.body.session;
  }

  // Optional 2FA for roles that do not require it: a signed-in user turns it on.
  @Roles(...ALL_STAFF)
  @ApiBearerAuth()
  @Post('2fa/setup/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Signed-in user begins optional TOTP enrollment (FR-102)' })
  @ApiOkResponse({ type: TotpEnrollmentDto })
  setupStart(@Req() req: AuthedRequest): Promise<TotpEnrollmentDto> {
    return this.auth.startEnrollment(this.userId(req));
  }

  @Roles(...ALL_STAFF)
  @ApiBearerAuth()
  @Post('2fa/setup/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Signed-in user confirms optional TOTP; returns recovery codes once' })
  @ApiOkResponse({ type: EnrollmentConfirmedDto })
  @ApiBadRequestResponse({ description: 'Wrong code' })
  async setupConfirm(
    @Body() dto: TotpCodeDto,
    @Req() req: AuthedRequest,
  ): Promise<EnrollmentConfirmedDto> {
    const result = await this.auth.confirmEnrollment(this.userId(req), dto.code, ctxOf(req));
    return { recoveryCodes: result.recoveryCodes };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh cookie and return a new access token (FR-104)' })
  @ApiCookieAuth()
  @ApiOkResponse({ type: AuthSessionDto })
  @ApiUnauthorizedResponse({ description: 'No valid refresh cookie, or a rotated one was reused' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionDto | undefined> {
    const outcome = await this.auth.refresh(readRefreshCookie(req), ctxOf(req));
    setRefreshCookie(res, outcome);
    return outcome.body.session;
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the refresh-token family and clear the cookie (FR-104)' })
  @ApiNoContentResponse()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req), ctxOf(req));
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: cookieOptions.path,
    });
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Request a reset link; same response whether or not the account exists',
  })
  @ApiAcceptedResponse({ type: AcceptedDto })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this IP' })
  async forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request): Promise<AcceptedDto> {
    await this.auth.forgotPassword(dto.email, ctxOf(req));
    return { message: 'If the account exists, a reset link has been sent.' };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Set a new password with the single-use token (FR-107); never signs in',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'Token invalid, expired or already used' })
  async reset(@Body() dto: ResetPasswordDto, @Req() req: Request): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.newPassword, ctxOf(req));
  }

  private userId(req: AuthedRequest): string {
    if (!req.user) throw new Error('Guard did not attach a user');
    return req.user.id;
  }
}
