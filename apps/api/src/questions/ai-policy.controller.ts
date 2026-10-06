import { Controller, Get, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { PrismaService } from '../database/prisma.service';
import { UserRole } from '../generated/prisma/client';
import { AiPolicyDto } from './dto/ai-policy.dto';
import { aiPolicyFromSettings } from './ai-reference-rules';

// Read-only view of the org's AI reference policy (permission ai_reference:read). Registered
// before QuestionsController so that `ai-policy` is never taken for a `:id`.
@ApiTags('questions')
@ApiBearerAuth()
@Controller('questions/ai-policy')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold ai_reference:read' })
export class AiPolicyController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.AUTHOR)
  @ApiOperation({ summary: 'The AI reference policy of your organization (ADR 0005 AI-4, AI-5)' })
  @ApiOkResponse({ type: AiPolicyDto })
  async get(@Req() req: AuthedRequest): Promise<AiPolicyDto> {
    if (!req.user) throw new Error('Guard did not attach a user');
    const org = await this.prisma.client.organization.findUnique({
      where: { id: req.user.orgId },
      select: { settings: true },
    });
    return {
      ...aiPolicyFromSettings(org?.settings),
      // ADR 0005 AI-4 names `aiReferences.refreshDays` (default 90) but no code reads it yet.
      refreshIntervalDays: null,
    };
  }
}
