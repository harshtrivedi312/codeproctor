import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { ctxOf } from '../common/request-context';
import { UserRole } from '../generated/prisma/client';
import { CreateInvitationDto, InvitationCreatedDto } from './dto/invitations.dto';
import { InvitationsService } from './invitations.service';

// FR-303. Permission invitation:create; recruiters and super admins only (ADR 0010).
@ApiTags('invitations')
@ApiBearerAuth()
@Roles(UserRole.SUPER_ADMIN, UserRole.RECRUITER)
@Controller('tests')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold the permission for this route' })
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post(':id/invitations')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Invite one candidate to a test for a start window; the single-use link is mailed, never returned (FR-303)',
  })
  @ApiCreatedResponse({ type: InvitationCreatedDto })
  @ApiBadRequestResponse({ description: 'Validation failed (email, name, window rules)' })
  @ApiNotFoundResponse({ description: 'No such test in your organization' })
  @ApiConflictResponse({
    description:
      'The candidate already has an active invitation for this test, or the candidate has asked for erasure',
  })
  @ApiUnprocessableEntityResponse({
    description: 'A random question slot of the test cannot be filled now (slot positions only)',
  })
  @ApiTooManyRequestsResponse({ description: 'The organization hit its hourly invitation limit' })
  @ApiServiceUnavailableResponse({
    description:
      'Sessions cannot be created yet, the rate limiter (Redis) is down, or the transaction timed out',
  })
  create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateInvitationDto,
    @Req() req: AuthedRequest,
  ): Promise<InvitationCreatedDto> {
    if (!req.user) throw new Error('Guard did not attach a user');
    return this.invitations.create({ id: req.user.id, orgId: req.user.orgId }, id, dto, ctxOf(req));
  }
}
