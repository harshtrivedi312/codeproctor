// Staff user management for SUPER_ADMIN (FR-103, FR-105, ADR 0003 section 4). Every query runs
// through the org-scoped client, so another org's user is simply not found: the same 404 as a
// user that does not exist (TC-008). Lock order, everywhere: the org's active SUPER_ADMIN rows
// (by id), then the target users row, then refresh_tokens, then the audit insert. The users row
// is always changed before the tokens are revoked, in one transaction, so a refresh or sign-in
// that races a role change or deactivation either finishes first and is then revoked, or waits on
// the row lock and finds the account changed (FR-104, FU-BE-43). Nothing here logs a token.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newOpaqueToken, sha256Hex } from '../auth/crypto.util';
import type { Env } from '../config/env';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { Prisma, UserRole } from '../generated/prisma/client';
import type { User } from '../generated/prisma/client';
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

export interface RequestContext {
  ip?: string;
}

interface LockedRow {
  id: string;
  role?: UserRole;
  is_active?: boolean;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown';
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly webOrigin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
    private readonly mail: MailPort,
    config: ConfigService<Env, true>,
  ) {
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
  }

  // ---- read -----------------------------------------------------------------------------------

  async list(page: number, pageSize: number): Promise<StaffUserListDto> {
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
   * as a reset (single use, expiry, atomic, revokes sessions, never signs in).
   */
  async invite(actor: Actor, dto: InviteStaffUserDto, ctx: RequestContext): Promise<StaffUserDto> {
    const token = newOpaqueToken();
    let created: User;
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
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
    const targetId = rawTargetId.toLowerCase();
    const actorId = actor.id.toLowerCase();
    const updated = await this.prisma.client.$transaction(async (tx) => {
      // 1. Every active SUPER_ADMIN of the org, in id order. Serialises changes to the admin set,
      //    so two admins demoting each other cannot both pass the last-admin check.
      const admins = await this.raw('lock the org active SUPER_ADMIN rows in id order', () =>
        tx.$queryRaw<LockedRow[]>(Prisma.sql`
          SELECT id FROM users
          WHERE org_id = ${actor.orgId}::uuid AND role = 'SUPER_ADMIN' AND is_active
          ORDER BY id FOR NO KEY UPDATE`),
      );
      // 2. The target row, same org only. A missing and a cross-org id are the same 404.
      const found = await this.raw('lock the target user row, same org only', () =>
        tx.$queryRaw<Required<LockedRow>[]>(Prisma.sql`
          SELECT id, role, is_active FROM users
          WHERE id = ${targetId}::uuid AND org_id = ${actor.orgId}::uuid
          FOR NO KEY UPDATE`),
      );
      const target = found[0];
      if (!target) throw new NotFoundException('User not found.');
      // The caller must still be an active SUPER_ADMIN now (a demotion may have landed since the
      // guard looked).
      if (!admins.some((a) => a.id === actorId)) throw new ForbiddenException('Forbidden.');

      const demotes = dto.role !== undefined && dto.role !== target.role;
      const deactivates = dto.active === false && target.is_active;
      if (target.id === actorId && (demotes || dto.active === false)) {
        throw new ConflictException('You cannot change your own role or deactivate yourself.');
      }
      const leavesAdmins =
        target.role === UserRole.SUPER_ADMIN &&
        target.is_active &&
        ((demotes && dto.role !== UserRole.SUPER_ADMIN) || deactivates);
      if (leavesAdmins && admins.filter((a) => a.id !== target.id).length === 0) {
        throw new ConflictException('An organization needs at least one active super admin.');
      }
      const reactivates = dto.active === true && !target.is_active;
      if (!demotes && !deactivates && !reactivates) {
        return tx.user.findUniqueOrThrow({ where: { id: targetId } });
      }

      // 3. The users row first ...
      const user = await tx.user.update({
        where: { id: targetId },
        data: {
          ...(demotes ? { role: dto.role } : {}),
          ...(deactivates ? { isActive: false } : {}),
          ...(reactivates ? { isActive: true } : {}),
          updatedAt: new Date(),
        },
      });
      // 4. ... then the tokens. A new role or a deactivation ends every refresh family.
      let revoked = 0;
      if (demotes || deactivates) {
        revoked = (
          await tx.refreshToken.updateMany({
            where: { userId: targetId, revokedAt: null },
            data: { revokedAt: new Date() },
          })
        ).count;
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
      if (demotes) {
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
   * Clears a login lockout (FR-101, P-03). The target row is locked first (FOR NO KEY UPDATE, the
   * same lock the attempt reservation takes), so an attempt in flight either finishes before and
   * is wiped with the counter, or starts after and counts from zero: at most 5 verified guesses
   * in the new window. The password, 2FA and sessions are not touched. No re-authentication is
   * asked: it grants nobody access, is audited, and a SUPER_ADMIN may unlock themselves.
   */
  async unlock(actor: Actor, rawTargetId: string, ctx: RequestContext): Promise<void> {
    const targetId = rawTargetId.toLowerCase();
    await this.prisma.client.$transaction(async (tx) => {
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
