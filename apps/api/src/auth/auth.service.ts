// Staff authentication: FR-101 (login, lockout), FR-102 (TOTP, recovery codes), FR-104 (access
// JWT, rotating refresh tokens with family revocation) and FR-107 (password reset, ADR 0003).
// Nothing in this file logs a password, token, TOTP secret, recovery code or reset link.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env';
import { PrismaService } from '../database/prisma.module';
import { Prisma, UserRole } from '../generated/prisma/client';
import type { User } from '../generated/prisma/client';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import { MailPort } from '../mail/mail.port';
import type { AuthSessionDto, LoginResultDto, TotpEnrollmentDto } from './dto/auth.dto';
import { newOpaqueToken, newRecoveryCode, normalizeRecoveryCode, sha256Hex } from './crypto.util';
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

/** Short fingerprint of the current password hash; changes whenever the password does. */
function passwordVersion(passwordHash: string): string {
  return sha256Hex(passwordHash).slice(0, 16);
}

class RefreshReuseSignal extends Error {}

@Injectable()
export class AuthService {
  private readonly webOrigin: string;

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
      // Unknown, deactivated and pending-invite accounts cost the same time as a wrong password.
      await this.passwords.burn(password);
      throw this.invalid();
    }
    // The attempt is reserved atomically before the password is verified, so parallel guesses
    // cannot exceed the limit (FU-BE-26). A locked account gets the same answer as a wrong
    // password: never reveal that the account exists or is locked (FU-BE-22).
    if (!(await this.reserveAttempt(user.id))) {
      await this.passwords.burn(password);
      throw this.invalid();
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
    return this.startSession(user);
  }

  // ---- FR-102: TOTP -------------------------------------------------------------------------

  /**
   * Validates a 2FA challenge token and returns the user and its single-use id. The challenge is
   * bound to the password it was issued under, so a reset invalidates it (FU-BE-27).
   */
  async resolveChallenge(token: string): Promise<{ userId: string; jti: string }> {
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
    return { userId: user.id, jti: claims.jti };
  }

  private challengeExpired(): UnauthorizedException {
    return new UnauthorizedException('Your sign-in has expired. Sign in again.');
  }

  /**
   * Runs `fn` with the challenge marked used (Redis SET NX), so one challenge cannot mint two
   * sessions. The mark is released when `fn` fails (wrong code), so retries stay possible.
   */
  private async withChallengeUse<T>(jti: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (jti === undefined) return fn();
    const key = `auth:challenge:used:${jti}`;
    let claimed: string | null;
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
      claimed = await this.redis.set(key, '1', 'EX', CHALLENGE_TTL_SECONDS, 'NX');
    } catch {
      claimed = null; // fail closed
    }
    if (claimed !== 'OK') throw this.challengeExpired();
    let succeeded = false;
    try {
      const result = await fn();
      succeeded = true;
      return result;
    } finally {
      if (!succeeded) await this.redis.del(key).catch(() => undefined);
    }
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

  /**
   * First valid code switches TOTP on and issues the recovery codes, once. A challenge holder
   * (forced enrollment at login) also gets a session; a signed-in user does not need one.
   */
  async confirmEnrollment(
    userId: string,
    code: string,
    ctx: RequestContext,
    challengeJti?: string,
  ): Promise<{ session?: SessionOutcome; recoveryCodes: string[] }> {
    return this.withChallengeUse(challengeJti, () =>
      this.doConfirmEnrollment(userId, code, ctx, challengeJti !== undefined),
    );
  }

  private async doConfirmEnrollment(
    userId: string,
    code: string,
    ctx: RequestContext,
    openSession: boolean,
  ): Promise<{ session?: SessionOutcome; recoveryCodes: string[] }> {
    const user = await this.loadActive(userId);
    if (user.totpEnabled) throw new ConflictException('Two-factor authentication is already on.');
    // A locked account looks exactly like a wrong code (FU-BE-22, FU-BE-34).
    if (!(await this.reserveAttempt(user.id))) throw this.invalidCode();
    if (!user.totpSecretEnc || !this.totp.verify(user.totpSecretEnc, code)) {
      await this.registerFailure(user, ctx);
      throw this.invalidCode();
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const enabled = await this.prisma.client.user.updateMany({
      where: { id: user.id, totpEnabled: false },
      data: { totpEnabled: true, recoveryCodeHashes: codes.map((c) => sha256Hex(c)) },
    });
    if (enabled.count === 0)
      throw new ConflictException('Two-factor authentication is already on.');
    await this.audit(user, 'AUTH_TOTP_ENABLED', ctx);
    if (!openSession) {
      await this.clearFailures(user.id);
      return { recoveryCodes: codes };
    }
    return { session: await this.startSession(user), recoveryCodes: codes };
  }

  /** Completes a login with a TOTP code or a recovery code (FR-102, ADR 0003 section 1). */
  async completeLogin(
    userId: string,
    code: string,
    ctx: RequestContext,
    challengeJti: string,
  ): Promise<SessionOutcome> {
    return this.withChallengeUse(challengeJti, () => this.doCompleteLogin(userId, code, ctx));
  }

  private async doCompleteLogin(
    userId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<SessionOutcome> {
    const user = await this.loadActive(userId);
    if (!user.totpEnabled || !user.totpSecretEnc) throw this.challengeExpired();
    // Same status and message as a wrong code, so a locked account is indistinguishable.
    if (!(await this.reserveAttempt(user.id))) throw this.invalidCode();
    if (/^\d{6}$/.test(code)) {
      if (!this.totp.verify(user.totpSecretEnc, code)) return this.failCode(user, ctx);
    } else {
      const hash = sha256Hex(normalizeRecoveryCode(code));
      // The check and the removal are one statement, so two concurrent uses cannot both win.
      const used = await this.prisma.client.$executeRaw`
        UPDATE users SET recovery_code_hashes = array_remove(recovery_code_hashes, ${hash}),
                         updated_at = now()
        WHERE id = ${user.id}::uuid AND ${hash} = ANY(recovery_code_hashes)`;
      if (used !== 1) return this.failCode(user, ctx);
      await this.audit(user, 'AUTH_RECOVERY_CODE_USED', ctx);
    }
    return this.startSession(user);
  }

  private async failCode(user: UserWithOrg, ctx: RequestContext): Promise<never> {
    await this.registerFailure(user, ctx);
    throw this.invalidCode();
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
        const created = await tx.refreshToken.create({
          data: {
            userId: user.id,
            familyId: existing.familyId,
            tokenHash: sha256Hex(next),
            expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
          },
        });
        // Only one caller can flip revokedAt from null; a concurrent second use loses here.
        const flipped = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: created.id },
        });
        if (flipped.count !== 1) throw new RefreshReuseSignal();
      });
    } catch (e) {
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
    if (ipCount === null || emailCount === null || emailCount > FORGOT_PER_EMAIL) return;

    const user = await this.prisma.client.user.findUnique({ where: { email } });
    // Only an active account that already has a password may reset it. A pending invite keeps its
    // 72-hour invite token and gets nothing (FU-BE-32).
    const eligible = user?.isActive === true && user.passwordHash !== null;

    // Every account, real or not, costs the same: one token, one UPDATE statement. For anything
    // ineligible the UPDATE matches no row, so response timing does not reveal the account
    // (FU-BE-31).
    const token = newOpaqueToken();
    await this.prisma.client.user.updateMany({
      where: { id: eligible ? user.id : NO_USER_ID },
      data: {
        setPasswordTokenHash: sha256Hex(token),
        setPasswordExpiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    if (!eligible) return;
    const url = `${this.webOrigin}/admin/reset-password#token=${token}`;
    // Not awaited, so mail latency does not reveal whether the account exists.
    void this.mail.sendPasswordReset(user.email, url).catch(() => undefined);
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
   * Zero rows means the account is locked or already has MAX_FAILED_LOGINS attempts in flight, so
   * at most 5 guesses are ever verified per window however many requests arrive together. An
   * expired lock (or a stuck in-flight window older than two minutes) restarts the count.
   */
  private async reserveAttempt(userId: string): Promise<boolean> {
    const stale = Prisma.sql`(
      (locked_until IS NOT NULL AND locked_until <= now())
      OR (locked_until IS NULL AND failed_logins >= ${MAX_FAILED_LOGINS}::int
          AND updated_at < now() - interval '2 minutes'))`;
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE users SET
        failed_logins = CASE WHEN ${stale} THEN 1 ELSE failed_logins + 1 END,
        locked_until = CASE WHEN ${stale} THEN NULL ELSE locked_until END,
        updated_at = now()
      WHERE id = ${userId}::uuid
        AND (${stale} OR (locked_until IS NULL AND failed_logins < ${MAX_FAILED_LOGINS}::int))
      RETURNING id`);
    return rows.length === 1;
  }

  /** Gives back a reservation whose secret turned out right but whose login is not finished. */
  private async refundAttempt(userId: string): Promise<void> {
    await this.prisma.client.$executeRaw`
      UPDATE users SET failed_logins = failed_logins - 1
      WHERE id = ${userId}::uuid AND locked_until IS NULL AND failed_logins > 0`;
  }

  /** Clears the counter after a success, but never a lock a sibling request just set. */
  private async clearFailures(userId: string): Promise<void> {
    await this.prisma.client.$executeRaw`
      UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now()
      WHERE id = ${userId}::uuid AND (locked_until IS NULL OR locked_until <= now())`;
  }

  /**
   * A failed guess. The attempt was already counted by reserveAttempt; once all 5 slots are
   * used, exactly one failing request sets the 15 minute lock and writes the audit row (TC-002).
   */
  private async registerFailure(user: User, ctx: RequestContext): Promise<void> {
    const locked = await this.prisma.client.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE users SET
        locked_until = now() + make_interval(mins => ${LOCKOUT_MINUTES}::int),
        updated_at = now()
      WHERE id = ${user.id}::uuid
        AND failed_logins >= ${MAX_FAILED_LOGINS}::int
        AND locked_until IS NULL
      RETURNING id`);
    if (locked.length === 1) {
      await this.audit(user, 'AUTH_ACCOUNT_LOCKED', ctx, { minutes: LOCKOUT_MINUTES });
    }
  }

  private async audit(
    user: User,
    action: string,
    ctx: RequestContext,
    metadata: Prisma.InputJsonObject = {},
  ): Promise<void> {
    await this.prisma.client.auditLog.create({
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
      { sub: user.id, org: user.orgId, role: user.role, kind: 'access' },
      ACCESS_TTL_SECONDS,
    );
    return { status: 'authenticated', session: this.session(user, accessToken) };
  }

  /** Full sign-in: clears the failure counter and opens a new refresh-token family. */
  private async startSession(user: UserWithOrg): Promise<SessionOutcome> {
    await this.clearFailures(user.id);
    const refreshToken = newOpaqueToken();
    await this.prisma.client.refreshToken.create({
      data: {
        userId: user.id,
        familyId: randomUUID(),
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
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
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, FORGOT_WINDOW_SECONDS);
      return count;
    } catch {
      return null;
    }
  }
}
