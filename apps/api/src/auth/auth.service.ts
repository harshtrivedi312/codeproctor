// Staff authentication: FR-101 (login, lockout), FR-102 (TOTP, recovery codes), FR-104 (access
// JWT, rotating refresh tokens with family revocation) and FR-107 (password reset, ADR 0003).
// Nothing in this file logs a password, token, TOTP secret, recovery code or reset link.
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BeforeApplicationShutdown,
  OnApplicationShutdown,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';
import { Prisma, UserRole } from '../generated/prisma/client';
import type { RefreshToken, User } from '../generated/prisma/client';
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
import type { RequestContext } from '../common/request-context';
import { errorName } from '../common/request-context';
import { isObject, lockContentionCode } from '../common/db-contention';
import { ACCESS_TTL_SECONDS } from '../common/auth/access-ttl';
import { TokenService } from '../common/auth/token.service';
import { TokenValidityService } from '../common/auth/token-validity.service';
import { CodedForbiddenException, disableRefused, reauthFailed } from '../common/coded.exception';
import { hitWindowCounter } from '../common/redis-counter';
import { PasswordService } from './password.service';
import { TotpService } from './totp.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export { ACCESS_TTL_SECONDS };
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const RECOVERY_CODE_COUNT = 10;
const FORGOT_PER_EMAIL = 3;
const FORGOT_PER_IP = 10;
const FORGOT_WINDOW_SECONDS = 60 * 60;
/** Matches no user; used so unknown accounts run the same UPDATE as real ones. */
const NO_USER_ID = '00000000-0000-0000-0000-000000000000';
/** The org of the nil user: the same statement shape, matching no row. */
const NO_ORG_ID = '00000000-0000-0000-0000-000000000000';

/** Roles that must use TOTP (FR-102). */
const TOTP_REQUIRED_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN, UserRole.REVIEWER];

/** The org-scoped client or one of its transactions: what the helpers below accept. */
type Db = Pick<
  OrgScopedPrismaClient,
  'user' | 'refreshToken' | 'auditLog' | '$queryRaw' | '$executeRaw'
>;

export type { RequestContext };

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
  // Database lock contention is answered 503 + Retry-After (DL-37): the transaction rolled back,
  // so the same challenge must stay usable for the retry it invites.
  return (
    e instanceof BadRequestException ||
    e instanceof ServiceUnavailableException ||
    lockContentionCode(e) !== undefined
  );
}

/** How long shutdown waits for deferred reset and lock mail. */
const SHUTDOWN_SETTLE_MS = 5_000;
/** Second, catch-all settle in onApplicationShutdown. */
const SHUTDOWN_CATCH_ALL_MS = 1_000;

