// Staff user management for SUPER_ADMIN (FR-103, FR-105, ADR 0003 section 4). Invite, role change,
// deactivation and unlock need the admin's current password (step-up, following the FR-102 re-auth
// decision of the admin 2FA reset): a stolen access token alone cannot create or strip admins or
// unlock accounts. The password is checked first, on the login path (reserve, equal work, lockout),
// so a wrong or locked password is the same 403 REAUTH_FAILED whatever the target is; the by-id
// 404 for a missing or other-org user comes only after it succeeds. Every query runs
// through the org-scoped client, so another org's user is simply not found: the same 404 as a
// user that does not exist (TC-008). Lock order, everywhere: the org's active SUPER_ADMIN rows
// (by id), then the target users row, then refresh_tokens, then the audit insert. The users row
// is always changed before the tokens are revoked, in one transaction, so a refresh or sign-in
// that races a role change or deactivation either finishes first and is then revoked, or waits on
// the row lock and finds the account changed (FR-104, FU-BE-43). Nothing here logs a token.
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { AuthService } from '../auth/auth.service';
import { newOpaqueToken, sha256Hex } from '../auth/crypto.util';
import { TokenValidityService } from '../common/auth/token-validity.service';
import { reauthFailed } from '../common/coded.exception';
import { lockContentionCode } from '../common/db-contention';
import { OutcomeUnknownError } from '../common/outcome-unknown.error';
import { hitWindowCounter, refundWindowCounter } from '../common/redis-counter';
import { errorName } from '../common/request-context';
import type { RequestContext } from '../common/request-context';
import { ensureConnected } from '../infrastructure/redis-ready';
import { REDIS_CLIENT } from '../infrastructure/infrastructure.module';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { Prisma, UserRole } from '../generated/prisma/client';
import type { User } from '../generated/prisma/client';
import type { OrgScopedPrismaClient } from '../database/org-scope.extension';

import { MailPort } from '../mail/mail.port';
import type {
  InviteStaffUserDto,
  LockEventListDto,
  StaffUserDto,
  StaffUserListDto,
  UpdateStaffUserDto,
} from './dto/users.dto';

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

interface TxPhase {
  started: boolean;
  finished: boolean;
}

export interface Actor {
  id: string;
  orgId: string;
}

/** The most rows a list can skip: deep offsets are refused (400) instead of scanning the table. */
export const MAX_LIST_OFFSET = 10_000;
type OrgScopedTx = Pick<OrgScopedPrismaClient, 'user'>;

const INVITE_WINDOW_SECONDS = 60 * 60;

interface AdminRow {
  id: string;
  password_hash: string | null;
}

