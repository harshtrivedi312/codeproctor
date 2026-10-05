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
    await this.takeInviteSlot(actor.orgId);
    const token = newOpaqueToken();
    let created: User;
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
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
        return user;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A user with this email already exists.');
      }
      throw e;
    }
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
   * to take over a live account. Same step-up, same rate limit as invite(). The audit row comes
   * from the route's @Audited interceptor (metadata method and route only); the mail goes out
   * after the commit and its failure is only logged by error name.
   */
  async reissueInvite(
    actor: Actor,
    rawTargetId: string,
    currentPassword: string,
    ctx: RequestContext,
  ): Promise<StaffUserDto> {
    const verified = await this.auth.verifyCurrentPassword(actor.id, currentPassword, ctx);
    await this.takeInviteSlot(actor.orgId);
    const targetId = rawTargetId.toLowerCase();
    const token = newOpaqueToken();
    const updated = await this.prisma.client.$transaction(async (tx) => {
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
      return tx.user.findUniqueOrThrow({ where: { id: targetId } });
    });
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

  /** Fixed window per org and hour. Redis down is a 503 (fail closed), over the limit a 429. */
  private async takeInviteSlot(orgId: string): Promise<void> {
    const key = `invite:org:${orgId}:${Math.floor(Date.now() / (INVITE_WINDOW_SECONDS * 1000))}`;
    let count: number;
    try {
      await ensureConnected(this.redis);
      // SET NX EX creates the key with its expiry in one command, so no counter is ever left
      // without a TTL; INCR then keeps that TTL.
      await this.redis.set(key, '0', 'EX', INVITE_WINDOW_SECONDS, 'NX');
      count = await this.redis.incr(key);
    } catch {
      throw new ServiceUnavailableException('Verification is temporarily unavailable.');
    }
    if (count > this.inviteLimit) {
      throw new HttpException(
        'Too many invitations. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
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
