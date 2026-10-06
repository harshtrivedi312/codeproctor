import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { ctxOf } from '../common/request-context';
import { UserRole } from '../generated/prisma/client';
import { OrgSettingsDto, UpdateOrgSettingsDto } from './dto/org-settings.dto';
import { OrgSettingsService } from './org-settings.service';
import type { Actor } from './org-settings.service';

function actorOf(req: AuthedRequest): Actor {
  if (!req.user) throw new Error('Guard did not attach a user');
  return { id: req.user.id, orgId: req.user.orgId };
}

// org_settings:manage (ADR 0010): SUPER_ADMIN only, own organization only.
@ApiTags('admin-org-settings')
@ApiBearerAuth()
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/org-settings')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({
  description:
    "Caller is not a super admin, or (PATCH) the admin's own currentPassword is wrong or locked: code 'REAUTH_FAILED'",
})
export class OrgSettingsController {
  constructor(private readonly settings: OrgSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Effective settings of the caller organization' })
  @ApiOkResponse({ type: OrgSettingsDto })
  get(@Req() req: AuthedRequest): Promise<OrgSettingsDto> {
    return this.settings.get(actorOf(req));
  }

  @Patch()
  @ApiOperation({
    summary:
      'Change settings (merged into the stored settings; audited ORG_SETTINGS_UPDATED). Needs the own currentPassword of the admin (step-up; wrong or locked is 403 REAUTH_FAILED, missing is 400); the password is never stored or audited. A change to the stored value only is audited; a repeat of the stored value is a 200 with no audit row.',
  })
  @ApiOkResponse({ type: OrgSettingsDto })
  @ApiBadRequestResponse({ description: 'Unknown key, null, out of range, or nothing to change' })
  update(@Body() dto: UpdateOrgSettingsDto, @Req() req: AuthedRequest): Promise<OrgSettingsDto> {
    return this.settings.update(actorOf(req), dto, ctxOf(req));
  }
}
