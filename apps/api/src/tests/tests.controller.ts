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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { AuthedRequest } from '../common/auth/auth.types';
import { Roles } from '../common/auth/decorators';
import { ctxOf } from '../common/request-context';
import { UserRole } from '../generated/prisma/client';
import {
  CreateTestDto,
  TestDetailDto,
  TestListDto,
  TestListQueryDto,
  UpdateTestDto,
} from './dto/tests.dto';
import { TestsService } from './tests.service';
import type { Actor } from './tests.service';

function actorOf(req: AuthedRequest): Actor {
  if (!req.user) throw new Error('Guard did not attach a user');
  return { id: req.user.id, orgId: req.user.orgId };
}

// FR-301, FR-302. Permissions test:read (GET), test:create (POST), test:update (PATCH); recruiters
// and super admins only (ADR 0010). See route-permissions.ts.
@ApiTags('tests')
@ApiBearerAuth()
@Roles(UserRole.SUPER_ADMIN, UserRole.RECRUITER)
@Controller('tests')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'The role does not hold the permission for this route' })
export class TestsController {
  constructor(private readonly tests: TestsService) {}

  @Get()
  @ApiOperation({ summary: "Test templates of the caller's organization (FR-301)" })
  @ApiOkResponse({ type: TestListDto })
  @ApiBadRequestResponse({ description: 'Invalid query' })
  list(@Query() query: TestListQueryDto): Promise<TestListDto> {
    return this.tests.list(query);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Create a test with ordered sections, fixed or random questions, a STANDARD or STRICT proctoring profile and a pass score (FR-301, FR-302)',
  })
  @ApiCreatedResponse({ type: TestDetailDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed (LOCKDOWN profile, time limits above the duration, bad random rule, ...)',
  })
  @ApiNotFoundResponse({
    description: 'A fixed question version does not exist or is not available in your organization',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'A fixed version belongs to an archived question, or a random rule matches too few published questions',
  })
  create(@Body() dto: CreateTestDto, @Req() req: AuthedRequest): Promise<TestDetailDto> {
    return this.tests.create(actorOf(req), dto, ctxOf(req));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One test with its sections and questions (FR-301)' })
  @ApiOkResponse({ type: TestDetailDto })
  @ApiBadRequestResponse({ description: 'Not a UUID' })
  @ApiNotFoundResponse({ description: 'No such test in your organization' })
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<TestDetailDto> {
    return this.tests.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edit a test that has no invitation or session yet; sections, when sent, replace all sections (FR-301, ADR 0002 S-6)',
  })
  @ApiOkResponse({ type: TestDetailDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or nothing to change' })
  @ApiNotFoundResponse({ description: 'No such test (or question version) in your organization' })
  @ApiConflictResponse({ description: 'The test already has an invitation or a session' })
  @ApiUnprocessableEntityResponse({
    description:
      'A fixed version belongs to an archived question, or a random rule is unsatisfiable',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTestDto,
    @Req() req: AuthedRequest,
  ): Promise<TestDetailDto> {
    return this.tests.update(actorOf(req), id, dto, ctxOf(req));
  }
}
