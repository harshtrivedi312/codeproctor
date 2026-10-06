// Organization settings for SUPER_ADMIN (FR-103, ADR 0010 org_settings:manage, ADR 0005 AI-5).
// One key today: aiReferences.minAssistants (integer 0..5 on write, default 2). Every query runs
// through the org-scoped client, so only the caller's own organizations row is ever read or
// written (ADR 0006, TC-008). A PATCH MERGES into the settings jsonb (other keys such as retention
// or consent survive), under a row lock on the organization, and writes its audit row in the same
// transaction. A PATCH that changes nothing (the stored value already equals the sent one) returns
// 200 with no write and no audit row. Malformed stored settings read as the default and a PATCH
// repairs them by writing a valid structure.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrgContextService } from '../database/org-context';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { RequestContext } from '../common/request-context';
import { DEFAULT_MIN_ASSISTANTS, storedMinAssistants } from '../questions/ai-reference-rules';
import type { OrgSettingsDto, UpdateOrgSettingsDto } from './dto/org-settings.dto';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgContext: OrgContextService,
  ) {}

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
    return this.prisma.client.$transaction(async (tx) => {
      const rows = await this.orgContext.runRawSql(
        'lock the caller organization row before merging settings',
        () =>
          tx.$queryRaw<{ settings: unknown }[]>(Prisma.sql`
            SELECT settings FROM organizations WHERE id = ${actor.orgId}::uuid FOR UPDATE`),
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('Organization not found.');
      const stored = storedMinAssistants(row.settings);
      if (stored === next) return view(row.settings);
      const from = stored ?? DEFAULT_MIN_ASSISTANTS;
      const settings: Record<string, unknown> = isPlainObject(row.settings)
        ? { ...row.settings }
        : {};
      const refs = isPlainObject(settings['aiReferences']) ? { ...settings['aiReferences'] } : {};
      refs['minAssistants'] = next;
      settings['aiReferences'] = refs;
      await tx.organization.update({
        where: { id: actor.orgId },
        data: { settings: settings as Prisma.InputJsonObject },
      });
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
