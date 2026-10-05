// Staff authentication: FR-101 (login, lockout), FR-102 (TOTP, recovery codes), FR-104 (access
// JWT, rotating refresh tokens with family revocation) and FR-107 (password reset, ADR 0003).
// Nothing in this file logs a password, token, TOTP secret, recovery code or reset link.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.module';
import { Prisma, UserRole } from '../generated/prisma/client';
import type { User } from '../generated/prisma/client';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { ensureConnected } from '../infrastructure/redis-ready';
import { MailPort } from '../mail/mail.port';
import type { AuthSessionDto, LoginResultDto, TotpEnrollmentDto } from './dto/auth.dto';
import {
  newOpaqueToken,
  newRecoveryCode,
  normalizeRecoveryCode,
  passwordVersion,
  sha256Hex,
} from './crypto.util';
import { TokenService } from '../common/auth/token.service';
import { PasswordService } from './password.service';
import { TotpService } from './totp.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const RECOVERY_CODE_COUNT = 10;
const FORGOT_PER_EMAIL = 3;
const FORGOT_PER_IP = 10;
const FORGOT_WINDOW_SECONDS = 60 * 60;
/** Matches no user; used so unknown accounts run the same UPDATE as real ones. */
const NO_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Roles that must use TOTP (FR-102). */
const TOTP_REQUIRED_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN, UserRole.REVIEWER];

export interface RequestContext {
  ip?: string;
}

export type UserWithOrg = User & { org: { name: string } };

export interface SessionOutcome {
  body: LoginResultDto;
  /** Raw refresh token for the httpOnly cookie. Absent when no new session started. */
  refreshToken?: string;
}

class RefreshReuseSignal extends Error {}
class AlreadyEnrolledSignal extends Error {}
class WrongRecoveryCodeSignal extends Error {}
/** The password (or the 2FA secret) changed after it was verified: no session may open (FR-104). */
class PasswordChangedSignal extends Error {}

/** A reservation is granted, or refused (locked, window full, or a stuck window just locked). */
type Reservation = 'granted' | 'denied';

/** Failures that mean "try again with the same challenge": a wrong code or an outage. */
function isRetryable(e: unknown): boolean {
  return e instanceof BadRequestException || e instanceof ServiceUnavailableException;
}