@Injectable()
export class AuthService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly webOrigin: string;
  private readonly logger = new Logger(AuthService.name);
  /** Errors whose reservation was already given back, so a caller does not refund them twice. */
  private readonly refundedErrors = new WeakSet<object>();
  /** Deferred forgot-password work still running; awaited by tests and at shutdown. */
  private readonly deferred = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly tokens: TokenService,
    private readonly validity: TokenValidityService,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly mail: MailPort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
  }

  // ---- org scope (FU-DB-58, database/README.md 'Auth bootstrap recipe') ----------------------
  //
  // Every entry point that runs before the caller is known (login, 2FA completion, refresh,
  // logout, forgot and reset) enters runSystem('AUTH_BOOTSTRAP') for its lookup and narrows to
  // the user's org with runAsUser as soon as the user row is in hand. Entry points behind the
  // guard run in the org scope the interceptor already set. Raw SQL is reviewed one statement at
  // a time through runRawSql. Entering a context sends no statement.

  /** Raw SQL for one statement; the reason is for the reviewer. */
  private raw<T>(reason: string, run: () => Promise<T>): Promise<T> {
    return this.orgContext.runRawSql(reason, run);
  }

  /** Narrows system scope to the user's org (a no-op change of scope inside the same org). */
  private asUser<T>(user: Pick<User, 'id' | 'orgId' | 'role'>, fn: () => Promise<T>): Promise<T> {
    return this.orgContext.runAsUser({ orgId: user.orgId, userId: user.id, role: user.role }, fn);
  }

  // ---- FR-101: login ------------------------------------------------------------------------

  login(email: string, password: string, ctx: RequestContext): Promise<SessionOutcome> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () => this.doLogin(email, password, ctx));
  }

  private async doLogin(
    email: string,
    password: string,
    ctx: RequestContext,
  ): Promise<SessionOutcome> {
    const user = await this.prisma.client.user.findUnique({
      where: { email },
      include: { org: { select: { name: true } } },
    });
    if (!user?.isActive || !user.passwordHash) {
      // Unknown, deactivated and pending-invite accounts run the same statements as a wrong
      // password, against a nil id, so the work done does not reveal the account (FU-BE-22/30).
      return this.rejectWithSameWork(password, ctx);
    }
    const { passwordHash } = user;
    return this.asUser(user, () => this.loginKnownUser(user, passwordHash, password, ctx));
  }

  private async loginKnownUser(
    user: UserWithOrg,
    passwordHash: string,
    password: string,
    ctx: RequestContext,
  ): Promise<SessionOutcome> {
    // The attempt is reserved atomically before the password is verified, so parallel guesses
    // cannot exceed the limit (FU-BE-26). A locked account gets the same answer and the same
    // statements as a wrong password: never reveal that the account exists or is locked.
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') {
      return this.burnAndFail(password, ctx);
    }
    if (!(await this.passwords.verify(passwordHash, password))) {
      await this.registerFailure(user, ctx);
      throw this.invalid();
    }

    if (user.totpEnabled) {
      // The password was right: give the reservation back. The 2FA step reserves its own.
      await this.refundAttempt(user);
      return {
        body: { status: 'two_factor_required', challengeToken: this.challenge(user) },
      };
    }
    if (TOTP_REQUIRED_ROLES.includes(user.role)) {
      await this.refundAttempt(user);
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
        await this.refundAttempt(user).catch(() => undefined);
        throw this.invalid();
      }
      // DL-37: the password was already right and opening the session hit lock contention (503,
      // retry): give back the attempt of THIS request only. startSession runs on the root client
      // here, with no transaction: the refresh-family INSERT may already have committed when
      // clearFailures fails, leaving a family whose token was never delivered (unusable; FU-BE-184). Failed-guess counts (wrong
      // password, wrong code) are never refunded, so contention cannot erase an attacker's count.
      if (lockContentionCode(e) !== undefined)
        await this.refundAttempt(user).catch(() => undefined);
      throw e;
    }
  }

  /** Unknown or ineligible account: reserve, burn and register against the nil id. */
  private async rejectWithSameWork(
    password: string,
    ctx: RequestContext,
    fail: () => Error = () => this.invalid(),
  ): Promise<never> {
    await this.reserveAttempt(null, ctx);
    return this.burnAndFail(password, ctx, fail);
  }

  /** Argon2 against a dummy hash, then a failure-shaped UPDATE that matches no row. */
  private async burnAndFail(
    password: string,
    ctx: RequestContext,
    fail: () => Error = () => this.invalid(),
  ): Promise<never> {
    await this.passwords.burn(password);
    await this.registerFailure(null, ctx);
    throw fail();
  }

  // ---- FR-102: TOTP -------------------------------------------------------------------------

  /**
   * Validates a 2FA challenge token and returns the user and its single-use id. The challenge is
   * bound to the password it was issued under, so a reset invalidates it (FU-BE-27).
   */
  resolveChallenge(token: string): Promise<{ userId: string; jti: string; pwv: string }> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () => this.doResolveChallenge(token));
  }

  private async doResolveChallenge(
    token: string,
  ): Promise<{ userId: string; jti: string; pwv: string }> {
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
   * when `fn` ends in a wrong code, an outage or database lock contention (503 + Retry-After), so
   * a retry stays possible. Other errors leave it spent. Contention can follow a committed refresh
   * family INSERT (the TOTP path has no transaction around startSession), which then never
   * reaches the client: unusable, and tracked by FU-BE-184. If releasing the mark also fails (Redis
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
   * account get the same generic 403 REAUTH_FAILED, so the lock state is never revealed. The reservation is
   * given back on success: the TOTP step reserves its own. Returns the user row whose password
   * hash was verified, so the caller can bind its final write to that hash. `refuse` builds the
   * refusal (default REAUTH_FAILED); /2fa/disable passes its own fixed detail (FU-BE-58).
   */
  private async requireCurrentPassword(
    userId: string,
    password: string,
    ctx: RequestContext,
    refuse: () => CodedForbiddenException = reauthFailed,
  ): Promise<UserWithOrg> {
    const user = await this.loadActive(userId);
    if (!user.passwordHash) return this.rejectWithSameWork(password, ctx, refuse);
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') {
      return this.burnAndFail(password, ctx, refuse);
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.registerFailure(user, ctx);
      throw refuse();
    }
    await this.refundAttempt(user);
    return user;
  }

  /**
   * Step-up for the SUPER_ADMIN user-management routes (follows the FR-102 re-auth decision): the
   * admin's current password on the login path (reserve, equal work, shared lockout). A wrong or
   * locked password is the same 403 REAUTH_FAILED. Returns the verified hash so the caller can bind
   * its transaction to it.
   */
  async verifyCurrentPassword(
    userId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<{ passwordHash: string }> {
    const user = await this.requireCurrentPassword(userId, password, ctx);
    return { passwordHash: user.passwordHash ?? '' };
  }

  /** A signed-in user begins optional TOTP enrollment; needs the current password (FU-BE-39). */
  async startSetup(
    userId: string,
    password: string,
    ctx: RequestContext,
  ): Promise<TotpEnrollmentDto> {
    const user = await this.requireCurrentPassword(userId, password, ctx);
    if (user.totpEnabled) throw new ConflictException('Two-factor authentication is already on.');
    const startHash = user.passwordHash ?? '';
    const enrollment = await this.totp.createEnrollment(user.email);
    // The secret is stored only while the verified password is still current.
    const stored = await this.prisma.client.user.updateMany({
      where: { id: user.id, passwordHash: startHash, totpEnabled: false },
      data: { totpSecretEnc: enrollment.encrypted },
    });
    if (stored.count !== 1) {
      // Only a changed password is a failed re-auth; TOTP turned on meanwhile is a plain 409.
      const now = await this.prisma.client.user.findUnique({ where: { id: user.id } });
      if (now?.passwordHash !== user.passwordHash) throw reauthFailed();
      throw new ConflictException('Two-factor authentication is already on.');
    }
    return {
      manualKey: enrollment.secret,
      otpauthUri: enrollment.otpauthUrl,
      qrDataUrl: enrollment.qrDataUrl,
    };
  }

  /** Forced enrollment at login: public (the challenge is the credential), so it starts in system scope. */
  startEnrollment(userId: string, challengePwv: string): Promise<TotpEnrollmentDto> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', async () => {
      const user = await this.loadActive(userId);
      return this.asUser(user, () => this.beginEnrollment(user, challengePwv));
    });
  }

  private async beginEnrollment(
    user: UserWithOrg,
    challengePwv: string,
  ): Promise<TotpEnrollmentDto> {
    this.requireChallengePassword(user, challengePwv);
    if (user.totpEnabled) throw new ConflictException('Two-factor authentication is already on.');
    const startHash = user.passwordHash ?? '';
    const enrollment = await this.totp.createEnrollment(user.email);
    // Conditional write (FU-BE-86): the account must still be active, on the password the challenge
    // was issued under (the pwv was checked against the row read above, and the hash is bound
    // here), and not enrolled. A reset or deactivation after that read, or an enroll/confirm that
    // committed after it, changes nothing.
    const stored = await this.prisma.client.user.updateMany({
      where: { id: user.id, isActive: true, passwordHash: startHash, totpEnabled: false },
      data: { totpSecretEnc: enrollment.encrypted },
    });
    if (stored.count !== 1) {
      // Same split as startSetup, with the refusal the challenge routes give (confirm uses it for
      // the same race): a changed password or a deactivation voids the challenge (401); TOTP
      // turned on meanwhile is a plain 409.
      const now = await this.prisma.client.user.findUnique({ where: { id: user.id } });
      if (!now?.isActive || now.passwordHash !== user.passwordHash) throw this.challengeExpired();
      throw new ConflictException('Two-factor authentication is already on.');
    }
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
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () =>
      this.withChallengeUse(challenge.jti, async () => {
        const done = await this.doConfirmEnrollment(userId, code, ctx, true, challenge.pwv);
        if (!done.session) throw new Error('Enrollment finished without a session');
        return { session: done.session, recoveryCodes: done.recoveryCodes };
      }),
    );
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
    return this.asUser(user, () =>
      this.confirmKnownUser(user, code, ctx, openSession, challengePwv, boundPasswordHash),
    );
  }

  private async confirmKnownUser(
    user: UserWithOrg,
    code: string,
    ctx: RequestContext,
    openSession: boolean,
    challengePwv?: string,
    boundPasswordHash?: string,
  ): Promise<{ session?: SessionOutcome; recoveryCodes: string[] }> {
    if (challengePwv !== undefined) this.requireChallengePassword(user, challengePwv);
    if (boundPasswordHash !== undefined && user.passwordHash !== boundPasswordHash) {
      throw reauthFailed();
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
          await this.clearFailures(user, tx);
          return undefined;
        }
        // The row was loaded before the update above, so report the state just written.
        return this.startSession({ ...user, totpEnabled: true }, tx);
      });
      return { session, recoveryCodes: codes };
    } catch (e) {
      // The code was right, so the reservation is not a failed guess.
      await this.refundAttempt(user).catch(() => undefined);
      if (e instanceof AlreadyEnrolledSignal) {
        throw new ConflictException('Two-factor authentication could not be turned on. Try again.');
      }
      if (e instanceof PasswordChangedSignal) {
        throw boundPasswordHash === undefined ? this.challengeExpired() : reauthFailed();
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
      await this.refundAttempt(user).catch(() => undefined);
      // The caller must not refund this same failure a second time (DL-37).
      if (isObject(e)) this.refundedErrors.add(e);
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
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () =>
      this.withChallengeUse(challenge.jti, () =>
        this.doCompleteLogin(userId, code, ctx, challenge.pwv),
      ),
    );
  }

  private async doCompleteLogin(
    userId: string,
    code: string,
    ctx: RequestContext,
    challengePwv: string,
  ): Promise<SessionOutcome> {
    const user = await this.loadActive(userId);
    return this.asUser(user, () => this.completeKnownUser(user, code, ctx, challengePwv));
  }

  private async completeKnownUser(
    user: UserWithOrg,
    code: string,
    ctx: RequestContext,
    challengePwv: string,
  ): Promise<SessionOutcome> {
    this.requireChallengePassword(user, challengePwv);
    const secret = user.totpSecretEnc;
    if (!user.totpEnabled || !secret) throw this.challengeExpired();
    // Same status and message as a wrong code, so a locked account is indistinguishable.
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') throw this.invalidCode();
    let wrongCode = false;
    try {
      if (/^\d{6}$/.test(code)) {
        if (!(await this.verifyTotp(user, secret, code))) {
          wrongCode = true; // a failed guess is never refunded (DL-37)
          return await this.failCode(user, ctx);
        }
        return await this.startSession(user, this.prisma.client, secret);
      }
      const hash = sha256Hex(normalizeRecoveryCode(code));
      // Removing the code and opening the session are one transaction, so a password change that
      // refuses the session also puts the code back.
      return await this.prisma.client.$transaction(async (tx) => {
        // The check and the removal are one statement, so two concurrent uses cannot both win.
        const used = await this.raw(
          'consume one recovery code atomically: check and removal in one UPDATE (FR-102)',
          () => tx.$executeRaw`
            UPDATE users SET recovery_code_hashes = array_remove(recovery_code_hashes, ${hash}),
                             updated_at = now()
            WHERE id = ${user.id}::uuid AND org_id = ${user.orgId}::uuid
              AND ${hash} = ANY(recovery_code_hashes)`,
        );
        if (used !== 1) throw new WrongRecoveryCodeSignal();
        await this.audit(user, 'AUTH_RECOVERY_CODE_USED', ctx, {}, tx);
        return this.startSession(user, tx, secret);
      });
    } catch (e) {
      // A wrong recovery code is a failed guess: counted by failCode, returned before any refund
      // below, so it is never refunded (DL-37).
      if (e instanceof WrongRecoveryCodeSignal) return this.failCode(user, ctx);
      if (e instanceof PasswordChangedSignal) {
        await this.refundAttempt(user).catch(() => undefined);
        throw this.challengeExpired();
      }
      // DL-37: contention (503, retry) before a verdict on the code was recorded gave no guess
      // oracle, so this request's reservation goes back. A wrong code (failCode) is never refunded.
      if (
        !wrongCode &&
        lockContentionCode(e) !== undefined &&
        !(isObject(e) && this.refundedErrors.has(e))
      ) {
        await this.refundAttempt(user).catch(() => undefined);
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
   * Turns 2FA off for the signed-in user (ADR 0011). Needs the current password AND a current
   * TOTP code, so a stolen access token plus a phished password is not enough. Order: password
   * (shared reserve and lockout, 403 REAUTH_FAILED), then 409 when 2FA is off, then the TOTP code
   * on its own reservation (same lockout, replay-protected; a wrong or replayed code is the same
   * 403 REAUTH_FAILED body as a wrong password; a Redis outage is a 503 with the reservation
   * given back), and only then the role refusal. Every refusal on this route (wrong password,
   * wrong or replayed code, locked account, password changed meanwhile) carries one fixed detail,
   * 'The password or code is incorrect.' (FU-BE-58), so nothing says which factor was wrong and
   * the user is not sent to retype a correct password. A code that already signed the user in
   * (same 30 s step) is a replay: wait for the next code. A code reservation refused after the
   * password passed skips verifyTotp and registerFailure (only someone who already proved the
   * password can reach it). The 409 before the code check tells someone who
   * already holds the password only that 2FA is off, which the signed-in user can see anyway.
   * Roles that must use 2FA are refused (FR-102). One transaction clears secret, flag and
   * recovery hashes (users row first), then revokes every refresh-token family of the user,
   * including the caller's own (users before refresh_tokens, the lock order every other path
   * uses), and audits. A refresh or a 2FA login racing this either waits on the users row lock
   * and is refused, or commits first and is revoked here. Access tokens already issued end at
   * once through the BE-03 tokens-valid-after marker (set in the same transaction).
   */
  async disableTwoFactor(
    userId: string,
    password: string,
    totpCode: string,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.requireCurrentPassword(userId, password, ctx, disableRefused);
    if (!user.totpEnabled) throw new ConflictException('Two-factor authentication is not on.');
    const secret = user.totpSecretEnc;
    if ((await this.reserveAttempt(user, ctx)) !== 'granted') throw disableRefused();
    if (!secret || !(await this.verifyTotp(user, secret, totpCode))) {
      await this.registerFailure(user, ctx);
      throw disableRefused();
    }
    // Both factors passed: the reservation is not a failed guess.
    await this.refundAttempt(user).catch(() => undefined);
    if (TOTP_REQUIRED_ROLES.includes(user.role)) throw this.twoFactorRequiredForRole();
    await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordHash: user.passwordHash ?? '',
          totpEnabled: true,
          totpSecretEnc: secret,
          role: { notIn: [...TOTP_REQUIRED_ROLES] },
        },
        data: { totpEnabled: false, totpSecretEnc: null, recoveryCodeHashes: [] },
      });
      if (updated.count !== 1) await this.explainRefusedChange(tx, user, true, disableRefused);
      const revoked = await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Access tokens issued so far end too (Redis marker; a Redis outage rolls this back, 503).
      await this.validity.invalidateIssuedTokens(user.id);
      await this.audit(user, 'AUTH_2FA_DISABLED', ctx, { sessionsRevoked: revoked.count }, tx);
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
      if (updated.count !== 1) await this.explainRefusedChange(tx, user, false);
      await this.audit(user, 'AUTH_RECOVERY_CODES_REGENERATED', ctx, {}, tx);
    });
    return { recoveryCodes: codes };
  }

  /** Why a bound write matched nothing: password changed (403 REAUTH_FAILED), or the 2FA state moved (409). */
  private async explainRefusedChange(
    tx: Db,
    user: User,
    fromDisable: boolean,
    refuse: () => CodedForbiddenException = reauthFailed,
  ): Promise<never> {
    const now = await tx.user.findUnique({ where: { id: user.id } });
    if (now?.passwordHash !== user.passwordHash) throw refuse();
    // The enforced-role refusal only applies to disable; a regenerate race is a plain 409.
    if (fromDisable && now && TOTP_REQUIRED_ROLES.includes(now.role))
      throw this.twoFactorRequiredForRole();
    throw new ConflictException('Two-factor authentication changed. Try again.');
  }

  private twoFactorRequiredForRole(): CodedForbiddenException {
    return new CodedForbiddenException(
      'Two-factor authentication is required for your role.',
      'TWO_FACTOR_REQUIRED_FOR_ROLE',
    );
  }

  /**
   * A SUPER_ADMIN clears another user's 2FA (lost device and recovery codes). The admin's own
   * current password is verified first, outside the transaction, on the same reserve, equal-work
   * and lockout path as login (a stolen access token alone cannot reset anyone). Same organisation
   * only: another org's user is a 404, like a missing one. The target's password is not touched.
   * The target row is locked FOR NO KEY UPDATE (it still conflicts with startSession's and
   * refresh()'s FOR SHARE, but not with the FOR KEY SHARE the audit insert takes on the actor row
   * through audit_logs.actor_id, so two admins resetting each other cannot deadlock). Then
   * refresh_tokens, same order as a password reset. A session being opened from the old second
   * factor is refused by startSession's bound secret. Access tokens already issued end at once
   * through the Redis tokens-valid-after marker (the password version does not change); the refresh
   * families are all revoked, so none renews. A role that requires 2FA is
   * sent through forced enrollment at the next login (FR-102).
   */
  async resetTwoFactorOf(
    actor: { id: string; orgId: string },
    rawTargetId: string,
    adminPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    // UUIDs are case-insensitive in Postgres: compare and use the canonical lowercase form.
    const targetId = rawTargetId.toLowerCase();
    const actorId = actor.id.toLowerCase();
    if (actorId === targetId) {
      throw new BadRequestException('Use your own security settings to change your 2FA.');
    }
    const verified = await this.requireCurrentPassword(actor.id, adminPassword, ctx);
    await this.prisma.client.$transaction(async (tx) => {
      // The admin's password hash, role and active flag are re-checked here with a plain read (the
      // admin row is deliberately not locked: locking it would allow an A<->B deadlock between
      // two admins resetting each other). It runs before the lock, so a changed admin gets
      // REAUTH_FAILED whether or not the target exists.
      const stillAdmin = await tx.user.count({
        where: {
          id: actor.id,
          orgId: actor.orgId,
          passwordHash: verified.passwordHash ?? '',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
        },
      });
      if (stillAdmin !== 1) throw reauthFailed();
      const locked = await this.raw(
        'row lock on the target user, FOR NO KEY UPDATE, same org only',
        () =>
          tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id FROM users
          WHERE id = ${targetId}::uuid AND org_id = ${actor.orgId}::uuid
          FOR NO KEY UPDATE`),
      );
      if (locked.length !== 1) throw new NotFoundException('User not found.');
      // Also enforced after the lock, on the id as the database sees it.
      if (locked[0]?.id === actorId) {
        throw new BadRequestException('Use your own security settings to change your 2FA.');
      }
      const target = await tx.user.findUniqueOrThrow({ where: { id: targetId } });
      await tx.user.update({
        where: { id: targetId },
        data: { totpEnabled: false, totpSecretEnc: null, recoveryCodeHashes: [] },
      });
      const revoked = await tx.refreshToken.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Access tokens issued so far end too (Redis marker; a Redis outage rolls this back, 503).
      await this.validity.invalidateIssuedTokens(targetId);
      await tx.auditLog.create({
        data: {
          orgId: actor.orgId,
          actorId: actor.id,
          action: 'AUTH_2FA_RESET_BY_ADMIN',
          entityType: 'user',
          entityId: targetId,
          ip: ctx.ip ?? null,
          metadata: {
            previouslyEnabled: target.totpEnabled,
            targetRole: target.role,
            sessionsRevoked: revoked.count,
          },
        },
      });
    });
  }

  // ---- FR-104: refresh and logout -----------------------------------------------------------

  refresh(rawToken: string | undefined, ctx: RequestContext): Promise<SessionOutcome> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', () => this.doRefresh(rawToken, ctx));
  }

  private async doRefresh(
    rawToken: string | undefined,
    ctx: RequestContext,
  ): Promise<SessionOutcome> {
    if (!rawToken) throw new UnauthorizedException('Authentication required.');
    const tokenHash = sha256Hex(rawToken);
    const existing = await this.prisma.client.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) throw new UnauthorizedException('Authentication required.');
    // The token names its user (a foreign key), so the org is known from here on.
    const user = await this.prisma.client.user.findUnique({
      where: { id: existing.userId },
      include: { org: { select: { name: true } } },
    });
    if (!user) throw new UnauthorizedException('Authentication required.');
    return this.asUser(user, () => this.rotate(existing, user, ctx));
  }

  private async rotate(
    existing: RefreshToken,
    user: UserWithOrg,
    ctx: RequestContext,
  ): Promise<SessionOutcome> {
    if (existing.revokedAt) {
      // A rotated or revoked token came back: assume theft and kill the whole family (TC-005).
      const revoked = await this.revokeFamily(existing.familyId);
      // Audit only when the reuse actually killed live tokens, not on every later retry.
      if (revoked > 0) await this.auditAfterCommit(user, 'AUTH_REFRESH_REUSE_DETECTED', ctx);
      throw new UnauthorizedException('Authentication required.');
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Authentication required.');
    }
    if (!user.isActive) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException('Authentication required.');
    }
    // Defence in depth: a role that requires 2FA never gets a token from a family that was not
    // opened through 2FA (a promotion racing a password sign-in). Same 401, family revoked.
    if (TOTP_REQUIRED_ROLES.includes(user.role) && !user.totpEnabled) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException('Authentication required.');
    }

    const next = newOpaqueToken();
    // Signed before the rotation commits, like startSession (S1).
    const body = this.authenticated(user);
    // Phase tracking for the failure rule below (FR-104, DL-37, FU-BE-197).
    let callbackStarted = false;
    let callbackFinished = false;
    try {
      await this.prisma.client.$transaction(async (tx) => {
        callbackStarted = true;
        // The new token exists only while the account is active and still has the password hash
        // loaded above. FOR SHARE locks the user row: a reset in flight is waited for (then the
        // WHERE fails), and a reset arriving later waits for this commit and revokes the new
        // token too. This also closes the race with deactivation (FR-104, FR-107).
        // `?? ''` is deliberate: an empty hash can never match, so nothing is inserted.
        const created = await this.raw(
          'rotate refresh token: INSERT ... SELECT ... FOR SHARE of the user row (FR-104, FR-107)',
          () =>
            tx.$queryRaw<{ id: string }[]>(Prisma.sql`
              INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
              SELECT u.id, ${existing.familyId}::uuid, ${sha256Hex(next)},
                     ${new Date(Date.now() + REFRESH_TTL_MS)}::timestamptz
              FROM users u
              WHERE u.id = ${user.id}::uuid AND u.org_id = ${user.orgId}::uuid AND u.is_active
                AND u.password_hash = ${user.passwordHash ?? ''}
                AND u.role = ${user.role}::user_role
              FOR SHARE OF u
              RETURNING id`),
        );
        const createdId = created[0]?.id;
        if (created.length !== 1 || !createdId) throw new PasswordChangedSignal();
        // Only one caller can flip revokedAt from null; a concurrent second use loses here.
        const flipped = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: createdId },
        });
        if (flipped.count !== 1) throw new RefreshReuseSignal();
        callbackFinished = true;
      });
    } catch (e) {
      if (e instanceof PasswordChangedSignal) {
        await this.revokeFamily(existing.familyId);
        throw new UnauthorizedException('Authentication required.');
      }
      if (e instanceof RefreshReuseSignal) {
        // Only a real reuse kills live tokens; a reset that revoked the family first does not
        // raise a theft alert (FU-BE-41).
        const revoked = await this.revokeFamily(existing.familyId);
        if (revoked > 0) await this.auditAfterCommit(user, 'AUTH_REFRESH_REUSE_DETECTED', ctx);
        throw new UnauthorizedException('Authentication required.');
      }
      // Failure rule (FR-104, TC-005, DL-37, hub ruling FU-BE-207; pool exhaustion is FU-BE-197). This transaction inserts the new refresh
      // token and flips the old one to revoked. If the commit landed on the server but the client
      // saw P2028 or a lost connection, a 503 would invite a retry with the OLD token, which is now
      // revoked, and reuse detection would kill the whole family (a forced logout that looks like
      // theft). So only a failure that is certainly a clean rollback answers 503 BUSY:
      //   - before the callback started (no transaction: pool timeout, contention on BEGIN, and
      //     Prisma's own start-timeout P2028 are all nothing-happened failures);
      //   - inside the callback body, a statement-level lock error (55P03, 40P01, 40001, P2034).
      // Everything else (the callback finished and the commit failed, P2028 inside, a connection
      // loss, anything unexpected) is outcome-unknown: a fixed non-retryable 401 tells the client to
      // sign in again. It changes no state and revokes nothing. Since #216 lockContentionCode maps
      // P2028 to 503 BUSY on every route, which is exactly the retry trap this closes. The pool
      // timeout (#276) needs no token here: it surfaces before the callback starts, by phase.
      if (!callbackStarted) throw e;
      const code = lockContentionCode(e);
      if (!callbackFinished && code !== undefined && code !== 'P2028') throw e;
      // Name and fixed code token only, never the message (it can hold SQL and values).
      this.logger.error(
        `Refresh rotation outcome unknown (${errorName(e)}, ${code ?? 'no-code'}) REFRESH_ROTATE_UNKNOWN`,
      );
      throw new UnauthorizedException('Authentication required.');
    }
    return { body, refreshToken: next };
  }

  logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (!rawToken) return Promise.resolve();
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', async () => {
      const existing = await this.prisma.client.refreshToken.findUnique({
        where: { tokenHash: sha256Hex(rawToken) },
      });
      if (!existing) return;
      const user = await this.prisma.client.user.findUnique({ where: { id: existing.userId } });
      if (!user) return;
      await this.asUser(user, async () => {
        await this.revokeFamily(existing.familyId);
        await this.auditAfterCommit(user, 'AUTH_LOGOUT', ctx);
      });
    });
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
    this.defer('password-reset', () =>
      this.orgContext.runSystem('AUTH_BOOTSTRAP', () => this.deliverReset(email)),
    );
  }

  /** Waits for deferred work (tests and graceful shutdown). */
  async settleDeferred(): Promise<void> {
    while (this.deferred.size > 0) await Promise.allSettled([...this.deferred]);
  }

  /**
   * Nest 11 order: onModuleDestroy, beforeApplicationShutdown, dispose() (the HTTP server closes),
   * onApplicationShutdown. This hook gives deferred reset and lock mail up to 5 s to reach the
   * email queue, which is still accepting at this point. Bounded so a stuck query cannot stall
   * shutdown until SIGKILL; the deferred work is only mail, so giving up loses at most a reset or
   * lock email.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.settleDeferredBounded(SHUTDOWN_SETTLE_MS);
  }

  /**
   * Catch-all for work deferred after the hook above but before dispose() closed the server. Short
   * bound. It is not guaranteed to run before the email queue stops (hook order between providers
   * is not defined), so such a mail can still be dropped; the queue logs the count then.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.settleDeferredBounded(SHUTDOWN_CATCH_ALL_MS);
  }

  /** Like settleDeferred, but gives up after timeoutMs and logs a fixed line (no payload). */
  async settleDeferredBounded(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      this.settleDeferred().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      this.logger.warn(
        `Shutdown gave up waiting for ${this.deferred.size} deferred tasks after ${timeoutMs} ms`,
      );
    }
  }

  private defer(label: string, work: () => Promise<void>): void {
    const task: Promise<void> = new Promise<void>((resolve) => {
      setImmediate(() => {
        Promise.resolve()
          .then(work)
          .catch((e: unknown) => {
            // Name only: the error may carry an address, a token or a query value.
            this.logger.error(`Deferred ${label} work failed (${errorName(e)})`);
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
    await this.asUser(user, () =>
      this.prisma.client.user.update({
        where: { id: user.id },
        data: {
          setPasswordTokenHash: sha256Hex(token),
          setPasswordExpiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      }),
    );
    const url = `${this.webOrigin}/admin/reset-password#token=${token}`;
    // If the enqueue fails this throws (caught and logged by defer). The new token hash stays and
    // has overwritten any earlier valid reset link: the user must ask again. No security impact.
    await this.mail.sendPasswordReset(user.email, url);
  }

  resetPassword(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    return this.orgContext.runSystem('AUTH_BOOTSTRAP', async () => {
      const tokenHash = sha256Hex(token);
      const user = await this.prisma.client.user.findUnique({
        where: { setPasswordTokenHash: tokenHash },
      });
      if (!user) throw this.invalidResetLink();
      await this.asUser(user, () => this.setPassword(user, tokenHash, newPassword, ctx));
    });
  }

  /**
   * Both the 30 minute reset link (FR-107) and the 72 hour staff invite link (ADR 0003 section 4)
   * land here: they share the set_password_* columns and the same hardening. Single use and expiry
   * are enforced by the UPDATE itself, the new hash, the spent token and the revocation of every
   * refresh family are one transaction, the response is the same generic 400 for every refusal,
   * and nobody is signed in. An invite (no password yet) is audited as AUTH_INVITE_ACCEPTED,
   * a reset as AUTH_PASSWORD_RESET (FU-BE-32).
   */
  private async setPassword(
    user: User,
    tokenHash: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    if (
      !user.isActive ||
      !user.setPasswordExpiresAt ||
      user.setPasswordExpiresAt.getTime() <= Date.now()
    ) {
      throw this.invalidResetLink();
    }
    const wasInvite = user.passwordHash === null;
    const passwordHash = await this.passwords.hash(newPassword);
    const done = await this.prisma.client.$transaction(async (tx) => {
      // Single use: the token is only valid while it is still stored and unexpired.
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          isActive: true,
          // The password state the link was read under (null for an invite): a change in
          // between, such as a deactivation or another reset, refuses this one.
          passwordHash: user.passwordHash,
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
          action: wasInvite ? 'AUTH_INVITE_ACCEPTED' : 'AUTH_PASSWORD_RESET',
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
    const rows = await this.raw(
      'atomic login-attempt reservation under a row lock (FU-BE-26)',
      () =>
        this.prisma.client.$queryRaw<{ granted: boolean }[]>(Prisma.sql`
      WITH old AS (
        SELECT id, failed_logins, locked_until, updated_at
        FROM users
        WHERE id = ${user?.id ?? NO_USER_ID}::uuid AND org_id = ${user?.orgId ?? NO_ORG_ID}::uuid
        FOR UPDATE)
      UPDATE users u SET
        failed_logins = CASE WHEN ${lockExpired} THEN 1
                             WHEN ${open} THEN old.failed_logins + 1
                             ELSE old.failed_logins END,
        locked_until = CASE WHEN ${lockExpired} OR ${open} THEN NULL
                            ELSE now() + make_interval(mins => ${LOCKOUT_MINUTES}::int) END
      FROM old
      WHERE u.id = old.id AND (${lockExpired} OR ${open} OR ${stale})
      RETURNING (${lockExpired} OR ${open}) AS granted`),
    );
    const row = rows[0];
    if (!row) return 'denied';
    if (row.granted) return 'granted';
    // The stuck window was just locked here.
    if (user) await this.recordLock(user, ctx);
    return 'denied';
  }

  /** Gives back a reservation whose secret turned out right but whose login is not finished. */
  private async refundAttempt(user: Pick<User, 'id' | 'orgId'>): Promise<void> {
    await this.raw(
      'give back one reserved attempt, never below zero or under a lock',
      () =>
        this.prisma.client.$executeRaw`
        UPDATE users SET failed_logins = failed_logins - 1
        WHERE id = ${user.id}::uuid AND org_id = ${user.orgId}::uuid
          AND locked_until IS NULL AND failed_logins > 0`,
    );
  }

  /** Clears the counter after a success, but never a lock a sibling request just set. */
  private async clearFailures(
    user: Pick<User, 'id' | 'orgId'>,
    db: Db = this.prisma.client,
  ): Promise<void> {
    await this.raw(
      'clear the failure counter without clearing a live lock',
      () =>
        db.$executeRaw`
        UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now()
        WHERE id = ${user.id}::uuid AND org_id = ${user.orgId}::uuid
          AND (locked_until IS NULL OR locked_until <= now())`,
    );
  }

  /**
   * A failed guess. The attempt was already counted by reserveAttempt; once all 5 slots are
   * used, exactly one failing request sets the 15 minute lock and writes the audit row (TC-002).
   * A null user runs the same statement against the nil id so every refused login costs the
   * same round trips.
   */
  private async registerFailure(user: User | null, ctx: RequestContext): Promise<void> {
    const locked = await this.raw(
      'set the lockout once, after the last reserved attempt fails',
      () =>
        this.prisma.client.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE users SET
          locked_until = now() + make_interval(mins => ${LOCKOUT_MINUTES}::int),
          updated_at = now()
        WHERE id = ${user?.id ?? NO_USER_ID}::uuid AND org_id = ${user?.orgId ?? NO_ORG_ID}::uuid
          AND failed_logins >= ${MAX_FAILED_LOGINS}::int
          AND locked_until IS NULL
        RETURNING id`),
    );
    if (user && locked.length === 1) await this.recordLock(user, ctx);
  }

  /**
   * The one place a lock is recorded: the AUTH_ACCOUNT_LOCKED audit row (which the SUPER_ADMIN
   * lock-events list reads) and, after the response, an email to the org's SUPER_ADMINs (P-03).
   * The alert is deferred and its failures only logged by name, so it never changes the answer,
   * the status or the statements of the locked user's request. Locked accounts are shown only to
   * SUPER_ADMINs of the same org (FU-BE-22).
   */
  private async recordLock(user: User, ctx: RequestContext): Promise<void> {
    await this.auditAfterCommit(user, 'AUTH_ACCOUNT_LOCKED', ctx, { minutes: LOCKOUT_MINUTES });
    const { orgId, email, fullName } = user;
    this.defer('lock-alert', () => this.alertAdmins(orgId, email, fullName));
  }

  private alertAdmins(orgId: string, email: string, name: string): Promise<void> {
    return this.orgContext.runInOrg(orgId, async () => {
      const admins = await this.prisma.client.user.findMany({
        where: { role: UserRole.SUPER_ADMIN, isActive: true, passwordHash: { not: null } },
        select: { email: true },
      });
      for (const admin of admins) {
        try {
          await this.mail.sendStaffAccountLocked(admin.email, {
            email,
            name,
            minutes: LOCKOUT_MINUTES,
          });
        } catch (e) {
          // Name only: the error may carry an address.
          this.logger.error(`Lock alert email failed (${errorName(e)})`);
        }
      }
    });
  }

  /**
   * An audit row written after the state change committed, on an auth route (login lockout,
   * re-auth failure lockout, refresh reuse, logout). A failure here is logged by class name (the
   * alert hook, FU-BE-191) and NEVER changes the response: a 500 on these paths would tell an
   * existing account from an unknown one (api-contract section 8, P-37).
   */
  private async auditAfterCommit(
    user: User,
    action: string,
    ctx: RequestContext,
    metadata: Prisma.InputJsonObject = {},
  ): Promise<void> {
    try {
      await this.audit(user, action, ctx, metadata);
    } catch (e) {
      this.logger.error(`Audit write after commit failed (${errorName(e)}) for ${action}`);
    }
  }

  private async audit(
    user: User,
    action: string,
    ctx: RequestContext,
    metadata: Prisma.InputJsonObject = {},
    db: Db = this.prisma.client,
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
    db: Db = this.prisma.client,
    boundTotpSecret?: string,
  ): Promise<SessionOutcome> {
    const refreshToken = newOpaqueToken();
    // The access token is signed BEFORE the refresh family commits, so its iat can never be later
    // than the time a concurrent 2FA disable, admin reset, role change or deactivation writes its
    // tokens-valid-after marker after waiting for this insert (S1). It is returned only if the
    // insert below succeeds.
    const body = this.authenticated(user);
    // The token exists only if the password is still the one that was verified. FOR SHARE (not
    // FOR KEY SHARE, which does not conflict with a non-key UPDATE) locks the user row in this
    // statement: it waits for an in-flight reset, re-checks the WHERE against the new row version
    // and inserts nothing; a reset arriving later waits for this commit, so its revoke-all sees
    // the token. A family can never outlive a reset (FR-104, FR-107).
    // `?? ''` is deliberate: an empty hash can never equal a stored hash, so it inserts nothing.
    // The role read at sign-in is bound too: a promotion to a 2FA-required role in between inserts
    // nothing, so no family exists that skipped 2FA (the guard refuses the old-role access token,
    // but a refresh would re-read the new role).
    // A 2FA completion also binds the TOTP secret it checked: an admin reset of the user's 2FA
    // that lands in between clears it, so no session is opened from the old second factor.
    const totpBound =
      boundTotpSecret === undefined
        ? Prisma.empty
        : Prisma.sql`AND u.totp_enabled AND u.totp_secret_enc = ${boundTotpSecret}`;
    const inserted = await this.raw(
      'open a refresh family: INSERT ... SELECT ... FOR SHARE of the user row (FR-104, FR-107)',
      () =>
        db.$queryRaw<{ id: string }[]>(Prisma.sql`
          INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
          SELECT u.id, ${randomUUID()}::uuid, ${sha256Hex(refreshToken)},
                 ${new Date(Date.now() + REFRESH_TTL_MS)}::timestamptz
          FROM users u
          WHERE u.id = ${user.id}::uuid AND u.org_id = ${user.orgId}::uuid AND u.is_active
            AND u.password_hash = ${user.passwordHash ?? ''}
            AND u.role = ${user.role}::user_role
            ${totpBound}
          FOR SHARE OF u
          RETURNING id`),
    );
    if (inserted.length !== 1) throw new PasswordChangedSignal();
    await this.clearFailures(user, db);
    return { body, refreshToken };
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
        totpEnabled: user.totpEnabled,
      },
    };
  }

  /** Increments a windowed counter. Returns null when Redis is unavailable (callers fail closed). */
  private async hit(key: string): Promise<number | null> {
    try {
      await ensureConnected(this.redis);
      // One atomic script: the TTL is set with the first hit, and repaired if a key lost it (FU-BE-64).
      return (await hitWindowCounter(this.redis, key, FORGOT_WINDOW_SECONDS)).count;
    } catch {
      return null;
    }
  }
}
