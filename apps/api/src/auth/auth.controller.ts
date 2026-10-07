import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
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
import type { SessionOutcome } from './auth.service';
import { ctxOf } from '../common/request-context';
import {
  AcceptedDto,
  AuthSessionDto,
  ChallengeCodeDto,
  ChallengeDto,
  CurrentPasswordDto,
  DisableTwoFactorDto,
  EnrollmentConfirmedDto,
  ForgotPasswordDto,
  LoginDto,
  LoginResultDto,
  RecoveryCodesDto,
  ResetPasswordDto,
  SetupConfirmDto,
  SetupStartDto,
  TotpEnrollmentDto,
} from './dto/auth.dto';

export const REFRESH_COOKIE = 'cp_refresh';
// Responses that carry a TOTP secret, QR code, recovery codes or a bearer token are never cached.
const NO_STORE = 'no-store';
const ALL_STAFF = [UserRole.SUPER_ADMIN, UserRole.RECRUITER, UserRole.AUTHOR, UserRole.REVIEWER];

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  signed: true,
  path: '/api/v1/auth',
};

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
  @Header('Cache-Control', NO_STORE)
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
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Begin forced TOTP enrollment with the login challenge (FR-102)' })
  @ApiOkResponse({ type: TotpEnrollmentDto })
  @ApiUnauthorizedResponse({ description: 'Challenge expired' })
  async enrollStart(@Body() dto: ChallengeDto): Promise<TotpEnrollmentDto> {
    const challenge = await this.auth.resolveChallenge(dto.challengeToken);
    return this.auth.startEnrollment(challenge.userId, challenge.pwv);
  }

  @Public()
  @Post('2fa/enroll/confirm')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
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
      challenge,
    );
    setRefreshCookie(res, result.session);
    return { session: result.session.body.session, recoveryCodes: result.recoveryCodes };
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
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
      challenge,
    );
    setRefreshCookie(res, outcome);
    return outcome.body.session;
  }

  // Optional 2FA for roles that do not require it: a signed-in user turns it on.
  @Roles(...ALL_STAFF)
  @ApiBearerAuth()
  @Post('2fa/setup/start')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Signed-in user begins optional TOTP enrollment (FR-102)' })
  @ApiOkResponse({ type: TotpEnrollmentDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({
    description:
      "Wrong current password or locked account: one generic body with code 'REAUTH_FAILED' (not a session expiry)",
  })
  setupStart(@Body() dto: SetupStartDto, @Req() req: AuthedRequest): Promise<TotpEnrollmentDto> {
    return this.auth.startSetup(this.userId(req), dto.currentPassword, ctxOf(req));
  }

  @Roles(...ALL_STAFF)
  @ApiBearerAuth()
  @Post('2fa/setup/confirm')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Signed-in user confirms optional TOTP; returns recovery codes once' })
  @ApiOkResponse({ type: EnrollmentConfirmedDto })
  @ApiBadRequestResponse({ description: 'Wrong code' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({
    description:
      "Wrong current password or locked account: one generic body with code 'REAUTH_FAILED' (not a session expiry)",
  })
  async setupConfirm(
    @Body() dto: SetupConfirmDto,
    @Req() req: AuthedRequest,
  ): Promise<EnrollmentConfirmedDto> {
    const result = await this.auth.confirmEnrollment(
      this.userId(req),
      dto.currentPassword,
      dto.code,
      ctxOf(req),
    );
    return { recoveryCodes: result.recoveryCodes };
  }

  @Roles(...ALL_STAFF)
  @ApiBearerAuth()
  @Post('2fa/disable')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Turn 2FA off; needs the current password and a current TOTP code; signs the user out everywhere (refresh cookie cleared); not for 2FA-required roles',
  })
  @ApiNoContentResponse({ description: 'Refresh cookie cleared; every session is revoked' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({
    description:
      "Wrong or locked current password, or a wrong or replayed TOTP code (one identical body, detail 'The password or code is incorrect.', so it does not say which part was wrong): code 'REAUTH_FAILED' (not a session expiry). A code that was already used to sign in counts as replayed: wait for the next code. 2FA required for this role: code 'TWO_FACTOR_REQUIRED_FOR_ROLE', checked after the password",
  })
  @ApiConflictResponse({ description: '2FA is not on' })
  @ApiServiceUnavailableResponse({ description: 'Code verification is temporarily unavailable' })
  async disable(
    @Body() dto: DisableTwoFactorDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.disableTwoFactor(
      this.userId(req),
      dto.currentPassword,
      dto.totpCode,
      ctxOf(req),
    );
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: cookieOptions.path,
    });
  }

  @Roles(...ALL_STAFF)
  @ApiBearerAuth()
  @Post('2fa/recovery-codes/regenerate')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Replace all recovery codes; needs the current password (FR-102)' })
  @ApiOkResponse({ type: RecoveryCodesDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({
    description:
      "Wrong current password or locked account: one generic body with code 'REAUTH_FAILED' (not a session expiry)",
  })
  @ApiConflictResponse({ description: '2FA is not on' })
  regenerateRecoveryCodes(
    @Body() dto: CurrentPasswordDto,
    @Req() req: AuthedRequest,
  ): Promise<RecoveryCodesDto> {
    return this.auth.regenerateRecoveryCodes(this.userId(req), dto.currentPassword, ctxOf(req));
  }

  @Roles(UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @Post('2fa/reset/:userId')
  @HttpCode(204)
  @ApiOperation({
    summary:
      "Super admin clears another user's 2FA and revokes their refresh sessions; needs the admin's own current password (FR-102). The target's access tokens issued so far end at once (Redis marker; 503 and no change if Redis is down).",
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'Not a UUID, or the caller targeted themselves' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({
    description:
      "Caller is not a super admin, or the admin's own current password is wrong or locked (code 'REAUTH_FAILED')",
  })
  @ApiNotFoundResponse({ description: 'No such user in your organization' })
  async resetTwoFactor(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: CurrentPasswordDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    if (!req.user) throw new Error('Guard did not attach a user');
    await this.auth.resetTwoFactorOf(req.user, userId, dto.currentPassword, ctxOf(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @ApiOperation({ summary: 'Rotate the refresh cookie and return a new access token (FR-104)' })
  @ApiCookieAuth()
  @ApiOkResponse({ type: AuthSessionDto })
  @ApiUnauthorizedResponse({ description: 'No valid refresh cookie, or a rotated one was reused' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionDto | undefined> {
    try {
      const outcome = await this.auth.refresh(readRefreshCookie(req), ctxOf(req));
      setRefreshCookie(res, outcome);
      return outcome.body.session;
    } catch (e) {
      // A refused refresh cookie can never succeed later (unknown, expired, revoked, or the fixed
      // outcome-unknown 401 whose commit may have landed). Clear it so a later page load or tab
      // does not send a revoked token and trip reuse detection (FR-104, TC-005, FU-BE-207).
      // A 503 BUSY keeps the cookie: that retry is safe by construction.
      if (e instanceof UnauthorizedException) {
        res.clearCookie(REFRESH_COOKIE, {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: cookieOptions.path,
        });
      }
      throw e;
    }
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