interface TargetRow {
  id: string;
  role: UserRole;
  is_active: boolean;
  has_password: boolean;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly webOrigin: string;
  private readonly inviteLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly mail: MailPort,
    private readonly auth: AuthService,
    private readonly validity: TokenValidityService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
    this.inviteLimit = config.get('INVITE_RATE_LIMIT_PER_ORG_HOUR', { infer: true });
  }

  // ---- read -----------------------------------------------------------------------------------

  async list(page: number, pageSize: number): Promise<StaffUserListDto> {
    this.checkOffset(page, pageSize);
    const [rows, total] = await Promise.all([
      this.prisma.client.user.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.user.count(),
    ]);
    return { items: rows.map((u) => this.toDto(u)), page, pageSize, total };
  }

  /** Recent AUTH_ACCOUNT_LOCKED audit rows of this org, newest first (P-03 in-app alert). */
  async lockEvents(page: number, pageSize: number): Promise<LockEventListDto> {
    this.checkOffset(page, pageSize);
    const where = { action: 'AUTH_ACCOUNT_LOCKED' };
    const [rows, total] = await Promise.all([
      this.prisma.client.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.auditLog.count({ where }),
    ]);
    const ids = [...new Set(rows.flatMap((r) => (r.entityId ? [r.entityId] : [])))];
    const users = ids.length
      ? await this.prisma.client.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, email: true, fullName: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      items: rows.map((r) => {
        const user = r.entityId ? byId.get(r.entityId) : undefined;
        return {
          id: r.id.toString(),
          userId: r.entityId ?? '',
          email: user?.email ?? null,
          name: user?.fullName ?? null,
          lockedAt: r.createdAt.toISOString(),
        };
      }),
      page,
      pageSize,
      total,
    };
  }

  // ---- invite ---------------------------------------------------------------------------------

  /**
   * Creates a pending user (no password) with a 72 hour single-use set-password token: only the
   * SHA-256 of 32 random bytes is stored. The link goes out through the staff-invite template,
   * after the commit. The user accepts through POST /auth/password/reset, the same hardened route
   * as a reset (single use, expiry, atomic, revokes sessions, never signs in). Needs the admin's
   * current password and is rate limited per org (Redis fixed window, fails closed).
   */
  async invite(actor: Actor, dto: InviteStaffUserDto, ctx: RequestContext): Promise<StaffUserDto> {
    const verified = await this.auth.verifyCurrentPassword(actor.id, dto.currentPassword, ctx);
    const slot = await this.takeInviteSlot(actor.orgId);
    const token = newOpaqueToken();
    let created: User;
    // Phase tracking for the failure rule (DL-37, FU-BE-208): set inside the callback.
    const phase: TxPhase = { started: false, finished: false };
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
        phase.started = true;
        await this.requireSameAdmin(tx, actor, verified.passwordHash);
        const user = await tx.user.create({
          data: {
            orgId: actor.orgId,
            email: dto.email.toLowerCase(),
            fullName: dto.name,
            role: dto.role,
            passwordHash: null,
            setPasswordTokenHash: sha256Hex(token),
            setPasswordExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
          },
        });
        await tx.auditLog.create({
          data: {
            orgId: actor.orgId,
            actorId: actor.id,
            action: 'USER_INVITED',
            entityType: 'user',
            entityId: user.id,
            ip: ctx.ip ?? null,
            metadata: { role: dto.role },
          },
        });
        phase.finished = true;
        return user;
      });
    } catch (e) {
      // P2002 can only come from the create inside the callback, so it never follows the commit.
      // Known limit (FU-BE-208): a retry after an unknown-outcome 500 can hit P2002 because the
      // first attempt did commit. That is indistinguishable server-side from an ordinary
      // duplicate, so it keeps the ordinary behaviour (409 plus a USER_INVITE_CONFLICT row).
      if (
        !phase.finished &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // The create and USER_INVITED rolled back together, so the attempt would leave no record
        // and a SUPER_ADMIN could probe other organizations' staff emails unseen (DL-36). Record it
        // outside that transaction: actor, org and time only, no email and no user id. If this
        // insert fails the request fails (500) rather than answering the probe unrecorded.
        try {
          await this.prisma.client.auditLog.create({
            data: {
              orgId: actor.orgId,
              actorId: actor.id,
              action: 'USER_INVITE_CONFLICT',
              entityType: 'user',
              entityId: null,
              ip: ctx.ip ?? null,
              metadata: {},
            },
          });
        } catch (auditError) {
          // Contention here is a 503 that invites a retry: the slot goes back (DL-37).
          await this.refundSlotOnContention(slot, auditError);
          throw auditError;
        }
        throw new ConflictException('A user with this email already exists.');
      }
      return this.failInviteTx(e, phase, slot, 'users.invite');
    }
    // The mail goes out only after a known commit. On OutcomeUnknownError (thrown above) no mail
    // is sent: the invitee has no link, and the client reads the user list and uses re-issue.
    try {
      await this.mail.sendStaffInvite(
        created.email,
        `${this.webOrigin}/admin/set-password#token=${token}`,
      );
    } catch (e) {
      // The user exists; the invite mail failed. Name only: the error may carry the address.
      this.logger.error(`Staff invite email failed (${errorName(e)})`);
    }
    return this.toDto(created);
  }

  /**
   * Re-issues the invite of a user who is still pending (no password yet, active), DL-23. A new
   * 32-byte token replaces the stored hash with a fresh 72 hour expiry, so the old link stops
   * working (the old hash is overwritten, single use). The target row is locked first and the write
   * is bound to `password_hash IS NULL` and `is_active`, so a re-issue that races the invitee
   * accepting cannot overwrite the new password or bring a link back: it finds the password set and
   * is a 409. A user with a password or a deactivated one is a 409 as well, so this cannot be used
   * to take over a live account. Same step-up, same rate limit as invite(). The audit row
   * (metadata method and route only) is written in the same transaction as the token rotation, so
   * a failed audit insert rolls the rotation back; the mail goes out after the commit and its failure is only logged by error name.
   */
  async reissueInvite(
    actor: Actor,
    rawTargetId: string,
    currentPassword: string,
    ctx: RequestContext,
  ): Promise<StaffUserDto> {
    const verified = await this.auth.verifyCurrentPassword(actor.id, currentPassword, ctx);
    const slot = await this.takeInviteSlot(actor.orgId);
    const targetId = rawTargetId.toLowerCase();
    const token = newOpaqueToken();
    const phase: TxPhase = { started: false, finished: false };
    const updated = await this.prisma.client
      .$transaction(async (tx) => {
        phase.started = true;
        await this.requireSameAdmin(tx, actor, verified.passwordHash);
        const found = await this.raw('lock the target user row, same org only', () =>
          tx.$queryRaw<{ id: string; is_active: boolean; has_password: boolean }[]>(Prisma.sql`
          SELECT id, is_active, (password_hash IS NOT NULL) AS has_password FROM users
          WHERE id = ${targetId}::uuid AND org_id = ${actor.orgId}::uuid
          FOR NO KEY UPDATE`),
        );
        const target = found[0];
        if (!target) throw new NotFoundException('User not found.');
        if (target.has_password || !target.is_active) {
          throw new ConflictException('Only a pending invitation can be re-issued.');
        }
        const done = await tx.user.updateMany({
          where: { id: targetId, passwordHash: null, isActive: true },
          data: {
            setPasswordTokenHash: sha256Hex(token),
            setPasswordExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
            updatedAt: new Date(),
          },
        });
        if (done.count !== 1)
          throw new ConflictException('Only a pending invitation can be re-issued.');
        await tx.auditLog.create({
          data: {
            orgId: actor.orgId,
            actorId: actor.id,
            action: 'USER_INVITE_REISSUED',
            entityType: 'user',
            entityId: targetId,
            ip: ctx.ip ?? null,
            metadata: { method: 'POST', route: '/api/v1/admin/users/:userId/invite' },
          },
        });
        const row = await tx.user.findUniqueOrThrow({ where: { id: targetId } });
        phase.finished = true;
        return row;
      })
      .catch((e: unknown) => this.failInviteTx(e, phase, slot, 'users.invite.reissue'));
    // No mail on OutcomeUnknownError (thrown above): the client reads the list and re-issues.
    try {
      await this.mail.sendStaffInvite(
        updated.email,
        `${this.webOrigin}/admin/set-password#token=${token}`,
      );
    } catch (e) {
      this.logger.error(`Staff invite email failed (${errorName(e)})`);
    }
    return this.toDto(updated);
  }

  /**
   * Classifies a failed invite or re-issue transaction (DL-37, FU-BE-208) and always throws.
   * Our own HttpExceptions and every failure before the callback returned keep the existing
   * behaviour: rethrown as is, the slot refunded only for contention (503 BUSY). After the callback
   * returned, 40001, 40P01 and P2034 are rollbacks (503 BUSY, slot refunded); anything else (P2028
   * or P1017 at COMMIT, a connection error) may have committed: OutcomeUnknownError, and the slot
   * is NOT refunded, so a retried invite cannot get a free slot.
   */
  private async failInviteTx(
    e: unknown,
    phase: TxPhase,
    slot: string,
    route: string,
  ): Promise<never> {
    if (e instanceof HttpException || !phase.finished) {
      await this.refundSlotOnContention(slot, e);
      throw e;
    }
    const code = lockContentionCode(e);
    if (code === '40001' || code === '40P01' || code === 'P2034') {
      await this.refundSlotOnContention(slot, e);
      throw e;
    }
    throw new OutcomeUnknownError(route);
  }

  /**
   * Fixed window per org and hour. Redis down is a 503 (fail closed), over the limit a 429.
   * Returns the window key that was counted, so a failed attempt can give its slot back.
   */
  private async takeInviteSlot(orgId: string): Promise<string> {
    const key = `invite:org:${orgId}:${Math.floor(Date.now() / (INVITE_WINDOW_SECONDS * 1000))}`;
    let count: number;
    try {
      await ensureConnected(this.redis);
      // One atomic script (INCR plus the expiry when the key is new or has none), so no counter is
      // ever left without a TTL, not even if the key expires between two commands (FU-BE-64).
      count = (await hitWindowCounter(this.redis, key, INVITE_WINDOW_SECONDS)).count;
    } catch {
      throw new ServiceUnavailableException('Verification is temporarily unavailable.');
    }
    if (count > this.inviteLimit) {
      throw new HttpException(
        'Too many invitations. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return key;
  }

  /**
   * DL-37: lock contention answers 503 and invites a retry, so the invite slot of the attempt
   * that never happened is given back; otherwise contention alone could exhaust the org's budget.
   * Only for contention: a refused invite (409, 404) keeps its slot as before. This counter does
   * not record a failed authentication (the admin's password was already verified), so refunding
   * it cannot erase an attacker's count. Best effort, never masks the original error.
   */
  private async refundSlotOnContention(slotKey: string, error: unknown): Promise<void> {
    if (lockContentionCode(error) === undefined) return;
    await refundWindowCounter(this.redis, slotKey);
  }

  /**
   * The admin must still be the one whose password was verified: active SUPER_ADMIN of this org
   * with the same hash. A plain read, no lock on the admin row (two admins acting on each other
   * cannot deadlock); a change in between is the same REAUTH_FAILED.
   */
  private async requireSameAdmin(
    tx: OrgScopedTx,
    actor: Actor,
    verifiedHash: string,
  ): Promise<void> {
    const still = await tx.user.count({
      where: {
        id: actor.id,
        orgId: actor.orgId,
        passwordHash: verifiedHash,
        role: UserRole.SUPER_ADMIN,
        isActive: true,
      },
    });
    if (still !== 1) throw reauthFailed();
  }

  // ---- role, deactivate, reactivate -----------------------------------------------------------

  async update(
    actor: Actor,
    rawTargetId: string,
    dto: UpdateStaffUserDto,
    ctx: RequestContext,
  ): Promise<StaffUserDto> {
    if (dto.role === undefined && dto.active === undefined) {
      throw new BadRequestException('Send a role, active, or both.');
    }
    const verified = await this.auth.verifyCurrentPassword(actor.id, dto.currentPassword, ctx);
    const targetId = rawTargetId.toLowerCase();
    const actorId = actor.id.toLowerCase();
    const updated = await this.prisma.client.$transaction(async (tx) => {
      // 1. Every active SUPER_ADMIN of the org, in id order. Serialises changes to the admin set,
      //    so two admins demoting each other cannot both pass the last-admin check. The caller's
      //    own row is among them, so this also re-checks the caller (still an active SUPER_ADMIN
      //    with the verified password) under the lock.
      const admins = await this.raw('lock the org active SUPER_ADMIN rows in id order', () =>
        tx.$queryRaw<AdminRow[]>(Prisma.sql`
          SELECT id, password_hash FROM users
          WHERE org_id = ${actor.orgId}::uuid AND role = 'SUPER_ADMIN' AND is_active
          ORDER BY id FOR NO KEY UPDATE`),
      );
      const self = admins.find((a) => a.id === actorId);
      if (!self || self.password_hash !== verified.passwordHash) throw reauthFailed();
      // 2. The target row, same org only. A missing and a cross-org id are the same 404 (after
      //    the password check above).
      const found = await this.raw('lock the target user row, same org only', () =>
        tx.$queryRaw<TargetRow[]>(Prisma.sql`
          SELECT id, role, is_active, (password_hash IS NOT NULL) AS has_password FROM users
          WHERE id = ${targetId}::uuid AND org_id = ${actor.orgId}::uuid
          FOR NO KEY UPDATE`),
      );
      const target = found[0];
      if (!target) throw new NotFoundException('User not found.');

      const roleChanges = dto.role !== undefined && dto.role !== target.role;
      const deactivates = dto.active === false && target.is_active;
      if (target.id === actorId && (roleChanges || dto.active === false)) {
        throw new ConflictException('You cannot change your own role or deactivate yourself.');
      }
      // Defensive: the caller is an active SUPER_ADMIN other than the target here (a self change
      // is refused above), so the set never empties. Kept in case that rule is ever relaxed.
      const leavesAdmins =
        target.role === UserRole.SUPER_ADMIN &&
        target.is_active &&
        ((roleChanges && dto.role !== UserRole.SUPER_ADMIN) || deactivates);
      if (leavesAdmins && admins.filter((a) => a.id !== target.id).length === 0) {
        throw new ConflictException('An organization needs at least one active super admin.');
      }
      const reactivates = dto.active === true && !target.is_active;
      if (!roleChanges && !deactivates && !reactivates) {
        return tx.user.findUniqueOrThrow({ where: { id: targetId } });
      }

      // 3. The users row first ... A deactivated account also drops a pending password-reset
      //    token (an invite token of a user with no password has to stay: the schema needs one).
      const user = await tx.user.update({
        where: { id: targetId },
        data: {
          ...(roleChanges ? { role: dto.role } : {}),
          ...(deactivates ? { isActive: false } : {}),
          ...(deactivates && target.has_password
            ? { setPasswordTokenHash: null, setPasswordExpiresAt: null }
            : {}),
          ...(reactivates ? { isActive: true } : {}),
          updatedAt: new Date(),
        },
      });
      // 4. ... then the tokens. A new role or a deactivation ends every refresh family and every
      //    access token issued so far (Redis marker; a Redis outage rolls this back with a 503).
      let revoked = 0;
      if (roleChanges || deactivates) {
        revoked = (
          await tx.refreshToken.updateMany({
            where: { userId: targetId, revokedAt: null },
            data: { revokedAt: new Date() },
          })
        ).count;
        await this.validity.invalidateIssuedTokens(targetId);
      }
      const audit = async (action: string, metadata: Prisma.InputJsonObject): Promise<void> => {
        await tx.auditLog.create({
          data: {
            orgId: actor.orgId,
            actorId: actor.id,
            action,
            entityType: 'user',
            entityId: targetId,
            ip: ctx.ip ?? null,
            metadata,
          },
        });
      };
      if (roleChanges) {
        await audit('USER_ROLE_CHANGED', {
          from: target.role,
          to: dto.role ?? null,
          sessionsRevoked: revoked,
        });
      }
      if (deactivates) await audit('USER_DEACTIVATED', { sessionsRevoked: revoked });
      if (reactivates) await audit('USER_REACTIVATED', {});
      return user;
    });
    return this.toDto(updated);
  }

  // ---- unlock ---------------------------------------------------------------------------------

  /**
   * Clears a login lockout (FR-101, P-03). Needs the admin's current password: without it a stolen
   * admin token could unlock an account again and again and so remove the 5-attempt limit. The
   * target row is locked first (FOR NO KEY UPDATE, the lock the attempt reservation takes), so an
   * attempt in flight either finishes before and is wiped with the counter, or starts after and
   * counts from zero: at most 5 verified guesses in the new window. The password, 2FA and
   * sessions are not touched. A SUPER_ADMIN may unlock themselves.
   */
  async unlock(
    actor: Actor,
    rawTargetId: string,
    currentPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    const verified = await this.auth.verifyCurrentPassword(actor.id, currentPassword, ctx);
    const targetId = rawTargetId.toLowerCase();
    await this.prisma.client.$transaction(async (tx) => {
      await this.requireSameAdmin(tx, actor, verified.passwordHash);
      const found = await this.raw('lock the target user row, same org only', () =>
        tx.$queryRaw<{ id: string; failed_logins: number; locked: boolean }[]>(Prisma.sql`
          SELECT id, failed_logins, (locked_until IS NOT NULL AND locked_until > now()) AS locked
          FROM users
          WHERE id = ${targetId}::uuid AND org_id = ${actor.orgId}::uuid
          FOR NO KEY UPDATE`),
      );
      const target = found[0];
      if (!target) throw new NotFoundException('User not found.');
      await tx.user.update({
        where: { id: targetId },
        data: { failedLogins: 0, lockedUntil: null, updatedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          orgId: actor.orgId,
          actorId: actor.id,
          action: 'USER_UNLOCKED',
          entityType: 'user',
          entityId: targetId,
          ip: ctx.ip ?? null,
          metadata: { wasLocked: target.locked },
        },
      });
    });
  }

  // ---- helpers --------------------------------------------------------------------------------

  private checkOffset(page: number, pageSize: number): void {
    if (page * pageSize > MAX_LIST_OFFSET) {
      throw new BadRequestException('That page is too deep. Narrow the list instead.');
    }
  }

  private raw<T>(reason: string, run: () => Promise<T>): Promise<T> {
    return this.orgContext.runRawSql(reason, run);
  }

  private toDto(u: User): StaffUserDto {
    const locked = u.lockedUntil !== null && u.lockedUntil.getTime() > Date.now();
    return {
      id: u.id,
      email: u.email,
      name: u.fullName,
      role: u.role,
      status: !u.isActive ? 'deactivated' : u.passwordHash === null ? 'invited' : 'active',
      locked,
      lockedUntil: locked && u.lockedUntil ? u.lockedUntil.toISOString() : null,
      totpEnabled: u.totpEnabled,
      createdAt: u.createdAt.toISOString(),
    };
  }
}
