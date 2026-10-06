// Organization settings for SUPER_ADMIN (FR-103, ADR 0010 org_settings:manage, ADR 0005 AI-5).
// One key today: aiReferences.minAssistants (integer 0..5 on write, default 2). Every query runs
// through the org-scoped client, so only the caller's own organizations row is ever read or
// written (ADR 0006, TC-008). A PATCH MERGES into the settings jsonb (other keys such as retention
// or consent survive), by compare-and-set (updateMany where the settings still equal the value read, 3 attempts, then
// 409 SETTINGS_CONFLICT), and writes its audit row in the same transaction as the winning update.
// No raw SQL (ADR 0006). A PATCH that changes nothing (the stored value already equals the sent one) returns
// 200 with no write and no audit row. Malformed stored settings read as the default and a PATCH
// repairs them by writing a valid structure.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { CodedConflictException } from '../common/coded.exception';
import type { RequestContext } from '../common/request-context';
import { DEFAULT_MIN_ASSISTANTS, storedMinAssistants } from '../questions/ai-reference-rules';
import type { OrgSettingsDto, UpdateOrgSettingsDto } from './dto/org-settings.dto';

const MAX_ATTEMPTS = 3;

export interface Actor {
  id: string;
  orgId: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function view(settings: unknown): OrgSettingsDto {
  const stored = storedMinAssistants(settings);
  return {
    aiReferences: {
      minAssistants: stored ?? DEFAULT_MIN_ASSISTANTS,
      isDefault: stored === undefined,
    },
  };
}

@Injectable()
export class OrgSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(actor: Actor): Promise<OrgSettingsDto> {
    const org = await this.prisma.client.organization.findUnique({
      where: { id: actor.orgId },
      select: { settings: true },
    });
    if (!org) throw new NotFoundException('Organization not found.');
    return view(org.settings);
  }

  async update(
    actor: Actor,
    dto: UpdateOrgSettingsDto,
    ctx: RequestContext,
  ): Promise<OrgSettingsDto> {
    const next = dto.aiReferences?.minAssistants;
    if (next === undefined) throw new BadRequestException('Send at least one setting.');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const done = await this.tryUpdate(actor, next, ctx);
      if (done) return done;
    }
    throw new CodedConflictException(
      'The settings changed while saving. Reload and try again.',
      'SETTINGS_CONFLICT',
    );
  }

  /**
   * One compare-and-set attempt: read the row, merge in code, then updateMany where the stored
   * settings still equal what was read. The audit row is written only after the update matched,
   * in the same transaction. Returns null when another writer got there first.
   */
  private tryUpdate(
    actor: Actor,
    next: number,
    ctx: RequestContext,
  ): Promise<OrgSettingsDto | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: actor.orgId },
        select: { settings: true },
      });
      if (!org) throw new NotFoundException('Organization not found.');
      const stored = storedMinAssistants(org.settings);
      if (stored === next) return view(org.settings);
      const from = stored ?? DEFAULT_MIN_ASSISTANTS;
      const settings: Record<string, unknown> = isPlainObject(org.settings)
        ? { ...org.settings }
        : {};
      const refs = isPlainObject(settings['aiReferences']) ? { ...settings['aiReferences'] } : {};
      refs['minAssistants'] = next;
      settings['aiReferences'] = refs;
      const won = await tx.organization.updateMany({
        where: {
          id: actor.orgId,
          settings: { equals: org.settings === null ? Prisma.JsonNull : org.settings },
        },
        data: { settings: settings as Prisma.InputJsonObject },
      });
      if (won.count !== 1) return null;
      await tx.auditLog.create({
        data: {
          orgId: actor.orgId,
          actorId: actor.id,
          action: 'ORG_SETTINGS_UPDATED',
          entityType: 'organization',
          entityId: actor.orgId,
          ip: ctx.ip ?? null,
          metadata: { changes: [{ key: 'aiReferences.minAssistants', from, to: next }] },
        },
      });
      return view(settings);
    });
  }
}
