import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Audited } from '../audit/audited.decorator';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { ctxOf } from '../common/request-context';
import { UserRole } from '../generated/prisma/client';
import {
  InviteStaffUserDto,
  ListQueryDto,
  LockEventListDto,
  StaffUserDto,
  StaffUserListDto,
  UnlockStaffUserDto,
  UpdateStaffUserDto,
} from './dto/users.dto';
import { UsersService } from './users.service';
import type { Actor } from './users.service';

function actorOf(req: AuthedRequest): Actor {
  if (!req.user) throw new Error('Guard did not attach a user');
  return { id: req.user.id, orgId: req.user.orgId };
}

// FR-103: SUPER_ADMIN only, own organization only. `locked` and `lockedUntil` appear on these
// routes and nowhere else (FU-BE-22).
@ApiTags('admin-users')
@ApiBearerAuth()
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/users')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({
  description:
    "Caller is not a super admin, or (invite, role/active change, unlock) the admin's own currentPassword is wrong or locked: code 'REAUTH_FAILED', one body for both (FR-102 re-auth decision)",
})
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Audited('USER_LIST', 'user')
  @ApiOperation({ summary: "Staff users of the caller's organization (FR-103)" })
  @ApiOkResponse({ type: StaffUserListDto })
  list(@Query() query: ListQueryDto): Promise<StaffUserListDto> {
    return this.users.list(query.page, query.pageSize);
  }

  @Get('lock-events')
  @Audited('USER_LOCK_EVENTS_LIST', 'user')
  @ApiOperation({
    summary: 'Recent account lockouts in the organization, newest first (FR-101, P-03)',
  })
  @ApiOkResponse({ type: LockEventListDto })
  lockEvents(@Query() query: ListQueryDto): Promise<LockEventListDto> {
    return this.users.lockEvents(query.page, query.pageSize);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Invite a staff user; they set a password from a 72 hour single-use link (ADR 0003)',
  })
  @ApiCreatedResponse({ type: StaffUserDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({ description: 'A user with this email already exists' })
  @ApiTooManyRequestsResponse({ description: 'Per-organization invite limit reached' })
  invite(@Body() dto: InviteStaffUserDto, @Req() req: AuthedRequest): Promise<StaffUserDto> {
    return this.users.invite(actorOf(req), dto, ctxOf(req));
  }

  @Patch(':userId')
  @ApiOperation({
    summary:
      'Change a role, deactivate or reactivate a user. A role change or deactivation revokes every refresh session at once.',
  })
  @ApiOkResponse({ type: StaffUserDto })
  @ApiBadRequestResponse({ description: 'Not a UUID, or neither role nor active sent' })
  @ApiNotFoundResponse({ description: 'No such user in your organization' })
  @ApiConflictResponse({ description: 'Own role or status, or the last super admin' })
  update(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: UpdateStaffUserDto,
    @Req() req: AuthedRequest,
  ): Promise<StaffUserDto> {
    return this.users.update(actorOf(req), userId, dto, ctxOf(req));
  }

  @Post(':userId/unlock')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Clear the login lockout of a user (FR-101). Does not change the password or the sessions.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'Not a UUID' })
  @ApiNotFoundResponse({ description: 'No such user in your organization' })
  async unlock(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: UnlockStaffUserDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.users.unlock(actorOf(req), userId, dto.currentPassword, ctxOf(req));
  }
}