@Injectable()
export class AuthService implements OnApplicationShutdown {
  private readonly webOrigin: string;
  private readonly logger = new Logger(AuthService.name);
  /** Deferred forgot-password work still running; awaited by tests and at shutdown. */
  private readonly deferred = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly mail: MailPort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
  }

  // ---- FR-101: login ------------------------------------------------------------------------

  async login(email: string, password: string, ctx: RequestContext): Promise<SessionOutcome> {
    const user = await this.prisma.client.user.findUnique({
      where: { email },
      include: { org: { select: { name: true } } },
    });
    if (!user?.isActive || !user.passwordHash) {
      // Unknown, deactivated and pending-invite accounts run the same statements as a wrong
      // password, against a nil id, so the work done does not reveal the account (FU-BE-22/30).
      return this.rejectWithSameWork(password, ctx);
    }
    // The attempt is reserved atomically before the password is verified, so parallel guesses
    // cannot exceed the limit (FU-BE-26). A locked account gets the same answer and the same
    // statements as a wrong password: never reveal that the account exists or is locked.
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') {
      return this.burnAndFail(password, ctx);
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.registerFailure(user, ctx);
      throw this.invalid();
    }

    if (user.totpEnabled) {
      // The password was right: give the reservation back. The 2FA step reserves its own.
      await this.refundAttempt(user.id);
      return {
        body: { status: 'two_factor_required', challengeToken: this.challenge(user) },
      };
    }
    if (TOTP_REQUIRED_ROLES.includes(user.role)) {
      await this.refundAttempt(user.id);
      return {
        body: {
          status: 'two_factor_enrollment_required',
          challengeToken: this.challenge(user),
        },
      };
    }
    try {
      return await this.startSession(user);
    } catch (e) {
      // A reset landed while the password was being verified: the sign-in is refused and the
      // reserved attempt is given back, as the password was right when it was checked.
      if (e instanceof PasswordChangedSignal) {
        await this.refundAttempt(user.id).catch(() => undefined);
        throw this.invalid();
      }
      throw e;
    }
  }

  /** Unknown or ineligible account: reserve, burn and register against the nil id. */
  private async rejectWithSameWork(password: string, ctx: RequestContext): Promise<never> {
    await this.reserveAttempt(null, ctx);
    return this.burnAndFail(password, ctx);
  }

  /** Argon2 against a dummy hash, then a failure-shaped UPDATE that matches no row. */
  private async burnAndFail(password: string, ctx: RequestContext): Promise<never> {
    await this.passwords.burn(password);
    await this.registerFailure(null, ctx);
    throw this.invalid();
  }

  // ---- FR-102: TOTP -------------------------------------------------------------------------

  /**
   * Validates a 2FA challenge token and returns the user and its single-use id. The challenge is
   * bound to the password it was issued under, so a reset invalidates it (FU-BE-27).
   */
  async resolveChallenge(token: string): Promise<{ userId: string; jti: string; pwv: string }> {
    let claims: { sub?: unknown; kind?: unknown; jti?: unknown; pwv?: unknown };
    try {
      claims = this.tokens.verify(token) as typeof claims;
    } catch {
      throw this.challengeExpired();
    }
    if (
      claims.kind !== 'challenge' ||
      typeof claims.sub !== 'string' ||
      typeof claims.jti !== 'string' ||
      typeof claims.pwv !== 'string'
    ) {
      throw this.challengeExpired();
    }
    const user = await this.prisma.client.user.findUnique({ where: { id: claims.sub } });
    if (
      !user?.isActive ||
      !user.passwordHash ||
      passwordVersion(user.passwordHash) !== claims.pwv
    ) {
      throw this.challengeExpired();
    }
    return { userId: user.id, jti: claims.jti, pwv: claims.pwv };
  }

  private challengeExpired(): UnauthorizedException {
    return new UnauthorizedException('Your sign-in has expired. Sign in again.');
  }

  /**
   * Runs `fn` with the challenge marked used (Redis SET NX), so one challenge cannot mint two
   * sessions. A Redis outage is a 503 (nothing is reserved or counted yet). The mark is released
   * only when `fn` ends in a wrong code or an outage, so a retry stays possible; once state may
   * have changed the challenge stays spent. If releasing the mark also fails (Redis
   * still down), the challenge stays spent until its TTL: the user signs in again.
   */
  private async withChallengeUse<T>(jti: string, fn: () => Promise<T>): Promise<T> {
    const key = `auth:challenge:used:${jti}`;
    let claimed: string | null;
    try {
      await ensureConnected(this.redis);
      claimed = await this.redis.set(key, '1', 'EX', CHALLENGE_TTL_SECONDS, 'NX');
    } catch {
      throw this.unavailable();
    }
    if (claimed !== 'OK') throw this.challengeExpired();
    try {
      return await fn();
    } catch (e) {
      if (isRetryable(e)) await this.redis.del(key).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Re-authentication for the signed-in setup routes (FU-BE-39): the current password, checked
   * on the same reserve, equal-work and lockout path as login. A wrong password and a locked
   * account get the same generic 401, so the lock state is never revealed. The reservation is
   * given back on success: the TOTP step reserves its own. Returns the user row whose password
   * hash was verified, so the caller can bind its final write to that hash.
   */
  private async requireCurrentPassword(
    userId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<UserWithOrg> {
    const user = await this.loadActive(userId);
    if (!user.passwordHash) return this.rejectWithSameWork(password, ctx);
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') {
      return this.burnAndFail(password, ctx);
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.registerFailure(user, ctx);
      throw this.invalid();
    }
    await this.refundAttempt(user.id);
    return user;
  }

  /** A signed-in user begins optional TOTP enrollment; needs the current password (FU-BE-39). */
  async startSetup(
    userId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<TotpEnrollmentDto> {
    const user = await this.requireCurrentPassword(userId, password, ctx);
    const startHash = user.passwordHash ?? '';
    const enrollment = await this.totp.createEnrollment(user.email);
    if (user.totpEnabled) throw new ConflictException('Two-factor authentication is already on.');
    // The secret is stored only while the verified password is still current.
    const stored = await this.prisma.client.user.updateMany({
      where: { id: user.id, passwordHash: startHash, totpEnabled: false },
      data: { totpSecretEnc: enrollment.encrypted },
    });
    if (stored.count !== 1) throw this.invalid();
    return {
      manualKey: enrollment.secret,
      otpauthUri: enrollment.otpauthUrl,
      qrDataUrl: enrollment.qrDataUrl,
    };
  }

  async startEnrollment(userId: string): Promise<TotpEnrollmentDto> {
    const user = await this.loadActive(userId);
    if (user.totpEnabled) throw new ConflictException('Two-factor authentication is already on.');
    const enrollment = await this.totp.createEnrollment(user.email);
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: enrollment.encrypted },
    });
    return {
      manualKey: enrollment.secret,
      otpauthUri: enrollment.otpauthUrl,
      qrDataUrl: enrollment.qrDataUrl,
    };
  }

  /** A signed-in user confirms optional TOTP (FR-102): recovery codes only, no new session. */
  async confirmEnrollment(
    userId: string,
    password: string,
    code: string,
    ctx: RequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const verified = await this.requireCurrentPassword(userId, password, ctx);
    // TOTP is switched on only while the verified password hash is still the stored one (FU-BE-39).
    return this.doConfirmEnrollment(
      userId,
      code,
      ctx,
      false,
      undefined,
      verified.passwordHash ?? '',
    );
  }

  /**
   * Forced enrollment at login: the challenge holder is also given a session. The challenge is
   * claimed first, so it can be spent only once.
   */
  confirmEnrollmentWithChallenge(
    userId: string,
    code: string,
    ctx: RequestContext,
    challenge: { jti: string; pwv: string },
  ): Promise<{ session: SessionOutcome; recoveryCodes: string[] }> {
    return this.withChallengeUse(challenge.jti, async () => {
      const done = await this.doConfirmEnrollment(userId, code, ctx, true, challenge.pwv);
      if (!done.session) throw new Error('Enrollment finished without a session');
      return { session: done.session, recoveryCodes: done.recoveryCodes };
    });
  }

  /**
   * First valid code switches TOTP on and issues the recovery codes, once. Enabling TOTP, the
   * recovery hashes, the audit row and the session are one transaction (FR-102).
   */
  private async doConfirmEnrollment(
    userId: string,
    code: string,
    ctx: RequestContext,
    openSession: boolean,
    challengePwv?: string,
    boundPasswordHash?: string,
  ): Promise<{ session?: SessionOutcome; recoveryCodes: string[] }> {
    const user = await this.loadActive(userId);
    if (challengePwv !== undefined) this.requireChallengePassword(user, challengePwv);
    if (boundPasswordHash !== undefined && user.passwordHash !== boundPasswordHash) {
      throw this.invalid();
    }
    if (user.totpEnabled) throw new ConflictException('Two-factor authentication is already on.');
    // A locked account looks exactly like a wrong code (FU-BE-22, FU-BE-34).
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') throw this.invalidCode();
    const checkedSecret = user.totpSecretEnc;
    const valid = checkedSecret ? await this.verifyTotp(user, checkedSecret, code) : false;
    if (!valid) {
      await this.registerFailure(user, ctx);
      throw this.invalidCode();
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    try {
      const session = await this.prisma.client.$transaction(async (tx) => {
        const enabled = await tx.user.updateMany({
          // The secret must still be the one the code was checked against.
          where: {
            id: user.id,
            totpEnabled: false,
            totpSecretEnc: checkedSecret,
            ...(boundPasswordHash === undefined ? {} : { passwordHash: boundPasswordHash }),
          },
          data: { totpEnabled: true, recoveryCodeHashes: codes.map((c) => sha256Hex(c)) },
        });
        if (enabled.count === 0) {
          if (boundPasswordHash !== undefined) {
            const now = await tx.user.findUnique({ where: { id: user.id } });
            if (now?.passwordHash !== boundPasswordHash) throw new PasswordChangedSignal();
          }
          throw new AlreadyEnrolledSignal();
        }
        await this.audit(user, 'AUTH_TOTP_ENABLED', ctx, {}, tx);
        if (!openSession) {
          await this.clearFailures(user.id, tx);
          return undefined;
        }
        return this.startSession(user, tx);
      });
      return { session, recoveryCodes: codes };
    } catch (e) {
      // The code was right, so the reservation is not a failed guess.
      await this.refundAttempt(user.id).catch(() => undefined);
      if (e instanceof AlreadyEnrolledSignal) {
        throw new ConflictException('Two-factor authentication could not be turned on. Try again.');
      }
      if (e instanceof PasswordChangedSignal) {
        throw boundPasswordHash === undefined ? this.challengeExpired() : this.invalid();
      }
      throw e;
    }
  }

  /**
   * TOTP check for a reserved attempt. A Redis outage throws a 503 and gives the reservation
   * back, so an outage can neither count as a failed guess nor lock anyone out.
   */
  private async verifyTotp(user: User, encryptedSecret: string, code: string): Promise<boolean> {
    try {
      return await this.totp.verify(user.id, encryptedSecret, code);
    } catch (e) {
      await this.refundAttempt(user.id).catch(() => undefined);
      throw e;
    }
  }

  /** Completes a login with a TOTP code or a recovery code (FR-102, ADR 0003 section 1). */
  async completeLogin(
    userId: string,
    code: string,
    ctx: RequestContext,
    challenge: { jti: string; pwv: string },
  ): Promise<SessionOutcome> {
    return this.withChallengeUse(challenge.jti, () =>
      this.doCompleteLogin(userId, code, ctx, challenge.pwv),
    );
  }

  private async doCompleteLogin(
    userId: string,
    code: string,
    ctx: RequestContext,
    challengePwv: string,
  ): Promise<SessionOutcome> {
    const user = await this.loadActive(userId);
    this.requireChallengePassword(user, challengePwv);
    const secret = user.totpSecretEnc;
    if (!user.totpEnabled || !secret) throw this.challengeExpired();
    // Same status and message as a wrong code, so a locked account is indistinguishable.
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') throw this.invalidCode();
    try {
      if (/^\d{6}$/.test(code)) {
        if (!(await this.verifyTotp(user, secret, code))) {
          return await this.failCode(user, ctx);
        }
        return await this.startSession(user, this.prisma.client, secret);
      }
      const hash = sha256Hex(normalizeRecoveryCode(code));
      // Removing the code and opening the session are one transaction, so a password change that
      // refuses the session also puts the code back.
      return await this.prisma.client.$transaction(async (tx) => {
        // The check and the removal are one statement, so two concurrent uses cannot both win.
        const used = await tx.$executeRaw`
          UPDATE users SET recovery_code_hashes = array_remove(recovery_code_hashes, ${hash}),
                           updated_at = now()
          WHERE id = ${user.id}::uuid AND ${hash} = ANY(recovery_code_hashes)`;
        if (used !== 1) throw new WrongRecoveryCodeSignal();
        await this.audit(user, 'AUTH_RECOVERY_CODE_USED', ctx, {}, tx);
        return this.startSession(user, tx, secret);
      });
    } catch (e) {
      if (e instanceof WrongRecoveryCodeSignal) return this.failCode(user, ctx);
      if (e instanceof PasswordChangedSignal) {
        await this.refundAttempt(user.id).catch(() => undefined);
        throw this.challengeExpired();
      }
      throw e;
    }
  }

  /** The user row just loaded must still carry the password the challenge was issued under. */
  private requireChallengePassword(user: User, challengePwv: string): void {
    if (!user.passwordHash || passwordVersion(user.passwordHash) !== challengePwv) {
      throw this.challengeExpired();
    }
  }

  private async failCode(user: UserWithOrg, ctx: RequestContext): Promise<never> {
    await this.registerFailure(user, ctx);
    throw this.invalidCode();
  }

  // ---- FR-102: manage 2FA while signed in ---------------------------------------------------

  /**
   * Turns 2FA off for the signed-in user. Needs the current password (same path as setup). Roles
   * that must use 2FA are refused, since disabling would bypass FR-102. Other sessions are left
   * alone: an access token carries no family id, so the caller's own family cannot be told
   * apart from the rest.
   */
  async disableTwoFactor(userId: string, password: string, ctx: RequestContext): Promise<void> {
    const user = await this.requireCurrentPassword(userId, password, ctx);
    if (TOTP_REQUIRED_ROLES.includes(user.role)) throw this.twoFactorRequiredForRole();
    if (!user.totpEnabled) throw new ConflictException('Two-factor authentication is not on.');
    await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordHash: user.passwordHash ?? '',
          totpEnabled: true,
          role: { notIn: [...TOTP_REQUIRED_ROLES] },
        },
        data: { totpEnabled: false, totpSecretEnc: null, recoveryCodeHashes: [] },
      });
      if (updated.count !== 1) await this.explainRefusedChange(tx, user);
      await this.audit(user, 'AUTH_2FA_DISABLED', ctx, {}, tx);
    });
  }

  /** Replaces all recovery codes with 10 new ones; the old ones stop working at once. */
  async regenerateRecoveryCodes(
    userId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.requireCurrentPassword(userId, password, ctx);
    if (!user.totpEnabled) throw new ConflictException('Two-factor authentication is not on.');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash ?? '', totpEnabled: true },
        data: { recoveryCodeHashes: codes.map((c) => sha256Hex(c)) },
      });
      if (updated.count !== 1) await this.explainRefusedChange(tx, user);
      await this.audit(user, 'AUTH_RECOVERY_CODES_REGENERATED', ctx, {}, tx);
    });
    return { recoveryCodes: codes };
  }

  /** Why a bound write matched nothing: password changed (401), or the 2FA state moved (409). */
  private async explainRefusedChange(tx: Prisma.TransactionClient, user: User): Promise<never> {
    const now = await tx.user.findUnique({ where: { id: user.id } });
    if (now?.passwordHash !== user.passwordHash) throw this.invalid();
    if (now && TOTP_REQUIRED_ROLES.includes(now.role)) throw this.twoFactorRequiredForRole();
    throw new ConflictException('Two-factor authentication changed. Try again.');
  }

  private twoFactorRequiredForRole(): ForbiddenException {
    return new ForbiddenException('Two-factor authentication is required for your role.');
  }

  /**
   * A SUPER_ADMIN clears another user's 2FA (lost device and recovery codes). Same organisation
   * only: another org's user is a 404, like a missing one. The password is not touched. The users
   * row is locked first, then refresh_tokens (same order as a password reset). A session being
   * opened from the old second factor is refused by startSession's bound secret. Access tokens
   * already issued stay valid until they expire (15 minutes): the guard keys on the password
   * version, which this does not change; the refresh families are all revoked, so none renews.
   * A role that requires 2FA is sent through forced enrollment at the next login (FR-102).
   */
  async resetTwoFactorOf(
    actor: { id: string; orgId: string },
    targetId: string,
    ctx: RequestContext,
  ): Promise<void> {
    if (actor.id === targetId) {
      throw new BadRequestException('Use your own security settings to change your 2FA.');
    }
    await this.prisma.client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM users
        WHERE id = ${targetId}::uuid AND org_id = ${actor.orgId}::uuid
        FOR UPDATE`);
      if (locked.length !== 1) throw new NotFoundException('User not found.');
      await tx.user.update({
        where: { id: targetId },
        data: { totpEnabled: false, totpSecretEnc: null, recoveryCodeHashes: [] },
      });
      const revoked = await tx.refreshToken.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          orgId: actor.orgId,
          actorId: actor.id,
          action: 'AUTH_2FA_RESET_BY_ADMIN',
          entityType: 'user',
          entityId: targetId,
          ip: ctx.ip ?? null,
          metadata: { targetUserId: targetId, sessionsRevoked: revoked.count },
        },
      });
    });
  }

  // ---- FR-104: refresh and logout -----------------------------------------------------------

  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<SessionOutcome> {
    if (!rawToken) throw new UnauthorizedException('Authentication required.');
    const tokenHash = sha256Hex(rawToken);
    const existing = await this.prisma.client.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) throw new UnauthorizedException('Authentication required.');

    if (existing.revokedAt) {
      // A rotated or revoked token came back: assume theft and kill the whole family (TC-005).
      const revoked = await this.revokeFamily(existing.familyId);
      const owner = await this.prisma.client.user.findUnique({ where: { id: existing.userId } });
      // Audit only when the reuse actually killed live tokens, not on every later retry.
      if (owner && revoked > 0) await this.audit(owner, 'AUTH_REFRESH_REUSE_DETECTED', ctx);
      throw new UnauthorizedException('Authentication required.');
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Authentication required.');
    }
    const user = await this.prisma.client.user.findUnique({
      where: { id: existing.userId },
      include: { org: { select: { name: true } } },
    });
    if (!user?.isActive) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException('Authentication required.');
    }

    const next = newOpaqueToken();
    try {
      await this.prisma.client.$transaction(async (tx) => {
        // The new token exists only while the account is active and still has the password hash
        // loaded above. FOR SHARE locks the user row: a reset in flight is waited for (then the
        // WHERE fails), and a reset arriving later waits for this commit and revokes the new
        // token too. This also closes the race with deactivation (FR-104, FR-107).
        // `?? ''` is deliberate: an empty hash can never match, so nothing is inserted.
        const created = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
          SELECT u.id, ${existing.familyId}::uuid, ${sha256Hex(next)},
                 ${new Date(Date.now() + REFRESH_TTL_MS)}::timestamptz
          FROM users u
          WHERE u.id = ${user.id}::uuid AND u.is_active
            AND u.password_hash = ${user.passwordHash ?? ''}
          FOR SHARE OF u
          RETURNING id`);
        const createdId = created[0]?.id;
        if (created.length !== 1 || !createdId) throw new PasswordChangedSignal();
        // Only one caller can flip revokedAt from null; a concurrent second use loses here.
        const flipped = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: createdId },
        });
        if (flipped.count !== 1) throw new RefreshReuseSignal();
      });
    } catch (e) {
      if (e instanceof PasswordChangedSignal) {
        await this.revokeFamily(existing.familyId);
        throw new UnauthorizedException('Authentication required.');
      }
      if (e instanceof RefreshReuseSignal) {
        await this.revokeFamily(existing.familyId);
        await this.audit(user, 'AUTH_REFRESH_REUSE_DETECTED', ctx);
        throw new UnauthorizedException('Authentication required.');
      }
      throw e;
    }
    return { body: this.authenticated(user), refreshToken: next };
  }

  async logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (!rawToken) return;
    const existing = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
    });
    if (!existing) return;
    await this.revokeFamily(existing.familyId);
    const user = await this.prisma.client.user.findUnique({ where: { id: existing.userId } });
    if (user) await this.audit(user, 'AUTH_LOGOUT', ctx);
  }

  // ---- FR-107: password reset ---------------------------------------------------------------

  /** Always resolves the same way for the caller, except an IP over its limit (429). */
  async forgotPassword(email: string, ctx: RequestContext): Promise<void> {
    const ipCount = await this.hit(`pwreset:ip:${ctx.ip ?? 'unknown'}`);
    if (ipCount !== null && ipCount > FORGOT_PER_IP) {
      throw new HttpException('Too many requests.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const emailCount = await this.hit(`pwreset:email:${sha256Hex(email.toLowerCase())}`);
    // Over the per-email limit (or Redis down): answer the same, send nothing.
    if (ipCount === null || emailCount === null) {
      this.logger.warn('reset limiter unavailable');
      return;
    }
    if (emailCount > FORGOT_PER_EMAIL) return;

    // Everything that depends on the account happens after this method has returned, so the
    // response is the same for a real, pending, deactivated or unknown account (FU-BE-31).
    this.defer(() => this.deliverReset(email));
  }

  /** Waits for deferred work (tests and graceful shutdown). */
  async settleDeferred(): Promise<void> {
    while (this.deferred.size > 0) await Promise.allSettled([...this.deferred]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.settleDeferred();
  }

  private defer(work: () => Promise<void>): void {
    const task: Promise<void> = new Promise<void>((resolve) => {
      setImmediate(() => {
        Promise.resolve()
          .then(work)
          .catch((e: unknown) => {
            // Name only: the error may carry an address, a token or a query value.
            this.logger.error(`Deferred password-reset work failed (${errorName(e)})`);
          })
          .finally(resolve);
      });
    }).finally(() => this.deferred.delete(task));
    this.deferred.add(task);
  }

  private async deliverReset(email: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({ where: { email } });
    // Only an active account that already has a password may reset it. A pending invite keeps its
    // 72-hour invite token and gets nothing (FU-BE-32).
    if (user?.isActive !== true || user.passwordHash === null) return;
    const token = newOpaqueToken();
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: {
        setPasswordTokenHash: sha256Hex(token),
        setPasswordExpiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    const url = `${this.webOrigin}/admin/reset-password#token=${token}`;
    await this.mail.sendPasswordReset(user.email, url);
  }

  async resetPassword(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    const tokenHash = sha256Hex(token);
    const user = await this.prisma.client.user.findUnique({
      where: { setPasswordTokenHash: tokenHash },
    });
    if (
      !user?.isActive ||
      !user.setPasswordExpiresAt ||
      user.setPasswordExpiresAt.getTime() <= Date.now()
    ) {
      throw this.invalidResetLink();
    }
    const passwordHash = await this.passwords.hash(newPassword);
    const done = await this.prisma.client.$transaction(async (tx) => {
      // Single use: the token is only valid while it is still stored and unexpired.
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          setPasswordTokenHash: tokenHash,
          setPasswordExpiresAt: { gt: new Date() },
        },
        data: {
          passwordHash,
          setPasswordTokenHash: null,
          setPasswordExpiresAt: null,
          failedLogins: 0,
          lockedUntil: null,
        },
      });
      if (updated.count !== 1) return false;
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          orgId: user.orgId,
          actorId: user.id,
          action: 'AUTH_PASSWORD_RESET',
          entityType: 'user',
          entityId: user.id,
          ip: ctx.ip ?? null,
          metadata: {},
        },
      });
      return true;
    });
    if (!done) throw this.invalidResetLink();
  }

  // ---- helpers ------------------------------------------------------------------------------

  private invalid(): UnauthorizedException {
    return new UnauthorizedException('Invalid email or password.');
  }

  private invalidResetLink(): BadRequestException {
    return new BadRequestException('This reset link is invalid or has expired.');
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException('Verification is temporarily unavailable.');
  }

  private invalidCode(): BadRequestException {
    return new BadRequestException('That code is not valid.');
  }

  private async loadActive(id: string): Promise<UserWithOrg> {
    const user = await this.prisma.client.user.findUnique({
      where: { id },
      include: { org: { select: { name: true } } },
    });
    if (!user?.isActive) throw new UnauthorizedException('Authentication required.');
    return user;
  }

  /**
   * Reserves one verification attempt atomically, before the secret is checked (FU-BE-26).
   * At most MAX_FAILED_LOGINS attempts are ever granted per window, however many requests arrive
   * together. Fail closed: if all slots are used and no failure has set the lock for two minutes
   * (a verify is stuck or its process died), the account is locked for the lockout period instead
   * of the count restarting, so slow verifies can never widen the window. Only an expired lock
   * restarts the count. A null user runs the identical statement against the nil id, which
   * matches no row (FU-BE-30); a refused attempt on a real account also matches no row.
   */
  private async reserveAttempt(user: User | null, ctx: RequestContext): Promise<Reservation> {
    const lockExpired = Prisma.sql`(old.locked_until IS NOT NULL AND old.locked_until <= now())`;
    const open = Prisma.sql`(old.locked_until IS NULL AND old.failed_logins < ${MAX_FAILED_LOGINS}::int)`;
    const stale = Prisma.sql`(old.locked_until IS NULL AND old.failed_logins >= ${MAX_FAILED_LOGINS}::int
      AND old.updated_at < now() - interval '2 minutes')`;
    const rows = await this.prisma.client.$queryRaw<{ granted: boolean }[]>(Prisma.sql`
      WITH old AS (
        SELECT id, failed_logins, locked_until, updated_at
        FROM users WHERE id = ${user?.id ?? NO_USER_ID}::uuid FOR UPDATE)
      UPDATE users u SET
        failed_logins = CASE WHEN ${lockExpired} THEN 1
                             WHEN ${open} THEN old.failed_logins + 1
                             ELSE old.failed_logins END,
        locked_until = CASE WHEN ${lockExpired} OR ${open} THEN NULL
                            ELSE now() + make_interval(mins => ${LOCKOUT_MINUTES}::int) END
      FROM old
      WHERE u.id = old.id AND (${lockExpired} OR ${open} OR ${stale})
      RETURNING (${lockExpired} OR ${open}) AS granted`);
    const row = rows[0];
    if (!row) return 'denied';
    if (row.granted) return 'granted';
    // The stuck window was just locked here.
    if (user) await this.audit(user, 'AUTH_ACCOUNT_LOCKED', ctx, { minutes: LOCKOUT_MINUTES });
    return 'denied';
  }

  /** Gives back a reservation whose secret turned out right but whose login is not finished. */
  private async refundAttempt(userId: string): Promise<void> {
    await this.prisma.client.$executeRaw`
      UPDATE users SET failed_logins = failed_logins - 1
      WHERE id = ${userId}::uuid AND locked_until IS NULL AND failed_logins > 0`;
  }

  /** Clears the counter after a success, but never a lock a sibling request just set. */
  private async clearFailures(
    userId: string,
    db: Prisma.TransactionClient = this.prisma.client,
  ): Promise<void> {
    await db.$executeRaw`
      UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now()
      WHERE id = ${userId}::uuid AND (locked_until IS NULL OR locked_until <= now())`;
  }

  /**
   * A failed guess. The attempt was already counted by reserveAttempt; once all 5 slots are
   * used, exactly one failing request sets the 15 minute lock and writes the audit row (TC-002).
   * A null user runs the same statement against the nil id so every refused login costs the
   * same round trips.
   */
  private async registerFailure(user: User | null, ctx: RequestContext): Promise<void> {
    const locked = await this.prisma.client.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE users SET
        locked_until = now() + make_interval(mins => ${LOCKOUT_MINUTES}::int),
        updated_at = now()
      WHERE id = ${user?.id ?? NO_USER_ID}::uuid
        AND failed_logins >= ${MAX_FAILED_LOGINS}::int
        AND locked_until IS NULL
      RETURNING id`);
    if (user && locked.length === 1) {
      await this.audit(user, 'AUTH_ACCOUNT_LOCKED', ctx, { minutes: LOCKOUT_MINUTES });
    }
  }

  private async audit(
    user: User,
    action: string,
    ctx: RequestContext,
    metadata: Prisma.InputJsonObject = {},
    db: Prisma.TransactionClient = this.prisma.client,
  ): Promise<void> {
    await db.auditLog.create({
      data: {
        orgId: user.orgId,
        actorId: user.id,
        action,
        entityType: 'user',
        entityId: user.id,
        ip: ctx.ip ?? null,
        metadata,
      },
    });
  }

  private async revokeFamily(familyId: string): Promise<number> {
    const result = await this.prisma.client.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  private challenge(user: User): string {
    return this.tokens.sign(
      {
        sub: user.id,
        org: user.orgId,
        role: user.role,
        kind: 'challenge',
        jti: randomUUID(),
        pwv: passwordVersion(user.passwordHash ?? ''),
      },
      CHALLENGE_TTL_SECONDS,
    );
  }

  private authenticated(user: UserWithOrg): LoginResultDto {
    const accessToken = this.tokens.sign(
      {
        sub: user.id,
        org: user.orgId,
        role: user.role,
        kind: 'access',
        // Bound to the password in force, so a reset ends the token at once (FU-BE-19).
        pwv: passwordVersion(user.passwordHash ?? ''),
      },
      ACCESS_TTL_SECONDS,
    );
    return { status: 'authenticated', session: this.session(user, accessToken) };
  }

  /** Full sign-in: clears the failure counter and opens a new refresh-token family. */
  private async startSession(
    user: UserWithOrg,
    db: Prisma.TransactionClient = this.prisma.client,
    boundTotpSecret?: string,
  ): Promise<SessionOutcome> {
    const refreshToken = newOpaqueToken();
    // The token exists only if the password is still the one that was verified. FOR SHARE (not
    // FOR KEY SHARE, which does not conflict with a non-key UPDATE) locks the user row in this
    // statement: it waits for an in-flight reset, re-checks the WHERE against the new row version
    // and inserts nothing; a reset arriving later waits for this commit, so its revoke-all sees
    // the token. A family can never outlive a reset (FR-104, FR-107).
    // `?? ''` is deliberate: an empty hash can never equal a stored hash, so it inserts nothing.
    // A 2FA completion also binds the TOTP secret it checked: an admin reset of the user's 2FA
    // that lands in between clears it, so no session is opened from the old second factor.
    const totpBound =
      boundTotpSecret === undefined
        ? Prisma.empty
        : Prisma.sql`AND u.totp_enabled AND u.totp_secret_enc = ${boundTotpSecret}`;
    const inserted = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
      SELECT u.id, ${randomUUID()}::uuid, ${sha256Hex(refreshToken)},
             ${new Date(Date.now() + REFRESH_TTL_MS)}::timestamptz
      FROM users u
      WHERE u.id = ${user.id}::uuid AND u.is_active AND u.password_hash = ${user.passwordHash ?? ''}
        ${totpBound}
      FOR SHARE OF u
      RETURNING id`);
    if (inserted.length !== 1) throw new PasswordChangedSignal();
    await this.clearFailures(user.id, db);
    return { body: this.authenticated(user), refreshToken };
  }

  private session(user: UserWithOrg, accessToken: string): AuthSessionDto {
    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.fullName,
        role: user.role,
        orgName: user.org.name,
      },
    };
  }

  /** Increments a windowed counter. Returns null when Redis is unavailable (callers fail closed). */
  private async hit(key: string): Promise<number | null> {
    try {
      await ensureConnected(this.redis);
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, FORGOT_WINDOW_SECONDS);
      return count;
    } catch {
      return null;
    }
  }
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown';
}
